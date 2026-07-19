/**
 * fetch-bills.js
 *
 * Fetch stage for the `congress-bills` source: pages the Congress.gov bill-list
 * endpoint for the configured congress into raw_payloads. First API-source
 * implementer of the connector contract (see CONNECTORS.md) — unlike the
 * scraped file sources, this stage writes its own cursors in source_state
 * (keyed per congress): the `fetch` resume cursor is the max consumed
 * updateDate, advanced inside the same transaction as each committed chunk, so
 * a kill mid-backfill resumes from the last committed chunk; backfill is this
 * same code with a NULL starting cursor. Whenever the catch-up pass was
 * multi-page, was truncated, or the resume cursor sits ahead of the
 * `fetch_verified` cursor (an earlier run's verification crashed or capped),
 * the run re-walks from `fetch_verified` until a complete pass writes nothing
 * new — only then does `fetch_verified` advance. Offset-pagination boundary
 * skips therefore can't strand a bill behind the cursors, even across crashes.
 *
 * Since task 0011 the fetch also fans out per changed bill: five per-bill
 * endpoints (detail, cosponsors, subjects, summaries, titles) land in
 * raw_payloads inside the same chunk transaction as the bill's list row, so
 * an interrupted fan-out resumes without re-fetching completed bills. A
 * per-run request budget keeps the whole run under the api.data.gov hourly
 * rate limit: when it runs out the run bails cleanly mid-walk (cursor
 * committed, verification deferred) and the next cron tick resumes — the
 * initial ~90k-request backfill drip-feeds over ~a day this way.
 *
 * Config: CONGRESS_GOV_API_KEY (required — without it the run is a loud,
 * clean skip so the cron never crashes), CONGRESS_GOV_TARGET_CONGRESS
 * (the backfill-depth knob, default 119), and
 * CONGRESS_GOV_HOURLY_REQUEST_BUDGET (default 4000 — headroom under the
 * 5,000/hour api.data.gov limit for pagination overrun; see requestBudget).
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { readCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import { SOURCE_NAME, fetchPagesUntilClean, fetchStateName, requestBudget, toFromDateTime } from './connectors/congress-bills.js';

const API_KEY = process.env.CONGRESS_GOV_API_KEY;
const TARGET_CONGRESS = Number.parseInt(process.env.CONGRESS_GOV_TARGET_CONGRESS ?? '119', 10);
// A malformed value parses to NaN, which would refuse every request; fall
// back to the default rather than run a dead fetch.
const parsedBudget = Number.parseInt(process.env.CONGRESS_GOV_HOURLY_REQUEST_BUDGET ?? '4000', 10);
const HOURLY_REQUEST_BUDGET = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 4000;

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

    const budget = requestBudget(HOURLY_REQUEST_BUDGET);
    const { passes, pages, upserted, unchanged, fanoutSkipped, fanoutNotFound, cursor, verified } = await fetchPagesUntilClean({
      client,
      congress: TARGET_CONGRESS,
      apiKey: API_KEY,
      fanout: {},
      budget,
      log: (msg) => logger.warn(msg),
      onPage: (p) =>
        logger.info(
          `Bills fetch pass ${p.pass} page ${p.pages} committed — upserted: ${p.upserted}, ` +
          `unchanged: ${p.unchanged}, cursor: ${p.cursor}`,
        ),
    });

    // The fetch cursor already advanced per committed chunk; closing the run
    // is bookkeeping only, so it needs no shared transaction with the cursor.
    // `upserted` is the distinct-key count across passes. The verification and
    // budget outcomes are recorded on the run row so a wedged fetch (every run
    // giving up unverified) is queryable in ingestion_runs, not just a log line.
    await succeedRun(client, runId, upserted, {
      verified,
      passes,
      requests: budget.used,
      budgetExhausted: budget.exhausted,
      fanoutSkipped,
      fanoutNotFound,
    });
    const summary =
      `Bills fetch complete — congress ${TARGET_CONGRESS}, passes: ${passes} ` +
      `(${verified ? 'verified' : 'NOT verified — next run re-walks'}), pages: ${pages}, ` +
      `upserted: ${upserted}, unchanged: ${unchanged}, requests: ${budget.used}` +
      `${budget.exhausted ? ' (budget exhausted — resuming next tick)' : ''}` +
      `${fanoutSkipped > 0 ? `, fan-out skipped for ${fanoutSkipped} malformed item(s)` : ''}` +
      `${fanoutNotFound > 0 ? `, ${fanoutNotFound} sub-endpoint 404(s) stored as empty` : ''}, cursor: ${cursor ?? 'none'}`;
    if (verified) logger.info(summary);
    else logger.warn(summary);

    // Dead-man's switch: only a VERIFIED run pings. A persistently wedged
    // fetch (non-converging verification every hour) then stops the pings and
    // trips the monitor instead of hiding behind a green healthcheck.
    if (verified && process.env.HEALTHCHECK_BILLS_FETCH_URL) {
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
