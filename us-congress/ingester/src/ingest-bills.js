/**
 * ingest-bills.js
 *
 * Load stage for the `congress-bills` source: transforms raw_payloads rows
 * fetched past the load cursor into bills upserts (ON CONFLICT (bill_id)
 * DO UPDATE — enriching the vote-stub rows, preserving the `hr3590-111`
 * natural-key format so vote cross-references keep resolving), and — since
 * task 0011 — the five per-bill endpoints: cosponsors/subjects/summaries
 * replace their child rows per bill, detail/titles enrich the bills row via
 * COALESCE (never overwriting a populated column with NULL). The bill-list
 * loader runs first so sub-entity rows always find their bills row.
 *
 * Stage gate: raw_payloads is an owned table, so per the plan's gating rule
 * readiness is a staleness comparison on fetched_at — not the file-source
 * fetch↔load cursor handshake. One load cursor spans all six endpoints; it
 * advances to the max consumed fetched_at in the same transaction that marks
 * the run successful. Each loader consumes its endpoint's whole backlog past
 * the cursor, so the shared advance strands nothing.
 */

import { pool } from './db.js';
import { logger } from './logger.js';
import { readCursor, advanceLoadCursor } from './cursor-state.js';
import { openRun, succeedRun, failRun } from './run-log.js';
import {
  SOURCE_NAME,
  capWatermark,
  load,
  rawReadiness,
} from './connectors/congress-bills.js';

async function run() {
  const client = await pool.connect();
  let runId;
  let locked = false;

  try {
    // Serialize load runs (a manual run beside the :20 cron): the load cursor
    // write is monotonic as a backstop, but overlapping runs would still
    // double-transform the same raws and double-count run stats.
    const { rows: lockRows } = await client.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [`${SOURCE_NAME}-load`],
    );
    locked = lockRows[0].locked;
    if (!locked) {
      logger.warn('Bills load skipped — another bills load run holds the advisory lock (still in progress)');
      return;
    }

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

    // Grace cap: fetched_at is transaction-start now(), so a fetch page
    // transaction still in flight can commit rows dated behind whatever this
    // run consumes. Never advance the cursor into the last few minutes —
    // clamped rows are re-read next run (idempotent upserts).
    const { rows: capRows } = await client.query(
      `SELECT to_char((now() - interval '5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cap`,
    );
    const graceCap = capRows[0].cap;

    const { processed, failed, consumed, bills, subResults } = await load({
      client,
      loadCursor,
      log: logger,
    });

    // Advance the load cursor to the (capped) consumed watermark and mark the
    // run successful atomically — the cursor and run status can never disagree.
    const advanceTo = capWatermark({ consumed, graceCap, loadCursor });
    await client.query('BEGIN');
    try {
      if (advanceTo !== null) await advanceLoadCursor(client, SOURCE_NAME, advanceTo);
      await succeedRun(client, runId, processed, {
        bills: bills.ingested,
        ...Object.fromEntries(Object.entries(subResults).map(([name, r]) => [name, r.processed])),
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    const subSummary = Object.entries(subResults)
      .map(([name, r]) => `${name}: ${r.processed}${r.skippedMissingBill > 0 ? ` (${r.skippedMissingBill} skipped, no bills row)` : ''}`)
      .join(', ');
    logger.info(
      `Bills load complete — bills: ${bills.ingested}, ${subSummary}, failed: ${failed}, cursor: ${advanceTo}` +
      (advanceTo !== consumed ? ` (grace-capped from ${consumed}; the tail re-reads next run)` : ''),
    );

    if (process.env.HEALTHCHECK_BILLS_INGEST_URL) {
      await fetch(process.env.HEALTHCHECK_BILLS_INGEST_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Bills load failed: ${err.message}`);
    if (runId) await failRun(client, runId, err.message).catch(() => {});
    process.exit(1);
  } finally {
    if (locked) {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`${SOURCE_NAME}-load`]).catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

run();
