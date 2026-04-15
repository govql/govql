import { createPostGraphileSchema } from 'postgraphile';
import ConnectionFilterPlugin from 'postgraphile-plugin-connection-filter';
import { pool } from './db.js';

export async function buildSchema() {
  return createPostGraphileSchema(pool, 'public', {
    dynamicJson: true,
    simpleCollections: 'both',
    disableDefaultMutations: true,
    appendPlugins: [ConnectionFilterPlugin],
    graphileBuildOptions: {
      connectionFilterRelations: true,
    },
  });
}
