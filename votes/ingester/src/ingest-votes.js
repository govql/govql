/**
 * ingest-votes.js
 *
 * Walks the directory tree produced by `usc-run votes` and upserts every
 * roll call vote (and its individual member positions) into PostgreSQL.
 *
 * Directory structure expected under CONGRESS_DATA_DIR (default /congress):
 *   data/{congress}/votes/{session}/{chamber}{number}/data.json
 *   e.g. data/113/votes/2013/h1/data.json
 *
 * Skip logic: if the vote already exists in the DB with a source_updated_at
 * >= the file's updated_at, the file is skipped. This keeps hourly runs fast
 * after the initial historical backfill.
 *
 * FK safety: vote_positions are inserted via a JOIN against the legislators
 * table, so any bioguide_id not yet in the DB is silently dropped (rather
 * than crashing the transaction). Run ingest-legislators.js first.
 */

import fs from 'fs';
import path from 'path';
import { pool } from './db.js';

const DATA_DIR = process.env.CONGRESS_DATA_DIR ?? '/congress';

// ---------------------------------------------------------------------------
// Valid category values per the schema CHECK constraint.
// Falls back to 'unknown' for anything not in this set.
// ---------------------------------------------------------------------------
const VALID_CATEGORIES = new Set([
  'passage', 'passage-suspension', 'amendment', 'cloture',
  'nomination', 'treaty', 'recommit', 'quorum', 'leadership',
  'conviction', 'veto-override', 'procedural', 'unknown',
]);

function normaliseCategory(raw) {
  return VALID_CATEGORIES.has(raw) ? raw : 'unknown';
}

// ---------------------------------------------------------------------------
// Directory walker
// Yields absolute paths to every data.json found under votes/ directories.
// ---------------------------------------------------------------------------
async function* walkVoteFiles(dataDir) {
  const dataPath = path.join(dataDir, 'data');

  if (!fs.existsSync(dataPath)) {
    console.warn(`Data directory not found: ${dataPath} — nothing to ingest`);
    return;
  }

  for (const congress of fs.readdirSync(dataPath)) {
    // Congress numbers are directories that look like integers.
    if (!/^\d+$/.test(congress)) continue;

    const votesDir = path.join(dataPath, congress, 'votes');
    if (!fs.existsSync(votesDir)) continue;

    for (const session of fs.readdirSync(votesDir)) {
      const sessionDir = path.join(votesDir, session);
      if (!fs.statSync(sessionDir).isDirectory()) continue;

      for (const voteDir of fs.readdirSync(sessionDir)) {
        const dataFile = path.join(sessionDir, voteDir, 'data.json');
        if (fs.existsSync(dataFile)) yield dataFile;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Check whether a vote needs (re-)processing.
// Returns true if the vote is absent from the DB or has a newer updated_at.
// ---------------------------------------------------------------------------
async function needsIngestion(client, voteId, fileUpdatedAt) {
  const { rows } = await client.query(
    `SELECT source_updated_at FROM votes WHERE vote_id = $1`,
    [voteId],
  );
  if (rows.length === 0) return true;                       // not yet ingested
  if (!rows[0].source_updated_at) return true;             // no timestamp recorded
  if (!fileUpdatedAt) return false;                        // no upstream timestamp; skip
  return new Date(fileUpdatedAt) > new Date(rows[0].source_updated_at);
}

// ---------------------------------------------------------------------------
// Upsert a minimal bill stub so the vote's FK can be satisfied.
// Full bill data (status, titles, etc.) is not available from vote files;
// ON CONFLICT DO NOTHING avoids overwriting richer data from future sources.
// ---------------------------------------------------------------------------
async function upsertBillStub(client, bill) {
  if (!bill?.bill_id || !bill?.type || bill?.number == null || !bill?.congress) return;

  await client.query(
    `INSERT INTO bills (bill_id, bill_type, bill_number, congress, official_title)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bill_id) DO NOTHING`,
    [
      bill.bill_id,
      bill.type,
      Number(bill.number),
      Number(bill.congress),
      bill.title ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Upsert the vote record itself.
// ---------------------------------------------------------------------------
async function upsertVote(client, v) {
  await client.query(
    `INSERT INTO votes (
       vote_id, chamber, congress, session, number, voted_at,
       question, vote_type, category, result, result_text, requires,
       related_bill_id, source_url, source_updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,
       $7,$8,$9,$10,$11,$12,
       $13,$14,$15
     )
     ON CONFLICT (vote_id) DO UPDATE SET
       voted_at         = EXCLUDED.voted_at,
       question         = EXCLUDED.question,
       vote_type        = EXCLUDED.vote_type,
       category         = EXCLUDED.category,
       result           = EXCLUDED.result,
       result_text      = EXCLUDED.result_text,
       requires         = EXCLUDED.requires,
       related_bill_id  = EXCLUDED.related_bill_id,
       source_url       = EXCLUDED.source_url,
       source_updated_at = EXCLUDED.source_updated_at`,
    [
      v.vote_id,
      v.chamber,
      v.congress,
      String(v.session),
      v.number,
      v.date         ?? null,
      v.question     ?? null,
      v.type         ?? null,
      normaliseCategory(v.category),
      v.result       ?? null,
      v.result_text  ?? null,
      v.requires     ?? null,
      v.bill?.bill_id ?? null,
      v.source_url   ?? null,
      v.updated_at   ?? null,
    ],
  );
}

// ---------------------------------------------------------------------------
// Replace vote positions.
//
// Positions are keyed by (vote_id, bioguide_id). We delete all existing rows
// for this vote_id and re-insert from the file — the set of positions for a
// historical vote doesn't change, and this avoids complex per-row diffing.
//
// The INSERT uses an unnest + JOIN against legislators so any bioguide_id
// not present in the DB is silently dropped instead of throwing an FK error.
// Unknown IDs are logged as a count for observability.
// ---------------------------------------------------------------------------
async function replacePositions(client, voteId, votes) {
  // Flatten all positions into parallel arrays for unnest.
  const bioguides = [];
  const positions = [];
  const parties   = [];
  const states    = [];

  for (const [positionLabel, members] of Object.entries(votes ?? {})) {
    for (const member of members) {
      if (!member.id) continue;
      bioguides.push(member.id);
      positions.push(positionLabel);
      parties.push(member.party ?? null);
      states.push(member.state ?? null);
    }
  }

  if (bioguides.length === 0) return;

  await client.query(
    'DELETE FROM vote_positions WHERE vote_id = $1',
    [voteId],
  );

  // The JOIN filters to legislators that exist in the DB; unknown IDs are
  // silently skipped. This handles VP tie-break votes and any scraper gaps.
  const { rowCount } = await client.query(
    `INSERT INTO vote_positions (vote_id, bioguide_id, position, party, state)
     SELECT $1, v.bioguide_id, v.position, v.party, v.state
     FROM unnest(
       $2::text[], $3::text[], $4::text[], $5::text[]
     ) AS v(bioguide_id, position, party, state)
     JOIN legislators ON legislators.bioguide_id = v.bioguide_id`,
    [voteId, bioguides, positions, parties, states],
  );

  const skipped = bioguides.length - rowCount;
  if (skipped > 0) {
    console.warn(
      `  ${voteId}: ${skipped} position(s) skipped (bioguide_id not in legislators table)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Process one vote file.
// Returns true if the vote was (re-)ingested, false if skipped.
// ---------------------------------------------------------------------------
async function processVoteFile(client, filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse ${filePath}:`, err.message);
    return false;
  }

  const { vote_id, votes, bill } = data;
  if (!vote_id) {
    console.warn(`No vote_id in ${filePath} — skipping`);
    return false;
  }

  if (!(await needsIngestion(client, vote_id, data.updated_at))) {
    return false; // already up to date
  }

  try {
    await client.query('BEGIN');
    if (bill?.bill_id) await upsertBillStub(client, bill);
    await upsertVote(client, data);
    await replacePositions(client, vote_id, votes);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`Failed to ingest vote ${vote_id}:`, err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  const client = await pool.connect();
  let runId;

  try {
    const { rows } = await client.query(
      `INSERT INTO ingestion_runs (run_type, status)
       VALUES ('votes', 'running')
       RETURNING id`,
    );
    runId = rows[0].id;

    let totalProcessed = 0;
    let totalSkipped   = 0;
    let totalFailed    = 0;

    for await (const filePath of walkVoteFiles(DATA_DIR)) {
      const ingested = await processVoteFile(client, filePath);
      if (ingested === true)  totalProcessed++;
      else if (ingested === false) totalSkipped++;  // skipped or parse error counted here
    }

    await client.query(
      `UPDATE ingestion_runs
       SET finished_at = now(), status = 'success', records_upserted = $1
       WHERE id = $2`,
      [totalProcessed, runId],
    );

    console.log(
      `Votes ingestion complete — ingested: ${totalProcessed}, ` +
      `skipped (up to date): ${totalSkipped}`,
    );
  } catch (err) {
    console.error('Votes ingestion failed:', err.message);
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
