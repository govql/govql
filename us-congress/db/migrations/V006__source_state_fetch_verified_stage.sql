-- Task 0010 review round 2: add a 'fetch_verified' stage to source_state.
--
-- API-source fetchers keep two watermarks per discovery unit: the 'fetch'
-- cursor is the RESUME position (advanced per committed page, monotonic), and
-- 'fetch_verified' is the VERIFIED-THROUGH position — advanced only after a
-- clean verification re-walk finds nothing new. A crash or pass-cap during
-- verification leaves 'fetch_verified' behind, so the next run re-walks from
-- it and no offset-pagination boundary skip can strand a record behind the
-- resume cursor. See ingester/CONNECTORS.md "Watermarks and gating".

ALTER TABLE source_state DROP CONSTRAINT source_state_stage_check;
ALTER TABLE source_state
  ADD CONSTRAINT source_state_stage_check CHECK (stage IN ('fetch', 'fetch_verified', 'load'));
