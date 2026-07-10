# Changelog

All notable changes to `govql-mcp-server` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.0] — 2026-07-09

### Changed

- Minimum supported Python raised to 3.13 (drops 3.10–3.12).

### Added

- `find_legislator` tool — discover members by `name`, `state`, `party`, and
  `chamber` (matched against their terms), with `current_only` (default) and a
  `limit`. Returns a compact ranked list with each member's `bioguideId` and
  current party/state/chamber.
- `find_vote` tool — search roll-call votes by `topic` (free-text over the vote
  question), `chamber`, `congress`, and `category`, newest first, with a `limit`.
- Curated tools cap result size two ways: a `limit` (default 20, max 500) and a
  response-byte guard that truncates oversized payloads and flags `truncated`.
  Discovery results also report `total_matches` — how many rows match the filter
  overall — so callers know when to refine or raise `limit`.

## [0.1.1] — 2026-07-03

### Changed

- `execute_graphql` now points agents at the precomputed derived analytics
  views (`VoteSimilarity`, `MemberPartyAgreement`, and the per-vote /
  per-member tally views) so analytical questions use them directly instead of
  aggregating raw `VotePosition` rows. Also nudges agents to run `list_types()`
  before hand-rolling any multi-row computation, and calls out the derived
  views in the `list_types` tip. Documentation only — no change to the tool
  surface.

## [0.1.0] — 2026-05-28

Initial release.

### Added

- `execute_graphql` tool — passthrough that runs any GraphQL query against
  the GovQL endpoint and returns the result along with a `last_ingest`
  freshness timestamp.
- `list_types` tool — returns the names and kinds of every type in the
  GovQL schema, with an optional case-insensitive `kind` filter.
- `describe_type` tool — returns one GraphQL type's full description
  (fields, arg signatures, input fields, enum values) by name.
- stdio transport (works with Claude Desktop, Claude Code, Cursor, and any
  other MCP-compatible client that supports stdio servers).
- Configuration via `GOVQL_ENDPOINT`, `GOVQL_TIMEOUT_MS`, and `LOG_LEVEL`
  environment variables (all optional — defaults point at the public API).
- Full test suite (23 tests) using FastMCP's in-memory client, including a
  guardrail test that fails if any module writes to stdout.
