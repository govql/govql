#!/usr/bin/env node
// Thin wrapper around the poller core (health-check.js): real fetch, real
// clock, per-round progress on stdout, and the process exit code as the
// verdict — a non-zero exit fails the deploy job, which drives the existing
// failure Slack ping. Runs on the CI runner against the live public URLs, so
// it exercises the real DNS/TLS/nginx path, not container status.
import { poll, createCheck } from './health-check.js';

// A malformed override must be a loud config error, not NaN: poll's deadline
// comparison is always false against NaN, which would retry forever and hang
// the deploy job until GitHub's 6-hour limit.
const positiveMs = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`invalid ${name}=${raw}: want a positive number of milliseconds`);
    process.exit(2);
  }
  return n;
};

const docsUrl = process.env.HEALTH_DOCS_URL ?? 'https://govql.us';
const apiUrl = process.env.HEALTH_API_URL ?? 'https://api.govql.us/graphql';
// ~2 minutes: long enough that normal startup (compose up, migrations, server
// boot) is not a false failure; short enough to fail a broken deploy promptly.
const timeoutMs = positiveMs('HEALTH_TIMEOUT_MS', 120_000);
const intervalMs = positiveMs('HEALTH_INTERVAL_MS', 5_000);

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
