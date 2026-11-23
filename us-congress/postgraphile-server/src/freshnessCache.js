// =============================================================================
// Data freshness cache
//
// Every response carries an X-Last-Ingest header so API consumers know how
// stale the data is. Cached for 60 s to avoid a DB round-trip per request.
// =============================================================================
const FRESHNESS_TTL_MS = 60_000;
let freshnessCache = { value: null, fetchedAt: 0 };

export async function getLastIngestTimestamp(logger, pool) {
  const now = Date.now();
  if (now - freshnessCache.fetchedAt < FRESHNESS_TTL_MS)
    return freshnessCache.value;
  try {
    const { rows } = await pool.query(
      `SELECT max(finished_at) AS ts FROM ingestion_runs WHERE status = 'success'`
    );
    freshnessCache = {
      value: rows[0]?.ts?.toISOString() ?? null,
      fetchedAt: now,
    };
  } catch (err) {
    logger.warn(`freshness cache refresh failed: ${err.message}`);
  }
  return freshnessCache.value;
}