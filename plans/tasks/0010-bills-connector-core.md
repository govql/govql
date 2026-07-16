# Task 0010: Connector contract + raw_payloads + bills core fetch/load

**Branch**: `feature/bills-connector-core`
**Depends on**: none
**Source**: talk-it-through 2026-07-15 · GitHub issue #89 (sub-issue of #56)

## What to build

An end-to-end bills pipeline for the configured congress (119 to start): a **fetch stage**
pages core bill metadata from the Congress.gov API bill-list endpoint into a new
`raw_payloads` Postgres table, and a **load stage** transforms those raw rows into the
existing `bills` table. Both stages are hourly cron entries in the ingester container,
cursor-tracked in `source_state`, and declared in the pipeline manifest. Along the way,
establish the **source-connector contract** — a documented module shape
(`discover → fetch(→raw) → transform → load` + watermark) plus shared helpers — with
bills as its first implementer.

Scope guard: **core list-endpoint fields only**. Per-bill sub-entity calls (cosponsors,
subjects, summaries) are task 0011. Durable decisions live in `plans/PLAN.md`
"Architectural decisions" and issue #89 — don't re-litigate them here.

## AFK tasks

- [x] Migration: `raw_payloads` table — `source_name`, `natural_key`, `endpoint`,
      `payload JSONB`, `fetched_at TIMESTAMPTZ`, unique on
      `(source_name, natural_key, endpoint)` — plus any core columns missing from
      `bills` (title, introduced date, policy area, latest action, `source_updated_at`).
- [x] Fetch stage for source `congress-bills`: page the bill-list endpoint for the
      configured congress with `fromDateTime` = fetch cursor, sorted by `updateDate`
      ascending, 250/page. Upsert each page's raw JSON into `raw_payloads` and advance
      the `source_state` fetch cursor (max consumed `updateDate`) **in the same
      transaction** — a crash resumes from the last committed page. Backfill is this
      same code with a NULL starting cursor.
- [x] Load stage: transform `raw_payloads` rows with `fetched_at` past the load cursor
      into `bills` upserts (`ON CONFLICT (bill_id) DO UPDATE`; preserve the
      `hr3590-111` natural-key format so vote cross-references keep resolving). Advance
      the load cursor and write the `ingestion_runs` row in the same transaction. Gate
      per the plan's gating rule: `raw_payloads` is an owned table, so readiness is a
      staleness comparison on `fetched_at`, not the file-source handshake.
- [x] Config knobs: API key env var and target congress (the backfill-depth knob).
      When the key is unset, skip cleanly with a loud log line — never crash the cron.
- [x] Two new hourly entries in `ingester/ingest_cron`; two new nodes in
      `pipeline.manifest.js`; regenerate `PIPELINE.md`; `--check` passes. Follow the
      add-a-source ritual recorded in `AGENTS.md`.
- [x] Connector contract: document the module shape and where raw lands per source
      type (files for scraped sources, `raw_payloads` for API sources); extract the
      shared helpers bills needs (chunked per-page commit, run logging) alongside the
      existing `cursor-state.js` helpers.
- [x] Tests: transform unit tests from recorded API fixtures; pagination/cursor resume
      logic (kill mid-backfill → resume from last committed page); suite keeps running
      `--check` against the real repo.

## Human-in-the-loop tasks

- [ ] [verify] Provide the Congress.gov API key (local env + droplet dotenvx) and
      confirm a live fetch+load lands congress-119 bills queryable over GraphQL —
      needs a secret only the user holds and a live, rate-limited API.

## Acceptance criteria

- [ ] `bills` rows for congress 119 are populated from Congress.gov (real titles,
      sponsors, latest actions — not just vote-stub rows) and queryable via GraphQL
- [x] Killing the fetch mid-backfill and rerunning resumes from the last committed
      page — no restart from zero, no duplicate rows (unit-tested; also smoke-tested
      against a real Postgres)
- [x] Rerunning fetch+load with nothing new upstream is a cheap no-op (payload-diff
      guard on the raw upsert leaves `fetched_at` untouched; verified in the smoke run)
- [x] `PIPELINE.md` shows the two new nodes; pipeline `--check` is green locally
      (CI runs the same suite)
- [ ] PR says `Part of #89` and closes nothing (#56 and #89 are tracking issues)

## Implementation log (2026-07-15)

Built on branch `feature/bills-connector-core`, all 56 ingester tests green,
pipeline `--check` green, plus an end-to-end smoke against a throwaway Postgres 17
(migrations V001+V003–V005 applied; fetch→raw→load→bills round-trip, per-page cursor
advance, stub-row enrichment, and both no-op reruns verified with the real SQL).

What was built, and where:

- `us-congress/db/migrations/V005__raw_payloads_and_bill_core_columns.sql` —
  `raw_payloads` (PK `(source_name, natural_key, endpoint)`, `@omit` from GraphQL,
  staleness index) + new `bills` columns `title`, `policy_area`, `latest_action`,
  `latest_action_at`.
- `us-congress/ingester/src/connectors/congress-bills.js` — the connector: pool-free
  `listPages` (offset pagination, `sort=updateDate asc`, 250/page), `fetchPagesIntoRaw`
  (per-page transaction: raw upserts + `advanceFetchCursor` to max consumed
  `updateDate`), pure `transform` (fixture-tested), `rawReadiness` (owned-table
  staleness gate), `loadStaleRawsIntoBills` (`ON CONFLICT (bill_id) DO UPDATE`).
  Tests + recorded-shape fixture beside it.
- `us-congress/ingester/src/fetch-bills.js` / `src/ingest-bills.js` — thin cron
  entrypoints mirroring `ingest-votes.js` idioms (readiness gate → run row → work →
  atomic cursor+run close → optional healthcheck ping → exit 1 on failure).
- `us-congress/ingester/src/run-log.js` (+ test) — shared `openRun`/`succeedRun`/
  `failRun`; `advanceFetchCursor` added to `cursor-state.js` (+ test).
- `us-congress/ingester/CONNECTORS.md` — the source-connector contract; pointer added
  to `AGENTS.md`.
- Cron `:05` fetch / `:20` load; `fetch-bills` + `ingest-bills` manifest nodes;
  `PIPELINE.md` regenerated; the pinned node-list test updated (5 → 7 nodes).
- Config: `CONGRESS_GOV_API_KEY` (loud clean skip when unset) and
  `CONGRESS_GOV_TARGET_CONGRESS` (default 119), declared in `compose.yml`, documented
  in `us-congress/README.md`.

Decisions made along the way:

- **Congress.gov display title lands in a new `bills.title` column**, not in
  `official_title`/`short_title`/`popular_title` — the list endpoint's `title` is its
  own concept (the latest display title), and overwriting the unitedstates-taxonomy
  columns would be semantically wrong. `introduced_at` and `source_updated_at`
  already existed; only `policy_area`, `latest_action`, `latest_action_at` were added.
- **The list endpoint carries no sponsor, introducedDate, or policyArea** — those need
  per-bill detail calls, which the scope guard defers ("core list-endpoint fields
  only"). `policy_area` is created now (it is on the task's core-column list) but
  stays NULL until 0011-era detail ingestion. The acceptance criterion's "sponsors"
  cannot be satisfied from the list endpoint — flagged for the human verify step.
- **Fetch cursor = max consumed `updateDate` (date-granular), compared and stored as
  strings** (no JS Date round-trip, per AGENTS.md). Resuming re-fetches the boundary
  date; the raw upsert's `WHERE payload IS DISTINCT FROM EXCLUDED.payload` guard makes
  that free and keeps `fetched_at` a truthful staleness watermark.
- **Fetch stage also writes `ingestion_runs`** (`run_type='bills_fetch'`) for
  observability, alongside the load's `run_type='bills'` row.
- **Schema-docs generator extended** to parse `ALTER TABLE … ADD COLUMN` (one column
  per statement) — V001 is immutable, so V005's new columns could not otherwise appear
  in the generated per-table docs.
- Run logging extracted to `run-log.js`; the chunked per-page commit stays inside the
  bills connector until a second API source justifies generalizing it (noted in
  CONNECTORS.md).
