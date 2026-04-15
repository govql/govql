import { createPostGraphileSchema } from 'postgraphile';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function buildSchema() {
  return createPostGraphileSchema(pool, 'public', {
    dynamicJson: true,
    simpleCollections: 'both',
    graphiql: false,
  });
}
