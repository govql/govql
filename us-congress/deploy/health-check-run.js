#!/usr/bin/env node
// Thin wrapper around the poller core (health-check.js): real fetch, real
// clock, per-round progress on stdout, and the process exit code as the
// verdict — a non-zero exit fails the deploy job, which drives the existing
// failure Slack ping. Runs on the CI runner against the live public URLs, so
// it exercises the real DNS/TLS/nginx path, not container status.
import { poll, createCheck } from './health-check.js';

const docsUrl = process.env.HEALTH_DOCS_URL ?? 'https://govql.us';
const apiUrl = process.env.HEALTH_API_URL ?? 'https://api.govql.us/graphql';
// ~2 minutes: long enough that normal startup (compose up, migrations, server
// boot) is not a false failure; short enough to fail a broken deploy promptly.
const timeoutMs = Number(process.env.HEALTH_TIMEOUT_MS ?? 120_000);
const intervalMs = Number(process.env.HEALTH_INTERVAL_MS ?? 5_000);

const check = createCheck({ docsUrl, apiUrl, fetch });
const loggedCheck = async () => {
  const results = await check();
  const red = Object.keys(results).filter((target) => !results[target]);
  console.log(red.length === 0 ? 'all targets green' : `waiting — not green: ${red.join(', ')}`);
  return results;
};

console.log(`health check: docs=${docsUrl} api=${apiUrl} timeout=${timeoutMs}ms`);
const result = await poll(loggedCheck, {
  timeoutMs,
  intervalMs,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

if (!result.ok) {
  console.error(`health check FAILED: still not green after ${timeoutMs}ms: ${result.failed.join(', ')}`);
  process.exit(1);
}
console.log('health check passed');
