// Container-backed integration test for the legislators connector: the same
// fixture YAML must produce the same legislators + legislator_terms rows on
// every run (idempotent upsert + per-legislator term replacement), against a
// real database migrated with the actual Flyway migrations.
//
// Run via `npm run test:integration`; under plain `npm test` the suite skips
// itself (INTEGRATION_DATABASE_URL unset).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { load } from './congress-legislators.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const skip = url ? false : 'INTEGRATION_DATABASE_URL not set — run via npm run test:integration';

const FIXTURE = fileURLToPath(new URL('./fixtures/legislators-current.yaml', import.meta.url));

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// The pg-integration suites share one database and run concurrently, so this
// file only touches its own fixture's rows (A000001/B000002 — disjoint from
// the votes suite's member ids) — no wholesale table deletes.
const FIXTURE_IDS = ['A000001', 'B000002'];

async function snapshot(client) {
  const { rows: legislators } = await client.query(
    `SELECT bioguide_id, lis_id, first_name, middle_name, last_name, nickname,
            official_full, to_char(birthday, 'YYYY-MM-DD') AS birthday, gender
     FROM legislators WHERE bioguide_id = ANY($1::text[]) ORDER BY bioguide_id`,
    [FIXTURE_IDS],
  );
  const { rows: terms } = await client.query(
    `SELECT bioguide_id, term_type, to_char(start_date, 'YYYY-MM-DD') AS start_date,
            to_char(end_date, 'YYYY-MM-DD') AS end_date, state, party, district,
            senate_class, state_rank
     FROM legislator_terms WHERE bioguide_id = ANY($1::text[]) ORDER BY bioguide_id, start_date`,
    [FIXTURE_IDS],
  );
  return { legislators, terms };
}

test('identical fixtures produce identical legislators and terms rows on every run', { skip }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM legislator_terms WHERE bioguide_id = ANY($1::text[])`, [FIXTURE_IDS]);
    await client.query(`DELETE FROM legislators WHERE bioguide_id = ANY($1::text[])`, [FIXTURE_IDS]);

    const first = await load({ client, files: [FIXTURE], log: silentLog });
    assert.deepEqual(first, { upserted: 2, failed: 0 });

    const afterFirst = await snapshot(client);
    assert.deepEqual(afterFirst.legislators, [
      {
        bioguide_id: 'A000001', lis_id: 'S307', first_name: 'Alexandra',
        middle_name: 'Jean', last_name: 'Adams', nickname: null,
        official_full: 'Alexandra J. Adams', birthday: '1962-02-20', gender: 'F',
      },
      {
        bioguide_id: 'B000002', lis_id: null, first_name: 'Ben',
        middle_name: null, last_name: 'Baker', nickname: 'Benny',
        official_full: null, birthday: null, gender: 'M',
      },
    ]);
    assert.equal(afterFirst.terms.length, 3);
    assert.deepEqual(afterFirst.terms[0], {
      bioguide_id: 'A000001', term_type: 'sen', start_date: '2019-01-03',
      end_date: '2025-01-03', state: 'KY', party: 'Republican', district: null,
      senate_class: 2, state_rank: 'senior',
    });

    // Run 2 over the same fixture: same rows, no term duplication.
    const second = await load({ client, files: [FIXTURE], log: silentLog });
    assert.deepEqual(second, { upserted: 2, failed: 0 });
    assert.deepEqual(await snapshot(client), afterFirst);
  } finally {
    client.release();
    await pool.end();
  }
});
