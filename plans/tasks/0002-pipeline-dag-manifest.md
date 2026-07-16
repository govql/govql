# Task 0002: Pipeline DAG manifest, generator + drift validator

**Branch**: `56-pipeline-dag-manifest`
**Depends on**: 0001
**Source**: GitHub issue #56 · talk-it-through 2026-06-30 · **User stories**: as a maintainer adding new sources/aggregations, I want the implicit cron+cursor DAG to be a generated, validated artifact, so the pipeline stays understandable and the docs can't silently drift from what actually runs.
**PR**: reference #56 (`Part of #56`); do **not** close it — it's a tracking issue spanning steps 1–5.

## What to build

Make the implicit ingestion DAG an explicit, maintained artifact, following the repo's "generate docs from the executable source of truth" idiom (mirrors `generate-schema-docs.mjs`). Depends on 0001 because the manifest must describe the post-0001 reality (the `fetch`/`load`/`build` stages, `source_state`, the new `build-aggregates` cron line).

- `ingester/pipeline.manifest.js` — the single source of truth: one node per stage (`scrape-votes`/`ingest-votes`/`build-aggregates`/`scrape-legislators`/`ingest-legislators`), each `{ id, stage, domain, upstream[], reads[], writes[], trigger{cron, readiness}, watermark{table, key, advances}, idempotency }`. `upstream[]` is the DAG's edge set.
- `generate-pipeline-docs.mjs` — renders a stamped, internal `us-congress/PIPELINE.md` (a Mermaid `graph LR` of nodes/edges + a per-node table). Lives next to `README.md`, **not** on the consumer Docusaurus site (per the changelog scope rule, scraper/ingester internals aren't consumer-facing).
- A `--check` mode on the generator that **fails (non-zero)** on drift: every manifest node with a `trigger.cron` matches a line in `ingester/ingest_cron` / `scraper/scrape_cron` and vice-versa; every table named in `reads`/`writes`/`watermark` exists in the migrations (reuse the schema-docs migration parser); and `PIPELINE.md` is up to date (regenerate to memory, diff). Runnable via `npm run` only — no CI runner yet (option B).
- The upkeep ritual recorded in `AGENTS.md`.

## AFK tasks

- [x] Write `ingester/pipeline.manifest.js` enumerating the five current nodes with their `upstream[]` edges and the fields above, reflecting the post-0001 crontabs, `source_state` cursors, and `vote_similarity_state` build watermark.
- [x] Write `generate-pipeline-docs.mjs` (sibling pattern to `generate-schema-docs.mjs`, with a stamped "generated — do not edit" header) that renders `us-congress/PIPELINE.md` with a Mermaid `graph LR` + a per-node table.
- [x] Implement `--check`: parse both crontabs and assert manifest↔crontab parity; parse `db/migrations/` and assert all referenced tables exist; regenerate `PIPELINE.md` to memory and fail if it differs from the committed file.
- [x] Add `npm run generate-pipeline-docs` and a `--check` invocation to `ingester/package.json` (use relative paths to reach `../scraper/scrape_cron` and `../db/migrations`); add `node:test` tests covering the validator: a consistent manifest passes; an extra/missing crontab node fails; a referenced non-existent table fails; a stale `PIPELINE.md` fails.
- [x] Generate and commit `us-congress/PIPELINE.md`.
- [x] Add the ritual to `AGENTS.md`: "Adding a data source or aggregation? Add its node(s) to `ingester/pipeline.manifest.js` using the standard fields, run `npm run generate-pipeline-docs`, and commit the regenerated `PIPELINE.md`; `--check` validates the manifest against the crontabs and schema." Cross-reference the master plan's "Staged cursors" and "Gating rule" decisions.

## Acceptance criteria

- [x] `pipeline.manifest.js` enumerates all current pipeline nodes and their dependency edges.
- [x] `npm run generate-pipeline-docs` produces `us-congress/PIPELINE.md` with a Mermaid DAG and a per-node table, carrying a generated-file header.
- [x] `--check` exits non-zero when (a) a crontab job has no manifest node or vice-versa, (b) a referenced table is absent, or (c) `PIPELINE.md` is stale; and exits zero when everything is consistent.
- [x] `AGENTS.md` documents the add-a-source/aggregation ritual.
- [x] `node:test` covers the validator's pass and fail cases and passes via `npm test` in `ingester/`.

## Implementation log (2026-07-15)

Built on branch `56-pipeline-dag-manifest`; 39 `node:test` tests, all green.

- **Key files:** `us-congress/ingester/pipeline.manifest.js` (manifest, five nodes),
  `us-congress/ingester/scripts/generate-pipeline-docs.mjs` (generator + `--check`),
  `us-congress/ingester/scripts/generate-pipeline-docs.test.js`,
  `us-congress/PIPELINE.md` (generated), `AGENTS.md` ritual section, npm scripts
  `generate-pipeline-docs` / `check-pipeline-docs`.
- **Decisions:**
  - `reads`/`writes` entries carry `table:` / `file:` / `external:` prefixes; only
    `table:` entries are validated against migrations.
  - Cron matching keys on schedule + a stable command substring (the two crontabs
    use different formats: 5-field busybox vs cron.d with a user field); `--check`
    always validates the fixed `KNOWN_CRONTABS` set, union'd with manifest refs.
  - The schema-docs parser was **not** reused (unexported; its module runs `main()`
    on import) — a documented, deliberately divergent parser lives in the generator.
  - `--check` also enforces structure beyond the spec: unique ids, known upstream
    refs, required fields present, exactly-one cron match per node.
  - `PIPELINE_DOCS_ROOT` env var points `--check` at a fixture root for CLI tests.
  - No dedicated CI step: the test suite runs `--check` against the real repo, and
    existing CI runs the suite — PLAN.md's "Implicit-DAG documentation" bullet
    updated to say so.
- **Review:** three passes in `reviews/0002-pipeline-dag-manifest-review.md`
  (gitignored). 17 findings fixed across rounds; one accepted limitation (N2:
  dollar-quoted `$$` SQL bodies aren't stripped by the table parser).
