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

- [ ] Migration: `raw_payloads` table — `source_name`, `natural_key`, `endpoint`,
      `payload JSONB`, `fetched_at TIMESTAMPTZ`, unique on
      `(source_name, natural_key, endpoint)` — plus any core columns missing from
      `bills` (title, introduced date, policy area, latest action, `source_updated_at`).
- [ ] Fetch stage for source `congress-bills`: page the bill-list endpoint for the
      configured congress with `fromDateTime` = fetch cursor, sorted by `updateDate`
      ascending, 250/page. Upsert each page's raw JSON into `raw_payloads` and advance
      the `source_state` fetch cursor (max consumed `updateDate`) **in the same
      transaction** — a crash resumes from the last committed page. Backfill is this
      same code with a NULL starting cursor.
- [ ] Load stage: transform `raw_payloads` rows with `fetched_at` past the load cursor
      into `bills` upserts (`ON CONFLICT (bill_id) DO UPDATE`; preserve the
      `hr3590-111` natural-key format so vote cross-references keep resolving). Advance
      the load cursor and write the `ingestion_runs` row in the same transaction. Gate
      per the plan's gating rule: `raw_payloads` is an owned table, so readiness is a
      staleness comparison on `fetched_at`, not the file-source handshake.
- [ ] Config knobs: API key env var and target congress (the backfill-depth knob).
      When the key is unset, skip cleanly with a loud log line — never crash the cron.
- [ ] Two new hourly entries in `ingester/ingest_cron`; two new nodes in
      `pipeline.manifest.js`; regenerate `PIPELINE.md`; `--check` passes. Follow the
      add-a-source ritual recorded in `AGENTS.md`.
- [ ] Connector contract: document the module shape and where raw lands per source
      type (files for scraped sources, `raw_payloads` for API sources); extract the
      shared helpers bills needs (chunked per-page commit, run logging) alongside the
      existing `cursor-state.js` helpers.
- [ ] Tests: transform unit tests from recorded API fixtures; pagination/cursor resume
      logic (kill mid-backfill → resume from last committed page); suite keeps running
      `--check` against the real repo.

## Human-in-the-loop tasks

- [ ] [verify] Provide the Congress.gov API key (local env + droplet dotenvx) and
      confirm a live fetch+load lands congress-119 bills queryable over GraphQL —
      needs a secret only the user holds and a live, rate-limited API.

## Acceptance criteria

- [ ] `bills` rows for congress 119 are populated from Congress.gov (real titles,
      sponsors, latest actions — not just vote-stub rows) and queryable via GraphQL
- [ ] Killing the fetch mid-backfill and rerunning resumes from the last committed
      page — no restart from zero, no duplicate rows
- [ ] Rerunning fetch+load with nothing new upstream is a cheap no-op
- [ ] `PIPELINE.md` shows the two new nodes; pipeline `--check` is green in CI
- [ ] PR says `Part of #89` and closes nothing (#56 and #89 are tracking issues)
