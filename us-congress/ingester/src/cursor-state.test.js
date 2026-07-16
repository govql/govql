import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isReady,
  readCursor,
  advanceFetchCursor,
  advanceVerifiedFetchCursor,
  advanceLoadCursor,
  loadReadiness,
} from './cursor-state.js';

// Stub pg client: records every query and returns canned rows by call order.
function stubClient(responses = []) {
  const calls = [];
  let i = 0;
  return {
    calls,
    query(text, params) {
      calls.push({ text, params });
      return Promise.resolve(responses[i++] ?? { rows: [] });
    },
  };
}

test('isReady: load never ran but fetch has advanced → ready (bootstrap)', () => {
  assert.equal(isReady('2026-06-30T12:00:00Z', null), true);
});

test('isReady: fetch advanced past load → ready', () => {
  assert.equal(isReady('2026-06-30T12:35:00Z', '2026-06-30T11:50:00Z'), true);
});

test('isReady: fetch equals load (already consumed) → skip', () => {
  assert.equal(isReady('2026-06-30T12:00:00Z', '2026-06-30T12:00:00Z'), false);
});

test('isReady: fetch behind load (stale) → skip', () => {
  assert.equal(isReady('2026-06-30T11:50:00Z', '2026-06-30T12:00:00Z'), false);
});

test('isReady: no fetch cursor yet (scraper never ran) → skip', () => {
  assert.equal(isReady(null, null), false);
  assert.equal(isReady(null, '2026-06-30T12:00:00Z'), false);
});

test('isReady: accepts Date objects, not just ISO strings (pg returns Date)', () => {
  assert.equal(
    isReady(new Date('2026-06-30T12:35:00Z'), new Date('2026-06-30T11:50:00Z')),
    true,
  );
  assert.equal(
    isReady(new Date('2026-06-30T12:00:00Z'), new Date('2026-06-30T12:00:00Z')),
    false,
  );
});

test('readCursor: returns the cursor as a full-precision string, null when absent', async () => {
  const ts = '2026-06-30T12:35:00.905108Z';
  const present = stubClient([{ rows: [{ cursor: ts }] }]);
  assert.equal(await readCursor(present, 'congress-votes', 'fetch'), ts);
  assert.deepEqual(present.calls[0].params, ['congress-votes', 'fetch']);
  // Pin the precision-preserving read: format to microseconds in UTC rather than
  // letting pg return a JS Date (which truncates to ms). See AGENTS.md.
  assert.match(present.calls[0].text, /to_char\(\s*cursor AT TIME ZONE 'UTC'/i);
  assert.match(present.calls[0].text, /\.US/);

  const absent = stubClient([{ rows: [] }]);
  assert.equal(await readCursor(absent, 'congress-votes', 'load'), null);
});

test('advanceLoadCursor: upserts the captured fetch value into the load stage, monotonically', async () => {
  // The captured value is the full-precision string from readCursor, written back
  // verbatim so load equals the consumed fetch value to the microsecond. The
  // write is monotonic: two overlapping load runs must not let the slower one
  // regress the cursor the faster one already advanced.
  const value = '2026-06-30T12:35:00.905108Z';
  const client = stubClient();
  await advanceLoadCursor(client, 'congress-votes', value);

  assert.equal(client.calls.length, 1);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO source_state/i);
  assert.match(text, /ON CONFLICT/i);
  // Pin the stage literal: advanceLoadCursor must write the 'load' stage, not
  // 'fetch'. The stage is hardcoded (not a param), so without this a regression
  // flipping it to 'fetch' would corrupt the handshake yet pass every other check.
  assert.match(text, /'load'/);
  assert.match(text, /WHERE source_state\.cursor IS NULL OR EXCLUDED\.cursor > source_state\.cursor/i);
  assert.deepEqual(params, ['congress-votes', value]);
});

test('advanceFetchCursor: upserts the consumed source watermark into the fetch stage, monotonically', async () => {
  // An API-source fetcher (Congress.gov bills) advances its own fetch cursor to
  // the max consumed source updateDate, per committed page. The write is
  // monotonic — a verification re-walk anchored at an older cursor must never
  // regress the persisted resume position (a crash mid-re-walk would otherwise
  // restart the next run near zero).
  const value = '2026-07-01';
  const client = stubClient();
  await advanceFetchCursor(client, 'congress-bills-119', value);

  assert.equal(client.calls.length, 1);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO source_state/i);
  assert.match(text, /ON CONFLICT/i);
  // Pin the stage literal, mirroring the advanceLoadCursor pin above.
  assert.match(text, /'fetch'/);
  // Pin the monotonic guard: only advance, never regress.
  assert.match(text, /WHERE source_state\.cursor IS NULL OR EXCLUDED\.cursor > source_state\.cursor/i);
  assert.deepEqual(params, ['congress-bills-119', value]);
});

test('advanceVerifiedFetchCursor: upserts the verified-through watermark, monotonically', async () => {
  // 'fetch_verified' records how far a clean verification re-walk has proven
  // complete; it only advances after such a pass, so a crashed or capped
  // verification leaves it behind and the next run re-walks from it.
  const value = '2026-07-01';
  const client = stubClient();
  await advanceVerifiedFetchCursor(client, 'congress-bills-119', value);

  assert.equal(client.calls.length, 1);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO source_state/i);
  assert.match(text, /'fetch_verified'/);
  assert.match(text, /WHERE source_state\.cursor IS NULL OR EXCLUDED\.cursor > source_state\.cursor/i);
  assert.deepEqual(params, ['congress-bills-119', value]);
});

test('loadReadiness: reads fetch then load and reports ready + captured fetch', async () => {
  const fetchTs = '2026-06-30T12:35:00.905108Z';
  const loadTs = '2026-06-30T11:50:00.000000Z';
  // Responses are returned in call order: first readCursor('fetch'), then 'load'.
  const client = stubClient([{ rows: [{ cursor: fetchTs }] }, { rows: [{ cursor: loadTs }] }]);

  const r = await loadReadiness(client, 'congress-votes');
  assert.deepEqual(r, { fetchCursor: fetchTs, loadCursor: loadTs, ready: true });
  assert.deepEqual(client.calls[0].params, ['congress-votes', 'fetch']);
  assert.deepEqual(client.calls[1].params, ['congress-votes', 'load']);
});

test('loadReadiness: not ready when load equals the exact fetch value consumed', async () => {
  // load holds the exact microsecond fetch value it consumed (precision preserved),
  // so when nothing new is scraped the two are identical → skip.
  const ts = '2026-06-30T12:00:00.905108Z';
  const client = stubClient([{ rows: [{ cursor: ts }] }, { rows: [{ cursor: ts }] }]);
  const r = await loadReadiness(client, 'congress-votes');
  assert.equal(r.ready, false);
});
