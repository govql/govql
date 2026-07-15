# Task 0005: Post-deploy external health check

**Branch**: `43-post-deploy-health-check`
**Depends on**: 0004
**Source**: PRD [`plans/prds/us-congress-continuous-delivery.md`](../prds/us-congress-continuous-delivery.md) · GitHub issue #43 · **User stories**: 22, 23 — as the operator, I want the pipeline to check the live docs site and API from the outside after a deploy and retry for a couple of minutes, so I know the real public path (DNS, TLS, nginx) works, not just that a container started, and normal startup time isn't mistaken for a failure.
**PR**: reference #43 (`Part of #43`); do **not** close it.

## What to build

Module B — a **health-check poller** that runs from the CI runner against the live public
endpoints after the deploy step (0004) brings the stack up. Given the two public URLs (the
docs site and the API), a trivial GraphQL probe, and a timeout, it polls until **both** are
green or the timeout elapses, then returns pass or fail. The retry/timeout/aggregation
logic is separated from the HTTP call so it is unit-tested against a stubbed HTTP layer;
the thin outer wrapper does the real requests.

A pass lets the deploy be reported a success (and, in 0006, releases the changelog
commit-back). A fail marks the deploy failed and drives the failure Slack ping from 0004.

## AFK tasks

- [x] Write the pure poller core: `poll(check, {timeout, interval})` where `check` returns green/not-green per target; aggregates over both targets; returns pass/fail with which target failed. No HTTP or clock coupling in the core (inject them).
- [x] Write the thin wrapper: real HTTP GET of the docs URL (expect 2xx) and a trivial GraphQL query POST to the API (expect a well-formed data response), retrying for ~2 minutes so normal startup isn't a false failure.
- [x] Add `node:test` (or the stack's test runner) coverage against a stubbed HTTP layer: both green immediately → pass; one target flaps then greens within timeout → pass; a target never greens → fail after timeout; aggregation reports the failing target.
- [x] Wire the poller as a job step after the 0004 deploy step; a fail sets the deploy result to failure (feeding the existing failure notification), a pass sets success.

## Human-in-the-loop tasks

- [ ] [verify] Against a real deploy, the poller correctly greens on the live docs + API and correctly fails a deliberately-broken deploy within the timeout — the true DNS/TLS/nginx public path can only be exercised end-to-end, not in unit tests. *(User will run this against the first real deploy after merge.)*

## Acceptance criteria

- [x] The poller's pure core is unit-tested for pass, retry-then-pass, timeout-fail, and correct failing-target aggregation.
- [x] After a deploy, the pipeline probes both the live docs URL and a real GraphQL query from the runner and retries for ~2 minutes.
- [x] A green result marks the deploy successful; a timeout marks it failed and triggers the failure notification.

## Implementation log (2026-07-13)

Built on branch `43-post-deploy-health-check`, three commits.

- **What was built**: `us-congress/deploy/health-check.js` — pure core: `poll(check, {timeoutMs, intervalMs, now, sleep})` returns `{ok, failed}` with the not-green targets of the last round; `createCheck({docsUrl, apiUrl, fetch, requestTimeoutMs})` probes both targets concurrently (docs GET → 2xx; GraphQL POST of `{ allLegislators(first: 1) { nodes { bioguideId } } }` → 2xx + `data` non-null + no `errors`; thrown fetch errors count as not-green; 10s per-request abort so a hung connection can't eat the window). `us-congress/deploy/health-check-run.js` — thin wrapper: real fetch/clock, per-round logging, 120s/5s defaults overridable via `HEALTH_DOCS_URL`/`HEALTH_API_URL`/`HEALTH_TIMEOUT_MS`/`HEALTH_INTERVAL_MS` (malformed ms values exit 2 loudly instead of a NaN deadline that never times out), exit code = verdict.
- **Wiring**: `.github/workflows/us-congress.yml` deploy job gained checkout (`persist-credentials: false`) + setup-node (24) at the top and the health check as its **final step** — a non-zero exit fails the job and the existing `notify-outcome` job reports ❌; no new secrets, no Slack references in the deploy job (both enforced by existing invariant tests). New invariant in `workflow.test.js`: SSH step exists, health check exists, runs after SSH, is the last step, checkout exists and precedes it.
- **Tests**: 7 new `node:test` tests in `health-check.test.js` (fake clock + stubbed fetch) covering the four spec-named edges plus request shape, abort signals, and all not-green criteria; deploy suite 26/26 green. Smoke-tested live: real endpoints → exit 0; broken API URL → retries, names `api`, exit 1; `HEALTH_TIMEOUT_MS=2m` → exit 2.
- **Decisions**: poller lives in `us-congress/deploy/` (existing ESM/node:test package, tests auto-run by the CI `test` job); PROBE_QUERY reuses the MCP server's canonical minimal query; per-round pass criterion is all targets green in the same round.
- **Review**: `task-review` round 1 (6 findings, all applied: parallel probes, env validation, strengthened invariants, persist-credentials, AGENTS.md deploy bullet) + round 2 (7 smaller findings; user approved fixing only the dead-shebang nit, rest declined). AGENTS.md one-click deploy bullet now names the external health check as the deploy verdict.
