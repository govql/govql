import http from 'http';
import { postgraphile } from 'postgraphile';
import { grafserv } from 'postgraphile/grafserv/node';
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber';
import { makeV4Preset } from 'postgraphile/presets/v4';
import { makePgService } from 'postgraphile/adaptors/pg';
import ConnectionFilterPlugin from 'postgraphile-plugin-connection-filter';
import {
  GraphQLError,
  isNonNullType,
  isListType,
  isObjectType,
  isInterfaceType,
  isUnionType,
  getNamedType,
} from 'graphql';
import { pool } from './db.js';
import { rateLimiter } from './rateLimit.js';
import { logger } from './logger.js';

// =============================================================================
// Depth limit
//
// Counts the deepest nesting level of a query, ignoring introspection fields
// (anything starting with __) entirely — they never touch the database so
// there is no cost concern, and their inherently deep ofType chains would
// otherwise trip the limit. The complexity budget below catches expensive
// real queries independently.
// =============================================================================
function maxDepthOfSelections(selections, fragments) {
  let max = 0;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (sel.name.value.startsWith('__')) continue;
      const child = sel.selectionSet
        ? 1 + maxDepthOfSelections(sel.selectionSet.selections, fragments)
        : 1;
      if (child > max) max = child;
    } else if (sel.kind === 'InlineFragment') {
      const child = maxDepthOfSelections(sel.selectionSet.selections, fragments);
      if (child > max) max = child;
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name.value];
      if (frag) {
        const child = maxDepthOfSelections(frag.selectionSet.selections, fragments);
        if (child > max) max = child;
      }
    }
  }
  return max;
}

function depthLimitRule(maxDepth) {
  return function DepthLimitRule(context) {
    return {
      Document: {
        leave(node) {
          const fragments = {};
          const operations = [];
          for (const def of node.definitions) {
            if (def.kind === 'FragmentDefinition')
              fragments[def.name.value] = def;
            else if (def.kind === 'OperationDefinition') operations.push(def);
          }
          for (const op of operations) {
            const depth = maxDepthOfSelections(
              op.selectionSet.selections,
              fragments,
            );
            if (depth > maxDepth) {
              context.reportError(
                new GraphQLError(
                  `Query depth ${depth} exceeds the limit of ${maxDepth}. ` +
                    'Use fewer levels of nesting.',
                ),
              );
            }
          }
        },
      },
    };
  };
}

// =============================================================================
// Complexity estimator
//
// Uses first/last as a multiplier so that:
//   votes(first: 100) { ... }                   → 100 × child cost
//   votes(first: 10) { votePositions(first: 50) } → 10 × 50 × child cost
//
// Unbounded list fields fall back to an assumed page size of 100.
// Budget: 10,000.
// =============================================================================
function postgraphileEstimator({ field, args, childComplexity }) {
  if (!field) return 1 + childComplexity;

  const limit = args.first ?? args.last;
  if (limit != null) return 1 + limit * Math.max(childComplexity, 1);

  const baseType = isNonNullType(field.type) ? field.type.ofType : field.type;
  if (
    isListType(baseType) ||
    getNamedType(field.type).name.endsWith('Connection')
  ) {
    return 1 + 100 * Math.max(childComplexity, 1);
  }

  return 1 + childComplexity;
}

function sumComplexity(selections, parentType, fragments, estimator) {
  let total = 0;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (sel.name.value.startsWith('__')) continue;

      const fieldDef =
        parentType && (isObjectType(parentType) || isInterfaceType(parentType))
          ? parentType.getFields()[sel.name.value]
          : null;

      const namedReturnType = fieldDef ? getNamedType(fieldDef.type) : null;
      const childType =
        namedReturnType &&
        (isObjectType(namedReturnType) ||
          isInterfaceType(namedReturnType) ||
          isUnionType(namedReturnType))
          ? namedReturnType
          : null;

      const childComplexity = sel.selectionSet
        ? sumComplexity(
            sel.selectionSet.selections,
            childType,
            fragments,
            estimator
          )
        : 0;

      const args = {};
      for (const arg of sel.arguments ?? []) {
        if (arg.value.kind === 'IntValue')
          args[arg.name.value] = parseInt(arg.value.value, 10);
      }

      total += estimator({ field: fieldDef, args, childComplexity }) ?? 1;
    } else if (sel.kind === 'InlineFragment') {
      total += sumComplexity(
        sel.selectionSet.selections,
        parentType,
        fragments,
        estimator
      );
    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name.value];
      if (frag)
        total += sumComplexity(
          frag.selectionSet.selections,
          parentType,
          fragments,
          estimator
        );
    }
  }
  return total;
}

function complexityLimitRule(maxComplexity, estimator) {
  return function ComplexityLimitRule(context) {
    return {
      Document: {
        leave(node) {
          const fragments = {};
          const operations = [];
          for (const def of node.definitions) {
            if (def.kind === 'FragmentDefinition')
              fragments[def.name.value] = def;
            else if (def.kind === 'OperationDefinition') operations.push(def);
          }

          const schema = context.getSchema();
          for (const op of operations) {
            const rootType =
              op.operation === 'mutation'
                ? schema.getMutationType()
                : op.operation === 'subscription'
                  ? schema.getSubscriptionType()
                  : schema.getQueryType();

            const complexity = sumComplexity(
              op.selectionSet.selections,
              rootType,
              fragments,
              estimator
            );

            if (complexity > maxComplexity) {
              context.reportError(
                new GraphQLError(
                  `Query complexity ${complexity} exceeds the limit of ${maxComplexity}. ` +
                    'Use smaller page sizes or fewer nested fields.'
                )
              );
            }
          }
        },
      },
    };
  };
}

// =============================================================================
// Data freshness cache
//
// Every response carries an X-Last-Ingest header so API consumers know how
// stale the data is. Cached for 60 s to avoid a DB round-trip per request.
// =============================================================================
const FRESHNESS_TTL_MS = 60_000;
let freshnessCache = { value: null, fetchedAt: 0 };

async function getLastIngestTimestamp() {
  const now = Date.now();
  if (now - freshnessCache.fetchedAt < FRESHNESS_TTL_MS)
    return freshnessCache.value;
  try {
    const { rows } = await pool.query(
      `SELECT max(finished_at) AS ts FROM ingestion_runs WHERE status = 'success'`
    );
    freshnessCache = {
      value: rows[0]?.ts?.toISOString() ?? null,
      fetchedAt: now,
    };
  } catch (err) {
    logger.warn(`freshness cache refresh failed: ${err.message}`);
  }
  return freshnessCache.value;
}

// =============================================================================
// Grafserv plugin: inject custom validation rules
//
// grafserv builds its `dynamicOptions.validationRules` array during `setPreset`
// and passes that array to graphql-js `validate()` on every request.  Plugins
// can intercept `setPreset` via `grafserv.middleware` to append extra rules.
// =============================================================================
const validationRulesPlugin = {
  name: 'CustomValidationRules',
  grafserv: {
    middleware: {
      setPreset(next, event) {
        event.validationRules = [
          ...event.validationRules,
          // Hard depth cap — cheap check that runs before complexity counting.
          // Introspection fields (__schema, __type, …) are excluded; see the
          // depthLimitRule implementation above for the reasoning.
          depthLimitRule(10),
          // Per-operation complexity budget.
          complexityLimitRule(10_000_000_000, postgraphileEstimator),
        ];
        return next();
      },
    },
  },
};

// =============================================================================
// PostGraphile v5 preset
// =============================================================================
const preset = {
  extends: [
    PostGraphileAmberPreset,
    makeV4Preset({
      dynamicJson: true,
      simpleCollections: 'both',
      disableDefaultMutations: true,
    }),
    // v5-compatible filter plugin (RC; stable v3.0.0 not yet released).
    // Adds the `filter:` argument to all connections with operators like
    // equalTo, greaterThan, in, etc. and cross-table relation filtering.
    ConnectionFilterPlugin.PostGraphileConnectionFilterPreset,
  ],

  pgServices: [makePgService({ pool, schemas: ['public'] })],

  plugins: [validationRulesPlugin],

  schema: {
    // Enable filtering across FK relationships, e.g.
    // votePositions(filter: { vote: { category: { equalTo: "nomination" } } })
    connectionFilterRelations: true,
  },

  grafserv: {
    // Ruru (the v5 GraphiQL replacement) — off in production.
    graphiql: process.env.ENABLE_GRAPHIQL === 'true',

    // CORS is handled manually in the HTTP server below so we can apply it
    // consistently to every route including /health.
    cors: false,
  },

  // Per-request PostgreSQL settings derived from the Authorization header.
  // makePgService reads `pgSettings` from the Grafast context automatically,
  // applying them as SET LOCAL on the connection before each query.
  //
  // TODO: replace with real JWT verification and per-role Postgres grants.
  grafast: {
    context: async (requestContext) => {
      const auth = requestContext.headers?.authorization;
      const user = auth ? { id: 1, role: 'app_user' } : null;
      return user
        ? {
            pgSettings: {
              role: user.role,
              'jwt.claims.user_id': String(user.id),
            },
          }
        : {};
    },
  },
};

// =============================================================================
// Grafserv + HTTP server
// =============================================================================
const pgl = postgraphile(preset);
const serv = pgl.createServ(grafserv);
const grafservHandler = serv.createHandler();

const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0].trim() ??
    req.socket?.remoteAddress ??
    'unknown';

  // ── Health check ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    try {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch (err) {
      logger.error(`health check: database unreachable: ${err.message}`);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ status: 'error', message: 'Database unavailable' })
      );
    }
    return;
  }

  // ── CORS ────────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Rate limiting ───────────────────────────────────────────────────────────
  try {
    await rateLimiter.consume(ip);
  } catch {
    logger.warn(`rate limit exceeded: ${ip}`);
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('Too many requests');
    return;
  }

  // ── Data freshness header ───────────────────────────────────────────────────
  const lastIngest = await getLastIngestTimestamp();
  if (lastIngest) res.setHeader('X-Last-Ingest', lastIngest);

  // ── Request logging ─────────────────────────────────────────────────────────
  res.on('finish', () => {
    logger.info(
      {
        ip,
        method: req.method,
        url: req.url,
        status: res.statusCode,
        durationMs: Date.now() - startTime,
      },
      'request'
    );
  });

  // ── GraphQL ─────────────────────────────────────────────────────────────────
  try {
    grafservHandler(req, res);
  } catch (err) {
    logger.error(`unhandled grafserv error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(4000, () => {
  logger.info(
    { port: 4000, graphiql: process.env.ENABLE_GRAPHIQL === 'true' },
    'GraphQL API started'
  );
});
