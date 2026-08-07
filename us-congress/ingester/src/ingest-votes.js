/**
 * ingest-votes.js
 *
 * Thin cron entrypoint for the `congress-votes` load stage. All source logic
 * lives in the connector module (src/connectors/congress-votes.js): discover
 * walks the tree produced by `usc-run votes`, transform maps each data.json,
 * and load upserts every roll call vote (and its member positions) into
 * PostgreSQL. This script does the wiring: pool, logger, readiness gate, run
 * logging, cursor advance, exit codes.
 *
 * Stage gate: this is the `load` stage of the fetch→load→build pipeline. It
 * runs only when the scraper's `fetch` cursor in source_state has advanced past
 * the `load` cursor (see cursor-state.js); otherwise it is a clean no-op. The
 * cron time is a soft schedule, not the correctness gate. Building the
 * precomputed aggregates is a separate stage — see build-aggregates.js.
 *
 * Skip logic: if the vote already exists in the DB with a source_updated_at
 * >= the file's updated_at, the file is skipped. This keeps hourly runs fast
 * after the initial historical backfill.
 *
 * FK safety: vote_positions are inserted via a JOIN against the legislators
 * table, so any bioguide_id not yet in the DB is silently dropped (rather
 * than crashing the transaction). Run ingest-legislators.js first.
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { loadReadiness, advanceLoadCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import { SOURCE_NAME, load } from './connectors/congress-votes.js';

const DATA_DIR = process.env.CONGRESS_DATA_DIR ?? '/congress';

// Pass --force to reprocess vote files that are already current in the DB.
// Useful when the ingestion logic changes.
const FORCE = process.argv.includes('--force');

async function run() {
  const client = await pool.connect();
  let runId;

  try {
    // Readiness gate: run only when the scraper's fetch cursor has advanced past
    // what we last loaded. Capture the fetch value now and advance load to exactly
    // it on success, so the handshake — not the cron clock — is the correctness
    // gate. A not-ready run is a clean, logged no-op (exit 0) that writes no
    // ingestion_runs row and pings no healthcheck.
    const { fetchCursor, loadCursor, ready } = await loadReadiness(client, SOURCE_NAME);
    if (!ready) {
      logger.info(
        `Votes ingestion skipped — fetch cursor ` +
        `(${fetchCursor ?? 'none'}) has not advanced past load cursor ` +
        `(${loadCursor ?? 'none'}); nothing new to load`,
      );
      return;
    }

    runId = await openRun(client, 'votes');

    const { ingested, skipped, failed } = await load({
      client,
      dataDir: DATA_DIR,
      force: FORCE,
      log: logger,
    });

    // Advance the load cursor to the captured fetch value and mark the run
    // successful atomically, in one transaction — so the cursor and the run's
    // status can never disagree. (A crash mid-walk never reaches here; a failure
    // inside this block rolls back both, leaving the cursor unadvanced so the next
    // run re-checks readiness and re-walks idempotently.)
    await client.query('BEGIN');
    try {
      await advanceLoadCursor(client, SOURCE_NAME, fetchCursor);
      await succeedRun(client, runId, ingested);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    logger.info(
      `Votes ingestion complete — ingested: ${ingested}, ` +
      `skipped (up to date): ${skipped}, failed: ${failed}`,
    );

    if (process.env.HEALTHCHECK_VOTES_INGEST_URL) {
      await fetch(process.env.HEALTHCHECK_VOTES_INGEST_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Votes ingestion failed: ${err.message}`);
    if (runId) await failRun(client, runId, err.message).catch(() => {});
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
