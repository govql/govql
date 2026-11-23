import Redis from 'ioredis';
import { RateLimiterRedis, RateLimiterMemory } from 'rate-limiter-flexible';

const redis = new Redis(process.env.REDIS_URL);

// In-memory fallback used automatically if Redis is unavailable. Limits are
// per-instance rather than global, but it keeps the API healthy during a Redis
// blip rather than rejecting every request.
const insuranceLimiter = new RateLimiterMemory({
  points: 100,
  duration: 60,
});

export const rateLimiter = new RateLimiterRedis({
  storeClient: redis,
  keyPrefix: 'rate_limit',
  points: 100,
  duration: 60,
  insuranceLimiter,
});
