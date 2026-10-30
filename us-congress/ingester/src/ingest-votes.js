/**
 * ingest-votes.js
 *
 * Thin cron entrypoint for the congress-votes load stage.
 * The connector discovers files, transforms votes, and loads their positions.
 * This entrypoint handles readiness, run logging, and cursor advancement.
 *
 * Normal runs require the fetch cursor to have advanced past the load cursor
 * and skip files whose source timestamps are already current.
 *
 * --force bypasses both checks to backfill changes in ingestion logic.
 * A forced run without a fetch cursor processes available files without
 * creating a load cursor.
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { loadReadiness, advanceLoadCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import { SOURCE_NAME, load } from './connectors/congress-votes.js';

const DATA_DIR = process.env.CONGRESS_DATA_DIR ?? '/congress';
const FORCE = process.argv.includes('--force');

async function run() {
  const client = await pool.connect();
  let runId;

  try {
    // Capture the exact fetch cursor before loading. Normal runs require
    // new fetched data; forced backfills can reprocess existing files.
    const { fetchCursor, loadCursor, ready } = await loadReadiness(
      client,
      SOURCE_NAME
    );

    if (!ready && !FORCE) {
      logger.info(
        `Votes ingestion skipped — fetch cursor ` +
          `(${fetchCursor ?? 'none'}) has not advanced past load cursor ` +
          `(${loadCursor ?? 'none'}); nothing new to load`
      );
      return;
    }

    if (FORCE) {
      logger.info(
        'Forced votes ingestion — bypassing readiness and per-file timestamp checks'
      );
    }

    runId = await openRun(client, 'votes');

    const { ingested, skipped, failed } = await load({
      client,
      dataDir: DATA_DIR,
      force: FORCE,
      log: logger,
    });

    // Record success and advance to the captured fetch cursor atomically.
    // A forced run may have no fetch cursor; don't invent one.
    await client.query('BEGIN');
    try {
      if (fetchCursor !== null) {
        await advanceLoadCursor(client, SOURCE_NAME, fetchCursor);
      }
      await succeedRun(client, runId, ingested);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    logger.info(
      `Votes ingestion complete — ingested: ${ingested}, ` +
        `skipped (up to date): ${skipped}, failed: ${failed}`
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
