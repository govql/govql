# Plan: GovQL

> Source: GitHub issue #56 (generalize ingestion architecture) + talk-it-through 2026-06-30.

This is the project's master plan: a durable architectural header plus an ordered
list of task pointers. Each task is one feature on its own branch, ending in a PR.
Task bodies live in `plans/tasks/`; finished tasks move to `plans/tasks/done/`.

This file lives in a generic `plans/` directory and is pointed to from `AGENTS.md`
("Active plan") rather than a Claude-specific `CLAUDE.md`, so the workflow stays
usable across Claude, Codex, and OpenCode.

**PR convention for these tasks**: issue #56 is a *tracking* issue spanning steps
1–5; this plan only implements steps 1+2. Each task's PR must **reference** #56
(e.g. `Part of #56`) and must **not** close it (no `Closes #56`). Steps 3–5 get a
fresh follow-up issue.

## Workflow

- New work is added by the `to-plan` skill: a self-contained task file under
  `plans/tasks/NNNN-<slug>.md` plus a pointer below. It appends; it never creates a
  second plan.
- `implement-next-task` takes the first eligible pointer (or an explicit task
  argument), builds it on its branch — AFK via `tdd`, `[decision]` via
  `talk-it-through`, `[verify]` paused for manual confirmation — runs `task-review`,
  then opens the PR after approval and flips the pointer to `[>]`.
- A pointer has four states: `[ ]` todo · `[~]` in progress (claimed) · `[>]` done,
  PR open, awaiting merge · `[x]` merged to `main`. `sync-main` flips `[>]→[x]` and
  moves the task file to `tasks/done/` once the PR merges. A fifth marker `[-]` means
  **paused / on hold** — deliberately not ready to pick up; selection skips it (it is
  not `[ ]`) until it's flipped back to `[ ]`.
- Pointers carry their direct prerequisites as an `(after NNNN, …)` suffix (none =
  no suffix). A task is selectable only once every ordinal in its `(after …)` list is
  `[x]` (merged).

## Architectural decisions

Durable decisions that apply across all tasks:

- **Monorepo**: `us-congress/` (PostGraphile v5 GraphQL API over PostgreSQL, plus
  cron-based scraper/ingester services and a Docusaurus docs site, orchestrated with
  Docker Compose) and `mcp-server/` (Python/FastMCP). Deployed independently.
- **Schema**: managed by **Flyway** migrations in `us-congress/db/migrations/`
  (`Vnnn__description.sql`, zero-padded, immutable once applied). Per-table API docs
  are **generated from the migration SQL** by `docs/scripts/generate-schema-docs.mjs`
  — the repo's "generate docs from the executable source of truth" idiom.
- **Ingestion model (retained)**: lightweight **cron** scrape→ingest, joined by a
  shared file volume; idempotent upserts on natural keys (`ON CONFLICT`);
  `ingestion_runs` audit log. A Postgres-backed queue (pg-boss or graphile-worker) is
  **deferred** until real fan-out / retry-with-backoff / concurrent-backfill pressure
  arrives; pg-boss is a co-equal/arguably-preferred candidate to graphile-worker.
- **Staged cursors**: ingestion is modeled as three decoupled, independently-gated,
  independently-watermarked stages — `fetch` (scrape) → `load` (ingest raw) →
  `build` (aggregates). A generic `source_state(source_name, stage, cursor TIMESTAMPTZ)`
  table holds the `fetch`/`load` cursors. **Readiness handshake**: `load.cursor` = the
  `fetch.cursor` value the load has fully consumed (read at start, written on success);
  load runs iff `fetch.cursor > load.cursor` (or `load.cursor IS NULL`). The `build`
  stage keeps its existing per-congress `vote_similarity_state` watermark.
- **Gating rule**: an **opaque/external** input (scrape files, an API) → **cursor
  handshake** in `source_state`. An **owned DB table** (has `updated_at`) →
  **staleness comparison**: rebuild when `GREATEST(inputs.updated_at) > built_through`,
  which fans in over multiple inputs for free. No generic DAG/edge table yet.
- **Implicit-DAG documentation**: the pipeline graph is a maintained artifact.
  `us-congress/ingester/pipeline.manifest.js` is the single source of truth (one node
  per stage, `upstream[]` = edges); `generate-pipeline-docs.mjs` renders a stamped
  `us-congress/PIPELINE.md` (Mermaid + node table); a `--check` mode validates the
  manifest against the crontabs and migrations and that `PIPELINE.md` is fresh.
  Adding a source or aggregation requires updating the manifest + regenerating
  (the ritual is recorded in `AGENTS.md`). Runnable via `npm run` only for now;
  CI/CD enforcement is a separate future issue.
- **Deployment (continuous *delivery*)**: the `us-congress` stack ships via
  merge-to-`main` → CI builds four immutable **SHA-tagged, public GHCR images**
  (`scraper`, `ingester`, `server`, docs-baked-into-`nginx` multi-stage) → **one-click
  GitHub `production` environment approval** → the droplet's unprivileged `govql` user
  pulls the pinned images and `docker compose up -d` (systemd one-shot, compose
  `restart: always` for crash recovery) → external health check → changelog stamped and
  committed back. The droplet **never builds**; app secrets stay on the box in dotenvx
  and **never enter CI**. Migrations remain **forward-only** (Flyway on `up`), so an image
  rollback does not undo a schema change. The manual approval gate is deliberate (public
  API, thin test coverage) and removable in one setting to graduate to continuous
  deployment. Source PRD: [`plans/prds/us-congress-continuous-delivery.md`](prds/us-congress-continuous-delivery.md).

---

## Tasks

- [x] 0001 · source_state cursor, fetch→load readiness, decoupled build stage → tasks/done/0001-source-state-cursor-decoupled-stages.md
- [-] 0002 · Pipeline DAG manifest, generator + drift validator (after 0001) — ⏸ paused 2026-07-13, not ready → tasks/0002-pipeline-dag-manifest.md
- [x] 0003 · CI: build & push SHA-tagged images to GHCR → tasks/done/0003-ci-build-push-images.md
- [x] 0004 · One-click production deploy + notifications (after 0003) → tasks/done/0004-one-click-production-deploy.md
- [x] 0005 · Post-deploy external health check (after 0004) → tasks/done/0005-post-deploy-health-check.md
- [x] 0006 · Automated changelog stamp (after 0004, 0005) → tasks/done/0006-changelog-stamp.md
- [x] 0007 · Rollback & on-demand redeploy (after 0004) → tasks/done/0007-rollback-redeploy.md
- [x] 0008 · Deployment docs & runbook (after 0004, 0005, 0006, 0007) → tasks/done/0008-deployment-docs.md
- [x] 0009 · Target node24-runtime action versions in the workflow (after 0003, 0004, 0005, 0006, 0007) → tasks/done/0009-workflow-node24-actions.md
