# vote_similarity legislator foreign keys — Design

**Issue:** #63 · **Component:** `us-congress` (DB migration) · **Date:** 2026-07-09

## Context

`vote_similarity` stores pairwise voting agreement per congress — one row per
`(congress, chamber, member_a, member_b)` — but `member_a`/`member_b` are bare
`TEXT` bioguide IDs with **no foreign key** to `legislators`. Its sibling
aggregate `member_party_agreement` already carries `bioguide_id … REFERENCES
legislators (bioguide_id)`, so PostGraphile exposes `legislatorByBioguideId`
there but nothing analogous on `VoteSimilarity`. A consumer of `VoteSimilarity`
therefore gets opaque IDs and must do a separate lookup to attach any member
detail.

This is the "next up (before v0.2)" item on the MCP roadmap
([mcp-server/docs/design.md](../../../mcp-server/docs/design.md)): bring `vote_similarity` in line
with `member_party_agreement` so the type exposes member identity and navigation
inline.

## Key finding: the FK exposes name + navigation, not party

`legislators` has **no party column**. Party lives in:

- `legislator_terms.party` — per term, but term rows are date-ranged
  (`start_date`/`end_date`) with no `congress` column, so "party in the 119th"
  requires date math across possibly multiple terms.
- `vote_positions.party` — snapshotted per vote.
- `member_party_agreement.member_party` — the one clean *per-(congress, member)*
  party value, on a separate table.

So the FK makes `legislatorByMemberA`/`legislatorByMemberB` expose each member's
**name, bio, and a navigable path to party (via terms)** — but party is **not**
a directly filterable field on `VoteSimilarity`. Efficient server-side
"opposing parties" filtering (the original motivating question) is deliberately
**not** solved here; the roadmap assigns it to the v0.4 `most_agreeing_pairs`
curated tool.

## Decisions

1. **Scope:** migration authored + verified on the local docker DB. Production
   apply + PostGraphile reload + live confirmation on `api.govql.us` is the
   normal deploy, outside this spec.
2. **Reverse direction:** expose both directions and **index** `member_a` and
   `member_b`. Pairs are stored once with `member_a < member_b`, so "all pairs
   for member X" needs both reverse relations; each is served by its own index.
3. **Party:** **FK only.** No `party_a`/`party_b` columns, no ingester change,
   no data rebuild. Opposing-party filtering stays the v0.4 tool's job.

## The change

One new Flyway migration, `us-congress/db/migrations/V004__vote_similarity_legislator_fks.sql`,
following the existing `V00N__snake_case.sql` convention. No ingester change and
no data rebuild — existing rows already satisfy the constraint (built from
`vote_positions`, which already `REFERENCES legislators`), so Postgres validates
in place with no backfill.

```sql
-- V004__vote_similarity_legislator_fks.sql
-- Add legislator foreign keys to vote_similarity.member_a / member_b so
-- PostGraphile exposes legislatorByMemberA / legislatorByMemberB (member name +
-- navigation inline on each pair), matching the FK member_party_agreement
-- already carries. Integrity holds by construction: member_a/member_b are built
-- from vote_positions (which REFERENCES legislators), so every value resolves —
-- the constraint validates in place, no rewrite or backfill.

ALTER TABLE vote_similarity
  ADD CONSTRAINT vote_similarity_member_a_fkey
    FOREIGN KEY (member_a) REFERENCES legislators (bioguide_id),
  ADD CONSTRAINT vote_similarity_member_b_fkey
    FOREIGN KEY (member_b) REFERENCES legislators (bioguide_id);

-- Support the reverse relations PostGraphile now exposes
-- (legislator -> voteSimilaritiesByMemberA / voteSimilaritiesByMemberB).
-- member_a/member_b are the 3rd/4th columns of the composite PK, so the PK
-- index does not serve single-column lookups on them.
CREATE INDEX idx_vote_similarity_member_a ON vote_similarity (member_a);
CREATE INDEX idx_vote_similarity_member_b ON vote_similarity (member_b);
```

Constraint names mirror what an inline `REFERENCES` auto-generates
(`<table>_<col>_fkey`, as on `member_party_agreement`); index names follow the
existing `idx_<table>_<col>` pattern (`idx_positions_bioguide`,
`idx_terms_bioguide`, …).

The same migration enriches the table comment (serves the discoverability theme
of the parent work). Append to the existing `COMMENT ON TABLE vote_similarity`:

> Join `legislatorByMemberA` / `legislatorByMemberB` for each member's name and
> details. Party is per-congress and not on `legislators` — see
> `member_party_agreement` for a member's party in a given congress.

## Resulting GraphQL surface

- `VoteSimilarity` gains `legislatorByMemberA: Legislator` and
  `legislatorByMemberB: Legislator` (forward).
- `Legislator` gains `voteSimilaritiesByMemberA` / `voteSimilaritiesByMemberB`
  connections (reverse, now indexed).
- Default inflection, disambiguated by column name — mirrors
  `legislatorByBioguideId` on `MemberPartyAgreement`.

## Verification (local — no automated DB test harness exists)

1. **Orphan pre-check** —
   `SELECT count(*) FROM vote_similarity vs LEFT JOIN legislators l ON vs.member_a = l.bioguide_id WHERE l.bioguide_id IS NULL`
   (and again for `member_b`); expect `0`. If nonzero, stop and investigate
   before applying.
2. **Apply** the migration via the project's normal Flyway migrate against the
   local docker Postgres; confirm `V004` applies cleanly.
3. **Introspect** — `describe_type("VoteSimilarity")` (via the `govql-local`
   MCP) shows both `legislatorBy…` fields.
4. **Forward query** — `allVoteSimilarities(first: 3, …)` returning
   `legislatorByMemberA { lastName } legislatorByMemberB { lastName }` gives
   names inline.
5. **Reverse spot-check** — a legislator's `voteSimilaritiesByMemberA(first: 1)`
   returns a pair (optional `EXPLAIN` to confirm index use).

## Out of scope / noted

- No `party_a`/`party_b` columns; opposing-party server-side filtering remains
  the v0.4 `most_agreeing_pairs` tool's job.
- No production rollout / PostGraphile prod reload — separate deploy.
- No ingester change, no data rebuild.
- No MCP-server change or PyPI publish (DB-only change).
- **Downstream follow-up (not this task):** once deployed, `execute_graphql`'s
  docstring could point agents at the new relations — a separate MCP patch.
