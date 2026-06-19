-- =============================================================================
-- 002 — Member-vs-party agreement
--
-- Adds the member_party_agreement aggregate table, and restates the
-- vote_similarity_state comment to reflect that its rebuild watermark now governs
-- both per-congress precomputed aggregates. Applied after 001-schema.sql.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- MEMBER-VS-PARTY AGREEMENT (all congresses) — incrementally maintained table
-- For each member, how often they voted with each party: one row per
-- (congress, chamber, bioguide_id, member_party, other_party). On each vote a
-- party's "position" is its strict-majority of Yea/Nay; agreement = the member's
-- Yea/Nay matched that majority. shared_votes counts votes where the member cast
-- Yea/Nay AND other_party had a determinable majority; agreed counts the matches.
--
-- other_party ranges over every party including the member's own — the own-party
-- row is a loyalty signal (and its inverse, a defection signal). member_party is
-- the member's party on the counted votes; a mid-congress party-switcher (rare)
-- splits into separate rows per party held.
--
-- Built per congress from vote_positions (party snapshotted at vote time) joined
-- to votes (for congress/chamber) — plain GROUP BYs, no roster join. Rebuilt by
-- the same per-congress incremental path as vote_similarity (see ingest-votes.js).
-- ---------------------------------------------------------------------------
CREATE TABLE member_party_agreement (
  congress       SMALLINT NOT NULL,
  chamber        CHAR(1)  NOT NULL,
  bioguide_id    TEXT     NOT NULL REFERENCES legislators (bioguide_id),
  member_party   TEXT     NOT NULL,      -- member's party on the counted votes
  other_party    TEXT     NOT NULL,      -- party compared against; includes own party (= loyalty)
  shared_votes   INT      NOT NULL,      -- votes where member cast Yea/Nay AND other_party had a majority
  agreed         INT      NOT NULL,      -- of those, votes where member matched other_party's majority
  -- Precomputed ratio so GraphQL can orderBy AGREEMENT_RATE_DESC without client-side sorting.
  agreement_rate REAL GENERATED ALWAYS AS (agreed::real / NULLIF(shared_votes, 0)) STORED,

  PRIMARY KEY (congress, chamber, bioguide_id, member_party, other_party)
);

COMMENT ON TABLE member_party_agreement IS E'How often each member voted with each party, per congress: one row per (congress, chamber, bioguide_id, member_party, other_party). agreement_rate = agreed / shared_votes, where agreement on a vote means the member''s Yea/Nay matched that party''s strict-majority position. other_party includes the member''s own party (loyalty). Maintained by the vote ingester.';

-- The rebuild watermark (created in 001) now governs this table too; restate its
-- comment to name both aggregates it covers.
COMMENT ON TABLE vote_similarity_state IS E'@omit\nRebuild bookkeeping for the per-congress precomputed aggregates (vote_similarity, member_party_agreement) — internal, not exposed via GraphQL.';
