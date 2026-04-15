import { createPostGraphileSchema } from 'postgraphile';
import { pool } from './db.js';

export async function buildSchema() {
  return createPostGraphileSchema(pool, 'public', {
    dynamicJson: true,
    simpleCollections: 'both',
  });
}
