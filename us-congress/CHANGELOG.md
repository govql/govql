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

## [2026-07-19]

### Added

- **Bill sub-entities from Congress.gov**: per-bill ingestion now pulls each bill's cosponsors,
  subjects, and summaries (congress 119 to start). New types and connections: `BillSubject`
  (`allBillSubjects`, `billSubjectsByBillId` on `Bill`) and `BillSummary` (`allBillSummaries`,
  `billSummariesByBillId` on `Bill`); the existing `BillCosponsor` type is now populated
  (`allBillCosponsors`, `billCosponsorsByBillId` on `Bill`, with legislator details via the
  `bioguideId` relation). Note: `BillSummary.summaryText` is raw upstream HTML as published by
  CRS, served unsanitized — sanitize before rendering. (#89)
- **Bill enrichment fields populated**: `Bill.sponsorBioguideId` (with the `legislatorBySponsorBioguideId`
  relation), `introducedAt`, `policyArea`, `enactedAsLawType`/`enactedAsNumber`, and the
  `officialTitle`/`shortTitle`/`popularTitle` columns now carry Congress.gov data for covered
  congresses, filled in over roughly a day as the per-bill backfill drip-feeds within the
  Congress.gov rate budget. (#89)
## [2026-07-17]

### Added

- **Cross-party agreement ranking on `VoteSimilarity`**: each pair now carries
  `partyA` / `partyB` (each member's dominant vote-time party for that
  congress+chamber), a stored `agreementRate` (`agreed / sharedVotes` — so
  `orderBy: AGREEMENT_RATE_DESC` ranks server-side), and `crossParty`, a
  symmetric different-party flag that works regardless of pair storage order.
  "Which opposing-party members vote together most?" is now one query: filter
  `{ crossParty: { equalTo: true }, sharedVotes: { greaterThanOrEqualTo: 100 } }`
  and order by `AGREEMENT_RATE_DESC`. All four fields are filterable and
  orderable. Independents count as their own party (so `crossParty` rankings
  lead with I–D caucus pairs); for strict D–R pairs, filter `partyA`/`partyB`
  in both orders with `or:`.

## [2026-07-16]

### Added

- **Congress.gov bill data**: bills are now ingested hourly from the Congress.gov API (starting
  with congress 119), so `Bill` rows carry real data instead of vote-stub placeholders. New
  fields on `Bill`: `title` (Congress.gov's display title, distinct from the existing
  `officialTitle`/`shortTitle`/`popularTitle`), `latestAction` and `latestActionAt` (the most
  recent action's text and date), and `policyArea` (present in the schema now; populated when
  per-bill detail ingestion lands). `sourceUpdatedAt` reflects the Congress.gov update
  timestamp. (#89)

## [2026-07-14]

### Added

- **Legislator relations on `vote_similarity`**: `member_a` and `member_b` now have foreign keys to
  `legislators`, so the API exposes `legislatorByMemberA` / `legislatorByMemberB` — each pair returns
  the two members' names and other legislator details inline instead of bare bioguide IDs. The reverse
  connections `voteSimilaritiesByMemberA` / `voteSimilaritiesByMemberB` are available on `Legislator`.
  (A member's party is per-congress — see `member_party_agreement`, not `legislators`.) (#63)

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
