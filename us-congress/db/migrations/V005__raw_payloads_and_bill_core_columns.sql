-- Task 0010 (issue #89): landing zone for API-source raw JSON, plus the core
-- bill columns the Congress.gov bill-list endpoint carries.
--
-- raw_payloads is the connector contract's raw layer for API sources (scraped
-- file sources keep landing on disk instead — see ingester/CONNECTORS.md).
-- One row per (source, natural key, endpoint); the fetch stage upserts the
-- latest payload and only touches fetched_at when the payload actually
-- changed, so fetched_at doubles as the load stage's staleness watermark
-- (the plan's owned-table gating rule).

CREATE TABLE raw_payloads (
  source_name TEXT        NOT NULL,  -- connector source key, e.g. 'congress-bills'
  natural_key TEXT        NOT NULL,  -- entity natural key, e.g. 'hr3590-111'
  endpoint    TEXT        NOT NULL,  -- which API endpoint produced it, e.g. 'bill-list'
  payload     JSONB       NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_name, natural_key, endpoint)
);

COMMENT ON TABLE raw_payloads IS E'@omit\nRaw API payloads landed by fetch stages (one row per source/natural key/endpoint, latest payload wins) — internal pipeline plumbing, not exposed via GraphQL.';

-- The load stage reads rows fetched past its cursor, ordered by fetched_at;
-- the PK index cannot serve that range scan.
CREATE INDEX idx_raw_payloads_staleness ON raw_payloads (source_name, endpoint, fetched_at);

-- Core columns the bill-list endpoint provides that bills lacks. The display
-- title is Congress.gov's own (latest) title for the bill — distinct from the
-- unitedstates-taxonomy official/short/popular titles already present.
-- policy_area is on the task's core-column list; the list endpoint does not
-- carry it, so it stays NULL until the per-bill detail work (task 0011).
ALTER TABLE bills ADD COLUMN title TEXT;
ALTER TABLE bills ADD COLUMN policy_area TEXT;
ALTER TABLE bills ADD COLUMN latest_action TEXT;
ALTER TABLE bills ADD COLUMN latest_action_at DATE;

COMMENT ON COLUMN bills.title IS 'Display title from Congress.gov (the latest title for the bill).';
COMMENT ON COLUMN bills.policy_area IS 'Primary policy area assigned by CRS (populated by per-bill detail ingestion, task 0011).';
COMMENT ON COLUMN bills.latest_action IS 'Text of the most recent action on the bill, from Congress.gov.';
COMMENT ON COLUMN bills.latest_action_at IS 'Date of the most recent action on the bill.';
