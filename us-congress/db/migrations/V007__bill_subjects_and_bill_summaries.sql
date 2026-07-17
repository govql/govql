-- Task 0011 (issue #89): child tables for the per-bill fan-out — legislative
-- subjects and CRS summaries from the Congress.gov /subjects and /summaries
-- endpoints. Cosponsors reuse the existing bill_cosponsors table (V001); the
-- bills row itself is enriched in place from the /bill detail and /titles
-- endpoints (all target columns already exist).
--
-- Both tables are loaded per bill with DELETE + re-INSERT inside the load
-- transaction (the endpoint payload is the full current set for the bill, so
-- replacement also handles removals), matching the repo's child-row pattern.

CREATE TABLE bill_subjects (
  id         BIGSERIAL PRIMARY KEY,
  bill_id    TEXT      NOT NULL REFERENCES bills (bill_id),
  subject    TEXT      NOT NULL,  -- legislative subject term assigned by CRS
  UNIQUE (bill_id, subject)
);

COMMENT ON TABLE bill_subjects IS 'Legislative subject terms assigned to a bill by the Congressional Research Service, from the Congress.gov /subjects endpoint. One row per bill/term; the set is replaced wholesale when the bill updates. The primary policy area lives on bills.policy_area, not here.';

COMMENT ON COLUMN bill_subjects.subject IS 'Legislative subject term, e.g. "Health care costs and insurance".';

-- FK reverse lookup: all subjects for a bill (the UNIQUE covers this) and all
-- bills for a subject term.
CREATE INDEX idx_bill_subjects_subject ON bill_subjects (subject);

CREATE TABLE bill_summaries (
  id                BIGSERIAL   PRIMARY KEY,
  bill_id           TEXT        NOT NULL REFERENCES bills (bill_id),
  version_code      TEXT        NOT NULL,  -- CRS summary version, e.g. '00' = Introduced
  action_desc       TEXT,
  action_date       DATE,
  summary_text      TEXT,
  source_updated_at TIMESTAMPTZ,
  UNIQUE (bill_id, version_code)
);

COMMENT ON TABLE bill_summaries IS 'CRS-authored summaries of a bill, from the Congress.gov /summaries endpoint. One row per bill/summary version (a bill gains a new version as it advances, e.g. Introduced, Reported); the set is replaced wholesale when the bill updates.';

COMMENT ON COLUMN bill_summaries.version_code IS 'Congress.gov summary version code, e.g. ''00'' (Introduced).';
COMMENT ON COLUMN bill_summaries.action_desc IS 'Bill action the summary version corresponds to, e.g. ''Introduced in House''.';
COMMENT ON COLUMN bill_summaries.action_date IS 'Date of the action the summary version corresponds to.';
COMMENT ON COLUMN bill_summaries.summary_text IS 'Summary body as HTML, as published by CRS.';
COMMENT ON COLUMN bill_summaries.source_updated_at IS 'When Congress.gov last updated this summary version.';

-- FK reverse lookup: all summaries for a bill.
CREATE INDEX idx_bill_summaries_bill ON bill_summaries (bill_id);
