// Staged-cursor readiness helper, shared by the ingesters.
//
// Ingestion is modeled as decoupled stages — fetch (scrape) → load (ingest) →
// build (aggregates). The fetch/load cursors live in the generic `source_state`
// table; `load.cursor` is the `fetch.cursor` value the load has fully consumed
// (read at start, written on success). A load runs only when fetch has advanced
// past what load last consumed. This file holds the pure readiness predicate and
// the thin `source_state` reads/writes; it never imports the pool, so the
// predicate is unit-testable without a database.

/**
 * Pure readiness predicate for the fetch→load handshake.
 *
 * A load is ready iff there is something fetched to consume (`fetchCursor` set)
 * AND either the load has never run (`loadCursor` null) or fetch has advanced
 * past what load last consumed (`fetchCursor > loadCursor`). With no fetch
 * cursor yet there is nothing to consume, so it is not ready (skip).
 */
export function isReady(fetchCursor, loadCursor) {
  if (fetchCursor == null) return false;
  if (loadCursor == null) return true;
  return new Date(fetchCursor) > new Date(loadCursor);
}

/**
 * Read the cursor for one `(source_name, stage)`. Returns the stored
 * `TIMESTAMPTZ` (a `Date`, as pg deserializes it) or null when no row exists.
 */
export async function readCursor(client, sourceName, stage) {
  const { rows } = await client.query(
    `SELECT cursor FROM source_state WHERE source_name = $1 AND stage = $2`,
    [sourceName, stage],
  );
  return rows.length ? rows[0].cursor : null;
}

/**
 * Advance the `load` cursor for a source to the `fetch` value the run just
 * consumed. Called only after a successful run, so a crash mid-run leaves the
 * cursor unadvanced and the next run re-checks readiness and re-walks
 * idempotently.
 */
export async function advanceLoadCursor(client, sourceName, value) {
  await client.query(
    `INSERT INTO source_state (source_name, stage, cursor, updated_at)
     VALUES ($1, 'load', $2, now())
     ON CONFLICT (source_name, stage)
       DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
    [sourceName, value],
  );
}

/**
 * Convenience for an ingester's run start: read both cursors and decide
 * readiness in one call. Returns the captured `fetchCursor` so the caller can
 * advance `load` to exactly that value on success.
 */
export async function loadReadiness(client, sourceName) {
  const fetchCursor = await readCursor(client, sourceName, 'fetch');
  const loadCursor = await readCursor(client, sourceName, 'load');
  return { fetchCursor, loadCursor, ready: isReady(fetchCursor, loadCursor) };
}
