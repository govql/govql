// Post-deploy external health check — the pure poller core. No HTTP and no
// real clock in this module: the check function, now() and sleep() are all
// injected, so the retry/timeout/aggregation logic is unit-testable. The thin
// wrapper that does real requests lives in health-check-run.js.

// Poll check() until every target it reports is green, or the timeout
// elapses. check() resolves to { targetName: boolean, ... }. Returns
// { ok, failed } where failed lists the targets not green on the last round.
export async function poll(check, { timeoutMs, intervalMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const results = await check();
    const failed = Object.keys(results).filter((target) => !results[target]);
    if (failed.length === 0) return { ok: true, failed };
    if (now() + intervalMs > deadline) return { ok: false, failed };
    await sleep(intervalMs);
  }
}

// The trivial probe query: also exercises the DB path, not just the server
// process (same minimal query the MCP server's tests use).
export const PROBE_QUERY = '{ allLegislators(first: 1) { nodes { bioguideId } } }';

// Build the check function for the two public targets. fetch is injected so
// the green/not-green criteria are testable; any thrown fetch error (DNS, TLS,
// connection refused) counts as not-green — that is the condition being polled.
export function createCheck({ docsUrl, apiUrl, fetch, requestTimeoutMs = 10_000 }) {
  // Per-request abort: a stalled connection fails its round instead of
  // silently eating the whole poll window.
  const docsGreen = async () => {
    const res = await fetch(docsUrl, { signal: AbortSignal.timeout(requestTimeoutMs) });
    return res.ok;
  };
  const apiGreen = async () => {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: PROBE_QUERY }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body.data != null && !body.errors;
  };
  const guard = (probe) => probe().catch(() => false);
  // Probe both targets concurrently: a round costs the slower probe, not the
  // sum — with both stalled at the abort timeout that's twice the rounds in
  // the same window.
  return async () => {
    const [docs, api] = await Promise.all([guard(docsGreen), guard(apiGreen)]);
    return { docs, api };
  };
}
