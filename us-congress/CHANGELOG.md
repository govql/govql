# Changelog

All notable **API-consumer-facing** changes to the GovQL GraphQL API are documented here.

Entries are
**date-stamped** rather than versioned: GovQL is a continuously-deployed, versionless GraphQL
API that evolves additively (new types and fields are added; outdated fields are deprecated
before removal), so there are no `v1`/`v2` releases or git tags to track.

### What belongs here

Only changes visible to people **querying the API**:

- New or changed types, fields, enums, filters, or connections
- Deprecations and removals
- Query behavior: rate limits, depth/complexity limits, pagination, error responses
- Data coverage: new data sources, new date ranges, or notable backfills

Internal changes (scraper/ingester plumbing, deployment, observability, docs tooling) are
**out of scope** — see the git history for those.

### Deprecation policy

Because the API is versionless, we avoid breaking changes. When a field or type must change
incompatibly, the old one is marked `@deprecated` and remains available for **at least 3 days**.
We understand that this is an uncommonly short deprecation period, but we intend to increase it once GovQL is more full-featured/stable and/or once there are more users. 
Planned removals are announced under `Deprecated` here before they happen and then recorded
under `Removed`.

Change categories: **Added** (new capabilities), **Changed** (changes to existing behavior),
**Deprecated** (soon-to-be-removed), **Removed**, **Fixed** (bug fixes), **Security**.

## [Unreleased]

## 2026-06-29

### Security

- Hardened the service against automated abuse and probing. (#36)

## [2026-06-25]

### Added

- **Member-vs-party voting agreement** via the `member_party_agreement` type: for each congress
  and chamber, how often a member voted with each party's majority position — `shared_votes`,
  `agreed`, and a precomputed `agreement_rate` (`agreed / shared_votes`, sortable via
  `orderBy: AGREEMENT_RATE_DESC`). `other_party` includes the member's own party (a loyalty
  measure). Maintained incrementally by the ingester across all congresses. (#49)


## [2026-06-18] — Baseline

First published changelog. Establishes the current public API as the starting point and records
recent consumer-facing additions.

### Added

- **Aggregation views** for common groupings, queryable through the API:
  `vote_party_breakdown` (per-vote tallies by party), `vote_totals` (overall Yea/Nay/present/not-voting
  totals per vote), and `member_voting_summary` (per-member voting activity). (#40)
- **Pairwise voting similarity** data via the `vote_similarity` type: for each congress and chamber,
  the number of shared votes and agreements between any two members (pairs stored once with
  `member_a < member_b`; compute agreement as `agreed / shared_votes`). Maintained incrementally by
  the ingester across all congresses.

### Current API surface (baseline)

- GraphQL API served by PostGraphile at `https://api.govql.us/graphql`, auto-generated from the
  PostgreSQL schema. Core types: `Legislator`, `LegislatorTerm`, `Vote`, `VotePosition`, `Bill`,
  `BillCosponsor`, `BillCommittee`, `Committee`, `CommitteeMembership`.
- Cursor-based pagination and connection filtering on list fields.
- Query guardrails: depth limit (default 15) and a query-complexity budget to protect the service.
