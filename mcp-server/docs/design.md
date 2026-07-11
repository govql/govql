# Design

This document explains why `govql-mcp-server` exists, what it deliberately
isn't, and where it's going.

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

## Core design: passthrough + curated tools

There are two shapes an MCP server like this could take:

- **Thin passthrough.** One tool exposes `execute_graphql`; the agent does
  all the query-writing work. Minimal code, can't drift from the GraphQL
  schema, doesn't need a maintainer to add tools when the schema grows.
- **Curated tools.** Hand-shaped tools like `find_legislator`,
  `get_voting_record`, `compare_voters`. Easier for agents to call
  correctly; more code to maintain; only as up-to-date as the maintainer.

v0.1 shipped the thin layer only: `execute_graphql` plus two narrow
schema-discovery tools (`list_types` and `describe_type`).
Curated tools have been added incrementally, but the passthrough
stays as the escape hatch.

The rule for adding a curated tool is: it should
embody a query pattern that's either non-obvious from the schema, expensive
if done naively, or so common it deserves a first-class slot. If the
GraphQL is obvious, let passthrough handle it.

## Why Python + FastMCP

The rest of the GovQL monorepo is JavaScript. Choosing Python here was a
deliberate trade-off, weighed in the project's planning docs:

- FastMCP-Python derives JSON schemas from Python type hints, which removes
  hundreds of lines of schema boilerplate that the TypeScript SDK would require.
- FastMCP-Python ships an in-memory test client, so tests don't have to
  spawn a subprocess and parse JSON-RPC manually. The test suite runs in seconds.
- The third-party `fastmcp` for TypeScript is a different author's wrapper
  that lags upstream — it didn't offer compelling enough ergonomics over
  the official `@modelcontextprotocol/sdk` to justify pulling it in.

The cost is a second toolchain in the repo. We accept that cost: the MCP
server has no runtime coupling to the JS backend, lives in a sibling
directory at the repo root, and follows the conventions of a normal Python
project (no shared linter, no shared lockfile, no proxied build commands).

## Roadmap

Each minor version beyond v0.1 adds tools that fall into one of three categories:

- **v0.2 — Discovery/lookup tools** (`find_legislator`, `find_vote`): the
  tools an agent reaches for when it doesn't yet know specific IDs.
- **v0.3 — Per-entity detail tools** (`get_legislator`,
  `get_vote_with_positions`): "give me everything about this entity" — saves
  round-trips across joined tables.
- **v0.4 — Aggregation/analysis tools** (`get_voting_record`,
  `compare_voters`, `find_party_defectors`): tools that answer questions, not
  just retrieve data.
  `compare_voters`, `find_party_defectors`): tools that answer questions, not
  just retrieve data.

As of 0.4.0, all three milestones above have shipped — the curated
discovery/detail/analysis set is complete. The roadmap continues below at
Post-v0.4.

Past v0.4, the project's wishlist shifts back to improving GovQL itself first
— populating the `bills`/`cosponsors`/`committees` tables, a NL-query helper
in the docs site, LLM-tuned schema descriptions — rather than expanding the
MCP surface further. That data work is what the relocated bill/committee
tools below are waiting on.

### Post-v0.4 (waiting on GovQL data-layer work)

These are designed but held back until GovQL does the underlying data work:

- **`most_agreeing_pairs`** (cross-party) — ranks `vote_similarity` to surface
  the opposing-party pairs who vote together most. The #63 legislator FKs
  (`legislatorByMemberA/B`) shipped, but a correct ranking still isn't
  expressible in the MCP layer alone: `vote_similarity` offers no agreement-rate
  ordering (the rate is derived from `sharedVotes`/`agreed`) and party lives on a
  member's terms, so cross-party pairs can't be filtered or ranked server-side.
  Deferred until GovQL precomputes a cross-party-ranked aggregate — the post-v0.4
  "improve GovQL first" work.
- **`find_bill`, `list_committees`** (discovery) and **`get_bill`,
  `get_committee`** (detail) — need the `bills`/`cosponsors`/`committees`
  tables populated (the post-v0.4 GovQL data work).
