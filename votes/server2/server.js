import http from 'http';
import { createYoga } from 'graphql-yoga';
import { buildSchema } from './schema.js';
import { rateLimiter } from './rateLimit.js';

import { useDepthLimit } from '@graphile/depth-limit';
import { createComplexityLimitRule } from 'graphql-query-complexity';

const schema = await buildSchema();

const yoga = createYoga({
  schema,

  plugins: [
    useDepthLimit({ maxDepth: 10 }),

    {
      async onRequest({ request }) {
        const ip = request.headers.get('x-forwarded-for') ?? 'anonymous';

        try {
          await rateLimiter.consume(ip);
        } catch {
          throw new Error('Too many requests');
        }
      },
    },
  ],

  validationRules: [createComplexityLimitRule(1000)],

  context: async ({ request }) => {
    const auth = request.headers.get('authorization');

    // Replace with real JWT verification
    const user = auth ? { id: 1, role: 'app_user' } : null;

    return {
      pgSettings: {
        role: user?.role ?? 'anonymous',
        'jwt.claims.user_id': user?.id,
      },
    };
  },
});

const server = http.createServer(yoga);

server.listen(4000, () => {
  console.log('GraphQL API running on port 4000');
});
