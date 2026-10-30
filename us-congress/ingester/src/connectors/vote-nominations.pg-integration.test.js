import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';

import { load } from './congress-votes.js';
import { readCursor } from '../cursor-state.js';

const execFileAsync = promisify(execFile);
const url = process.env.INTEGRATION_DATABASE_URL;
const skip = url
  ? false
  : 'INTEGRATION_DATABASE_URL not set — run via npm run test:integration';

const log = { info() {}, warn() {}, error() {} };
const sourceName = 'congress-votes';
const memberId = 'N009901';
const lisId = 'S9901';
const cursor = '2026-10-01T12:00:00.123456Z';

const examples = [
  {
    vote_id: 's9901-119.2026',
    congress: 119,
    session: 2026,
    number: 9901,
    category: 'cloture',
    nomination: { number: 'PN1129-1', title: 'Example nomination' },
  },
  {
    vote_id: 's9902-119.2026',
    congress: 119,
    session: 2026,
    number: 9902,
    category: 'nomination',
    nomination: { number: 'PN1129-1', title: 'Example nomination' },
  },
  {
    vote_id: 's9901-118.2024',
    congress: 118,
    session: 2024,
    number: 9901,
    category: 'nomination',
    nomination: { number: 'PN1129-1', title: 'Earlier nomination' },
  },
  {
    vote_id: 's9903-119.2026',
    congress: 119,
    session: 2026,
    number: 9903,
    category: 'passage',
  },
];

const voteIds = examples.map((example) => example.vote_id);

function buildDataDir() {
  const dataDir = mkdtempSync(join(tmpdir(), 'vote-nominations-pg-'));

  for (const example of examples) {
    const directory = join(
      dataDir,
      'data',
      String(example.congress),
      'votes',
      String(example.session),
      `s${example.number}`
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'data.json'),
      JSON.stringify({
        ...example,
        chamber: 's',
        updated_at: '2026-09-01T12:00:00Z',
        votes: {
          Yea: [{ id: lisId, party: 'I', state: 'VT' }],
        },
      })
    );
  }

  return dataDir;
}

async function snapshot(client) {
  const { rows: votes } = await client.query(
    `SELECT vote_id, congress, nomination_number, nomination_title,
            source_updated_at::text
     FROM votes
     WHERE vote_id = ANY($1::text[])
     ORDER BY vote_id`,
    [voteIds]
  );
  const { rows: positions } = await client.query(
    `SELECT vote_id, bioguide_id, position, party, state
     FROM vote_positions
     WHERE vote_id = ANY($1::text[])
     ORDER BY vote_id, bioguide_id`,
    [voteIds]
  );
  return { votes, positions };
}

async function runEntrypoint(dataDir, force) {
  return execFileAsync(
    process.execPath,
    [
      fileURLToPath(new URL('../ingest-votes.js', import.meta.url)),
      ...(force ? ['--force'] : []),
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: url,
        CONGRESS_DATA_DIR: dataDir,
        HEALTHCHECK_VOTES_INGEST_URL: '',
      },
      timeout: 30_000,
    }
  );
}

test(
  'nomination inserts and forced backfills preserve references without duplicates',
  { skip },
  async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const client = await pool.connect();
    const dataDir = buildDataDir();

    try {
      await client.query(
        `DELETE FROM vote_positions WHERE vote_id = ANY($1::text[])`,
        [voteIds]
      );
      await client.query(`DELETE FROM votes WHERE vote_id = ANY($1::text[])`, [
        voteIds,
      ]);
      await client.query(
        `INSERT INTO legislators (bioguide_id, lis_id, first_name, last_name)
       VALUES ($1, $2, 'Example', 'Senator')
       ON CONFLICT (bioguide_id) DO NOTHING`,
        [memberId, lisId]
      );

      // Exercise inserts through the real connector and migrated schema.
      assert.deepEqual(await load({ client, dataDir, log }), {
        ingested: 4,
        skipped: 0,
        failed: 0,
      });

      const expected = await snapshot(client);
      assert.equal(expected.votes.length, 4);
      assert.equal(expected.positions.length, 4);

      for (const example of examples) {
        const vote = expected.votes.find(
          (row) => row.vote_id === example.vote_id
        );
        assert.equal(vote.congress, example.congress);
        assert.equal(
          vote.nomination_number,
          example.nomination?.number ?? null
        );
        assert.equal(vote.nomination_title, example.nomination?.title ?? null);
      }

      // Simulate existing records created before these columns were populated.
      // The files and their source timestamps remain unchanged.
      await client.query(
        `UPDATE votes
       SET nomination_number = NULL, nomination_title = NULL
       WHERE vote_id = ANY($1::text[])`,
        [voteIds]
      );

      // Make the entrypoint's normal readiness gate return false.
      await client.query(`DELETE FROM source_state WHERE source_name = $1`, [
        sourceName,
      ]);
      await client.query(
        `INSERT INTO source_state (source_name, stage, cursor)
       VALUES ($1, 'fetch', $2), ($1, 'load', $2)`,
        [sourceName, cursor]
      );

      const beforeBackfill = await snapshot(client);
      const normal = await runEntrypoint(dataDir, false);
      assert.match(normal.stdout, /Votes ingestion skipped/);
      assert.deepEqual(await snapshot(client), beforeBackfill);

      // The actual CLI must bypass both readiness and timestamp checks.
      for (let attempt = 0; attempt < 2; attempt++) {
        const forced = await runEntrypoint(dataDir, true);
        assert.match(
          forced.stdout,
          /ingested: 4, skipped \(up to date\): 0, failed: 0/
        );
        assert.deepEqual(await snapshot(client), expected);
        assert.equal(await readCursor(client, sourceName, 'fetch'), cursor);
        assert.equal(await readCursor(client, sourceName, 'load'), cursor);
      }
    } finally {
      try {
        await client.query(
          `DELETE FROM vote_positions WHERE vote_id = ANY($1::text[])`,
          [voteIds]
        );
        await client.query(
          `DELETE FROM votes WHERE vote_id = ANY($1::text[])`,
          [voteIds]
        );
        await client.query(`DELETE FROM legislators WHERE bioguide_id = $1`, [
          memberId,
        ]);
        await client.query(`DELETE FROM source_state WHERE source_name = $1`, [
          sourceName,
        ]);
      } finally {
        client.release();
        await pool.end();
        rmSync(dataDir, { recursive: true, force: true });
      }
    }
  }
);
