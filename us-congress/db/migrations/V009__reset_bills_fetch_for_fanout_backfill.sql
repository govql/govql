-- Task 0011 (issue #89): one-off data reset so the per-bill fan-out backfills
-- bills that were ingested before the fan-out existed.
--
-- The fan-out fires only when a bill's stored bill-list payload changes, and
-- 0010's deploy already landed every congress-119 list payload — so without
-- this reset, dormant bills (never updated upstream again) would never
-- receive their detail/cosponsors/subjects/summaries/titles. Deleting the
-- stored list payloads AND the fetch cursors makes the next hourly fetch a
-- full re-walk in which every bill reads as changed: the ordinary backfill
-- machinery (chunked commits, request budget, resume, verification) then
-- drip-feeds the ~90k-request fan-out over roughly a day, exactly as a fresh
-- install would.
--
-- Safe by construction: raw_payloads is rebuildable pipeline plumbing (the
-- domain tables are untouched), the bills load is idempotent, and the load
-- cursor is deliberately kept — re-fetched rows land with fresh fetched_at
-- values ahead of it.
--
-- Apply via the normal deploy (compose up runs Flyway alongside the new
-- ingester image). Do NOT apply manually while a pre-fan-out ingester is
-- still live: its next hourly tick would rebuild the list payloads without
-- fan-out, and the new code would then see every bill as unchanged. The
-- fetch stage's has-detail backstop (fan out any listed bill missing its
-- bill-detail raw) softens that window, but only for bills a later walk
-- actually lists — deploy order is still the guarantee.

DELETE FROM raw_payloads
WHERE source_name = 'congress-bills' AND endpoint = 'bill-list';

DELETE FROM source_state
WHERE source_name LIKE 'congress-bills-%' AND stage IN ('fetch', 'fetch_verified');
