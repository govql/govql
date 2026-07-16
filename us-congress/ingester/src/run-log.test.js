import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openRun, succeedRun, failRun } from './run-log.js';

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

test('openRun inserts a running ingestion_runs row and returns its id', async () => {
  const client = stubClient([{ rows: [{ id: 42 }] }]);
  const runId = await openRun(client, 'bills', { congress: 119 });

  assert.equal(runId, 42);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO ingestion_runs/i);
  assert.match(text, /'running'/);
  assert.match(text, /RETURNING id/i);
  assert.deepEqual(params, ['bills', JSON.stringify({ congress: 119 })]);
});

test('openRun stores NULL source_params when none are given', async () => {
  const client = stubClient([{ rows: [{ id: 7 }] }]);
  await openRun(client, 'bills_fetch');
  assert.deepEqual(client.calls[0].params, ['bills_fetch', null]);
});

test('succeedRun closes the run with status success and the upsert count', async () => {
  const client = stubClient();
  await succeedRun(client, 42, 250);

  const { text, params } = client.calls[0];
  assert.match(text, /UPDATE ingestion_runs/i);
  assert.match(text, /'success'/);
  assert.match(text, /finished_at = now\(\)/i);
  // '{}' (a merge no-op), never NULL — jsonb || NULL is NULL and would wipe
  // the source_params recorded at openRun.
  assert.deepEqual(params, [250, '{}', 42]);
});

test('succeedRun merges outcome details into source_params so monitoring can query them', async () => {
  // A fetch run that gave up unverified must be distinguishable from a healthy
  // one in ingestion_runs, not only in container logs.
  const client = stubClient();
  await succeedRun(client, 42, 250, { verified: false, passes: 5 });

  const { text, params } = client.calls[0];
  assert.match(text, /source_params = coalesce\(source_params, '\{\}'::jsonb\) \|\| \$2/i);
  assert.deepEqual(params, [250, JSON.stringify({ verified: false, passes: 5 }), 42]);
});

test('failRun closes the run with status failed and the error message', async () => {
  const client = stubClient();
  await failRun(client, 42, 'HTTP 429');

  const { text, params } = client.calls[0];
  assert.match(text, /UPDATE ingestion_runs/i);
  assert.match(text, /'failed'/);
  assert.match(text, /error_message/i);
  assert.deepEqual(params, ['HTTP 429', 42]);
});
