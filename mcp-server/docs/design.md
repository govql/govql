# Design

This document explains why `govql-mcp-server` exists, what it deliberately
isn't, and where it's going. It's aimed at contributors and at anyone trying
to understand the philosophy from the outside.

## Why this exists

[GovQL](https://govql.us) makes US Congressional voting data queryable over
GraphQL. The data is technically public but hard to use directly — multiple
sites, multiple formats, no joined IDs. GovQL solves that for human
developers.

AI agents (Claude Desktop, Claude Code, Cursor, etc.) have the *same*
problem at a different layer: they can hit HTTP, but each user has to teach
their agent where the endpoint lives, how to write a valid query, and how to
read the response. MCP collapses those three steps into one tool call.

The MCP server is therefore a distribution channel — it makes GovQL
addressable from any MCP-compatible client without bespoke wiring.

## Philosophy: thin layer + (eventually) curated tools

There are two shapes an MCP server like this could take:

- **Thin passthrough.** One tool exposes `execute_graphql`; the agent does
  all the query-writing work. Minimal code, can't drift from the GraphQL
  schema, doesn't need a maintainer to add tools when the schema grows.
- **Curated tools.** Hand-shaped tools like `find_legislator`,
  `get_voting_record`, `compare_voters`. Easier for agents to call
  correctly; more code to maintain; only as up-to-date as the maintainer.

v0.1 ships *only* the thin layer (`execute_graphql` + `introspect_schema`).
The roadmap below adds curated tools incrementally — but the passthrough
stays as the escape hatch. The rule for adding a curated tool is: it should
embody a query pattern that's either non-obvious from the schema, expensive
if done naively, or so common it deserves a first-class slot. If the
GraphQL is obvious, let passthrough handle it.

## Why Python + FastMCP

The rest of the GovQL monorepo is JavaScript. Choosing Python here was a
deliberate trade-off, weighed in the project's planning docs:

- The planned curated layer is 10–15 tools. FastMCP-Python derives JSON
  schemas from Python type hints, which removes hundreds of lines of
  hand-written schema boilerplate that the TypeScript SDK would require.
- FastMCP-Python ships an in-memory test client, so tests don't have to
  spawn a subprocess and parse JSON-RPC manually. The whole 17-test suite
  runs in under a second.
- The third-party `fastmcp` for TypeScript is a different author's wrapper
  that lags upstream — it didn't offer compelling enough ergonomics over
  the official `@modelcontextprotocol/sdk` to justify pulling it in.

The cost is a second toolchain in the repo. We accept that cost: the MCP
server has no runtime coupling to the JS backend, lives in a sibling
directory at the repo root, and follows the conventions of a normal Python
project (no shared linter, no shared lockfile, no proxied build commands).

## Why no Dockerfile

stdio MCP servers are spawned by the MCP client (Claude Desktop, Cursor,
etc.) as a per-session subprocess. There is no long-running server to host.
A Dockerfile would only be useful if a client wanted to run the server in
a container, which is not how any current MCP client works. If demand
emerges later we can publish a Docker image alongside the PyPI release;
shipping one now would be cargo-cult engineering.

## Roadmap

v0.1 ships the foundation. Each subsequent version is independently
shippable and adds tools that fall into one of three categories:

- **v0.2 — Discovery/lookup tools** (e.g. `find_legislator`, `find_bill`,
  `find_vote`, `list_committees`): the tools an agent reaches for when it
  doesn't yet know specific IDs.
- **v0.3 — Per-entity detail tools** (e.g. `get_legislator`,
  `get_vote_with_positions`, `get_bill`, `get_committee`): "give me
  everything about this entity" — saves round-trips across joined tables.
- **v0.4 — Aggregation/analysis tools** (e.g. `get_voting_record`,
  `compare_voters`, `find_party_defectors`): tools that answer questions,
  not just retrieve data.

The voting-similarity matrix is deliberately *not* on the v0.4 list because
it needs server-side Postgres aggregation to avoid O(n²) hammering of the
GraphQL API — that's a DB migration with its own scope and risk profile,
and it can ship later under a separate plan.

Past v0.4, the project's wishlist shifts back to improving GovQL itself
(populating the bills/cosponsors/committees tables, a NL-query helper in
the docs site, LLM-tuned schema descriptions) rather than expanding the
MCP surface further.
