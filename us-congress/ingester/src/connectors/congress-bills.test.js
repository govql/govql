import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  fetchPagesIntoRaw,
  listPages,
  loadStaleRawsIntoBills,
  rawReadiness,
  toFromDateTime,
  transform,
} from './congress-bills.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/bill-list-page.json', import.meta.url)), 'utf8'),
);

test('transform rejects an item whose type cannot satisfy the bills.bill_type constraint', () => {
  assert.throws(
    () => transform({ ...fixture.bills[0], type: 'AMDT' }),
    /unknown bill type "AMDT"/,
  );
});

test('transform maps a bill-list item to a bills row with the hr3590-111 natural key', () => {
  const row = transform(fixture.bills[0]);
  assert.deepEqual(row, {
    bill_id: 'hr1234-119',
    bill_type: 'hr',
    bill_number: 1234,
    congress: 119,
    title: 'Example Tax Relief Act of 2025',
    latest_action: 'Referred to the Committee on Ways and Means.',
    latest_action_at: '2025-04-01',
    source_updated_at: '2025-04-02T07:15:31Z',
  });
});

function stubFetch(pages) {
  const urls = [];
  const fetchImpl = (url) => {
    urls.push(url);
    const body = pages[urls.length - 1];
    if (!body) throw new Error(`unexpected extra fetch: ${url}`);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { urls, fetchImpl };
}

test('listPages pages the bill-list endpoint with cursor, sort, and offset until the last page', async () => {
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'https://api.congress.gov/v3/bill/119?offset=1' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { urls, fetchImpl } = stubFetch([pageOne, pageTwo]);

  const pages = [];
  for await (const page of listPages({
    congress: 119,
    apiKey: 'test-key',
    fromDateTime: '2025-04-01T00:00:00Z',
    limit: 1,
    fetchImpl,
  })) {
    pages.push(page);
  }

  assert.deepEqual(pages, [pageOne, pageTwo]);
  assert.equal(urls.length, 2);
  const first = new URL(urls[0]);
  assert.equal(first.origin + first.pathname, 'https://api.congress.gov/v3/bill/119');
  assert.equal(first.searchParams.get('api_key'), 'test-key');
  assert.equal(first.searchParams.get('fromDateTime'), '2025-04-01T00:00:00Z');
  assert.equal(first.searchParams.get('sort'), 'updateDate asc');
  assert.equal(first.searchParams.get('limit'), '1');
  assert.equal(first.searchParams.get('offset'), '0');
  assert.equal(first.searchParams.get('format'), 'json');
  assert.equal(new URL(urls[1]).searchParams.get('offset'), '1');
});

test('listPages omits fromDateTime on a NULL-cursor backfill', async () => {
  const { urls, fetchImpl } = stubFetch([{ bills: [], pagination: { count: 0 } }]);
  for await (const _ of listPages({ congress: 119, apiKey: 'k', fromDateTime: null, fetchImpl })) void _;
  assert.equal(new URL(urls[0]).searchParams.has('fromDateTime'), false);
});

test('listPages surfaces a non-OK API response as an error', async () => {
  const fetchImpl = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
  await assert.rejects(async () => {
    for await (const _ of listPages({ congress: 119, apiKey: 'k', fetchImpl })) void _;
  }, /429/);
});

// Stub pg client: records every query and returns canned rows by call order.
// (Same shape as cursor-state.test.js; raw upserts get a rowCount response.)
function stubClient(respond = () => ({ rows: [], rowCount: 1 })) {
  const calls = [];
  return {
    calls,
    query(text, params) {
      calls.push({ text, params });
      return Promise.resolve(respond(text, params));
    },
  };
}

test('fetchPagesIntoRaw commits each page atomically: raw upserts + fetch-cursor advance', async () => {
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { fetchImpl } = stubFetch([pageOne, pageTwo]);
  const client = stubClient();

  const result = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', limit: 1, fetchImpl });

  assert.equal(result.pages, 2);
  assert.equal(result.upserted, 2);
  assert.equal(result.cursor, '2025-04-03');

  const texts = client.calls.map((c) => c.text);
  // Two page transactions, each: BEGIN, raw upsert, cursor advance, COMMIT.
  const shape = texts.map((t) =>
    t === 'BEGIN' || t === 'COMMIT' ? t
    : /INSERT INTO raw_payloads/i.test(t) ? 'raw'
    : /INSERT INTO source_state/i.test(t) ? 'cursor'
    : 'other');
  assert.deepEqual(shape, ['BEGIN', 'raw', 'cursor', 'COMMIT', 'BEGIN', 'raw', 'cursor', 'COMMIT']);

  // The raw upsert carries the connector's source/natural-key/endpoint identity
  // and only touches fetched_at when the payload actually changed.
  const raw = client.calls[1];
  assert.match(raw.text, /ON CONFLICT \(source_name, natural_key, endpoint\)/i);
  assert.match(raw.text, /IS DISTINCT FROM/i);
  assert.deepEqual(raw.params.slice(0, 3), ['congress-bills', 'hr1234-119', 'bill-list']);
  assert.deepEqual(JSON.parse(raw.params[3]), fixture.bills[0]);

  // Per-page cursor advance goes to that page's max consumed updateDate.
  assert.deepEqual(client.calls[2].params, ['congress-bills', '2025-04-02']);
  assert.deepEqual(client.calls[6].params, ['congress-bills', '2025-04-03']);
});

test('fetchPagesIntoRaw: a crash mid-run keeps earlier pages committed, and the rerun resumes from the committed cursor', async () => {
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  let callCount = 0;
  const urls = [];
  const fetchImpl = (url) => {
    urls.push(url);
    callCount += 1;
    if (callCount === 1) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(pageOne) });
    return Promise.reject(new Error('network down'));  // the "kill" mid-backfill
  };
  const client = stubClient();

  await assert.rejects(
    () => fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', limit: 1, fetchImpl }),
    /network down/,
  );

  // Page one was committed (BEGIN..COMMIT completed) before the crash.
  const texts = client.calls.map((c) => c.text);
  assert.equal(texts.filter((t) => t === 'COMMIT').length, 1);
  assert.equal(texts.filter((t) => t === 'ROLLBACK').length, 0);

  // Rerun with the cursor that page-one transaction committed: the query
  // restarts at offset 0 with fromDateTime = the committed watermark.
  const resumed = stubFetch([{ bills: [], pagination: { count: 0 } }]);
  await fetchPagesIntoRaw({
    client: stubClient(),
    congress: 119,
    apiKey: 'k',
    fromDateTime: toFromDateTime('2025-04-02T00:00:00.000000Z'),
    fetchImpl: resumed.fetchImpl,
  });
  const resumeUrl = new URL(resumed.urls[0]);
  assert.equal(resumeUrl.searchParams.get('fromDateTime'), '2025-04-02T00:00:00Z');
  assert.equal(resumeUrl.searchParams.get('offset'), '0');
});

test('fetchPagesIntoRaw counts unchanged payloads separately (rerun is a cheap no-op)', async () => {
  const page = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  const { fetchImpl } = stubFetch([page]);
  // rowCount 0 = the WHERE payload IS DISTINCT FROM guard suppressed the write.
  const client = stubClient((text) => (/INSERT INTO raw_payloads/i.test(text) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 }));

  const result = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', fetchImpl });
  assert.equal(result.upserted, 0);
  assert.equal(result.unchanged, 2);
});

test('toFromDateTime truncates a full-precision cursor to the API format', () => {
  assert.equal(toFromDateTime('2025-04-02T07:15:31.905108Z'), '2025-04-02T07:15:31Z');
  assert.equal(toFromDateTime(null), null);
});

test('rawReadiness gates the load on raw_payloads staleness, not the fetch↔load handshake', async () => {
  const maxFetched = '2026-07-15T10:00:00.123456Z';
  const respond = () => ({ rows: [{ max_fetched_at: maxFetched }], rowCount: 1 });

  // Something fetched past the load cursor → ready.
  let client = stubClient(respond);
  let r = await rawReadiness(client, '2026-07-15T09:00:00.000000Z');
  assert.deepEqual(r, { maxFetchedAt: maxFetched, ready: true });
  assert.match(client.calls[0].text, /max\(fetched_at\)/i);
  assert.deepEqual(client.calls[0].params, ['congress-bills', 'bill-list']);

  // Load already caught up → skip.
  r = await rawReadiness(stubClient(respond), maxFetched);
  assert.equal(r.ready, false);

  // Never loaded → ready.
  r = await rawReadiness(stubClient(respond), null);
  assert.equal(r.ready, true);

  // Nothing fetched yet → skip.
  r = await rawReadiness(stubClient(() => ({ rows: [{ max_fetched_at: null }] })), null);
  assert.equal(r.ready, false);
});

test('loadStaleRawsIntoBills upserts transformed raws and reports the consumed watermark', async () => {
  const staleRows = [
    { natural_key: 'hr1234-119', payload: fixture.bills[0], fetched_at: '2026-07-15T09:30:00.000001Z' },
    { natural_key: 'sres22-119', payload: fixture.bills[1], fetched_at: '2026-07-15T09:30:00.000002Z' },
  ];
  const client = stubClient((text) =>
    /FROM raw_payloads/i.test(text) ? { rows: staleRows, rowCount: 2 } : { rows: [], rowCount: 1 });

  const result = await loadStaleRawsIntoBills({ client, loadCursor: '2026-07-15T09:00:00.000000Z' });

  assert.deepEqual(result, { ingested: 2, failed: 0, maxFetchedAt: '2026-07-15T09:30:00.000002Z' });

  // The stale-raw read is cursor-filtered, ordered, and precision-preserving.
  const read = client.calls[0];
  assert.match(read.text, /fetched_at > \$3/i);
  assert.match(read.text, /ORDER BY fetched_at/i);
  assert.match(read.text, /to_char\(\s*fetched_at AT TIME ZONE 'UTC'/i);
  assert.deepEqual(read.params, ['congress-bills', 'bill-list', '2026-07-15T09:00:00.000000Z']);

  // Bills upsert enriches existing stub rows instead of DO NOTHING-ing them.
  const upsert = client.calls[1];
  assert.match(upsert.text, /INSERT INTO bills/i);
  assert.match(upsert.text, /ON CONFLICT \(bill_id\) DO UPDATE/i);
  assert.equal(upsert.params[0], 'hr1234-119');
});

test('loadStaleRawsIntoBills counts a bad payload as failed and keeps going', async () => {
  const staleRows = [
    { natural_key: 'amdt1-119', payload: { ...fixture.bills[0], type: 'AMDT' }, fetched_at: '2026-07-15T09:30:00.000001Z' },
    { natural_key: 'sres22-119', payload: fixture.bills[1], fetched_at: '2026-07-15T09:30:00.000002Z' },
  ];
  const client = stubClient((text) =>
    /FROM raw_payloads/i.test(text) ? { rows: staleRows, rowCount: 2 } : { rows: [], rowCount: 1 });

  const result = await loadStaleRawsIntoBills({ client, loadCursor: null, log: () => {} });
  assert.deepEqual(result, { ingested: 1, failed: 1, maxFetchedAt: '2026-07-15T09:30:00.000002Z' });
});
