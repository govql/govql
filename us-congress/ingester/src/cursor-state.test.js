import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isReady,
  readCursor,
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

test('readCursor: returns the cursor for a (source, stage), null when absent', async () => {
  const ts = new Date('2026-06-30T12:35:00Z');
  const present = stubClient([{ rows: [{ cursor: ts }] }]);
  assert.equal(await readCursor(present, 'congress-votes', 'fetch'), ts);
  assert.deepEqual(present.calls[0].params, ['congress-votes', 'fetch']);

  const absent = stubClient([{ rows: [] }]);
  assert.equal(await readCursor(absent, 'congress-votes', 'load'), null);
});

test('advanceLoadCursor: upserts the captured fetch value into the load stage', async () => {
  const value = new Date('2026-06-30T12:35:00Z');
  const client = stubClient();
  await advanceLoadCursor(client, 'congress-votes', value);

  assert.equal(client.calls.length, 1);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO source_state/i);
  assert.match(text, /ON CONFLICT/i);
  assert.deepEqual(params, ['congress-votes', value]);
});

test('loadReadiness: reads fetch then load and reports ready + captured fetch', async () => {
  const fetchTs = new Date('2026-06-30T12:35:00Z');
  const loadTs = new Date('2026-06-30T11:50:00Z');
  // Responses are returned in call order: first readCursor('fetch'), then 'load'.
  const client = stubClient([{ rows: [{ cursor: fetchTs }] }, { rows: [{ cursor: loadTs }] }]);

  const r = await loadReadiness(client, 'congress-votes');
  assert.deepEqual(r, { fetchCursor: fetchTs, loadCursor: loadTs, ready: true });
  assert.deepEqual(client.calls[0].params, ['congress-votes', 'fetch']);
  assert.deepEqual(client.calls[1].params, ['congress-votes', 'load']);
});

test('loadReadiness: not ready when fetch has not advanced past load', async () => {
  const ts = new Date('2026-06-30T12:00:00Z');
  const client = stubClient([{ rows: [{ cursor: ts }] }, { rows: [{ cursor: ts }] }]);
  const r = await loadReadiness(client, 'congress-votes');
  assert.equal(r.ready, false);
});
