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
- **Deploying schema changes:** `git pull` then `docker compose up` — the gated
  one-shot `flyway` service runs `migrate` and the API server restarts after it.
  Existing databases were adopted with a one-time
  `flyway baseline -baselineVersion=1`. Full dev/prod steps are in
  [`us-congress/README.md`](us-congress/README.md).
- **Flyway image** is pinned to a specific version (`flyway/flyway:12.9.0-alpine`)
  for reproducible deploys — bump it deliberately, not via a floating tag.

### Generated docs depend on the migration SQL

The per-table API docs are generated from the migration files by
`us-congress/docs/scripts/generate-schema-docs.mjs`. Keep migrations hand-written,
readable SQL (the generator parses `CREATE TABLE` / `COMMENT ON` statements);
re-run `npm run generate-schema-docs` after schema changes.
