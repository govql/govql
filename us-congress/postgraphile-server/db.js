import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — exiting');
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Max connections kept open. PostGraphile's planner can hold a connection for
  // the full duration of a query, so keep headroom for concurrent requests.
  max: 10,
  // Release idle connections after 30 s to avoid accumulating stale sockets.
  idleTimeoutMillis: 30_000,
  // Fail fast if the pool is exhausted or Postgres is unreachable.
  connectionTimeoutMillis: 3_000,
});
