/**
 * fetch-bills.js
 *
 * Fetch stage for the `congress-bills` source: pages the Congress.gov bill-list
 * endpoint for the configured congress into raw_payloads. First API-source
 * implementer of the connector contract (see CONNECTORS.md) — unlike the
 * scraped file sources, this stage writes its own `fetch` cursor in
 * source_state (keyed per congress): the max consumed updateDate, advanced
 * inside the same transaction as each committed page, so a kill mid-backfill
 * resumes from the last committed page. Backfill is this same code with a NULL
 * starting cursor. Multi-page runs re-walk from the starting cursor until a
 * pass writes nothing new, so offset-pagination boundary skips can't drop a
 * bill behind the advanced cursor.
 *
 * Config: CONGRESS_GOV_API_KEY (required — without it the run is a loud,
 * clean skip so the cron never crashes) and CONGRESS_GOV_TARGET_CONGRESS
 * (the backfill-depth knob, default 119).
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { readCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import { SOURCE_NAME, fetchPagesUntilClean, fetchStateName, toFromDateTime } from './connectors/congress-bills.js';

const API_KEY = process.env.CONGRESS_GOV_API_KEY;
const TARGET_CONGRESS = Number.parseInt(process.env.CONGRESS_GOV_TARGET_CONGRESS ?? '119', 10);

async function run() {
  if (!API_KEY) {
    logger.warn(
      'Bills fetch skipped — CONGRESS_GOV_API_KEY is not set. ' +
      'Set it (local .env / droplet dotenvx) to enable Congress.gov bill ingestion.',
    );
    return;
  }

  const client = await pool.connect();
  let runId;
  let locked = false;

  try {
    // Serialize fetch runs: raw_payloads.fetched_at is transaction-start
    // now(), so two overlapping runs could commit rows behind a load cursor
    // that already advanced past them. Skip-if-locked keeps a long backfill
    // from being overlapped by the next hourly cron.
    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [SOURCE_NAME],
    );
    locked = lockRows[0].locked;
    if (!locked) {
      logger.warn('Bills fetch skipped — another bills fetch run holds the advisory lock (still in progress)');
      return;
    }

    // The fetch cursor is keyed per congress, so retargeting
    // CONGRESS_GOV_TARGET_CONGRESS starts that congress's own backfill instead
    // of filtering behind another congress's watermark. Read here for the run
    // record; fetchPagesUntilClean manages the resume/verified pair itself.
    const fromDateTime = toFromDateTime(await readCursor(client, fetchStateName(TARGET_CONGRESS), 'fetch'));
    runId = await openRun(client, 'bills_fetch', { congress: TARGET_CONGRESS, fromDateTime });

    const { passes, pages, upserted, unchanged, cursor, verified } = await fetchPagesUntilClean({
      client,
      congress: TARGET_CONGRESS,
      apiKey: API_KEY,
      log: (msg) => logger.warn(msg),
      onPage: (p) =>
        logger.info(
          `Bills fetch pass ${p.pass} page ${p.pages} committed — upserted: ${p.upserted}, ` +
          `unchanged: ${p.unchanged}, cursor: ${p.cursor}`,
        ),
    });

    // The fetch cursor already advanced per committed page; closing the run is
    // bookkeeping only, so it needs no shared transaction with the cursor.
    // `upserted` is the distinct-key count across passes.
    await succeedRun(client, runId, upserted);
    logger.info(
      `Bills fetch complete — congress ${TARGET_CONGRESS}, passes: ${passes} ` +
      `(${verified ? 'verified' : 'NOT verified — next run re-walks'}), pages: ${pages}, ` +
      `upserted: ${upserted}, unchanged: ${unchanged}, cursor: ${cursor ?? 'none'}`,
    );

    if (process.env.HEALTHCHECK_BILLS_FETCH_URL) {
      await fetch(process.env.HEALTHCHECK_BILLS_FETCH_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Bills fetch failed: ${err.message}`);
    if (runId) await failRun(client, runId, err.message).catch(() => {});
    process.exit(1);
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [SOURCE_NAME]).catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

run();
