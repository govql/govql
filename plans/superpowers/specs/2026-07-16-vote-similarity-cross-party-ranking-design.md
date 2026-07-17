# vote_similarity cross-party ranking columns — Design

**Issue:** #87 · **Component:** `us-congress` (DB migration + ingester build stage + docs) · **Date:** 2026-07-16

## Context

*"Which opposing-party members vote together most?"* needs three things the
GraphQL layer can't provide today, all verified by introspecting the live
schema:

- **No agreement-rate ordering.** `vote_similarity` stores `shared_votes` and
  `agreed`; the rate is derived, so `VoteSimilaritiesOrderBy` offers only
  `AGREED_*` / `SHARED_VOTES_*`. `AGREED_DESC` is a poor proxy (300/300 = 100%
  sorts below 350/500 = 70%).
- **No server-side party.** `Legislator` has no `party` column (it's
  per-congress), so "opposing parties" can't be filtered at the DB level.
- **Client-side ranking doesn't fit.** A House congress slice is ~96k pairs —
  too big for an agent's context via passthrough, and paginating it inside a
  curated tool would burn the 100 req/60 s rate limit on every question.

History: #63 (V004) added the `legislators` FKs and *deliberately* scoped party
columns out, assigning opposing-party filtering to a curated MCP tool. The
v0.4 MCP milestone then established the tool can't do it — there is no ranking
primitive to build on. This change moves the aggregate into the data layer,
following the `member_party_agreement` precedent: a stored generated
`agreement_rate` is what gives that table its `AGREEMENT_RATE_*` orderBy.

Issue #87 proposed a new derived view (`cross_party_vote_similarity`). Design
review collapsed that to **in-place columns on `vote_similarity`**: the counts
and the `(congress, chamber, member_a, member_b)` key already live there, the
sibling aggregates are plain tables rebuilt per-congress (so "match the sibling
refresh pattern" means riding the same rebuild transaction, not adding a view),
and the #63 FKs already provide inline name lookups. Every clause of the
issue's definition of done is met — rate ordering, per-side party, member FKs,
cross-party filtering — with no second copy of ~2M rows.

## Decisions

1. **In-place columns, not a new view/table.** Four new columns on
   `vote_similarity`; no new relation, no ingester bookkeeping changes, all
   GraphQL changes additive.
2. **`party_a` / `party_b` = dominant vote-time party**: the party the member
   cast the most Yea/Nay positions under within that congress+chamber (from
   `vote_positions.party`, the same vote-time snapshot the sibling aggregate
   uses), tie-broken alphabetically for determinism. *Not* latest-term party
   (would label a 2005 pair with a 2026 party) and *not* split rows per party
   stint (changes the row identity and would roughly double the heaviest build
   stage). A rare mid-congress switcher (e.g. Van Drew, 116th) gets one label:
   the party they cast more Yea/Nay under; the caveat is documented in the
   table comment.
3. **`cross_party` is a stored generated boolean.** PostGraphile's connection
   filter can't compare two columns to each other, so `party_a <> party_b`
   must be materialized to be filterable. It's also order-safe (see surface
   notes below).
4. **`agreement_rate` is a stored generated `REAL`,** mirroring
   `member_party_agreement.agreement_rate` exactly
   (`agreed::real / NULLIF(shared_votes, 0)`).
5. **`party_a`/`party_b` are `NOT NULL`.** Verified live (2026-07-16): zero
   Yea/Nay positions have a NULL party, and `member_party_agreement.member_party`
   is already NOT NULL from the same source — if future data violated this,
   both aggregates fail the same loud way (rebuild rolls back, congress stays
   stale, run marked failed).
6. **No baked shared-votes floor.** V001's philosophy stands ("any
   minimum-shared-votes threshold [is] applied by the consumer"): `shared_votes`
   is filterable (`greaterThanOrEqualTo`), and the table comment recommends a
   floor because rates on tiny overlaps are noise.
7. **Partial index** `(congress, chamber, agreement_rate DESC) WHERE cross_party`
   serves the canonical top-N walk. Cheap to maintain (~100–150k rows per
   congress rebuild).

## The change

### 1. Migration `V007__vote_similarity_cross_party_ranking.sql`

```sql
-- Make "which opposing-party members vote together most?" a one-query,
-- server-side answer: add each member's party to vote_similarity plus a stored
-- agreement_rate (PostGraphile then emits AGREEMENT_RATE_* orderBy, as on
-- member_party_agreement) and a cross_party flag (the connection filter cannot
-- compare two columns, so party_a <> party_b must be materialized to be
-- filterable). Ranking cannot be done client-side: a House congress slice is
-- ~96k pairs, and AGREED_DESC is a poor proxy for the rate.

ALTER TABLE vote_similarity
  ADD COLUMN party_a TEXT,
  ADD COLUMN party_b TEXT,
  ADD COLUMN agreement_rate REAL GENERATED ALWAYS AS
    (agreed::real / NULLIF(shared_votes, 0)) STORED,
  ADD COLUMN cross_party BOOLEAN GENERATED ALWAYS AS
    (party_a IS DISTINCT FROM party_b) STORED;

-- Backfill: each member's dominant vote-time party within the congress+chamber
-- — the party they cast the most Yea/Nay positions under (vote_positions
-- snapshots party at vote time), ties broken alphabetically for determinism.
-- Matches what the ingester's rebuild computes from the same rows, so a later
-- rebuild is a no-op with respect to these values.
WITH party_counts AS (
  SELECT v.congress, v.chamber, vp.bioguide_id, vp.party, count(*) AS positions
  FROM vote_positions vp
  JOIN votes v ON v.vote_id = vp.vote_id
  WHERE vp.position IN ('Yea', 'Nay')
  GROUP BY v.congress, v.chamber, vp.bioguide_id, vp.party
),
dominant_party AS (
  SELECT DISTINCT ON (congress, chamber, bioguide_id)
         congress, chamber, bioguide_id, party
  FROM party_counts
  ORDER BY congress, chamber, bioguide_id, positions DESC, party
)
UPDATE vote_similarity vs
SET party_a = da.party,
    party_b = db.party
FROM dominant_party da, dominant_party db
WHERE da.congress = vs.congress
  AND da.chamber  = vs.chamber
  AND da.bioguide_id = vs.member_a
  AND db.congress = vs.congress
  AND db.chamber  = vs.chamber
  AND db.bioguide_id = vs.member_b;

-- Every member in vote_similarity has Yea/Nay positions by construction, and
-- (verified) none of those rows lack a party — so the backfill reaches every
-- row and NOT NULL holds. If it ever didn't, failing the migration loudly is
-- the correct outcome.
ALTER TABLE vote_similarity
  ALTER COLUMN party_a SET NOT NULL,
  ALTER COLUMN party_b SET NOT NULL;

-- Serve the canonical query: top pairs by rate within a congress+chamber,
-- cross-party only.
CREATE INDEX idx_vote_similarity_cross_party_rate
  ON vote_similarity (congress, chamber, agreement_rate DESC)
  WHERE cross_party;
```

Plus comment updates (PostGraphile surfaces these as GraphQL descriptions, and
agents read them via `describe_type`):

- **Table comment** (restated): adds that each row carries both members'
  parties and a stored `agreement_rate`; order by `AGREEMENT_RATE_DESC` with a
  `shared_votes` floor (rates on tiny overlaps are noise); pairs are stored
  once with `member_a < member_b` *by bioguide id*, so `party_a`/`party_b`
  follow member order, not a canonical party order — `cross_party` is the
  order-safe way to select opposing-party pairs; parties are each member's
  dominant vote-time party (mid-congress switcher caveat).
- **Column comments** on all four new columns, including the tie-break rule
  and the "filter `shared_votes` before trusting the rate" guidance.

### 2. Ingester build stage — one query in `ingester/src/build-aggregates.js`

The `vote_similarity` INSERT gains the party columns. The pairwise aggregation
(the memory-critical ~100M-row self-join documented in AGENTS.md) is
**unchanged**; the dominant-party map is computed from the same `cpos` CTE
(already materialized — it's referenced twice today) and joined to the ~100–150k
*grouped* rows, not the pairwise stream:

```sql
INSERT INTO vote_similarity
  (congress, chamber, member_a, member_b, shared_votes, agreed, party_a, party_b)
WITH cpos AS (
  SELECT vp.vote_id, vp.bioguide_id, vp.position, vp.party, v.congress, v.chamber
  FROM vote_positions vp
  JOIN votes v ON v.vote_id = vp.vote_id
  WHERE v.congress = $1 AND vp.position IN ('Yea', 'Nay')
),
pairs AS (
  SELECT a.congress, a.chamber,
         a.bioguide_id AS member_a, b.bioguide_id AS member_b,
         count(*)::int AS shared_votes,
         count(*) FILTER (WHERE a.position = b.position)::int AS agreed
  FROM cpos a
  JOIN cpos b ON b.vote_id = a.vote_id AND a.bioguide_id < b.bioguide_id
  GROUP BY a.congress, a.chamber, a.bioguide_id, b.bioguide_id
),
party_counts AS (
  SELECT chamber, bioguide_id, party, count(*) AS positions
  FROM cpos
  GROUP BY chamber, bioguide_id, party
),
dominant_party AS (
  SELECT DISTINCT ON (chamber, bioguide_id) chamber, bioguide_id, party
  FROM party_counts
  ORDER BY chamber, bioguide_id, positions DESC, party
)
SELECT p.congress, p.chamber, p.member_a, p.member_b,
       p.shared_votes, p.agreed, da.party, db.party
FROM pairs p
JOIN dominant_party da ON da.chamber = p.chamber AND da.bioguide_id = p.member_a
JOIN dominant_party db ON db.chamber = p.chamber AND db.bioguide_id = p.member_b
```

The dominant-party derivation is scoped per chamber within the congress, so a
member who moved chambers mid-congress is labeled correctly in each. The
generated columns (`agreement_rate`, `cross_party`) fill themselves. Everything
else — transaction shape, watermark, `member_party_agreement`, memory settings —
is untouched.

### 3. Docs

- **`us-congress/CHANGELOG.md`** under `[Unreleased]` / `### Added`
  (API-consumer-facing): `VoteSimilarity` gains `partyA`, `partyB`,
  `agreementRate`, `crossParty` — all filterable and orderable (notably
  `AGREEMENT_RATE_DESC`) — making top cross-party pairs a single server-side
  query.
- **Hand-written Aggregation section** (`docs/docs/schema/index.md`): the
  "Voting similarity" block currently says "compute the agreement ratio as
  `agreed / sharedVotes`" and examples `orderBy: AGREED_DESC`. Update to
  present `agreementRate` (ready to sort on, like the member-party block
  already does) and add the cross-party top-N example.
- **No generated-schema-docs impact**: aggregate tables have no per-table
  generated pages (`vote_similarity` is not in the generator's `TABLE_ORDER`;
  it's documented only in the hand-written Aggregation section above), so
  there is nothing to regenerate for this change.

## Resulting GraphQL surface (all additive)

- `VoteSimilarity` gains `partyA`, `partyB`, `agreementRate`, `crossParty`.
- `VoteSimilarityFilter` gains all four; `VoteSimilaritiesOrderBy` gains
  `AGREEMENT_RATE_ASC/DESC`, `PARTY_A_*`, `PARTY_B_*`, `CROSS_PARTY_*`.
- The issue's target query becomes, on the existing connection:

```graphql
{
  allVoteSimilarities(
    filter: {
      congress: { equalTo: 119 }
      chamber: { equalTo: "s" }
      crossParty: { equalTo: true }
      sharedVotes: { greaterThanOrEqualTo: 100 }
    }
    orderBy: AGREEMENT_RATE_DESC
    first: 10
  ) {
    nodes {
      legislatorByMemberA { officialFull }
      legislatorByMemberB { officialFull }
      partyA partyB sharedVotes agreed agreementRate
    }
  }
}
```

- **Party order caveat** (inherited from canonical pair storage, documented in
  the table comment): `party_a`/`party_b` follow bioguide order, so a filter
  for specifically-D-vs-R pairs needs
  `or: [{partyA: {equalTo: "D"}, partyB: {equalTo: "R"}}, {partyA: {equalTo: "R"}, partyB: {equalTo: "D"}}]`;
  `crossParty` itself is symmetric and needs no such care.

## Backfill & deploy notes

- `vote_similarity` holds ~1.95M rows (live count, 2026-07-16). Adding a
  STORED generated column rewrites the table; the backfill UPDATE rewrites it
  again; `SET NOT NULL` scans it. All bounded, minutes at worst on the
  production container.
- Migrations apply via the one-shot `flyway` service on every deploy `up`, in
  the same deploy that swaps the ingester image. If the hourly build (`:55`)
  fires inside that window, the old image's INSERT violates `NOT NULL` and the
  run fails — which is the already-designed self-healing path (watermark not
  advanced → congress stays stale → retried next hour, run marked failed).
  Worst case is one missed heartbeat; no action needed.

## Verification (local stack; no automated DB test harness)

1. **Migration applies** on a local DB with real ingested data; `SET NOT NULL`
   succeeds (proves full backfill coverage).
2. **Backfill ≡ rebuild:** delete one congress's `vote_similarity_state` row,
   run `build-aggregates.js`, and diff that congress's
   `(member_a, member_b, party_a, party_b)` against the pre-rebuild backfilled
   values — must be identical.
3. **Canonical query** via local PostGraphile: ordering strictly by
   `agreementRate` desc; every row has `partyA <> partyB`; `agreementRate`
   equals `agreed / sharedVotes`.
4. **Switcher spot-check** (data permitting): a known mid-congress switcher
   (e.g. Van Drew, 116th House) carries exactly one deterministic label, while
   `member_party_agreement` still shows their per-party split rows.
5. **Sanity vs. sibling:** for a few members, `party_a`/`party_b` matches the
   `member_party_agreement.member_party` value with the most `shared_votes`
   for that congress+chamber.
6. Optional: `EXPLAIN` the canonical query, expect the partial index.
7. Ingester hygiene: `npm test` and `npm run check-pipeline-docs` in
   `ingester/` still pass (the manifest doesn't change — the stage reads and
   writes the same tables).

## Out of scope / noted

- The MCP `most_agreeing_pairs` tool (and whether the raw query is now obvious
  enough to skip it) — tracked in the MCP roadmap, separate branch lineage.
  The deferral wording in `mcp-server/docs/design.md` is already updated on
  the unmerged v0.4 branch.
- Production rollout / live confirmation on `api.govql.us` — the normal
  deploy, outside this spec.
- No `PIPELINE.md` / pipeline-manifest change: the build stage's
  reads/writes/watermark are table-granular and unchanged.
- No MCP-server code change or PyPI publish (DB + ingester + docs only).
