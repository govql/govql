import { validationRulesPlugin } from './rules.js'
import { makeV4Preset } from 'postgraphile/presets/v4';
import { makePgService } from 'postgraphile/adaptors/pg';
import { PostGraphileAmberPreset } from 'postgraphile/presets/amber';
import ConnectionFilterPlugin from 'postgraphile-plugin-connection-filter';
import { pool } from './db.js';
// =============================================================================
// PostGraphile v5 preset
// =============================================================================
export const preset = {
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

    // CORS is handled in the HTTP server
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