# Task 0001: source_state cursor, fetch→load readiness, decoupled build stage

**Branch**: `feature/source-state-cursor-decoupled-stages`
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

- [ ] Add `V003__source_state.sql`: `source_state(source_name TEXT, stage TEXT CHECK (stage IN ('fetch','load')), cursor TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (source_name, stage))`, with an `@omit` table comment (internal, like `vote_similarity_state`). It holds no secrets, so the blanket `grafana_reader` SELECT is fine — no REVOKE needed.
- [ ] Re-run `npm run generate-schema-docs`; confirm the `@omit` table is excluded from / handled by the generated schema docs (match how `vote_similarity_state` is treated).
- [ ] Add a small reusable cursor helper (read `fetch`/`load` cursor for a source; advance `load` cursor to a captured value) used by both ingesters; write `node:test` unit tests for the pure readiness predicate (`run iff fetch.cursor > load.cursor or load.cursor IS NULL`, else skip).
- [ ] `ingest-votes.js`: at run start read `congress-votes` `fetch` cursor; if not ready, log and exit 0 without walking; on success advance the `load` cursor to the captured `fetch` value. Remove the aggregate-build section (moves to `build-aggregates.js`).
- [ ] `ingest-legislators.js`: same `fetch`→`load` readiness gate + `load` cursor advance for `congress-legislators`.
- [ ] New `build-aggregates.js`: move `staleCongresses()` + `rebuildAggregatesForCongress()` + the per-congress rebuild loop here, with its own `ingestion_runs` row (`run_type = 'vote_aggregates'`) and the votes-ingest healthcheck split appropriately. Logic and `vote_similarity_state` semantics unchanged.
- [ ] Scraper container: add `postgresql-client` to `scraper/Dockerfile`; add `DATABASE_URL` to the `scraper` service in `compose.yml`. After each successful scrape, UPSERT the `fetch` cursor (`now()`) via `psql` — for the votes cron line and in/after `update-legislators.sh` — only on success.
- [ ] Ingester crontab: keep the votes `load` and legislators `load` lines (soft schedule), add a `build-aggregates.js` line scheduled after the votes load. Remove any reliance on the old "15-min buffer" comment/coupling.
- [ ] Add `node:test` test scripts to `ingester/package.json` (`node --test`) so the readiness/cursor logic is covered without new deps.

## Human-in-the-loop tasks

- [ ] [verify] On a real `docker compose -f compose.yml -f compose.dev.yml up`, trigger a scrape and confirm end-to-end: the scraper writes the `fetch` cursor to `source_state`; each ingester **skips** when the `fetch` cursor hasn't advanced and **runs + advances `load`** when it has; `build-aggregates.js` runs as its own cron job and rebuilds only stale congresses. — Cron scheduling, container env-sourcing (`printenv > /etc/environment`), and cross-container DB writes can't be exercised by `node:test`, and the repo has no docker-based integration harness or CI yet (CI is a separate future issue).

## Acceptance criteria

- [ ] `V003__source_state.sql` applies cleanly via the `flyway` service; `source_state` is `@omit`'d from the GraphQL schema.
- [ ] On a successful scrape, the scraper writes a `fetch` cursor row for `congress-votes` and `congress-legislators`.
- [ ] Each ingester exits 0 with a clear log line when `fetch.cursor` has not advanced past `load.cursor`, and otherwise runs and advances `load.cursor` to the captured `fetch.cursor` only after a successful run (crash mid-run leaves `load.cursor` unadvanced → next run re-checks ready and re-walks idempotently).
- [ ] Aggregates are built by `build-aggregates.js` as a separate cron job; `ingest-votes.js` no longer builds aggregates; `vote_similarity_state` staleness/rebuild behavior and `needsIngestion()` per-record skipping are unchanged.
- [ ] No wall-clock dependency remains between scrape and ingest — the readiness check is the only correctness gate; cron times are documented as a soft schedule.
- [ ] `node:test` covers the readiness predicate and cursor-advance logic and passes via `npm test` in `ingester/`.
