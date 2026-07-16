import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  capWatermark,
  fetchPagesIntoRaw,
  fetchPagesUntilClean,
  fetchStateName,
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

test('transform rejects a non-numeric bill number instead of silently clobbering another bill', () => {
  // parseInt('12A') === 12 would map a malformed item onto the REAL hr12-119
  // row via ON CONFLICT DO UPDATE; the natural key must be strictly numeric.
  assert.throws(() => transform({ ...fixture.bills[0], number: '12A' }), /unparseable bill number/);
  assert.throws(() => transform({ ...fixture.bills[0], congress: '119th' }), /unparseable bill number/);
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
  const options = [];
  const fetchImpl = (url, opts) => {
    urls.push(url);
    options.push(opts);
    const body = pages[urls.length - 1];
    if (!body) throw new Error(`unexpected extra fetch: ${url}`);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { urls, options, fetchImpl };
}

test('listPages pages the bill-list endpoint with cursor, sort, and offset until the last page', async () => {
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'https://api.congress.gov/v3/bill/119?offset=1' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { urls, options, fetchImpl } = stubFetch([pageOne, pageTwo]);

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
  // The key travels in the X-Api-Key header, never the URL — query strings
  // leak into proxy/access logs and error objects.
  assert.equal(first.searchParams.has('api_key'), false);
  assert.deepEqual(options[0], { headers: { 'X-Api-Key': 'test-key' } });
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

  // Per-page cursor advance goes to that page's max consumed updateDate,
  // keyed per congress so changing the target congress starts a fresh
  // backfill instead of silently filtering behind another congress's cursor.
  assert.deepEqual(client.calls[2].params, ['congress-bills-119', '2025-04-02']);
  assert.deepEqual(client.calls[6].params, ['congress-bills-119', '2025-04-03']);
});

// Stub client for fetchPagesUntilClean runs: serves the resume ('fetch') and
// verified ('fetch_verified') cursors to readCursor, canned rowCounts to raw
// upserts, and records every source_state write.
function cursorAwareClient({ resume = null, verified = null, rawRowCount = () => 1 } = {}) {
  const calls = [];
  let rawWrites = 0;
  return {
    calls,
    query(text, params) {
      calls.push({ text, params });
      if (/FROM source_state/i.test(text)) {
        const cursor = params[1] === 'fetch' ? resume : verified;
        return Promise.resolve({ rows: cursor === null ? [] : [{ cursor }] });
      }
      if (/INSERT INTO raw_payloads/i.test(text)) {
        rawWrites += 1;
        return Promise.resolve({ rows: [], rowCount: rawRowCount(rawWrites) });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
}

function verifiedWrites(client) {
  return client.calls.filter((c) => /'fetch_verified'/.test(c.text) && /INSERT INTO source_state/i.test(c.text));
}

test('fetchPagesUntilClean: multi-page pass triggers a verification re-walk from the VERIFIED cursor, then advances it', async () => {
  // Prior state verified (resume == verified). Pass 1 from the resume cursor
  // is multi-page (boundary skips possible); the verification pass re-walks
  // from the verified cursor and finds nothing new → verified advances.
  const anchor = '2025-04-01T00:00:00.000000Z';
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { urls, fetchImpl } = stubFetch([pageOne, pageTwo, pageOne, pageTwo]);
  const client = cursorAwareClient({
    resume: anchor,
    verified: anchor,
    rawRowCount: (n) => (n <= 2 ? 1 : 0), // verification pass: payloads identical
  });

  const pageEvents = [];
  const result = await fetchPagesUntilClean({
    client,
    congress: 119,
    apiKey: 'k',
    limit: 1,
    fetchImpl,
    onPage: (p) => pageEvents.push(p),
  });

  assert.equal(result.passes, 2);
  assert.equal(result.verified, true);
  assert.equal(result.upserted, 2); // distinct bills, not per-pass double counts
  assert.equal(result.unchanged, 2);
  assert.equal(urls.length, 4);
  for (const i of [0, 2]) {
    const u = new URL(urls[i]);
    assert.equal(u.searchParams.get('fromDateTime'), '2025-04-01T00:00:00Z');
    assert.equal(u.searchParams.get('offset'), '0');
  }
  // onPage events carry the pass number so run logs are unambiguous.
  assert.deepEqual(pageEvents.map((p) => p.pass), [1, 1, 2, 2]);
  // The verified cursor advances exactly once, to the final resume position.
  const vw = verifiedWrites(client);
  assert.equal(vw.length, 1);
  assert.deepEqual(vw[0].params, ['congress-bills-119', '2025-04-03']);
});

test('fetchPagesUntilClean: single-page pass on a verified baseline skips verification and advances the verified cursor', async () => {
  const anchor = '2025-04-01T00:00:00.000000Z';
  const { urls, fetchImpl } = stubFetch([{ bills: [fixture.bills[0]], pagination: { count: 1 } }]);
  const client = cursorAwareClient({ resume: anchor, verified: anchor });

  const result = await fetchPagesUntilClean({ client, congress: 119, apiKey: 'k', fetchImpl });

  assert.equal(result.passes, 1);
  assert.equal(result.verified, true);
  assert.equal(urls.length, 1);
  assert.equal(verifiedWrites(client).length, 1);
});

test('fetchPagesUntilClean: a resume cursor ahead of the verified cursor forces verification even for a single-page pass', async () => {
  // The previous run crashed (or was capped) mid-verification: resume moved,
  // verified did not. This run must re-walk from the verified cursor even
  // though its own catch-up pass was trivially small.
  const resume = '2025-04-03T00:00:00.000000Z';
  const verified = '2025-04-01T00:00:00.000000Z';
  const emptyPage = { bills: [], pagination: { count: 0 } };
  const fullPage = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  const { urls, fetchImpl } = stubFetch([emptyPage, fullPage]);
  const client = cursorAwareClient({ resume, verified, rawRowCount: () => 0 });

  const result = await fetchPagesUntilClean({ client, congress: 119, apiKey: 'k', fetchImpl });

  assert.equal(result.passes, 2);
  assert.equal(result.verified, true);
  assert.equal(new URL(urls[0]).searchParams.get('fromDateTime'), '2025-04-03T00:00:00Z');
  assert.equal(new URL(urls[1]).searchParams.get('fromDateTime'), '2025-04-01T00:00:00Z');
  // Clean verification → verified catches up to the resume position.
  const vw = verifiedWrites(client);
  assert.equal(vw.length, 1);
  assert.deepEqual(vw[0].params, ['congress-bills-119', resume]);
});

test('fetchPagesUntilClean: a verification pass truncated by an empty-page-with-next is NOT clean', async () => {
  // Anomalous API response: zero bills but pagination.next present. Such a
  // pass wrote nothing, but it also never re-walked the territory — treating
  // it as clean would advance fetch_verified over a possibly-skipped bill.
  const anchor = '2025-04-01T00:00:00.000000Z';
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const truncated = { bills: [], pagination: { count: 2, next: 'x' } };
  // Pass 1: multi-page catch-up. Pass 2: truncated (not clean). Pass 3: full
  // re-walk, everything unchanged → clean.
  const { fetchImpl } = stubFetch([pageOne, pageTwo, truncated, pageOne, pageTwo]);
  const client = cursorAwareClient({
    resume: anchor,
    verified: anchor,
    rawRowCount: (n) => (n <= 2 ? 1 : 0),
  });

  const result = await fetchPagesUntilClean({
    client,
    congress: 119,
    apiKey: 'k',
    limit: 1,
    fetchImpl,
    maxPasses: 5,
  });

  assert.equal(result.passes, 3);
  assert.equal(result.verified, true);
  assert.equal(verifiedWrites(client).length, 1);
});

test('fetchPagesUntilClean: hitting the pass cap leaves the verified cursor untouched for the next run', async () => {
  // Every pass keeps finding changes → cap fires. The verified cursor must NOT
  // advance: the next hourly run re-walks from it, so nothing is stranded.
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { fetchImpl } = stubFetch([pageOne, pageTwo, pageOne, pageTwo]);
  const client = cursorAwareClient({ resume: null, verified: null, rawRowCount: () => 1 });

  const warnings = [];
  const result = await fetchPagesUntilClean({
    client,
    congress: 119,
    apiKey: 'k',
    limit: 1,
    fetchImpl,
    maxPasses: 2,
    log: (m) => warnings.push(m),
  });

  assert.equal(result.passes, 2);
  assert.equal(result.verified, false);
  assert.equal(verifiedWrites(client).length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did not converge/);
});

test('capWatermark bounds the load-cursor advance: never past the grace cap, never backwards', () => {
  const loadCursor = '2026-07-15T09:00:00.000000Z';
  const graceCap = '2026-07-15T10:15:00.000000Z';
  // Normal: consumed below the cap → advance to consumed.
  assert.equal(
    capWatermark({ consumed: '2026-07-15T10:00:00.000000Z', graceCap, loadCursor }),
    '2026-07-15T10:00:00.000000Z',
  );
  // Consumed inside the grace window (in-flight fetch transactions may still
  // land behind it) → clamp to the cap.
  assert.equal(
    capWatermark({ consumed: '2026-07-15T10:19:00.000000Z', graceCap, loadCursor }),
    graceCap,
  );
  // Clamp would regress an already-ahead cursor → keep the cursor.
  assert.equal(
    capWatermark({ consumed: '2026-07-15T10:19:00.000000Z', graceCap: '2026-07-15T08:00:00.000000Z', loadCursor }),
    loadCursor,
  );
  // Nothing consumed → cursor unchanged.
  assert.equal(capWatermark({ consumed: null, graceCap, loadCursor }), loadCursor);
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

  const result = await loadStaleRawsIntoBills({
    client,
    loadCursor: '2026-07-15T09:00:00.000000Z',
    batchSize: 500,
  });

  assert.deepEqual(result, { ingested: 2, failed: 0, maxFetchedAt: '2026-07-15T09:30:00.000002Z' });

  // The stale-raw read is cursor-filtered, ordered, precision-preserving, and
  // bounded — batches of batchSize, never the whole backlog in memory.
  const read = client.calls[0];
  assert.match(read.text, /fetched_at > \$3/i);
  assert.match(read.text, /ORDER BY fetched_at, natural_key/i);
  assert.match(read.text, /LIMIT \$4/i);
  assert.match(read.text, /to_char\(\s*fetched_at AT TIME ZONE 'UTC'/i);
  assert.deepEqual(read.params, ['congress-bills', 'bill-list', '2026-07-15T09:00:00.000000Z', 500]);

  // Bills upsert enriches existing stub rows instead of DO NOTHING-ing them.
  const upsert = client.calls[1];
  assert.match(upsert.text, /INSERT INTO bills/i);
  assert.match(upsert.text, /ON CONFLICT \(bill_id\) DO UPDATE/i);
  assert.equal(upsert.params[0], 'hr1234-119');
});

test('loadStaleRawsIntoBills pages through the backlog in keyset batches', async () => {
  // Three stale rows, batchSize 2: batch one fills (2 rows), so a second read
  // follows keyed on the last row's (fetched_at, natural_key) — tuple keyset,
  // not a bare fetched_at bound, because a whole fetch page shares one now().
  const ts = '2026-07-15T09:30:00.000001Z';
  const batchOne = [
    { natural_key: 'hr1234-119', payload: fixture.bills[0], fetched_at: ts },
    { natural_key: 'sres22-119', payload: fixture.bills[1], fetched_at: ts },
  ];
  const batchTwo = [
    { natural_key: 'sres23-119', payload: { ...fixture.bills[1], number: '23' }, fetched_at: ts },
  ];
  let reads = 0;
  const client = stubClient((text) => {
    if (!/FROM raw_payloads/i.test(text)) return { rows: [], rowCount: 1 };
    reads += 1;
    return reads === 1 ? { rows: batchOne, rowCount: 2 } : { rows: batchTwo, rowCount: 1 };
  });

  const result = await loadStaleRawsIntoBills({ client, loadCursor: null, batchSize: 2 });

  assert.deepEqual(result, { ingested: 3, failed: 0, maxFetchedAt: ts });
  const secondRead = client.calls.filter((c) => /FROM raw_payloads/i.test(c.text))[1];
  assert.match(secondRead.text, /\(fetched_at, natural_key\) > \(\$3, \$4\)/i);
  assert.deepEqual(secondRead.params, ['congress-bills', 'bill-list', ts, 'sres22-119', 2]);
});

test('loadStaleRawsIntoBills counts a transform reject as failed and keeps going', async () => {
  const staleRows = [
    { natural_key: 'amdt1-119', payload: { ...fixture.bills[0], type: 'AMDT' }, fetched_at: '2026-07-15T09:30:00.000001Z' },
    { natural_key: 'sres22-119', payload: fixture.bills[1], fetched_at: '2026-07-15T09:30:00.000002Z' },
  ];
  const client = stubClient((text) =>
    /FROM raw_payloads/i.test(text) ? { rows: staleRows, rowCount: 2 } : { rows: [], rowCount: 1 });

  const result = await loadStaleRawsIntoBills({ client, loadCursor: null, log: () => {} });
  assert.deepEqual(result, { ingested: 1, failed: 1, maxFetchedAt: '2026-07-15T09:30:00.000002Z' });
});

test('loadStaleRawsIntoBills lets a database upsert error propagate — the cursor must not advance past it', async () => {
  // Only transform rejects are the designed skip path. A row whose upsert
  // fails transiently (deadlock, timeout) must fail the run so the unadvanced
  // cursor re-reads it next hour — otherwise the payload-diff guard freezes
  // its fetched_at and the bill is dropped forever.
  const staleRows = [
    { natural_key: 'hr1234-119', payload: fixture.bills[0], fetched_at: '2026-07-15T09:30:00.000001Z' },
  ];
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: staleRows, rowCount: 1 };
    throw new Error('deadlock detected');
  });

  await assert.rejects(
    () => loadStaleRawsIntoBills({ client, loadCursor: null, log: () => {} }),
    /deadlock detected/,
  );
});
