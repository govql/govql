-- Make "which opposing-party members vote together most?" a one-query,
-- server-side answer (issue #87): add each member's party to vote_similarity
-- plus a stored agreement_rate — PostGraphile then emits AGREEMENT_RATE_*
-- orderBy, exactly as on member_party_agreement — and a cross_party flag (the
-- GraphQL connection filter cannot compare two columns, so party_a <> party_b
-- must be materialized to be filterable). Ranking cannot be pushed to clients:
-- a House congress slice is ~96k pairs, and AGREED_DESC is a poor proxy for
-- the rate (300/300 = 100% sorts below 350/500 = 70%).

-- Flyway runs this file in one transaction, so SET LOCAL governs the whole
-- migration. Same memory guards as the ingester's aggregate rebuild
-- (build-aggregates.js; see AGENTS.md "Aggregate rebuild memory"): the backfill
-- below aggregates vote_positions, and at the cluster-default work_mem the
-- planner's group-count overestimates can pick a spilling plan whose temp-file
-- page cache has OOM-killed the 256M postgres container before.
SET LOCAL work_mem = '32MB';
SET LOCAL max_parallel_workers_per_gather = 0;
SET LOCAL jit = off;

-- One column per ADD COLUMN statement — generate-schema-docs.mjs parses
-- migrations and requires this shape (see its header comment).
ALTER TABLE vote_similarity
  ADD COLUMN party_a TEXT;
ALTER TABLE vote_similarity
  ADD COLUMN party_b TEXT;
ALTER TABLE vote_similarity
  ADD COLUMN agreement_rate REAL GENERATED ALWAYS AS
    (agreed::real / NULLIF(shared_votes, 0)) STORED;
ALTER TABLE vote_similarity
  ADD COLUMN cross_party BOOLEAN GENERATED ALWAYS AS
    (party_a IS DISTINCT FROM party_b) STORED;

-- Backfill: each member's dominant vote-time party within the congress+chamber
-- — the party they cast the most Yea/Nay positions under (vote_positions
-- snapshots party at vote time), ties broken alphabetically for determinism.
-- Same derivation the ingester's rebuild computes (build-aggregates.js), with
-- two migration-specific differences:
--   * per-congress loop, mirroring the rebuild's $1 scoping — one congress's
--     positions at a time keeps every aggregate/sort memory-bounded no matter
--     what plan the optimizer picks (see the SET LOCAL note above);
--   * NULL-party positions are excluded here rather than aborting: the
--     migration cannot distinguish stale rows from bad data, so loud
--     enforcement of "every counted position has a party" stays with the
--     rebuild (whose INSERT, like member_party_agreement, fails NOT NULL).
DO $$
DECLARE
  c smallint;
BEGIN
  FOR c IN SELECT DISTINCT congress FROM vote_similarity ORDER BY congress LOOP
    WITH cpos AS (
      SELECT vp.bioguide_id, vp.party, v.chamber
      FROM vote_positions vp
      JOIN votes v ON v.vote_id = vp.vote_id
      WHERE v.congress = c AND vp.position IN ('Yea', 'Nay')
        AND vp.party IS NOT NULL
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
    UPDATE vote_similarity vs
    SET party_a = da.party,
        party_b = db.party
    FROM dominant_party da, dominant_party db
    WHERE vs.congress = c
      AND da.chamber = vs.chamber AND da.bioguide_id = vs.member_a
      AND db.chamber = vs.chamber AND db.bioguide_id = vs.member_b;
  END LOOP;
END $$;

-- Rows still NULL reference a member with no current Yea/Nay positions (with a
-- party) in the congress+chamber: stale pairs whose positions were corrected
-- since the last rebuild, or NULL-party artifacts. Both are wrong per current
-- data — drop them and clear those congresses' watermarks so the next hourly
-- build regenerates the whole congress from live positions (genuine NULL-party
-- data still aborts that rebuild loudly). Without this sweep, a single stale
-- row would fail SET NOT NULL and brick the deploy.
WITH deleted AS (
  DELETE FROM vote_similarity
  WHERE party_a IS NULL OR party_b IS NULL
  RETURNING congress
)
DELETE FROM vote_similarity_state s
USING (SELECT DISTINCT congress FROM deleted) d
WHERE s.congress = d.congress;

-- Provably safe now: every surviving row was matched by dominant_party, whose
-- rows carry no NULL party by construction.
ALTER TABLE vote_similarity
  ALTER COLUMN party_a SET NOT NULL;
ALTER TABLE vote_similarity
  ALTER COLUMN party_b SET NOT NULL;

-- Serve the canonical query — top pairs by rate within a congress+chamber,
-- cross-party only — without a per-query sort of the whole slice.
CREATE INDEX idx_vote_similarity_cross_party_rate
  ON vote_similarity (congress, chamber, agreement_rate DESC)
  WHERE cross_party;

-- Restate the table comment (PostGraphile surfaces it as the type description;
-- agents read it via describe_type) and describe the new columns.
COMMENT ON TABLE vote_similarity IS E'Pairwise voting agreement, per congress: one row per (congress, chamber, member_a, member_b) with shared_votes (both cast Yea/Nay), agreed (voted the same), each member''s party, and a stored agreement_rate (agreed / shared_votes). Pairs are stored once with member_a < member_b (by bioguide id), so party_a/party_b follow member order, not a canonical party order — filter cross_party = true to select different-party pairs regardless of order. Independents count as their own party, so cross-party rankings lead with I–D caucus pairs; for strict D–R pairs filter party_a/party_b in both orders. Rank with orderBy AGREEMENT_RATE_DESC plus a shared_votes floor (e.g. greaterThanOrEqualTo: 100); rates on tiny overlaps are noise. Maintained by the vote ingester. Join legislatorByMemberA / legislatorByMemberB for each member''s name and details — party is per-congress and NOT a field on legislators; it is carried here as party_a/party_b (see member_party_agreement for member-vs-party loyalty).';

COMMENT ON COLUMN vote_similarity.party_a IS E'member_a''s dominant vote-time party in this congress+chamber — the party they cast the most Yea/Nay positions under (vote_positions snapshots party at vote time). A rare mid-congress switcher gets the party they voted under more often; ties break alphabetically.';

COMMENT ON COLUMN vote_similarity.party_b IS E'member_b''s dominant vote-time party in this congress+chamber — see party_a for the derivation.';

COMMENT ON COLUMN vote_similarity.agreement_rate IS E'agreed / shared_votes, stored so consumers can order by it (AGREEMENT_RATE_DESC). Meaningless on tiny overlaps — pair it with a shared_votes floor.';

COMMENT ON COLUMN vote_similarity.cross_party IS E'True when party_a <> party_b — the order-safe way to select different-party pairs (party columns follow member order, so filtering party_a/party_b directly must handle both orders). Independents count as their own party: cross-party rankings lead with I–D caucus pairs; for strict D–R matchups filter both party orders with or.';
