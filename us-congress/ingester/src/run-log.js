// Shared ingestion_runs logging, extracted as part of the source-connector
// contract (see CONNECTORS.md). Mirrors the open/succeed/fail lifecycle the
// existing stages write inline: a 'running' row at start, closed on success
// or marked failed from the stage's catch block. LOAD stages call succeedRun
// inside the same transaction as their cursor advance (the two must never
// disagree); FETCH stages advance their cursor per committed page instead,
// so they close the run outside any transaction as plain bookkeeping.
//
// Pool-free like cursor-state.js — takes a client, unit-testable with stubs.

/** Open a 'running' ingestion_runs row; returns its id. */
export async function openRun(client, runType, sourceParams = null) {
  const { rows } = await client.query(
    `INSERT INTO ingestion_runs (run_type, status, source_params)
     VALUES ($1, 'running', $2)
     RETURNING id`,
    [runType, sourceParams === null ? null : JSON.stringify(sourceParams)],
  );
  return rows[0].id;
}

/**
 * Close a run as successful with the number of records upserted. Optional
 * `outcome` details (e.g. a fetch run's `{verified, passes}`) merge into
 * source_params so monitoring can query them — a run that completed but gave
 * up on some guarantee must be distinguishable from a healthy one in
 * ingestion_runs, not only in container logs.
 */
export async function succeedRun(client, runId, recordsUpserted, outcome = null) {
  await client.query(
    `UPDATE ingestion_runs
     SET finished_at = now(), status = 'success', records_upserted = $1,
         source_params = coalesce(source_params, '{}'::jsonb) || $2
     WHERE id = $3`,
    [recordsUpserted, outcome === null ? '{}' : JSON.stringify(outcome), runId],
  );
}

/** Close a run as failed with the error message. */
export async function failRun(client, runId, errorMessage) {
  await client.query(
    `UPDATE ingestion_runs
     SET finished_at = now(), status = 'failed', error_message = $1
     WHERE id = $2`,
    [errorMessage, runId],
  );
}
