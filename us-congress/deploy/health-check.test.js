// The post-deploy health check: a pure poller core (poll) exercised against
// stubbed checks and a fake clock, and the target checks (createCheck)
// exercised against a stubbed fetch. No real HTTP or real time in here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { poll, createCheck } from './health-check.js';

// A fake clock: now() reads a counter, sleep() advances it. Lets the poller's
// timeout logic run instantly and deterministically.
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

test('poll: both targets green immediately → pass', async () => {
  const clock = fakeClock();
  const check = async () => ({ docs: true, api: true });
  const result = await poll(check, { timeoutMs: 120_000, intervalMs: 5_000, ...clock });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
});

test('poll: a target flaps then greens within the timeout → pass', async () => {
  const clock = fakeClock();
  const rounds = [
    { docs: true, api: false },
    { docs: true, api: false },
    { docs: true, api: true },
  ];
  let calls = 0;
  const check = async () => rounds[calls++];
  const result = await poll(check, { timeoutMs: 120_000, intervalMs: 5_000, ...clock });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
  assert.equal(calls, 3, 'kept polling until green');
  assert.equal(clock.now(), 10_000, 'slept the interval between rounds');
});

test('poll: a target never greens → fail after the timeout, naming the target', async () => {
  const clock = fakeClock();
  let calls = 0;
  const check = async () => {
    calls++;
    return { docs: true, api: false };
  };
  const result = await poll(check, { timeoutMs: 120_000, intervalMs: 5_000, ...clock });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['api'], 'reports which target failed');
  assert.equal(calls, 25, 'polled the full window: t=0 plus one round per interval');
  assert.ok(clock.now() <= 120_000, 'gave up once the next round would pass the deadline');
});

test('poll: both targets never green → both reported failed', async () => {
  const clock = fakeClock();
  const check = async () => ({ docs: false, api: false });
  const result = await poll(check, { timeoutMs: 10_000, intervalMs: 5_000, ...clock });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['docs', 'api']);
});

// A stubbed fetch: responds per-URL from a table of { status, body } entries.
function stubFetch(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const entry = responses[url];
    if (entry instanceof Error) throw entry;
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      json: async () => entry.body,
    };
  };
  return { fetch, calls };
}

const DOCS_URL = 'https://govql.us';
const API_URL = 'https://api.govql.us/graphql';

test('createCheck: docs 2xx and a well-formed GraphQL data response → both green', async () => {
  const { fetch, calls } = stubFetch({
    [DOCS_URL]: { status: 200, body: '' },
    [API_URL]: { status: 200, body: { data: { allLegislators: { nodes: [{ bioguideId: 'A1' }] } } } },
  });
  const check = createCheck({ docsUrl: DOCS_URL, apiUrl: API_URL, fetch });
  assert.deepEqual(await check(), { docs: true, api: true });

  const apiCall = calls.find((c) => c.url === API_URL);
  assert.equal(apiCall.init.method, 'POST', 'API is probed with a real GraphQL POST');
  assert.equal(apiCall.init.headers['Content-Type'], 'application/json');
  assert.ok(JSON.parse(apiCall.init.body).query, 'body carries a GraphQL query');

  // A hung request must not eat the poll window: every probe carries an abort
  // signal so a stalled connection fails the round instead of blocking it.
  for (const call of calls) {
    assert.ok(call.init.signal instanceof AbortSignal, `${call.url} probe has a request timeout`);
  }
});

test('createCheck: not-green criteria — bad status, GraphQL errors, null data, network error', async () => {
  const wellFormed = { status: 200, body: { data: { allLegislators: { nodes: [] } } } };
  const cases = [
    // [docs entry, api entry, expected]
    [{ status: 502, body: '' }, wellFormed, { docs: false, api: true }],
    [{ status: 200, body: '' }, { status: 500, body: {} }, { docs: true, api: false }],
    // 200 with an errors array and no data — errors-only response is not green.
    [
      { status: 200, body: '' },
      { status: 200, body: { data: null, errors: [{ message: 'boom' }] } },
      { docs: true, api: false },
    ],
    // fetch throwing (DNS, TLS, refused) is the normal not-up-yet signal.
    [new TypeError('fetch failed'), wellFormed, { docs: false, api: true }],
    [{ status: 200, body: '' }, new TypeError('fetch failed'), { docs: true, api: false }],
  ];
  for (const [docsEntry, apiEntry, expected] of cases) {
    const { fetch } = stubFetch({ [DOCS_URL]: docsEntry, [API_URL]: apiEntry });
    const check = createCheck({ docsUrl: DOCS_URL, apiUrl: API_URL, fetch });
    assert.deepEqual(await check(), expected);
  }
});
