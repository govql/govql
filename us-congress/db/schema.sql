-- =============================================================================
-- Congressional Voting Database Schema
-- For use with PostGraphile + unitedstates/congress ingestion pipeline
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- LEGISLATORS
-- Core legislator identity, keyed by bioguide_id (the canonical cross-system ID)
-- ---------------------------------------------------------------------------
CREATE TABLE legislators (
  bioguide_id   TEXT        PRIMARY KEY,
  -- IDs in external systems (nullable; not all legislators have all IDs)
  thomas_id     TEXT        UNIQUE,
  lis_id        TEXT        UNIQUE,        -- Senate roll call ID
  govtrack_id   INTEGER     UNIQUE,
  opensecrets_id TEXT,
  votesmart_id  INTEGER,
  icpsr_id      INTEGER,
  cspan_id      INTEGER,
  -- Name fields
  first_name    TEXT        NOT NULL,
  middle_name   TEXT,
  last_name     TEXT        NOT NULL,
  name_suffix   TEXT,
  nickname      TEXT,
  official_full TEXT,                      -- As displayed on House/Senate websites
  -- Biographical
  birthday      DATE,
  gender        CHAR(1)     CHECK (gender IN ('M', 'F')),
  -- Ingestion bookkeeping
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE legislators IS 'One row per person who has ever served in Congress. Bioguide ID is the canonical primary key used across all unitedstates/* datasets.';
COMMENT ON COLUMN legislators.lis_id IS 'Used in Senate roll call XML to identify members. Essential for matching Senate vote records.';

-- ---------------------------------------------------------------------------
-- LEGISLATOR TERMS
-- Each election/appointment produces one term row.
-- ---------------------------------------------------------------------------
CREATE TABLE legislator_terms (
  id            BIGSERIAL   PRIMARY KEY,
  bioguide_id   TEXT        NOT NULL REFERENCES legislators (bioguide_id),
  term_type     TEXT        NOT NULL CHECK (term_type IN ('rep', 'sen')),
  start_date    DATE        NOT NULL,
  end_date      DATE        NOT NULL,
  state         CHAR(2)     NOT NULL,
  party         TEXT,
  caucus        TEXT,                      -- For independents, the party they caucus with
  district      SMALLINT,                  -- House only; 0 = at-large, -1 = historical unknown
  senate_class  SMALLINT    CHECK (senate_class IN (1, 2, 3)),
  state_rank    TEXT        CHECK (state_rank IN ('junior', 'senior')),
  how           TEXT,                      -- 'election', 'appointment', 'special-election'
  -- Contact (valid for current term only; snapshotted at ingestion time)
  url           TEXT,
  address       TEXT,
  phone         TEXT,
  office        TEXT
);

COMMENT ON TABLE legislator_terms IS 'Each row is one term of service. A legislator may have many terms across both chambers.';
COMMENT ON COLUMN legislator_terms.district IS 'House only. 0 = at-large district. -1 = unknown in historical data.';

CREATE INDEX idx_terms_bioguide ON legislator_terms (bioguide_id);
CREATE INDEX idx_terms_state ON legislator_terms (state);
CREATE INDEX idx_terms_dates ON legislator_terms (start_date, end_date);

-- ---------------------------------------------------------------------------
-- COMMITTEES
-- Both current and historical. thomas_id is the stable 4-letter code.
-- ---------------------------------------------------------------------------
CREATE TABLE committees (
  thomas_id         TEXT    PRIMARY KEY,   -- e.g. 'HSWM', 'SSEG'
  chamber           TEXT    NOT NULL CHECK (chamber IN ('house', 'senate', 'joint')),
  name              TEXT    NOT NULL,
  jurisdiction      TEXT,
  parent_thomas_id  TEXT    REFERENCES committees (thomas_id),  -- NULL for full committees
  subcommittee_id   TEXT,                  -- 2-digit code, unique within parent
  is_current        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE committees IS 'House, Senate, and Joint committees and subcommittees. Subcommittees have parent_thomas_id set.';
COMMENT ON COLUMN committees.thomas_id IS 'For subcommittees, this is the concatenated parent + subcommittee code (e.g. SSEG03).';

CREATE INDEX idx_committees_chamber ON committees (chamber);
CREATE INDEX idx_committees_parent ON committees (parent_thomas_id);

-- ---------------------------------------------------------------------------
-- BILLS
-- Scoped to vote-related data; not intended to be a complete bill database.
-- ---------------------------------------------------------------------------
CREATE TABLE bills (
  id              BIGSERIAL   PRIMARY KEY,
  bill_id         TEXT        NOT NULL UNIQUE, -- e.g. 'hr3590-111'
  bill_type       TEXT        NOT NULL CHECK (bill_type IN ('hr','hres','hjres','hconres','s','sres','sjres','sconres')),
  bill_number     INTEGER     NOT NULL,
  congress        SMALLINT    NOT NULL,
  introduced_at   DATE,
  official_title  TEXT,
  short_title     TEXT,
  popular_title   TEXT,
  status          TEXT,                        -- Bill status code per unitedstates/congress taxonomy
  status_at       TIMESTAMPTZ,
  -- Sponsor (denormalised for query convenience; FK to legislators)
  sponsor_bioguide_id TEXT    REFERENCES legislators (bioguide_id),
  -- Enactment (if applicable)
  enacted_as_law_type TEXT,                    -- 'public' or 'private'
  enacted_as_number   TEXT,                    -- Slip law number
  -- Ingestion bookkeeping
  source_updated_at TIMESTAMPTZ,              -- updated_at from the upstream JSON
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE bills IS 'Legislation referenced by roll call votes. Not a comprehensive bill database — populated from vote cross-references.';
COMMENT ON COLUMN bills.bill_id IS 'Canonical ID in the form [bill_type][number]-[congress], e.g. hr3590-111.';
COMMENT ON COLUMN bills.status IS 'Current bill status code per the unitedstates/congress taxonomy (INTRODUCED, REFERRED, ENACTED:SIGNED, etc.).';

CREATE INDEX idx_bills_congress ON bills (congress);
CREATE INDEX idx_bills_type ON bills (bill_type);
CREATE INDEX idx_bills_status ON bills (status);
CREATE INDEX idx_bills_sponsor ON bills (sponsor_bioguide_id);

-- ---------------------------------------------------------------------------
-- ROLL CALL VOTES
-- One row per vote event (a specific question put to a chamber on a specific day).
-- ---------------------------------------------------------------------------
CREATE TABLE votes (
  id              BIGSERIAL   PRIMARY KEY,
  vote_id         TEXT        NOT NULL UNIQUE, -- e.g. 'h202-113.2013'
  chamber         CHAR(1)     NOT NULL CHECK (chamber IN ('h', 's')),
  congress        SMALLINT    NOT NULL,
  session         TEXT        NOT NULL,        -- Calendar year string, e.g. '2013'
  number          INTEGER     NOT NULL,
  voted_at        TIMESTAMPTZ,                 -- Date or datetime of vote
  -- What was being voted on
  question        TEXT,                        -- Full description from House/Senate
  vote_type       TEXT,                        -- Semi-normalised: 'On Passage', etc.
  category        TEXT        CHECK (category IN (
                    'passage','passage-suspension','amendment','cloture',
                    'nomination','treaty','recommit','quorum','leadership',
                    'conviction','veto-override','procedural','unknown'
                  )),
  -- Result
  result          TEXT,                        -- Free-form result string from source
  result_text     TEXT,
  requires        TEXT,                        -- Threshold required, e.g. '1/2', '2/3'
  -- Related documents
  related_bill_id TEXT        REFERENCES bills (bill_id),
  -- Ingestion metadata
  source_url      TEXT,                        -- Primary source URL (human-readable link)
  source_updated_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (chamber, congress, session, number)
);

COMMENT ON TABLE votes IS 'One row per roll call vote event. The vote_id is the canonical identifier from unitedstates/congress (e.g. h202-113.2013).';
COMMENT ON COLUMN votes.category IS 'Normalised vote category from unitedstates/congress: passage, amendment, cloture, nomination, treaty, etc.';
COMMENT ON COLUMN votes.session IS 'Calendar year string. Sessions roughly follow calendar years but are bounded by Congress start/end dates.';
COMMENT ON COLUMN votes.source_url IS 'Canonical URL of the upstream source — suitable for linking users to the official primary source.';

CREATE INDEX idx_votes_chamber ON votes (chamber);
CREATE INDEX idx_votes_congress ON votes (congress);
CREATE INDEX idx_votes_category ON votes (category);
CREATE INDEX idx_votes_voted_at ON votes (voted_at DESC);
CREATE INDEX idx_votes_related_bill ON votes (related_bill_id);
-- Compound index for common "all votes in a session" queries
CREATE INDEX idx_votes_chamber_congress_session ON votes (chamber, congress, session);

-- ---------------------------------------------------------------------------
-- VOTE POSITIONS (the individual member-level votes)
-- This is the highest-volume table: ~500 members × thousands of votes.
-- ---------------------------------------------------------------------------
CREATE TABLE vote_positions (
  id              BIGSERIAL   PRIMARY KEY,
  vote_id         TEXT        NOT NULL REFERENCES votes (vote_id),
  bioguide_id     TEXT        NOT NULL REFERENCES legislators (bioguide_id),
  -- Position as recorded; values differ slightly between chambers
  position        TEXT        NOT NULL,        -- 'Yea','Nay','Not Voting','Present','VP' (VP tie-break)
  -- Party/state at time of vote (denormalised for query convenience)
  party           CHAR(1),                     -- 'D','R','I', etc.
  state           CHAR(2),

  UNIQUE (vote_id, bioguide_id)
);

COMMENT ON TABLE vote_positions IS 'The individual yea/nay/abstain position of each legislator on each roll call vote. Highest-volume table.';
COMMENT ON COLUMN vote_positions.position IS 'Values: Yea, Nay, Not Voting, Present, VP (vice presidential tie-breaker).';
COMMENT ON COLUMN vote_positions.party IS 'Party at time of vote (snapshotted from upstream data to avoid joins for common analytics).';

-- These indexes are critical for performance at query time
CREATE INDEX idx_positions_vote_id ON vote_positions (vote_id);
CREATE INDEX idx_positions_bioguide ON vote_positions (bioguide_id);
CREATE INDEX idx_positions_position ON vote_positions (position);
-- Compound: "how did all Democrats vote on this vote?"
CREATE INDEX idx_positions_vote_party ON vote_positions (vote_id, party);
-- Compound: "all votes by this member, most recent first" (joined with votes table)
CREATE INDEX idx_positions_bioguide_vote ON vote_positions (bioguide_id, vote_id);

-- ---------------------------------------------------------------------------
-- BILL COSPONSORS
-- ---------------------------------------------------------------------------
CREATE TABLE bill_cosponsors (
  id                  BIGSERIAL   PRIMARY KEY,
  bill_id             TEXT        NOT NULL REFERENCES bills (bill_id),
  bioguide_id         TEXT        NOT NULL REFERENCES legislators (bioguide_id),
  original_cosponsor  BOOLEAN     NOT NULL DEFAULT FALSE,
  sponsored_at        DATE,
  withdrawn_at        DATE,

  UNIQUE (bill_id, bioguide_id)
);

CREATE INDEX idx_cosponsors_bill ON bill_cosponsors (bill_id);
CREATE INDEX idx_cosponsors_legislator ON bill_cosponsors (bioguide_id);

-- ---------------------------------------------------------------------------
-- BILL COMMITTEE REFERRALS
-- ---------------------------------------------------------------------------
CREATE TABLE bill_committees (
  id              BIGSERIAL   PRIMARY KEY,
  bill_id         TEXT        NOT NULL REFERENCES bills (bill_id),
  thomas_id       TEXT        NOT NULL REFERENCES committees (thomas_id),
  activities      TEXT[],                  -- e.g. ARRAY['referral', 'markup', 'reporting']

  UNIQUE (bill_id, thomas_id)
);

CREATE INDEX idx_bill_committees_bill ON bill_committees (bill_id);
CREATE INDEX idx_bill_committees_committee ON bill_committees (thomas_id);

-- ---------------------------------------------------------------------------
-- COMMITTEE MEMBERSHIPS (current only)
-- ---------------------------------------------------------------------------
CREATE TABLE committee_memberships (
  id              BIGSERIAL   PRIMARY KEY,
  thomas_id       TEXT        NOT NULL REFERENCES committees (thomas_id),
  bioguide_id     TEXT        NOT NULL REFERENCES legislators (bioguide_id),
  party           TEXT        CHECK (party IN ('majority', 'minority')),
  rank            SMALLINT,
  title           TEXT,                    -- 'Chair', 'Ranking Member', 'Ex Officio', etc.

  UNIQUE (thomas_id, bioguide_id)
);

CREATE INDEX idx_memberships_committee ON committee_memberships (thomas_id);
CREATE INDEX idx_memberships_legislator ON committee_memberships (bioguide_id);

-- ---------------------------------------------------------------------------
-- API KEYS (for rate limiting / access tiers in GraphQL Yoga)
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  key             TEXT        PRIMARY KEY,
  tier            TEXT        NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'unlimited')),
  owner_email     TEXT,
  description     TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ
);

COMMENT ON TABLE api_keys IS 'API key registry for rate limiting and access tier enforcement in the Yoga middleware layer.';

CREATE INDEX idx_api_keys_active ON api_keys (is_active) WHERE is_active = TRUE;

-- ---------------------------------------------------------------------------
-- INGESTION RUN LOG
-- ---------------------------------------------------------------------------
CREATE TABLE ingestion_runs (
  id              BIGSERIAL   PRIMARY KEY,
  run_type        TEXT        NOT NULL,    -- 'votes', 'bills', 'legislators', etc.
  chamber         TEXT,                    -- 'house', 'senate', or NULL for both
  congress        SMALLINT,
  session         TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  records_upserted INTEGER,
  error_message   TEXT,
  source_params   JSONB                    -- The CLI args / config used for this run
);

COMMENT ON TABLE ingestion_runs IS 'Audit log of ingestion pipeline runs. Exposes data freshness — query max(finished_at) per run_type for cache-control headers.';

CREATE INDEX idx_ingestion_run_type ON ingestion_runs (run_type, started_at DESC);
CREATE INDEX idx_ingestion_status ON ingestion_runs (status);

-- ---------------------------------------------------------------------------
-- Updated-at trigger (shared across all timestamped tables)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_legislators_updated_at
  BEFORE UPDATE ON legislators
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_committees_updated_at
  BEFORE UPDATE ON committees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_bills_updated_at
  BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_votes_updated_at
  BEFORE UPDATE ON votes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- PostGraphile: smart comments for GraphQL naming / visibility control
-- ---------------------------------------------------------------------------

-- Expose the API keys table only to the privileged role, not the public schema
COMMENT ON TABLE api_keys IS E'@omit\nAPI key registry — managed by Yoga middleware, not exposed via GraphQL.';
COMMENT ON TABLE ingestion_runs IS E'@omit\nIngestion audit log — internal use only.';

-- Human-readable GraphQL field descriptions
COMMENT ON COLUMN votes.vote_id IS E'@name voteId\nCanonical vote identifier in the form [chamber][number]-[congress].[session], e.g. h202-113.2013.';
COMMENT ON COLUMN votes.category IS E'Normalised vote category. One of: passage, amendment, cloture, nomination, treaty, recommit, quorum, leadership, conviction, veto-override, procedural, unknown.';
COMMENT ON COLUMN legislators.bioguide_id IS E'Canonical legislator identifier from the Congressional Biographical Directory. Use this as the stable cross-system key.';
COMMENT ON COLUMN vote_positions.position IS E'The recorded vote position. Values: Yea, Nay, Not Voting, Present, VP (vice presidential tie-breaker).';
