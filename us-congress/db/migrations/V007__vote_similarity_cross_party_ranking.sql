-- Make "which opposing-party members vote together most?" a one-query,
-- server-side answer (issue #87): add each member's party to vote_similarity
-- plus a stored agreement_rate — PostGraphile then emits AGREEMENT_RATE_*
-- orderBy, exactly as on member_party_agreement — and a cross_party flag (the
-- GraphQL connection filter cannot compare two columns, so party_a <> party_b
-- must be materialized to be filterable). Ranking cannot be pushed to clients:
-- a House congress slice is ~96k pairs, and AGREED_DESC is a poor proxy for
-- the rate (300/300 = 100% sorts below 350/500 = 70%).

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
-- Same derivation the ingester's rebuild now computes (build-aggregates.js),
-- so a later rebuild reproduces these exact values.
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
-- none of those rows lack a party (verified on live data, 2026-07-16), so the
-- backfill reaches every row. If that invariant ever breaks, failing loudly
-- here (and in the ingester's NOT NULL insert) is the intended behavior —
-- matching member_party_agreement.member_party, built from the same source.
ALTER TABLE vote_similarity
  ALTER COLUMN party_a SET NOT NULL,
  ALTER COLUMN party_b SET NOT NULL;

-- Serve the canonical query — top pairs by rate within a congress+chamber,
-- cross-party only — without a per-query sort of the whole slice.
CREATE INDEX idx_vote_similarity_cross_party_rate
  ON vote_similarity (congress, chamber, agreement_rate DESC)
  WHERE cross_party;

-- Restate the table comment (PostGraphile surfaces it as the type description;
-- agents read it via describe_type) and describe the new columns.
COMMENT ON TABLE vote_similarity IS E'Pairwise voting agreement, per congress: one row per (congress, chamber, member_a, member_b) with shared_votes (both cast Yea/Nay), agreed (voted the same), each member''s party, and a stored agreement_rate (agreed / shared_votes). Pairs are stored once with member_a < member_b (by bioguide id), so party_a/party_b follow member order, not a canonical party order — filter cross_party = true to select opposing-party pairs regardless of order. Rank with orderBy AGREEMENT_RATE_DESC plus a shared_votes floor (e.g. greaterThanOrEqualTo: 100); rates on tiny overlaps are noise. Maintained by the vote ingester. Join legislatorByMemberA / legislatorByMemberB for each member''s name and details; see member_party_agreement for member-vs-party loyalty.';

COMMENT ON COLUMN vote_similarity.party_a IS E'member_a''s dominant vote-time party in this congress+chamber — the party they cast the most Yea/Nay positions under (vote_positions snapshots party at vote time). A rare mid-congress switcher gets the party they voted under more often; ties break alphabetically.';

COMMENT ON COLUMN vote_similarity.party_b IS E'member_b''s dominant vote-time party in this congress+chamber — see party_a for the derivation.';

COMMENT ON COLUMN vote_similarity.agreement_rate IS E'agreed / shared_votes, stored so consumers can order by it (AGREEMENT_RATE_DESC). Meaningless on tiny overlaps — pair it with a shared_votes floor.';

COMMENT ON COLUMN vote_similarity.cross_party IS E'True when party_a <> party_b. The order-safe way to select opposing-party pairs: party columns follow member order (member_a < member_b by bioguide id), so filtering party_a/party_b directly must handle both orders.';
