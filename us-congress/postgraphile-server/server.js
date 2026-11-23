import { postgraphile } from 'postgraphile';
import { pool } from './src/db.js';
import { rateLimiter } from './src/rateLimit.js';
import { logger } from './logger.js';
import { getLastIngestTimestamp } from './src/freshnessCache.js';
import { preset } from './src/pglPreset.js';
import { grafserv } from 'grafserv/fastify/v4';
import Fastify from 'fastify';
import cors from '@fastify/cors';

const pgl = postgraphile(preset);
const serv = pgl.createServ(grafserv);

const fastify = Fastify({
  loggerInstance: logger,
});

/**
 * Handles uncaught errors, logging them and sending a 500 response to the client
 * if there is not a 4xx or 5xx status code set.
 */
fastify.setErrorHandler((error, request, reply) => {
  const grafservStatus =
    reply.statusCode >= 400
      ? reply.statusCode
      : (error.statusCode ?? error.status ?? 500);
  const statusCode =
    Number.isInteger(grafservStatus) && grafservStatus >= 400
      ? grafservStatus
      : 500;

  fastify.log.error(
    {
      err: error,
      method: request.method,
      url: request.url,
      statusCode,
    },
    'unhandled request error'
  );

  if (reply.sent || reply.raw.headersSent) return;

  return reply.status(statusCode).send({
    error:
      statusCode >= 500
        ? 'Internal server error'
        : error.message || 'Request failed',
  });
});

await fastify.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// Attach mutable properties to request objects that persist throughout the request lifecycle
fastify.decorateRequest('ipAddress', '');
fastify.decorateRequest('startTime', 0);

/**
 * Executes immediately upon request arrival, before any parsing or validation
 */
fastify.addHook('onRequest', async (request, reply) => {
  request.startTime = Date.now();
  request.ipAddress =
    request.headers['x-forwarded-for']?.split(',')[0].trim() ??
    request.socket?.remoteAddress ??
    'unknown';

  try {
    await rateLimiter.consume(request.ipAddress);
  } catch {
    fastify.log.warn(`rate limit exceeded: ${request.ipAddress}`);
    reply.statusCode = 429;
    reply.header('Content-Type', 'text/plain');
    reply.send('Too many requests');
    return reply;
  }

  //Freshness Cache
  const lastIngest = await getLastIngestTimestamp(logger, pool);
  if (lastIngest) reply.header('X-Last-Ingest', lastIngest);
});

/**
 * Executed after a response has been sent to the client
 */
fastify.addHook('onResponse', async (request, reply) => {
  fastify.log.info(
    {
      ip: request.ipAddress,
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      durationMs: Date.now() - request.startTime,
    },
    'request'
  );
});

/**
 * Encapsulates routes. PostGraphile handles the GraphQL routes separately.
 * @param {FastifyInstance} fastify  Encapsulated Fastify Instance
 * @param {Object} options plugin options, refer to https://fastify.dev/docs/latest/Reference/Plugins/#plugin-options
 */
async function routes(fastify, options) {
  fastify.get('/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      return reply.status(200).send({ status: 'ok' });
    } catch (err) {
      fastify.log.error(`health check: database unreachable: ${err.message}`);
      return reply.status(503).send({
        status: 'error',
        message: 'Database unavailable',
      });
    }
  });
}

fastify.register(routes);

// Add PostGraphile handling of GraphQL requests to Fastify server
await serv.addTo(fastify);

fastify.listen({ port: 4000, host: '0.0.0.0' }, function (err, address) {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(
    { port: 4000, graphiql: process.env.ENABLE_GRAPHIQL === 'true' },
    'GraphQL API started'
  );
});
