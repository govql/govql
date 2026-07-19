/**
 * ingest-legislators.js
 *
 * Thin cron entrypoint for the `congress-legislators` load stage. All source
 * logic lives in the connector module (src/connectors/congress-legislators.js):
 * discover resolves the YAML files synced by the scraper's
 * update-legislators.sh (which clones/pulls unitedstates/congress-legislators),
 * transform maps each record, and load upserts them into the `legislators` and
 * `legislator_terms` tables. This script does the wiring: pool, logger,
 * readiness gate, run logging, cursor advance, exit codes.
 *
 * Dependency order: this script must run before ingest-votes.js because
 * vote_positions has a FK on legislators.bioguide_id.
 *
 * Stage gate: this is the `load` stage for the legislators source. It runs only
 * when the scraper's `fetch` cursor in source_state has advanced past the `load`
 * cursor (see cursor-state.js); otherwise it is a clean no-op. The cron time is a
 * soft schedule, not the correctness gate.
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { loadReadiness, advanceLoadCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import { SOURCE_NAME, findLegislatorFiles, load } from './connectors/congress-legislators.js';

const DATA_DIR = process.env.CONGRESS_DATA_DIR ?? '/congress';

async function run() {
  const client = await pool.connect();
  let runId;

  try {
    // Readiness gate: run only when the scraper's fetch cursor has advanced past
    // what we last loaded. Capture the fetch value now and advance load to exactly
    // it on success. A not-ready run is a clean, logged no-op (exit 0) — including
    // on a fresh system before the first legislators scrape, where there is no
    // fetch cursor yet and no files synced.
    const { fetchCursor, loadCursor, ready } = await loadReadiness(client, SOURCE_NAME);
    if (!ready) {
      logger.info(
        `Legislators ingestion skipped — fetch cursor ` +
        `(${fetchCursor ?? 'none'}) has not advanced past load cursor ` +
        `(${loadCursor ?? 'none'}); nothing new to load`,
      );
      return;
    }

    // Fetch advanced, so the synced YAML must be present; its absence here is a
    // real inconsistency, not a fresh-system no-op.
    const files = findLegislatorFiles(DATA_DIR);
    if (files.length === 0) {
      throw new Error(
        `No legislator YAML files found under ${DATA_DIR}/data/legislators/ ` +
        'despite an advanced fetch cursor. Check the scraper\'s update-legislators.sh.',
      );
    }

    runId = await openRun(client, 'legislators');

    const { upserted, failed } = await load({ client, files, log: logger });

    // Advance the load cursor to the captured fetch value and mark the run
    // successful atomically, in one transaction — so the cursor and the run's
    // status can never disagree. (A crash mid-walk never reaches here; a failure
    // inside this block rolls back both, leaving the cursor unadvanced so the next
    // run re-checks readiness and re-walks idempotently.)
    await client.query('BEGIN');
    try {
      await advanceLoadCursor(client, SOURCE_NAME, fetchCursor);
      await succeedRun(client, runId, upserted);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    logger.info(
      `Legislators ingestion complete — upserted: ${upserted}, failed: ${failed}`,
    );

    if (process.env.HEALTHCHECK_LEGISLATORS_INGEST_URL) {
      await fetch(process.env.HEALTHCHECK_LEGISLATORS_INGEST_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Legislators ingestion failed: ${err.message}`);
    if (runId) await failRun(client, runId, err.message).catch(() => {});
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
