// Container-backed integration tests for the two guarantees the stub-client
// suite cannot observe, because they live in Postgres semantics:
//
//  1. The fan-out changed-check — `payload IS DISTINCT FROM $n::jsonb`
//     against JSON.stringify'd input. jsonb normalizes key order, so a
//     semantically identical but differently-ordered payload must read as
//     unchanged and must NOT re-fan-out (the resume guarantee).
//  2. The COALESCE enrichment — a populated bills column must survive a
//     payload that omits the field, and the no-op WHERE guard must leave
//     updated_at untouched when nothing changes.
//
// These run against a real database migrated with the actual Flyway
// migrations: `npm run test:integration` (starts a throwaway dockerized
// Postgres, migrates, runs this file, tears down). Under plain `npm test`
// the suite is skipped — INTEGRATION_DATABASE_URL is unset.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import {
  fetchPagesIntoRaw,
  loadStaleDetailRaws,
  loadStaleTitleRaws,
} from './congress-bills.js';

const url = process.env.INTEGRATION_DATABASE_URL;
const skip = url ? false : 'INTEGRATION_DATABASE_URL not set — run via npm run test:integration';

function loadFixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

const listFixture = loadFixture('bill-list-page.json');
const subFixtures = {
  '/v3/bill/119/hr/1234': loadFixture('bill-detail.json'),
  '/v3/bill/119/hr/1234/cosponsors': loadFixture('bill-cosponsors.json'),
  '/v3/bill/119/hr/1234/subjects': loadFixture('bill-subjects.json'),
  '/v3/bill/119/hr/1234/summaries': loadFixture('bill-summaries.json'),
  '/v3/bill/119/hr/1234/titles': loadFixture('bill-titles.json'),
};

function routedFetch(listPage) {
  const urls = [];
  const fetchImpl = (u, opts) => {
    urls.push({ url: u, opts });
    const { pathname } = new URL(u);
    const body = pathname === '/v3/bill/119' ? listPage() : subFixtures[pathname];
    if (!body) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { urls, fetchImpl };
}

test('changed-check on real Postgres: a re-listed bill with identical-but-reordered payload does not re-fan-out', { skip }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM raw_payloads WHERE source_name = 'congress-bills'`);
    await client.query(`DELETE FROM source_state WHERE source_name LIKE 'congress-bills%'`);

    const item = listFixture.bills[0]; // hr1234-119

    // Run 1: fresh bill → full fan-out (1 list request + 5 sub-endpoints).
    const run1 = routedFetch(() => ({ bills: [item], pagination: { count: 1 } }));
    const r1 = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', fetchImpl: run1.fetchImpl, fanout: {} });
    assert.equal(r1.upserted, 1);
    assert.equal(run1.urls.length, 6);
    const { rows: stored } = await client.query(
      `SELECT endpoint FROM raw_payloads WHERE source_name = 'congress-bills' AND natural_key = 'hr1234-119' ORDER BY endpoint`,
    );
    assert.deepEqual(stored.map((r) => r.endpoint), [
      'bill-cosponsors', 'bill-detail', 'bill-list', 'bill-subjects', 'bill-summaries', 'bill-titles',
    ]);

    // Run 2: the SAME bill, keys in reverse insertion order. JSON.stringify
    // produces a different string, but jsonb normalizes — the changed-check
    // must read it as unchanged and skip the fan-out entirely.
    const reordered = Object.fromEntries(Object.entries(item).reverse());
    assert.notEqual(JSON.stringify(reordered), JSON.stringify(item)); // the test only means something if the strings differ
    const run2 = routedFetch(() => ({ bills: [reordered], pagination: { count: 1 } }));
    const r2 = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', fetchImpl: run2.fetchImpl, fanout: {} });
    assert.equal(r2.upserted, 0);
    assert.equal(r2.unchanged, 1);
    assert.equal(run2.urls.length, 1); // list only — no sub-endpoint re-fetch
  } finally {
    client.release();
    await pool.end();
  }
});

test('COALESCE enrichment on real Postgres: populated columns survive omitted fields, and no-op loads leave updated_at alone', { skip }, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM raw_payloads WHERE source_name = 'congress-bills'`);
    await client.query(`DELETE FROM bill_cosponsors WHERE bill_id = 'hr1234-119'`);
    await client.query(`DELETE FROM bills WHERE bill_id = 'hr1234-119'`);
    await client.query(
      `INSERT INTO legislators (bioguide_id, first_name, last_name) VALUES ('B001319', 'Katie', 'Britt')
       ON CONFLICT (bioguide_id) DO NOTHING`,
    );
    await client.query(
      `INSERT INTO bills (bill_id, bill_type, bill_number, congress, introduced_at, policy_area, official_title, sponsor_bioguide_id)
       VALUES ('hr1234-119', 'hr', 1234, 119, '2025-01-06', 'Immigration', 'An existing official title.', 'B001319')`,
    );
    const before = await client.query(`SELECT updated_at FROM bills WHERE bill_id = 'hr1234-119'`);

    // An all-null detail payload (what a 404 stores) and an empty titles
    // payload: neither may overwrite anything, and neither may bump
    // updated_at (the WHERE guard).
    await client.query(
      `INSERT INTO raw_payloads (source_name, natural_key, endpoint, payload)
       VALUES ('congress-bills', 'hr1234-119', 'bill-detail', 'null'::jsonb),
              ('congress-bills', 'hr1234-119', 'bill-titles', '{"titles": []}'::jsonb)`,
    );
    await loadStaleDetailRaws({ client, loadCursor: null, log: () => {} });
    await loadStaleTitleRaws({ client, loadCursor: null, log: () => {} });

    const after = await client.query(
      `SELECT introduced_at::text, policy_area, official_title, sponsor_bioguide_id, updated_at FROM bills WHERE bill_id = 'hr1234-119'`,
    );
    assert.equal(after.rows[0].introduced_at, '2025-01-06');
    assert.equal(after.rows[0].policy_area, 'Immigration');
    assert.equal(after.rows[0].official_title, 'An existing official title.');
    assert.equal(after.rows[0].sponsor_bioguide_id, 'B001319');
    assert.deepEqual(after.rows[0].updated_at, before.rows[0].updated_at); // no fake modification signal

    // A real change (new enacted-as citation) applies AND bumps updated_at,
    // while the omitted fields still COALESCE onto their current values.
    await client.query(
      `INSERT INTO raw_payloads (source_name, natural_key, endpoint, payload)
       VALUES ('congress-bills', 'hr1234-119', 'bill-detail', '{"laws": [{"type": "Public Law", "number": "119-1"}]}'::jsonb)
       ON CONFLICT (source_name, natural_key, endpoint) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    );
    await loadStaleDetailRaws({ client, loadCursor: null, log: () => {} });
    const enacted = await client.query(
      `SELECT enacted_as_law_type, enacted_as_number, policy_area, updated_at FROM bills WHERE bill_id = 'hr1234-119'`,
    );
    assert.equal(enacted.rows[0].enacted_as_law_type, 'Public Law');
    assert.equal(enacted.rows[0].enacted_as_number, '119-1');
    assert.equal(enacted.rows[0].policy_area, 'Immigration');
    assert.notDeepEqual(enacted.rows[0].updated_at, before.rows[0].updated_at);
  } finally {
    client.release();
    await pool.end();
  }
});
