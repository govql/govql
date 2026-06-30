# Task 0001: source_state cursor, fetch→load readiness, decoupled build stage

**Branch**: `56-source-state-cursor-decoupled-stages`
**Depends on**: none
**Source**: GitHub issue #56 (steps 1+2) · talk-it-through 2026-06-30 · **User stories**: as the data platform, I want each ingestion stage to gate on an explicit upstream cursor instead of a wall-clock buffer, and to run aggregates as their own job, so adding sources doesn't depend on cron timing luck.
**PR**: reference #56 (`Part of #56`); do **not** close it — it's a tracking issue spanning steps 1–5.

## What to build

Reshape the `us-congress` ingestion pipeline from "scrape at :35, ingest at :50 (15-min buffer), build aggregates in the same process" into three decoupled, cursor-gated stages — `fetch` → `load` → `build` — for both existing sources (votes, legislators).

- A generic `source_state(source_name, stage, cursor TIMESTAMPTZ)` table holds the `fetch` and `load` cursors (the `build` stage keeps its existing per-congress `vote_similarity_state` watermark, untouched).
- The **scraper** gains DB access and, on each successful scrape, UPSERTs its `fetch` cursor = `now()`.
- Each **ingester** reads its source's `fetch` cursor at the start of a run, **skips** (clean no-op, exit 0, logged) when `fetch.cursor` has not advanced past `load.cursor`, and on a successful full run advances `load.cursor` to the `fetch.cursor` value it captured at the start. Existing per-record `needsIngestion()` skip logic and all `ON CONFLICT` idempotency are preserved.
- Aggregate building is split out of `ingest-votes.js` into a new `build-aggregates.js` with its own cron schedule and its own `ingestion_runs` row; `staleCongresses()` / `rebuildAggregatesForCongress()` / the `vote_similarity_state` watermark semantics move verbatim and stay self-gating.

The readiness handshake — not the cron time — is the correctness gate; cron times become a soft schedule only. See the master plan's "Staged cursors" decision for the durable cursor semantics.

## AFK tasks

- [x] Add `V003__source_state.sql`: `source_state(source_name TEXT, stage TEXT CHECK (stage IN ('fetch','load')), cursor TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (source_name, stage))`, with an `@omit` table comment (internal, like `vote_similarity_state`). It holds no secrets, so the blanket `grafana_reader` SELECT is fine — no REVOKE needed.
- [x] Re-run `npm run generate-schema-docs`; confirm the `@omit` table is excluded from / handled by the generated schema docs (match how `vote_similarity_state` is treated).
- [x] Add a small reusable cursor helper (read `fetch`/`load` cursor for a source; advance `load` cursor to a captured value) used by both ingesters; write `node:test` unit tests for the pure readiness predicate (`run iff fetch.cursor > load.cursor or load.cursor IS NULL`, else skip).
- [x] `ingest-votes.js`: at run start read `congress-votes` `fetch` cursor; if not ready, log and exit 0 without walking; on success advance the `load` cursor to the captured `fetch` value. Remove the aggregate-build section (moves to `build-aggregates.js`).
- [x] `ingest-legislators.js`: same `fetch`→`load` readiness gate + `load` cursor advance for `congress-legislators`.
- [x] New `build-aggregates.js`: move `staleCongresses()` + `rebuildAggregatesForCongress()` + the per-congress rebuild loop here, with its own `ingestion_runs` row (`run_type = 'vote_aggregates'`) and the votes-ingest healthcheck split appropriately. Logic and `vote_similarity_state` semantics unchanged.
- [x] Scraper container: add `postgresql-client` to `scraper/Dockerfile`; add `DATABASE_URL` to the `scraper` service in `compose.yml`. After each successful scrape, UPSERT the `fetch` cursor (`now()`) via `psql` — for the votes cron line and in/after `update-legislators.sh` — only on success.
- [x] Ingester crontab: keep the votes `load` and legislators `load` lines (soft schedule), add a `build-aggregates.js` line scheduled after the votes load. Remove any reliance on the old "15-min buffer" comment/coupling.
- [x] Add `node:test` test scripts to `ingester/package.json` (`node --test`) so the readiness/cursor logic is covered without new deps.

## Human-in-the-loop tasks

- [x] [verify] On a real `docker compose -f compose.yml -f compose.dev.yml up`, trigger a scrape and confirm end-to-end: the scraper writes the `fetch` cursor to `source_state`; each ingester **skips** when the `fetch` cursor hasn't advanced and **runs + advances `load`** when it has; `build-aggregates.js` runs as its own cron job and rebuilds only stale congresses. — **Verified live 2026-06-30:** V003 applied via real Flyway (`@omit` confirmed); `write-fetch-cursor.sh` wrote `fetch` rows for both sources (env via `pam_env`/`/etc/environment` confirmed in the real container); ingesters skipped when `fetch ≤ load` and ran + advanced `load` when `fetch > load`; `build-aggregates.js` ran as its own job (`run_type='vote_aggregates'`) and rebuilt all 12 stale congresses. Two issues surfaced and fixed during verify (see log): an aggregate-rebuild OOM and a µs cursor-precision bug.

## Acceptance criteria

- [x] `V003__source_state.sql` applies cleanly via the `flyway` service; `source_state` is `@omit`'d from the GraphQL schema. _(Verified by applying V001+V003 to a throwaway Postgres: table/PK/CHECK/`@omit` all correct; `generate-schema-docs` excludes it. The `flyway`-service path specifically is part of the live [verify].)_
- [x] On a successful scrape, the scraper writes a `fetch` cursor row for `congress-votes` and `congress-legislators`. _(Verified live: `write-fetch-cursor.sh` wrote both rows from the real scraper container.)_
- [x] Each ingester exits 0 with a clear log line when `fetch.cursor` has not advanced past `load.cursor`, and otherwise runs and advances `load.cursor` to the captured `fetch.cursor` only after a successful run (crash mid-run leaves `load.cursor` unadvanced → next run re-checks ready and re-walks idempotently). _(Readiness predicate + cursor-advance unit-tested; advance happens only on the success path.)_
- [x] Aggregates are built by `build-aggregates.js` as a separate cron job; `ingest-votes.js` no longer builds aggregates; `vote_similarity_state` staleness/rebuild behavior and `needsIngestion()` per-record skipping are unchanged.
- [x] No wall-clock dependency remains between scrape and ingest — the readiness check is the only correctness gate; cron times are documented as a soft schedule.
- [x] `node:test` covers the readiness predicate and cursor-advance logic and passes via `npm test` in `ingester/`.

## Implementation log

- **Built (commit `25f46b4`):** `db/migrations/V003__source_state.sql`; `ingester/src/cursor-state.js` (pure `isReady()` + `readCursor`/`advanceLoadCursor`/`loadReadiness`) with `cursor-state.test.js` (10 `node:test` cases); readiness gate + load-cursor advance in `ingest-votes.js` and `ingest-legislators.js`; new `ingester/src/build-aggregates.js`; `scraper/write-fetch-cursor.sh`; edits to `scraper/Dockerfile`, `scraper/scrape_cron`, `scraper/update-legislators.sh`, `ingester/ingest_cron`, `ingester/package.json`, `compose.yml`.
- **Review + fixes (commit `bf8abd9`):** task-review panel run; its headline "blocker" (cron can't pass `DATABASE_URL` to `write-fetch-cursor.sh`) was investigated to ground truth and **dismissed as a false positive** (pam_env / busybox crond deliver the env; verified empirically against the real base images incl. a special-char URL). Applied four genuine findings: crontab env-delivery comments; `build-aggregates` fails + skips its healthcheck on a total rebuild outage; test pins the `'load'` stage; votes scrape healthcheck decoupled from the cursor write. Deferred: cursor-advance/ordering nit and SQL-bind nit (left as-is); least-privilege scraper role → **follow-up issue**.
- **Decisions:** `isReady` treats a null `fetch` cursor as not-ready (nothing fetched → skip), a deliberate refinement of the literal predicate; load cursor advances only on a run with no thrown error (matches the existing `ingestion_runs` success notion); the build stage stays self-gating on `vote_similarity_state` (no `source_state` cursor). `DATABASE_URL` derives from `us-congress/.env` (dotenvx) as `postgresql://…@postgres:5432/…`.
- **Live-verify fixes (commit `a53e8fe`):** the docker `[verify]` surfaced two issues, both fixed and re-verified on the live stack:
  1. **Aggregate-rebuild OOM** — the pairwise self-join emits ~100M rows; at the default `work_mem` (2MB) the HashAggregate spilled to ~128 temp partitions and the temp-file page cache OOM-killed the 256M postgres container (the whole cluster). Fixed with a transaction-local `SET LOCAL work_mem='32MB'` + `max_parallel_workers_per_gather=0` + `jit=off` in `rebuildAggregatesForCongress` (keeps the small ~150k-group aggregate in memory, no spill). The 12-congress backfill that previously crashed postgres now completes. **Not a regression** (the aggregate SQL is verbatim from `main`'s `ingest-votes.js`, which loops over all stale congresses identically) — but fixed here because automating the rebuild as an hourly job could hit the full-backfill case in production.
  2. **µs cursor precision** — `readCursor` returned a JS `Date` (ms), truncating the `fetch` value (`now()`, µs), so `load` was stored a few µs behind what it consumed (a latent "perpetually ready" trap, the same JS-ms-vs-PG-µs class the watermark already guards against). `readCursor` now reads via `to_char(... 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and writes the exact string back; verified live that `load == fetch` to the µs.
  Both gotchas are now documented in `AGENTS.md`.
- **Decision docs referenced:** master plan "Staged cursors" / "Gating rule" / "Implicit-DAG documentation". Review at `reviews/0001-source-state-cursor-decoupled-stages-review.md` (branch-scoped, gitignored).
