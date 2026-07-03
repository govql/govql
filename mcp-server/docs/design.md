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

v0.1 ships *only* the thin layer: `execute_graphql` plus two narrow
schema-discovery tools (`list_types` and `describe_type`).
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
  spawn a subprocess and parse JSON-RPC manually. The whole test suite
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

v0.1 ships the foundation. **v0.1.1** then closed a discoverability gap: with
the derived analytics views now deployed in the data layer, `execute_graphql`
points agents at them (`VoteSimilarity`, `MemberPartyAgreement`, and the
per-vote / per-member tally views) so analytical questions use the precomputed
views instead of brute-forcing over raw `VotePosition` rows.

### Next up (before v0.2)

Testing v0.1.1 against the motivating question — *"which two opposing-party
members vote together most often?"* — showed the agent now finds `VoteSimilarity`
but still struggles, because the table is **party-blind**: `member_a`/`member_b`
are bare bioguide IDs with **no foreign key** to `legislators` (unlike
`member_party_agreement`, which has one). So the type exposes no
`legislatorByMemberA`/`legislatorByMemberB` relation, "opposing parties" can't be
filtered server-side, and the agent falls back to fetching the whole (~96k-row
for a House congress) pairwise slice and joining party client-side.

- **[next task] Add `member_a`/`member_b` → `legislators` foreign keys to
  `vote_similarity`** (small `us-congress` DB migration). Brings it in line with
  `member_party_agreement` so PostGraphile exposes `legislatorByMemberA` /
  `legislatorByMemberB` — party + name come back inline in one query instead of a
  separate lookup. Helps every consumer of the table, not just this question.
- **Passthrough robustness.** `execute_graphql` returns whatever the query
  returns and #36 left no page-size cap, so a large connection can overflow the
  agent's context (observed: a full pairwise fetch had to be spilled to a file).
  Add a docstring rule to use `orderBy` + a small `first:` for "top-N" questions,
  and optionally a soft response-size guard that truncates + warns. Small
  standalone MCP patch (behavior change → not folded into the docs-only v0.1.1).

Each subsequent version is independently shippable and adds tools that fall
into one of three categories:

- **v0.2 — Discovery/lookup tools** (e.g. `find_legislator`, `find_bill`,
  `find_vote`, `list_committees`): the tools an agent reaches for when it
  doesn't yet know specific IDs.
- **v0.3 — Per-entity detail tools** (e.g. `get_legislator`,
  `get_vote_with_positions`, `get_bill`, `get_committee`): "give me
  everything about this entity" — saves round-trips across joined tables.
- **v0.4 — Aggregation/analysis tools** (e.g. `get_voting_record`,
  `compare_voters`, `find_party_defectors`, and a cross-party
  `most_agreeing_pairs`): tools that answer questions, not just retrieve data.
  The pairwise aggregate these need is now deployed (`vote_similarity`), so they
  no longer require new server-side aggregation — a curated tool does the party
  lookup, the cross-party filter, the ordering and a top-N cap internally,
  returning a small already-answered result instead of leaving the agent to
  improvise (the failure mode the FK above + this tool together resolve).

Past v0.4, the project's wishlist shifts back to improving GovQL itself
(populating the bills/cosponsors/committees tables, a NL-query helper in
the docs site, LLM-tuned schema descriptions) rather than expanding the
MCP surface further.
