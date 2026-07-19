# Task 0011: Bill sub-entities + detail — cosponsors, subjects, summaries, detail, titles

**Branch**: `feature/bill-sub-entities`
**Depends on**: 0010
**Source**: talk-it-through 2026-07-15 · GitHub issue #89 (sub-issue of #56) ·
extended 2026-07-16 after 0010's verify (detail + titles endpoints added)

## What to build

Extend the bills connector's fetch stage with the **per-bill fan-out**: for each bill
whose `updateDate` moved, pull **five** endpoints into `raw_payloads` — cosponsors,
subjects, and summaries (child tables), plus the **bill detail** endpoint
(`/bill/{congress}/{type}/{number}`) and the **titles** endpoint (`/titles`), which
enrich the `bills` row itself. Extend the load stage to transform those rows into the
existing `bill_cosponsors` table, new `bill_subjects` / `bill_summaries` tables, and
the `bills` columns that 0010's list endpoint could not populate: `sponsor_bioguide_id`,
`introduced_at`, `policy_area`, `enacted_as_law_type`/`enacted_as_number` (detail) and
`official_title`/`short_title`/`popular_title` (titles). This closes 0010's deferred
"sponsors" acceptance criterion.

This is the task that exercises chunked, checkpointed batching under real request
volume: the initial fan-out over congress 119 (~17.5k bills × 5 endpoints) is ~90k
requests against the 5,000/hour api.data.gov budget — roughly a day of drip-feeding
that must survive interruption.

Amendments and full bill text stay out of scope (deferred in #89 until something
consumes them). Whether to *derive* `status`/`status_at` from the action history is
parked separately in issue #91 — not this task.

## AFK tasks

- [x] Migration: `bill_subjects` and `bill_summaries` tables (natural-keyed on
      `bill_id` + the sub-entity's own identity, idempotent upserts or
      DELETE+re-INSERT per bill, matching the repo's existing child-row pattern).
      → `V007__bill_subjects_and_bill_summaries.sql`; smoke-applied on a throwaway
      Postgres 16 via the repo's Flyway image.
- [x] Fetch fan-out: after each consumed list page, fetch the five per-bill
      endpoints (cosponsors, subjects, summaries, detail, titles) per changed bill
      into `raw_payloads` (one row per endpoint per bill), still committing and
      advancing the fetch cursor per chunk so an interrupted fan-out resumes without
      re-fetching completed bills.
      → `fetchPagesIntoRaw` now commits in chunks (default 25 bills); a bill's list
      row + its five endpoint payloads + the cursor advance are one transaction, so
      resume sees completed bills as unchanged and skips their fan-out. Paginated
      sub-endpoints are merged before the write. Malformed list items skip fan-out
      with a logged count instead of 404ing the run forever.
- [x] Rate-budget guard: stay under the hourly request limit (throttle or bail out
      cleanly mid-run and resume next cron tick — either is fine, pick one and
      document it in the connector contract).
      → **Decision: bail out cleanly, not throttle.** `requestBudget` counter
      (`CONGRESS_GOV_HOURLY_REQUEST_BUDGET`, default 4000 of the 5,000/hr limit);
      refused check stops the run before the next bill, run returns unverified and
      the next cron tick resumes from the committed cursors. Documented in
      CONNECTORS.md ("Request budget") and PLAN.md's source-connector decision.
- [x] Load stage: transform sub-entity raw rows into `bill_cosponsors` (existing
      table), `bill_subjects`, `bill_summaries`, in the same cursor-gated transaction
      pattern as 0010.
      → `loadStaleCosponsorRaws` / `loadStaleSubjectRaws` / `loadStaleSummaryRaws`:
      DELETE+re-INSERT per bill in one transaction; cosponsors use the FK-safe
      unnest JOIN with logged drops. One load cursor spans all six endpoints;
      `rawReadiness` is now source-wide. The keyset batch reader was extracted
      (`staleRawBatches`) — the extraction CONNECTORS.md had flagged for the second
      consumer.
- [x] Bills-row enrichment from detail + titles raws (FK-safe sponsor, COALESCE
      no-NULL-overwrite, most-recent title per type).
      → `loadStaleDetailRaws` / `loadStaleTitleRaws`; unknown sponsor bioguide →
      NULL with a log line; every enrichment column COALESCEs onto its current value.
- [x] Update the two manifest nodes' reads/writes; regenerate `PIPELINE.md`;
      `--check` green.
      → fetch-bills reads the five endpoints; ingest-bills writes the three child
      tables and reads legislators. `npm run check-pipeline-docs` green.
- [x] Tests: transforms from recorded fixtures for all five endpoints;
      resume-after-interrupt behavior for the fan-out; rate-guard behavior;
      no-NULL-overwrite behavior for the bills-row enrichment.
      → 20 new tests (89 total, all green); five recorded fixtures under
      `src/connectors/fixtures/`.

## Human-in-the-loop tasks

- [ ] [verify] Watch the live fan-out complete for congress 119 (cosponsors, subjects,
      summaries populated, request rate within budget) — it runs over hours on the
      live rate-limited API, which a test can't compress.

## Acceptance criteria

- [ ] Cosponsors, subjects, and summaries for congress-119 bills are queryable via
      GraphQL and consistent with the Congress.gov site for spot-checked bills
- [ ] Congress-119 `bills` rows carry sponsor, introduced date, policy area,
      enacted-as, and the official/short/popular titles where Congress.gov provides
      them (closes 0010's deferred "sponsors" criterion)
- [ ] Interrupting the fan-out mid-run loses no completed work and re-fetches no
      completed bill on resume
- [ ] Steady-state hourly runs fetch only bills whose `updateDate` moved
- [ ] `PIPELINE.md` reflects the updated nodes; pipeline `--check` green in CI
- [ ] PR says `Part of #89` and closes nothing

## Implementation log

- 2026-07-17: Built on `feature/bill-sub-entities`. Key files:
  `us-congress/db/migrations/V007__bill_subjects_and_bill_summaries.sql`,
  `us-congress/ingester/src/connectors/congress-bills.js` (fan-out + budget +
  five transforms + five loaders), `src/fetch-bills.js` / `src/ingest-bills.js`
  (wiring), `pipeline.manifest.js` + regenerated `PIPELINE.md`, CONNECTORS.md
  (fan-out endpoint-tag convention + request-budget strategy), schema docs
  regenerated (generator's TABLE_ORDER gained the two new tables), compose.yml +
  README gained `CONGRESS_GOV_HOURLY_REQUEST_BUDGET`.
- 2026-07-17 (review round): applied all 16 findings from
  `reviews/0011-bill-sub-entities-review.md` with user approval. Highlights:
  V008 data-reset migration so the fan-out backfills the already-ingested
  congress-119 bills (user-chosen approach); fan-out HTTP moved BEFORE the
  chunk transaction (read-only changed-check + in-memory payloads, DB-only
  txn) so slow requests can't strand rows behind the load's grace cap;
  per-request 30s timeout; sub-endpoint 404 stored as empty payload instead
  of wedging the pipeline; pagination.next origin check (key can't leak off
  the API origin); batched bill-existence probe (no N+1); cosponsor dedupe;
  null-safe transformDetail; fixtures replaced with real recorded responses
  from /v3/bill/119/s/5 (Laken Riley Act — enacted, so it exercises `laws`);
  docs generator naming maps fixed (undefinedsConnection); CHANGELOG
  [Unreleased] entries; CONNECTORS.md load-row admits per-entity replacement;
  summary_text documented as unsanitized upstream HTML (user chose document
  over sanitize); PLAN.md rate-budget paragraph kept (user chose to promote
  it to a durable decision); error-asymmetry + omitted-fields tests added.
  95 tests green.
- 2026-07-18 (review round 2): applied 10 of the 11 residual findings with
  user approval (skipped only the branch-naming process note). Highlights:
  a 404 mid-pagination now fails the run instead of storing an empty set
  over real child rows (404-as-empty is first-request-only); pagination.next
  resolves relative URLs against the base before the origin check; the
  changed-check gained a has-detail backstop (a listed bill missing its
  bill-detail raw fans out even if its list payload is unchanged) plus a
  deploy-order note in V008; summaries loader batch dropped to 50 under the
  64 MB heap; detail/titles UPDATEs got a no-op WHERE guard so updated_at
  never bumps without a change (explicit ::text/::date casts — real Postgres
  rejected the guard without them); fanoutSkipped now surfaces in the run
  summary and outcome; stale "committed page" wording fixed; docs generator
  unescapes SQL doubled quotes; NEW `npm run test:integration` runs
  *.pg-integration.test.js against a throwaway dockerized Postgres migrated
  with the real migrations — it pins the jsonb changed-check (reordered-key
  payload does not re-fan-out) and COALESCE/updated_at semantics, and its
  first run caught the cast bug. 99 stub tests + 2 pg tests green.
- 2026-07-18 (review round 3): applied all four residual findings with user
  approval. requestBudget latches exhausted on any refusal (a NaN limit from
  a malformed env var previously refused everything while reporting verified
  runs) and fetch-bills validates the env var with a fallback; pagination.next
  now resolves against the returning page's URL (path-relative links keep
  /v3); the pg-integration suite runs in CI (new workflow step); sub-endpoint
  404 counts (fanoutNotFound) surface in the run summary and ingestion_runs
  outcome alongside fanoutSkipped. 100 stub tests + 2 pg tests green.
- 2026-07-19 (review rounds 4-5, converged): applied the three round-4
  findings (TCP readiness probe in the integration runner — the socket-only
  init-phase server could flake the deploy-gating CI job; workflow.test.js
  pins the test:integration step; budget env fallback warns and allows 0 as
  an explicit pause) plus the round-5 delta finding (validate the budget env
  var as a raw digit string — parseInt prefix parsing let '1e3'→1 evade the
  warn). Round-5 re-check: no open findings. Final: 100 stub + 2 pg
  integration + 50 deploy invariant tests green, pipeline --check green.
- Decisions made in-flight (no [decision] items were open): rate strategy =
  clean bail-out (documented); fan-out chunk size 25; one load cursor spans all
  six endpoints (each loader drains its endpoint's backlog, so the shared
  advance strands nothing); sub-entity raws whose bills row is missing are
  counted + skipped (deterministic transform-reject family); a started bill's
  fan-out always completes so stored payloads are never truncated merges
  (budget default leaves headroom for the overrun).
