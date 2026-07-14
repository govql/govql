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

-- Restate the table comment to point consumers at the new relations and to make
-- clear that party is NOT reachable via legislators (it is per-congress).
COMMENT ON TABLE vote_similarity IS E'Pairwise voting agreement, per congress: one row per (congress, chamber, member_a, member_b) with shared_votes (both cast Yea/Nay) and agreed (voted the same). Pairs are stored once with member_a < member_b. Maintained by the vote ingester. Compute agreement as agreed::float / shared_votes. Join legislatorByMemberA / legislatorByMemberB for each member''s name and details; party is per-congress and not on legislators — see member_party_agreement for a member''s party in a given congress.';
