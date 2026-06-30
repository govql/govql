/**
 * ingest-legislators.js
 *
 * Reads the YAML files synced by the scraper's update-legislators.sh
 * (which clones/pulls unitedstates/congress-legislators) and upserts them
 * into the `legislators` and `legislator_terms` tables.
 *
 * Dependency order: this script must run before ingest-votes.js because
 * vote_positions has a FK on legislators.bioguide_id.
 *
 * Stage gate: this is the `load` stage for the legislators source. It runs only
 * when the scraper's `fetch` cursor in source_state has advanced past the `load`
 * cursor (see cursor-state.js); otherwise it is a clean no-op. The cron time is a
 * soft schedule, not the correctness gate.
 *
 * Expected files (relative to CONGRESS_DATA_DIR, default /congress):
 *   data/legislators/legislators-current.yaml
 *   data/legislators/legislators-historical.yaml
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { pool } from './db.js';
import { logger } from './logger.js';
import { loadReadiness, advanceLoadCursor } from './cursor-state.js';

const DATA_DIR = process.env.CONGRESS_DATA_DIR ?? '/congress';

// Source key for the staged fetch→load cursor handshake in source_state.
const SOURCE_NAME = 'congress-legislators';

const LEGISLATOR_FILES = [
  'data/legislators/legislators-current.yaml',
  'data/legislators/legislators-historical.yaml',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the legislator YAML files that actually exist on disk. */
function findLegislatorFiles() {
  return LEGISLATOR_FILES
    .map(f => path.join(DATA_DIR, f))
    .filter(f => fs.existsSync(f));
}

/** Parse a raw YAML file and return its array of legislator objects. */
function parseLegislatorFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw);
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

/** Upsert a single legislator row. */
async function upsertLegislator(client, leg) {
  const { id, name, bio = {} } = leg;
  await client.query(
    `INSERT INTO legislators (
       bioguide_id, thomas_id, lis_id, govtrack_id, opensecrets_id,
       votesmart_id, icpsr_id, cspan_id,
       first_name, middle_name, last_name, name_suffix, nickname, official_full,
       birthday, gender
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       $9,$10,$11,$12,$13,$14,
       $15,$16
     )
     ON CONFLICT (bioguide_id) DO UPDATE SET
       thomas_id     = EXCLUDED.thomas_id,
       lis_id        = EXCLUDED.lis_id,
       govtrack_id   = EXCLUDED.govtrack_id,
       opensecrets_id = EXCLUDED.opensecrets_id,
       votesmart_id  = EXCLUDED.votesmart_id,
       icpsr_id      = EXCLUDED.icpsr_id,
       cspan_id      = EXCLUDED.cspan_id,
       first_name    = EXCLUDED.first_name,
       middle_name   = EXCLUDED.middle_name,
       last_name     = EXCLUDED.last_name,
       name_suffix   = EXCLUDED.name_suffix,
       nickname      = EXCLUDED.nickname,
       official_full = EXCLUDED.official_full,
       birthday      = EXCLUDED.birthday,
       gender        = EXCLUDED.gender`,
    [
      id.bioguide,
      id.thomas        ?? null,
      id.lis           ?? null,
      id.govtrack      ?? null,
      id.opensecrets   ?? null,
      id.votesmart     ?? null,
      id.icpsr         ?? null,
      id.cspan         ?? null,
      name.first,
      name.middle      ?? null,
      name.last,
      name.suffix      ?? null,
      name.nickname    ?? null,
      name.official_full ?? null,
      bio.birthday     ?? null,
      bio.gender       ?? null,
    ],
  );
}

/**
 * Replace all terms for a legislator.
 * DELETE + INSERT is simpler and correct here: terms can have end dates
 * updated, districts changed, or contact info refreshed. There are no
 * other tables that FK into legislator_terms, so delete is safe.
 */
async function replaceTerms(client, bioguideId, terms = []) {
  await client.query(
    'DELETE FROM legislator_terms WHERE bioguide_id = $1',
    [bioguideId],
  );

  for (const term of terms) {
    await client.query(
      `INSERT INTO legislator_terms (
         bioguide_id, term_type, start_date, end_date, state,
         party, caucus, district, senate_class, state_rank,
         how, url, address, phone, office
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        bioguideId,
        term.type,
        term.start,
        term.end,
        term.state,
        term.party       ?? null,
        term.caucus      ?? null,
        term.district    ?? null,  // House only; null for senators
        term.class       ?? null,  // Senate class (1/2/3); null for reps
        term.state_rank  ?? null,
        term.how         ?? null,
        term.url         ?? null,
        term.address     ?? null,
        term.phone       ?? null,
        term.office      ?? null,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

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
    const files = findLegislatorFiles();
    if (files.length === 0) {
      throw new Error(
        `No legislator YAML files found under ${DATA_DIR}/data/legislators/ ` +
        'despite an advanced fetch cursor. Check the scraper\'s update-legislators.sh.',
      );
    }

    // Open an ingestion run record.
    const { rows } = await client.query(
      `INSERT INTO ingestion_runs (run_type, status)
       VALUES ('legislators', 'running')
       RETURNING id`,
    );
    runId = rows[0].id;

    let totalUpserted = 0;
    let totalFailed = 0;

    for (const file of files) {
      logger.info(`Processing ${path.basename(file)} …`);
      const legislators = parseLegislatorFile(file);

      for (const leg of legislators) {
        const bioguideId = leg?.id?.bioguide;
        if (!bioguideId) {
          logger.warn('Skipping legislator record with no bioguide_id');
          totalFailed++;
          continue;
        }

        try {
          await client.query('BEGIN');
          await upsertLegislator(client, leg);
          await replaceTerms(client, bioguideId, leg.terms);
          await client.query('COMMIT');
          totalUpserted++;
        } catch (err) {
          await client.query('ROLLBACK');
          logger.error(`Failed to upsert legislator ${bioguideId}: ${err.message}`);
          totalFailed++;
        }
      }
    }

    // Advance the load cursor to the captured fetch value and mark the run
    // successful atomically, in one transaction — so the cursor and the run's
    // status can never disagree. (A crash mid-walk never reaches here; a failure
    // inside this block rolls back both, leaving the cursor unadvanced so the next
    // run re-checks readiness and re-walks idempotently.)
    await client.query('BEGIN');
    try {
      await advanceLoadCursor(client, SOURCE_NAME, fetchCursor);
      await client.query(
        `UPDATE ingestion_runs
         SET finished_at = now(), status = 'success', records_upserted = $1
         WHERE id = $2`,
        [totalUpserted, runId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }

    logger.info(
      `Legislators ingestion complete — upserted: ${totalUpserted}, failed: ${totalFailed}`,
    );

    if (process.env.HEALTHCHECK_LEGISLATORS_INGEST_URL) {
      await fetch(process.env.HEALTHCHECK_LEGISLATORS_INGEST_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Legislators ingestion failed: ${err.message}`);
    if (runId) {
      await client.query(
        `UPDATE ingestion_runs
         SET finished_at = now(), status = 'failed', error_message = $1
         WHERE id = $2`,
        [err.message, runId],
      );
    }
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
