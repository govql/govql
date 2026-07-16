/**
 * ingest-bills.js
 *
 * Load stage for the `congress-bills` source: transforms raw_payloads rows
 * fetched past the load cursor into bills upserts (ON CONFLICT (bill_id)
 * DO UPDATE — enriching the vote-stub rows, preserving the `hr3590-111`
 * natural-key format so vote cross-references keep resolving).
 *
 * Stage gate: raw_payloads is an owned table, so per the plan's gating rule
 * readiness is a staleness comparison on fetched_at — not the file-source
 * fetch↔load cursor handshake. The load cursor advances to the max consumed
 * fetched_at in the same transaction that marks the run successful.
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { readCursor, advanceLoadCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import { SOURCE_NAME, rawReadiness, loadStaleRawsIntoBills } from './connectors/congress-bills.js';

async function run() {
  const client = await pool.connect();
  let runId;

  try {
    const loadCursor = await readCursor(client, SOURCE_NAME, 'load');
    const { maxFetchedAt, ready } = await rawReadiness(client, loadCursor);
    if (!ready) {
      logger.info(
        `Bills load skipped — no raw payloads fetched past the load cursor ` +
        `(max fetched_at: ${maxFetchedAt ?? 'none'}, load cursor: ${loadCursor ?? 'none'})`,
      );
      return;
    }

    runId = await openRun(client, 'bills');

    const { ingested, failed, maxFetchedAt: consumed } = await loadStaleRawsIntoBills({
      client,
      loadCursor,
      log: logger.error,
    });

    // Advance the load cursor to the consumed watermark and mark the run
    // successful atomically — the cursor and run status can never disagree.
    await client.query('BEGIN');
    try {
      await advanceLoadCursor(client, SOURCE_NAME, consumed);
      await succeedRun(client, runId, ingested);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    logger.info(`Bills load complete — ingested: ${ingested}, failed: ${failed}, cursor: ${consumed}`);

    if (process.env.HEALTHCHECK_BILLS_INGEST_URL) {
      await fetch(process.env.HEALTHCHECK_BILLS_INGEST_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Bills load failed: ${err.message}`);
    if (runId) await failRun(client, runId, err.message).catch(() => {});
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
