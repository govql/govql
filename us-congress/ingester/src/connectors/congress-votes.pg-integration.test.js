// Container-backed integration test for the votes connector: the same fixture
// tree must produce the same votes / vote_positions / bills rows on every run,
// with the second run skipping files that are already current (needsIngestion)
// — against a real database migrated with the actual Flyway migrations. Also
// exercises the two JOIN paths the stub suite can only assert as SQL text:
// house positions resolve member ids as bioguide ids, senate positions as
// lis_ids, and unknown ids (the VP) are dropped, not fatal.
//
// The pg-integration suites share one database and run concurrently, so this
// file only touches rows it creates (its member ids are disjoint from the
// legislators suite's fixture) — no wholesale table deletes.
//
// Run via `npm run test:integration`; under plain `npm test` the suite skips
// itself (INTEGRATION_DATABASE_URL unset).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { load } from './congress-votes.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const skip = url ? false : 'INTEGRATION_DATABASE_URL not set — run via npm run test:integration';

function fixturePath(name) {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

const VOTE_IDS = ['h5-119.2025', 's17-119.2025'];

// The members the fixtures reference: house files carry bioguide ids, senate
// files carry lis_ids. 'VP' matches neither and must be dropped by the JOIN.
const SEED_LEGISLATORS = [
  ['H001001', null, 'Hana', 'Adams'],
  ['H001002', null, 'Hugh', 'Baker'],
  ['H001003', null, 'Hilda', 'Cruz'],
  ['H001004', null, 'Hector', 'Diaz'],
  ['V000901', 'S901', 'Mitch', 'McConnell'],
  ['V000902', 'S902', 'Chuck', 'Schumer'],
  ['V000903', 'S903', 'Bernie', 'Sanders'],
];
const SEED_IDS = SEED_LEGISLATORS.map(([bioguide]) => bioguide);

function buildDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'votes-pg-'));
  mkdirSync(join(dir, 'data/119/votes/2025/h5'), { recursive: true });
  mkdirSync(join(dir, 'data/119/votes/2025/s17'), { recursive: true });
  copyFileSync(fixturePath('vote-house.json'), join(dir, 'data/119/votes/2025/h5/data.json'));
  copyFileSync(fixturePath('vote-senate.json'), join(dir, 'data/119/votes/2025/s17/data.json'));
  return dir;
}

async function snapshot(client) {
  const { rows: votes } = await client.query(
    `SELECT vote_id, chamber, congress, session, number, category, result, related_bill_id,
            to_char(source_updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS source_updated_at
     FROM votes WHERE vote_id = ANY($1::text[]) ORDER BY vote_id`,
    [VOTE_IDS],
  );
  const { rows: positions } = await client.query(
    `SELECT vote_id, bioguide_id, position, party, state
     FROM vote_positions WHERE vote_id = ANY($1::text[]) ORDER BY vote_id, bioguide_id`,
    [VOTE_IDS],
  );
  const { rows: bills } = await client.query(
    `SELECT bill_id, bill_type, bill_number, congress, official_title FROM bills WHERE bill_id = 'hr1-119'`,
  );
  return { votes, positions, bills };
}

test('identical fixtures produce identical votes, positions, and bill-stub rows; the rerun skips current files', { skip }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM vote_positions WHERE vote_id = ANY($1::text[])`, [VOTE_IDS]);
    await client.query(`DELETE FROM votes WHERE vote_id = ANY($1::text[])`, [VOTE_IDS]);
    await client.query(`DELETE FROM bills WHERE bill_id = 'hr1-119'`);
    await client.query(`DELETE FROM legislators WHERE bioguide_id = ANY($1::text[])`, [SEED_IDS]);
    for (const [bioguide, lis, first, last] of SEED_LEGISLATORS) {
      await client.query(
        `INSERT INTO legislators (bioguide_id, lis_id, first_name, last_name) VALUES ($1, $2, $3, $4)`,
        [bioguide, lis, first, last],
      );
    }

    const dataDir = buildDataDir();
    const warnings = [];
    const log = { ...silentLog, warn: (m) => warnings.push(m) };

    const first = await load({ client, dataDir, force: false, log });
    assert.deepEqual(first, { ingested: 2, skipped: 0, failed: 0 });

    const afterFirst = await snapshot(client);
    assert.deepEqual(afterFirst.votes.map((v) => [v.vote_id, v.chamber, v.category, v.related_bill_id]), [
      ['h5-119.2025', 'h', 'passage', 'hr1-119'],
      ['s17-119.2025', 's', 'cloture', null],
    ]);
    // House positions resolved by bioguide_id; senate by lis_id → bioguide_id;
    // the VP row was dropped by the JOIN and logged, not fatal.
    assert.deepEqual(afterFirst.positions, [
      { vote_id: 'h5-119.2025', bioguide_id: 'H001001', position: 'Aye', party: 'R', state: 'TX' },
      { vote_id: 'h5-119.2025', bioguide_id: 'H001002', position: 'Aye', party: 'R', state: 'FL' },
      { vote_id: 'h5-119.2025', bioguide_id: 'H001003', position: 'No', party: 'D', state: 'CA' },
      { vote_id: 'h5-119.2025', bioguide_id: 'H001004', position: 'Not Voting', party: 'D', state: 'NY' },
      { vote_id: 's17-119.2025', bioguide_id: 'V000901', position: 'Yea', party: 'R', state: 'KY' },
      { vote_id: 's17-119.2025', bioguide_id: 'V000902', position: 'Yea', party: 'D', state: 'NY' },
      { vote_id: 's17-119.2025', bioguide_id: 'V000903', position: 'Nay', party: 'I', state: 'VT' },
    ]);
    assert.deepEqual(afterFirst.bills, [
      { bill_id: 'hr1-119', bill_type: 'hr', bill_number: 1, congress: 119, official_title: 'An Act to authorize appropriations' },
    ]);
    assert.equal(warnings.some((m) => /s17-119\.2025: 1 position\(s\) skipped — unknown lis_id: VP/.test(m)), true);

    // Run 2 over the same tree: both files are current → skipped, rows identical.
    const second = await load({ client, dataDir, force: false, log });
    assert.deepEqual(second, { ingested: 0, skipped: 2, failed: 0 });
    assert.deepEqual(await snapshot(client), afterFirst);

    // Run 3 with --force reprocesses and still lands identical rows.
    const third = await load({ client, dataDir, force: true, log });
    assert.deepEqual(third, { ingested: 2, skipped: 0, failed: 0 });
    assert.deepEqual(await snapshot(client), afterFirst);
  } finally {
    client.release();
    await pool.end();
  }
});
