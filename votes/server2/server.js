import http from 'http';
import { createYoga } from 'graphql-yoga';
import {
  GraphQLError,
  execute as graphqlExecute,
  isNonNullType, isListType, isObjectType, isInterfaceType, isUnionType,
  getNamedType,
} from 'graphql';
import { useDepthLimit } from '@graphile/depth-limit';
import { withPostGraphileContext } from 'postgraphile';
import { buildSchema } from './schema.js';
import { pool } from './db.js';
import { rateLimiter } from './rateLimit.js';
import { logger } from './logger.js';

// =============================================================================
// Complexity estimator
//
// The default estimator assigns a flat 1 point per field, which means page
// size and nesting depth don't influence the score at all. This estimator
// uses first/last as a multiplier so that:
//
//   votes(first: 100) { ... }                   → 100 × child cost
//   votes(first: 10) { votePositions(first: 50) } → 10 × 50 × child cost
//
// Unbounded list fields (simple collections without first/last) fall back to
// an assumed page size of 100 to discourage accidental bulk fetches.
//
// Budget: 10,000 — supports rich single-level queries and moderately nested
// ones (e.g. 20 votes × 50 positions = 1,000 units) while blocking bulk
// cross-product queries.
// =============================================================================
function postgraphileEstimator({ field, args, childComplexity }) {
  if (!field) return 1 + childComplexity;

  const limit = args.first ?? args.last;

  if (limit != null) {
    // Paginated list: complexity scales with the requested page size.
    return 1 + limit * Math.max(childComplexity, 1);
  }

  // Unwrap NonNull to inspect the actual return type.
  const baseType = isNonNullType(field.type) ? field.type.ofType : field.type;
  if (isListType(baseType) || getNamedType(field.type).name.endsWith('Connection')) {
    // Unbounded list (simple-collection without first/last) — assume 100 rows.
    return 1 + 100 * Math.max(childComplexity, 1);
  }

  // Single object or scalar — cheap.
  return 1 + childComplexity;
}

// =============================================================================
// Complexity validation rule (inline — avoids graphql-query-complexity's
// unreliable CJS/ESM interop)
//
// Walks the full operation at validation time, accumulating cost using the
// estimator above. Fragment definitions are collected in a first pass so they
// are available regardless of document order.
// =============================================================================
function sumComplexity(selections, parentType, fragments, estimator) {
  let total = 0;
  for (const sel of selections) {
    if (sel.kind === 'Field') {
      if (sel.name.value.startsWith('__')) continue; // skip introspection

      const fieldDef =
        parentType && (isObjectType(parentType) || isInterfaceType(parentType))
          ? parentType.getFields()[sel.name.value]
          : null;

      const namedReturnType = fieldDef ? getNamedType(fieldDef.type) : null;
      const childType =
        namedReturnType &&
        (isObjectType(namedReturnType) || isInterfaceType(namedReturnType) || isUnionType(namedReturnType))
          ? namedReturnType
          : null;

      const childComplexity = sel.selectionSet
        ? sumComplexity(sel.selectionSet.selections, childType, fragments, estimator)
        : 0;

      // Collect numeric arguments (first, last, etc.) for the estimator.
      const args = {};
      for (const arg of sel.arguments ?? []) {
        if (arg.value.kind === 'IntValue') {
          args[arg.name.value] = parseInt(arg.value.value, 10);
        }
      }

      total += estimator({ field: fieldDef, args, childComplexity }) ?? 1;

    } else if (sel.kind === 'InlineFragment') {
      total += sumComplexity(sel.selectionSet.selections, parentType, fragments, estimator);

    } else if (sel.kind === 'FragmentSpread') {
      const frag = fragments[sel.name.value];
      if (frag) total += sumComplexity(frag.selectionSet.selections, parentType, fragments, estimator);
    }
  }
  return total;
}

function complexityLimitRule(maxComplexity, estimator) {
  return function ComplexityLimitRule(context) {
    return {
      // Use the Document leave hook so all FragmentDefinitions are collected
      // before we walk any OperationDefinitions.
      Document: {
        leave(node) {
          const fragments = {};
          const operations = [];

          for (const def of node.definitions) {
            if (def.kind === 'FragmentDefinition') fragments[def.name.value] = def;
            else if (def.kind === 'OperationDefinition') operations.push(def);
          }

          const schema = context.getSchema();

          for (const op of operations) {
            const rootType =
              op.operation === 'mutation'     ? schema.getMutationType()     :
              op.operation === 'subscription' ? schema.getSubscriptionType() :
                                               schema.getQueryType();

            const complexity = sumComplexity(
              op.selectionSet.selections, rootType, fragments, estimator,
            );

            if (complexity > maxComplexity) {
              context.reportError(new GraphQLError(
                `Query complexity ${complexity} exceeds the limit of ${maxComplexity}. ` +
                'Use smaller page sizes or fewer nested fields.',
              ));
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
// stale the data is. We cache the result for 60 s to avoid a DB round-trip
// on every request.
// =============================================================================
const FRESHNESS_TTL_MS = 60_000;
let freshnessCache = { value: null, fetchedAt: 0 };

async function getLastIngestTimestamp() {
  const now = Date.now();
  if (now - freshnessCache.fetchedAt < FRESHNESS_TTL_MS) {
    return freshnessCache.value;
  }
  try {
    const { rows } = await pool.query(
      `SELECT max(finished_at) AS ts
       FROM ingestion_runs
       WHERE status = 'success'`,
    );
    freshnessCache = {
      value: rows[0]?.ts?.toISOString() ?? null,
      fetchedAt: now,
    };
  } catch (err) {
    // Non-critical — serve the stale cached value rather than blocking.
    logger.warn({ err: err.message }, 'freshness cache refresh failed');
  }
  return freshnessCache.value;
}

// =============================================================================
// Yoga
// =============================================================================
const schema = await buildSchema();

const yoga = createYoga({
  schema,

  // Public read-only API — allow all origins.
  cors: { origin: '*', methods: ['GET', 'POST'] },

  // GraphiQL is off in production. Set ENABLE_GRAPHIQL=true for local dev.
  graphiql: process.env.ENABLE_GRAPHIQL === 'true',

  plugins: [
    // Hard depth limit — prevents arbitrarily deep queries before they reach
    // the complexity budget check.
    useDepthLimit({ maxDepth: 10 }),

    // Per-IP rate limiting.
    {
      async onRequest({ request }) {
        const ip =
          request.headers.get('x-forwarded-for')?.split(',')[0].trim() ??
          'anonymous';
        try {
          await rateLimiter.consume(ip);
        } catch {
          logger.warn({ ip }, 'rate limit exceeded');
          throw new Response('Too many requests', { status: 429 });
        }
      },
    },

    // Log the GraphQL operation name at execution time.
    {
      onExecute({ args }) {
        const operationName =
          args.operationName ??
          args.document?.definitions?.find(
            d => d.kind === 'OperationDefinition',
          )?.name?.value ??
          'anonymous';
        logger.debug({ operationName }, 'graphql execute');
      },
    },

    // withPostGraphileContext checks out a pg client from the pool and injects
    // it into the GraphQL context as `pgClient`, which PostGraphile's resolvers
    // require. Yoga v5 ignores a top-level `execute` option, so we hook in via
    // the Envelop onExecute / setExecuteFn API instead.
    {
      onExecute({ args, setExecuteFn }) {
        const { pgSettings } = args.contextValue ?? {};
        setExecuteFn((executeArgs) =>
          withPostGraphileContext(
            { pgPool: pool, pgSettings },
            (pgContext) => graphqlExecute({
              ...executeArgs,
              contextValue: { ...executeArgs.contextValue, ...pgContext },
            }),
          ),
        );
      },
    },
  ],

  validationRules: [
    complexityLimitRule(10_000, postgraphileEstimator),
  ],

  context: async ({ request }) => {
    const auth = request.headers.get('authorization');
    // TODO: replace with real JWT verification and per-role Postgres grants.
    // pgSettings is picked up by the execute wrapper above and forwarded to
    // withPostGraphileContext, which applies them as SET LOCAL on the connection.
    const user = auth ? { id: 1, role: 'app_user' } : null;
    return user
      ? { pgSettings: { role: user.role, 'jwt.claims.user_id': String(user.id) } }
      : {};
  },
});

// =============================================================================
// HTTP server
// =============================================================================
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();

  // ── Health check ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/health') {
    try {
      await pool.query('SELECT 1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch (err) {
      logger.error({ err: err.message }, 'health check: database unreachable');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Database unavailable' }));
    }
    return;
  }

  // ── Data freshness header ───────────────────────────────────────────────────
  const lastIngest = await getLastIngestTimestamp();
  if (lastIngest) res.setHeader('X-Last-Ingest', lastIngest);

  // ── Request logging ─────────────────────────────────────────────────────────
  res.on('finish', () => {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ??
      req.socket?.remoteAddress ??
      'unknown';
    logger.info({
      ip,
      method: req.method,
      url: req.url,
      status: res.statusCode,
      durationMs: Date.now() - startTime,
    }, 'request');
  });

  // ── GraphQL ─────────────────────────────────────────────────────────────────
  yoga.handle(req, res);
});

server.listen(4000, () => {
  logger.info({ port: 4000, graphiql: process.env.ENABLE_GRAPHIQL === 'true' }, 'GraphQL API started');
});
