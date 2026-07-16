# AGENTS.md

Conventions for AI coding agents (and humans) working in this repository. These
are operative rules — follow them. They complement, and do not replace, the
per-package `README.md` files, which this document links to for detail.

When a new cross-cutting convention is decided, add it here so future sessions
inherit it.

## Active plan

The project's master plan lives at [`plans/PLAN.md`](plans/PLAN.md) — a durable
architectural header plus an ordered list of task pointers (task bodies in
`plans/tasks/`, finished ones in `plans/tasks/done/`). It is kept here, in
`AGENTS.md` and a generic `plans/` directory rather than a Claude-specific
`CLAUDE.md`, so the planning workflow stays usable across Claude, Codex, and
OpenCode. New work is appended by the `to-plan` workflow; it never creates a
second plan.

## Linking issues and PRs

Goal: from any issue you can find its PRs, and from any merged PR you can find its
issue — **without** auto-closing a tracking issue that spans many PRs (e.g. an
epic like #56 covering several steps).

The trick is to **reference** an issue, not **link** it. References give two-way
discoverability with no auto-close; links and closing keywords auto-close on merge.

**Do this (no auto-close):**

- In every PR body, write a plain reference — `Part of #N` (or `Refs #N`, or just
  `#N`). This records a cross-reference in issue #N's timeline *and* leaves a
  clickable link in the PR body, in both directions, and does not close the issue.
- Name the branch `<issue#>-<slug>` and create it with
  `git checkout -b <issue#>-<slug> main`. The number ties it to the issue at a
  glance, and a git-created branch is never auto-linked.

**Avoid these (they auto-close the issue on merge, regardless of body text):**

- Closing keywords — `Closes` / `Fixes` / `Resolves #N`. Use one **only** on the
  PR that is meant to close the issue.
- A Development-panel link, including any branch **"Created from" the issue** via
  the GitHub issue UI. Merging *any* PR from such a branch closes the issue even if
  the body says "Part of #N" — this is exactly how #56 was wrongly closed by the
  scaffolding PR #57. After merging anything tied to a tracking issue, confirm it's
  still open (`gh issue view <n> --json state`).

**Close a tracking issue deliberately** — a closing keyword on the final PR, or by
hand once every referenced PR has merged.

**Find them:**

```bash
gh pr list --state all --search "#56 in:body"                          # issue -> PRs
gh pr view <PR#> --json body --jq '[.body | scan("#[0-9]+")] | unique' # PR -> issue
```
**Planning-tool artifacts (Superpowers etc.) go under `plans/`, never
a root `docs/`.** Superpowers defaults to writing plans and specs into
`docs/superpowers/{plans,specs}`, but a new top-level `docs/` at the repo root
broke the on-box deploy (the `govql` user can't create a new entry at the root of
`/opt/govql` — issue #85). Superpowers v5.0+ honors project instructions over its
own defaults, so: **save Superpowers plans to `plans/superpowers/plans/` and specs to
`plans/superpowers/specs/`.** A `.gitignore` guard (`/docs/`) backstops any
pre-v5.0 client that ignores this.

## Repository map

- **`us-congress/`** — US Congress roll-call vote data, served as a GraphQL API
  via PostGraphile v5 over PostgreSQL, with scraper/ingester services and a
  Docusaurus docs site. Orchestrated with Docker Compose. See
  [`us-congress/README.md`](us-congress/README.md).
- **`mcp-server/`** — the GovQL MCP server (Python / FastMCP) that lets AI clients
  query the API. See [`mcp-server/README.md`](mcp-server/README.md).

The two are deployed independently and depend on each other only at runtime via
HTTP.

## Database schema & migrations (Flyway)

The `us-congress` Postgres schema is managed with **Flyway**.

- **All schema changes are Flyway migrations in `us-congress/db/migrations/`.**
  Never edit a schema file in place, and never hand-apply DDL (`psql`/`docker
  exec`) to a live database. The deploy applies pending migrations automatically.
- **Naming: `Vnnn__description.sql`** — capital `V`, a **zero-padded 3-digit**
  sequential version, a **double** underscore, a description, `.sql`
  (e.g. `V003__add_foo_table.sql`). Flyway orders versions numerically; the
  padding keeps directory listings in the same order for humans.
- **Migrations are immutable once applied.** Flyway checksums them and will refuse
  to run if an applied file changed. To alter the schema, add the **next**
  `Vnnn__…` migration — do not rename or edit an existing one.
- **Service-account roles** (e.g. `grafana_reader`) are defined in
  `us-congress/db/roles/`, created at **initdb** (fresh database only). Their
  **grants live in migrations**, because grants track the schema while the role is
  secret-bearing, cluster-global infrastructure. Don't put role passwords in a
  migration; don't put grants in `db/roles/`.
- **Adding a column/table to Grafana's reach** is automatic — `grafana_reader` has
  a blanket `SELECT` plus `ALTER DEFAULT PRIVILEGES`. But any **new table holding
  secrets** must be explicitly `REVOKE`d (see `V002__grafana_reader_grants.sql`,
  which revokes `api_keys`).
- **Deploying (one-click):** every change ships by merge to `main` → CI builds
  SHA-tagged images → a one-click approval on the GitHub `production`
  environment → the droplet checks out the commit and runs
  `us-congress/deploy/deploy.sh` (pull + digest verify + `up -d`) → CI probes
  the live docs site and GraphQL API from outside (retrying ~2 min,
  `us-congress/deploy/health-check-run.js`) — that external health check is the
  deploy verdict Slack reports, not just "containers started". After a healthy
  deploy, CI stamps `us-congress/CHANGELOG.md`'s `Unreleased` section with the
  America/Chicago date and commits it back to `main` (`commit-changelog` job).
  Two loop guards keep that commit from re-deploying, and **both are
  load-bearing**: the push uses the built-in `GITHUB_TOKEN` (its pushes never
  trigger workflows), and the `images` job skips runs whose head commit starts
  with `docs(us-congress): stamp changelog` — the message prefix, the guard,
  and `workflow.test.js` pin each other; change them together. Never run a
  bare `docker compose up` on the droplet — compose resolves `${IMAGE_TAG}` to
  `latest` without the scripts; the manual path is
  `us-congress/deploy/up.sh --pull`. Schema changes ride along: the gated
  one-shot `flyway` service runs `migrate` on the way up and the API server
  restarts after it (existing databases were adopted with a one-time
  `flyway baseline -baselineVersion=1`). **Rollback / on-demand redeploy** is a
  manual `workflow_dispatch` on the same gated deploy job, pointed at any prior
  commit: it pulls that commit's retained SHA-tagged images (no rebuild) with the
  digest gate relaxed — the production approval is the trust boundary — and the
  droplet's forced command takes it via an explicit `rollback <sha>` form that
  bypasses the ancestor-refusal guard (migrations are forward-only, so an image
  rollback does not undo a schema change). Each deploy then prunes superseded
  images (`us-congress/deploy/prune-images.sh`, keeping the current + previous
  SHA set) so the droplet disk stays bounded; GHCR itself is never pruned, so
  older images stay pullable for a rollback. Full dev/prod steps are in
  [`us-congress/README.md`](us-congress/README.md).
- **Flyway image** is pinned to a specific version (`flyway/flyway:12.9.0-alpine`)
  for reproducible deploys — bump it deliberately, not via a floating tag.

### Generated docs depend on the migration SQL

The per-table API docs are generated from the migration files by
`us-congress/docs/scripts/generate-schema-docs.mjs`. Keep migrations hand-written,
readable SQL (the generator parses `CREATE TABLE` / `COMMENT ON` /
`ALTER TABLE … ADD COLUMN` statements — one column per `ADD COLUMN`);
re-run `npm run generate-schema-docs` after schema changes.

## Ingestion pipeline manifest & docs

The `us-congress` ingestion DAG is a maintained artifact.
`us-congress/ingester/pipeline.manifest.js` is the single source of truth — one
node per cron-triggered stage, `upstream[]` as the edge set — and
`us-congress/PIPELINE.md` is generated from it.

**Adding a data source or aggregation?** Add its node(s) to
`ingester/pipeline.manifest.js` using the standard fields (`id`, `stage`,
`domain`, `upstream[]`, `reads[]`/`writes[]` with `table:`/`file:`/`external:`
prefixes, `trigger{cron, readiness}`, `watermark{table, key, advances}`,
`idempotency`), run `npm run generate-pipeline-docs` in `us-congress/ingester`,
and commit the regenerated `PIPELINE.md`. `npm run check-pipeline-docs` (also
exercised by `npm test`) fails on drift: a crontab job with no manifest node or
vice-versa, a referenced table missing from `db/migrations/`, or a stale
`PIPELINE.md`.

New nodes follow the master plan's ingestion decisions
([`plans/PLAN.md`](plans/PLAN.md) "Staged cursors" and "Gating rule"): an
opaque/external input gets a `source_state` fetch→load cursor handshake; an
owned DB table gets a staleness comparison against its watermark.

New sources implement the **source-connector contract** — module shape, where
raw lands per source type (files for scraped sources, `raw_payloads` for API
sources), watermark rules, and the shared helpers — documented in
[`us-congress/ingester/CONNECTORS.md`](us-congress/ingester/CONNECTORS.md),
with the Congress.gov bills connector as the reference implementation.

## Timestamps: JavaScript milliseconds vs Postgres microseconds

**This has bitten us more than once — read it before writing any code that reads a
`TIMESTAMPTZ`, compares it, and writes it back.**

Postgres `TIMESTAMPTZ` (and `now()`) has **microsecond** precision; a JavaScript
`Date` has only **millisecond** precision. `node-postgres` deserializes a
`TIMESTAMPTZ` into a `Date`, **silently truncating** the microseconds. So any value
that round-trips DB → JS `Date` → DB comes back a few microseconds *smaller* than
the original.

The failure mode is a watermark/cursor that looks **perpetually stale**: you store
`built_through`/`load.cursor` from a truncated `Date`, then compare it against the
still-microsecond source value, and `source > stored` is forever true — so the work
re-runs every cycle and never settles.

Two ways we avoid it, both in the codebase already:

- **Capture the watermark in SQL**, never in JS — e.g. the aggregate rebuild does
  `INSERT ... SELECT max(updated_at) FROM votes` so `built_through` keeps full
  precision (see `ingester/src/build-aggregates.js`).
- **Read the value as text, not a `Date`**, when JS must carry it — the cursor
  helper reads with `to_char(cursor AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
  and writes that exact string back, so `load.cursor` equals the consumed `fetch`
  value to the microsecond (see `ingester/src/cursor-state.js`). Comparisons via
  `new Date()` still truncate to ms, which is fine — both sides truncate equally —
  but the **stored** value must stay exact.

## Aggregate rebuild memory

The per-congress aggregate rebuild (`ingester/src/build-aggregates.js`) runs a
pairwise member self-join that emits ~100M rows. Postgres is capped at 256 MB (1 GB
host). At the cluster-default `work_mem` (2 MB) the `HashAggregate` mis-estimates
its group count, spills those rows across ~128 temp partitions, and the temp-file
**page cache** OOM-kills the container — taking the whole cluster down, not just the
query. The rebuild therefore wraps its transaction in
`SET LOCAL work_mem = '32MB'` + `SET LOCAL max_parallel_workers_per_gather = 0` +
`SET LOCAL jit = off`, which keeps the (genuinely small, ~150k-group) aggregate in
memory with no spill. Keep these `SET LOCAL`s if you touch that code, and never
raise `work_mem` cluster-wide to fix it — every connection would then be able to
blow the cap.
