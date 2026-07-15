# MCP Curated Tools (v0.2–v0.4 arc) — Design Spec

**Issue:** #68 (v0.2); two further issues to be created for v0.3 and v0.4.
**Component:** `mcp-server/` (`govql-mcp-server`, Python + FastMCP).
**Status:** Approved design, ready for implementation planning.

## Purpose

`govql-mcp-server` v0.1.x ships a *thin* layer: `execute_graphql` plus two
schema-discovery tools (`list_types`, `describe_type`). The roadmap
([mcp-server/docs/design.md](../../../mcp-server/docs/design.md)) adds **curated
tools** incrementally — hand-shaped tools that embody a query pattern that is
non-obvious from the schema, expensive if done naively, or common enough to
deserve a first-class slot. The passthrough remains the escape hatch.

This spec designs the **entire buildable arc** in one pass — the tools whose
underlying data is already populated (legislators, votes, vote positions, and
the derived aggregates). It deliberately excludes tools that depend on the
empty `bills`/`cosponsors`/`committees` tables, and excludes `most_agreeing_pairs`
(which is the one tool that would depend on the #63 `vote_similarity` foreign
keys) — both are relocated to a **post-v0.4** phase.

The design is written once (shared conventions + all seven tools) but is
**implemented and shipped as three separate PRs** — one per roadmap milestone —
so each version is independently shippable, per the roadmap's principle.

## Scope

**In scope (7 tools across 3 milestones):**

- **v0.2 — Discovery/lookup:** `find_legislator`, `find_vote`
- **v0.3 — Per-entity detail:** `get_legislator`, `get_vote_with_positions`
- **v0.4 — Aggregation/analysis:** `get_voting_record`, `compare_voters`,
  `find_party_defectors`

**Explicitly out of scope (relocated to post-v0.4 in the roadmap edit):**

- `most_agreeing_pairs` — depends on the #63 `vote_similarity` legislator FKs;
  deferred so this arc has zero dependency on #63 and can be built today.
- `find_bill`, `list_committees`, `get_bill`, `get_committee` — depend on the
  `bills`/`cosponsors`/`committees` tables, which exist in the schema but are
  not yet populated.

**Also in scope:** the roadmap edit in `mcp-server/docs/design.md` (rides in the
v0.2 PR), README additions, `mcp-server/CHANGELOG.md` entries, and version bumps.

## Cross-milestone sequencing & constraints

- **Merge order:** #63 (the `vote_similarity` FK migration) merges before any of
  these PRs land. Each milestone branch is cut from fresh `main`. The v0.2 PR's
  roadmap edit refreshes the FK language to past tense, which is only correct
  once #63 is merged — hence v0.2 must merge after #63.
- **No FK dependency in the code:** none of the seven tools requires #63.
  `compare_voters` filters `vote_similarity` on its scalar `memberA`/`memberB`
  columns (which exist today) and looks up member names separately.
- **Each PR is release-ready** (version bump + CHANGELOG) but the actual PyPI
  publish + git tag remain the maintainer's `RELEASE.md` step — publish cadence
  (per-milestone or batched) is the maintainer's call; the plans do not automate
  publishing.
- **Authorship:** commits authored by Alex, no Claude co-author trailer
  (`includeCoAuthoredBy: false`). PRs carry no "Generated with Claude Code"
  footer.
- **Live validation:** every tool's GraphQL is confirmed against live
  `api.govql.us` during implementation; the mocked test fixtures encode the
  verified query + a representative response. The maintainer runs a live smoke
  check at each milestone's review pause before opening its PR.

## Architecture

Follow the existing tool pattern exactly. Each tool is a thin async function
decorated with `@mcp.tool`, living in its own module under
`src/govql_mcp_server/tools/`, registered by importing it in
[server.py](../../../mcp-server/src/govql_mcp_server/server.py). Each tool:

1. Normalizes its friendly scalar parameters.
2. Builds a parameterized GraphQL document (with variables).
3. Calls `graphql_client.execute_graphql(query, variables)`.
4. Shapes a compact, opinionated result and applies the response-size guard.

A new private helper module **`tools/_curated_shared.py`** (sibling to the
existing `_discovery_shared.py`; underscore = not-a-tool, registers nothing)
holds the recurring logic:

- `normalize_party(str) -> str | None` — `"D"`/`"dem"`/`"democratic"`/`"democrat"`
  → `"Democrat"`; `"R"`/`"rep"`/`"republican"` → `"Republican"`;
  `"I"`/`"independent"` → `"Independent"`. Returns `None`/passes through unknown
  values untouched so the caller can decide. (Maps to the **full-string**
  `legislator_terms.party`.)
- `normalize_party_code(str) -> str | None` — the short-code counterpart
  (`"Democrat"`/`"dem"`/`"D"` → `"D"`, etc.) for the aggregate tables whose
  `member_party`/`party` columns use `"D"`/`"R"`/`"I"`.
- `normalize_chamber_termtype(str) -> str | None` — `"senate"`/`"sen"`/`"s"` →
  `"sen"`, `"house"`/`"rep"`/`"h"` → `"rep"` (for `legislator_terms.term_type`).
- `normalize_chamber_code(str) -> str | None` — `"senate"`/`"s"` → `"s"`,
  `"house"`/`"h"` → `"h"` (for `votes.chamber` / aggregate `chamber`).
- `normalize_state(str) -> str | None` — upper-case, validate 2 letters.
- `LIMIT_DEFAULT = 20`, `LIMIT_MAX = 500`; `clamp_limit(int|None) -> int`.
- `RESPONSE_BYTE_BUDGET = 100_000` and
  `apply_size_guard(payload) -> payload` — if the shaped result serializes
  beyond the budget, truncate the list portion and set `truncated: true` with a
  human-readable `message` telling the agent to narrow the filter or paginate.
- Reuse `network_error_response` from `_discovery_shared.py` (import it; do not
  duplicate).

### Shared conventions (all seven tools)

1. **Envelope:** success → `{"data": {...}}`; GraphQL errors → surfaced as
   `{"data": null, "errors": [...]}` with the tool result **not** marked as an
   MCP error (`isError` False), so the agent can read and react; transport
   failures → `network_error_response(err)`. This matches the existing tools.
2. **Forgiving params:** `Annotated[T | None, Field(description=...)]`; FastMCP
   derives the JSON schema from the hints. Every friendly enum-like param is run
   through the relevant normalizer.
3. **Compact, opinionated returns:** finders return a small ranked candidate list
   (the IDs needed to drill down + just enough to disambiguate). Detail/analysis
   tools return the assembled answer built on the precomputed aggregates. Never a
   raw hundreds-of-rows dump by default.
4. **Row limit is a UX knob, not the safety net:** finders default `limit=20`,
   hard-capped at `500` (a full 437-member House + margin). The **real**
   safeguard is `apply_size_guard` (byte budget), which adapts to per-row weight:
   a full-chamber roster (~67 KB) passes; an all-history (12,767-member, ~2 MB) or
   raw-`vote_similarity` (~96k-row) payload is truncated with guidance.
5. **Current-vs-historical:** legislator tools interpret party/state/chamber
   against the **current** term by default (`legislator_terms.end_date > today`),
   with `current_only=False` to widen to any term. (`legislator_terms` has no
   `congress` column, so "current vs ever" is the finder's time axis; per-congress
   scoping lives in the analysis tools via the aggregates' `congress` column.)
6. **GraphQL errors are data.** Empty results are valid (e.g. two members who
   never overlapped) and returned as an empty list/clear message, not an error.

### Data-model facts the tools encapsulate (verified live)

- **Party lives on `legislator_terms`, not `legislators`.** Filtering members by
  party/state/chamber traverses `legislatorTermsByBioguideId: { some: {...} }`.
- **`legislator_terms.party` is a full string** (`"Democrat"`/`"Republican"`);
  **`vote_positions.party` and the aggregates' party columns are short codes**
  (`"D"`/`"R"`/`"I"`). Hence the two party normalizers.
- **`legislator_terms.term_type`** is `"rep"`/`"sen"`; **`votes.chamber`** and the
  aggregate `chamber` columns are `"h"`/`"s"`. Hence the two chamber normalizers.
- **`vote_similarity` stores each pair once with `member_a < member_b`.**
  `compare_voters` must canonicalize the two IDs before filtering.
- **`member_party_agreement` has a row per `(member, other_party)`, including
  `other_party == member_party`** — that own-party row is the loyalty measure;
  a low `agreement_rate` on it is the defection signal.
- **`member_party_agreement` exposes `legislatorByBioguideId`** (FK present), so
  `find_party_defectors` and `get_voting_record` get member names inline.
  `vote_similarity` has **no** such FK yet (that is #63), so `compare_voters`
  looks names up separately.

## Tool specifications

Each tool returns the standard envelope. Field lists below describe the shaped
`data` payload.

### v0.2 — Discovery/lookup

#### `find_legislator`

Find members by attributes when the agent lacks a bioguide_id.

- **Params:** `name: str | None` (case-insensitive substring across
  `first_name`, `last_name`, `official_full`, `nickname`), `state: str | None`,
  `party: str | None`, `chamber: str | None`, `current_only: bool = True`,
  `limit: int = 20`.
- **Query:** `allLegislators(first: <clamped>, filter: { <name OR-clause>,
  legislatorTermsByBioguideId: { some: { termType?, state?, party?,
  endDate: { greaterThan: <today> } if current_only } } })`, selecting each
  node's identity plus its latest term
  (`legislatorTermsByBioguideIdList(orderBy: END_DATE_DESC, first: 1)`) for
  display. The `name` OR-clause is
  `or: [{lastName:{includesInsensitive:name}}, {firstName:{...}},
  {officialFull:{...}}, {nickname:{...}}]`; omitted when `name` is null.
  When `current_only` is true and a `party`/`state`/`chamber` is given, all
  those term predicates go inside the **same** `some: {...}` so they must be
  satisfied by one term.
- **Returns:** `{ "legislators": [ { bioguideId, firstName, lastName,
  officialFull, party, state, chamber, current } ], "result_count", "truncated" }`.
  `chamber` in the output is the normalized display value derived from
  `termType`. `current` is `end_date > today`.

#### `find_vote`

Topic/keyword search over votes when the agent lacks a vote_id.

- **Params:** `topic: str | None` (free-text →
  `question: { includesInsensitive: topic }`), `chamber: str | None`
  (`h`/`s`), `congress: int | None`, `category: str | None` (equalTo),
  `limit: int = 20`.
- **Query:** `allVotes(first: <clamped>, orderBy: VOTED_AT_DESC,
  filter: { question?, chamber?, congress?, category? })`.
- **Returns:** `{ "votes": [ { voteId, chamber, congress, votedAt, category,
  question, result, resultText, sourceUrl } ], "result_count", "truncated" }`,
  newest first.

### v0.3 — Per-entity detail

#### `get_legislator`

Identity + full term history for one member (the *identity* tool).

- **Params:** `bioguide_id: str` (required).
- **Query:** `legislatorByBioguideId(bioguideId: $id) { <identity>,
  legislatorTermsByBioguideIdList(orderBy: START_DATE_ASC) { ... } }`.
- **Returns:** `{ "legislator": { bioguideId, firstName, middleName, lastName,
  nameSuffix, nickname, officialFull, birthday, gender, terms: [ { termType,
  party, state, district, startDate, endDate, how, caucus } ], current: {
  party, state, chamber, district } | null } }`. `current` is derived from the
  term whose `end_date > today` (null if none). If the id doesn't exist,
  `data.legislator` is `null`.

#### `get_vote_with_positions`

One vote plus how members voted — **shaped**, not a raw dump.

- **Params:** `vote_id: str` (required), `include_positions: bool = False`,
  `party: str | None`, `state: str | None`, `position: str | None`
  (any of the three filters implies `include_positions`),
  `positions_limit: int = 500`.
- **Query:** `voteByVoteId(voteId: $id) { <vote metadata>, <tally aggregate>,
  <party-breakdown aggregate>, votePositionsByVoteIdList(first: <clamped>,
  filter: { party?, state?, position? }) { position party state
  legislatorByBioguideId { firstName lastName } } }`. The exact relation names
  for the `vote_totals` and `vote_party_breakdown` aggregates are confirmed via
  `describe_type("Vote")` at implementation start; positions are only selected
  when requested/filtered.
- **Returns:** `{ "vote": { voteId, chamber, congress, votedAt, question,
  category, result, resultText, requires, sourceUrl }, "totals": {...},
  "party_breakdown": [...], "positions": [ { firstName, lastName, party, state,
  position } ] | null, "truncated" }`. `positions` is `null` unless requested.
  Size guard applies.

### v0.4 — Aggregation/analysis

#### `get_voting_record`

A member's voting *behavior* (the analytics counterpart to `get_legislator`).

- **Params:** `bioguide_id: str` (required), `congress: int | None`
  (omitted → all congresses, one row each).
- **Query:** filter `allMemberVotingSummaries` and `allMemberPartyAgreements`
  by `bioguideId` (+ `congress?`); for party loyalty, select the own-party row
  (`memberParty == otherParty`, resolved per the loyalty mechanism below).
- **Returns:** `{ "bioguideId", "name", "records": [ { congress, chamber,
  totalVotes, yea, nay, present, notVoting, participationRate, partyLoyaltyRate }
  ] }`, most recent congress first. Empty `records` if the member has no
  summary rows.

#### `compare_voters`

Pairwise voting agreement between two members.

- **Params:** `bioguide_id_a: str`, `bioguide_id_b: str` (required),
  `congress: int | None`.
- **Query:** canonicalize `member_a = min(a, b)`, `member_b = max(a, b)`
  (string order matches the ingester's storage order), then
  `allVoteSimilarities(filter: { memberA: {equalTo}, memberB: {equalTo},
  congress? })`. Member names come from a separate small lookup of the two
  bioguide ids (two aliased `legislatorByBioguideId`) — **no FK dependency**.
  (Once #63 lands, this can switch to `legislatorByMemberA/B`.)
- **Returns:** `{ "memberA": { bioguideId, name }, "memberB": { bioguideId,
  name }, "comparisons": [ { congress, chamber, sharedVotes, agreed,
  agreementRate } ] }`, where `agreementRate = agreed / sharedVotes`. Empty
  `comparisons` with a clear message when the two never share a
  `(congress, chamber)` slice.

#### `find_party_defectors`

Members who least often vote with their own party.

- **Params:** `congress: int` (required), `chamber: str | None`,
  `party: str | None` (short code after normalization), `limit: int = 20`.
- **Query:** `allMemberPartyAgreements(first: <clamped>,
  orderBy: AGREEMENT_RATE_ASC, filter: { congress: {equalTo}, chamber?,
  memberParty: {equalTo: P}, otherParty: {equalTo: P} })` — the
  `memberParty == otherParty` own-party row is the loyalty measure; ascending
  `agreement_rate` ranks the biggest defectors first. When `party` is omitted,
  the tool runs the query per party present (`D`, `R`, and `I` if applicable)
  and merges the results by `agreement_rate` ascending, capped at `limit`.
  Names come inline via `legislatorByBioguideId`.
- **Returns:** `{ "congress", "chamber" | null, "defectors": [ { bioguideId,
  name, memberParty, agreementRate, sharedVotes, agreed } ] }`, ascending.

## Testing

Mirror the existing suite: `respx`-mocked GovQL endpoint + the in-memory
FastMCP `Client` (`tests/conftest.py`), fast (<1s), **no live network in CI**.

For each tool, tests assert:

1. **Correct query construction** — inspect the outgoing request body
   (`route.calls.last.request`) for the expected filter shape, including:
   param normalization (`"dem"` → `"Democrat"`, `"senate"` → `"sen"`, state
   upper-casing), the `legislatorTermsByBioguideId.some` nesting, the
   `current_only` `endDate` predicate, `compare_voters`' canonical
   `member_a < member_b` ordering, and `find_party_defectors`'
   `memberParty == otherParty` clause.
2. **Correct response shaping** — a representative mocked response maps to the
   documented `data` payload.
3. **Edge/error paths** — empty results (empty list + `result_count: 0` /
   clear message), transport failure (`network_error_response` shape,
   `isError` False), and the `truncated` flag when a mocked oversized payload
   exceeds `RESPONSE_BYTE_BUDGET`.

`_curated_shared.py` gets direct unit tests for each normalizer, `clamp_limit`,
and `apply_size_guard` (below/at/above budget).

Each mocked query is one the implementer has **run live** against
`api.govql.us` first, so fixtures reflect the real schema. The existing ~23
tests must stay green.

## Milestones (three PRs)

### PR 1 — v0.2 (issue #68)

- `tools/_curated_shared.py` + its tests.
- `tools/find_legislator.py`, `tools/find_vote.py` + tests.
- Register both in `server.py`.
- **Roadmap edit** in `mcp-server/docs/design.md`:
  - Trim v0.2 list → `find_legislator`, `find_vote`.
  - Trim v0.3 list → `get_legislator`, `get_vote_with_positions`.
  - v0.4 list → `get_voting_record`, `compare_voters`, `find_party_defectors`.
  - Relocate `most_agreeing_pairs` **and** the bill/committee tools
    (`find_bill`, `list_committees`, `get_bill`, `get_committee`) to a
    **post-v0.4** phase, gated behind the bills/cosponsors/committees data
    population.
  - Refresh the "Next up (before v0.2)" FK section + the "the FK above"
    reference to past tense (the FK shipped in #63).
- README "What you can do" additions (1–2 discovery examples).
- `mcp-server/CHANGELOG.md`: `## [0.2.0]` with an `### Added` entry for the two
  discovery tools.
- Version bump `pyproject.toml` `0.1.1` → `0.2.0`.

### PR 2 — v0.3 (new issue)

- `tools/get_legislator.py`, `tools/get_vote_with_positions.py` + tests;
  register in `server.py`.
- README + `mcp-server/CHANGELOG.md` `## [0.3.0]` `### Added`.
- Version bump `0.2.0` → `0.3.0`.

### PR 3 — v0.4 (new issue)

- `tools/get_voting_record.py`, `tools/compare_voters.py`,
  `tools/find_party_defectors.py` + tests; register in `server.py`.
- README + `mcp-server/CHANGELOG.md` `## [0.4.0]` `### Added`.
- Version bump `0.3.0` → `0.4.0`.
- Roadmap: note `most_agreeing_pairs` remains the top post-v0.4 item (needs the
  #63 FK for its `legislatorByMemberA/B` navigation).

## Non-goals

- No new dependencies; no changes to `graphql_client.py`'s public shape.
- No PyPI publishing/tagging in the plans (maintainer's `RELEASE.md` step).
- No tools over unpopulated tables; no `most_agreeing_pairs` in this arc.
- No changes to the `us-congress` component (this arc is MCP-only; #63 is
  separate).
