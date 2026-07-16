/**
 * fetch-bills.js
 *
 * Fetch stage for the `congress-bills` source: pages the Congress.gov bill-list
 * endpoint for the configured congress into raw_payloads. First API-source
 * implementer of the connector contract (see CONNECTORS.md) — unlike the
 * scraped file sources, this stage writes its own `fetch` cursor in
 * source_state: the max consumed updateDate, advanced inside the same
 * transaction as each committed page, so a kill mid-backfill resumes from the
 * last committed page. Backfill is this same code with a NULL starting cursor.
 *
 * Config: CONGRESS_GOV_API_KEY (required — without it the run is a loud,
 * clean skip so the cron never crashes) and CONGRESS_GOV_TARGET_CONGRESS
 * (the backfill-depth knob, default 119).
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { readCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import { SOURCE_NAME, fetchPagesIntoRaw, toFromDateTime } from './connectors/congress-bills.js';

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

  try {
    const fromDateTime = toFromDateTime(await readCursor(client, SOURCE_NAME, 'fetch'));
    runId = await openRun(client, 'bills_fetch', { congress: TARGET_CONGRESS, fromDateTime });

    const { pages, upserted, unchanged, cursor } = await fetchPagesIntoRaw({
      client,
      congress: TARGET_CONGRESS,
      apiKey: API_KEY,
      fromDateTime,
      onPage: (p) =>
        logger.info(
          `Bills fetch page ${p.pages} committed — upserted: ${p.upserted}, ` +
          `unchanged: ${p.unchanged}, cursor: ${p.cursor}`,
        ),
    });

    // The fetch cursor already advanced per committed page; closing the run is
    // bookkeeping only, so it needs no shared transaction with the cursor.
    await succeedRun(client, runId, upserted);
    logger.info(
      `Bills fetch complete — congress ${TARGET_CONGRESS}, pages: ${pages}, ` +
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
    client.release();
    await pool.end();
  }
}

run();
