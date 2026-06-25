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
import { logger } from './logger.js';

const DATA_DIR = process.env.CONGRESS_DATA_DIR ?? '/congress';

// Pass --force to reprocess vote files that are already current in the DB.
// Useful when the ingestion logic changes (e.g. this lis_id fix).
const FORCE = process.argv.includes('--force');

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
    logger.warn(`Data directory not found: ${dataPath} — nothing to ingest`);
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
  if (FORCE) return true;
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
async function replacePositions(client, voteId, chamber, votes) {
  // Flatten all positions into parallel arrays for unnest.
  const memberIds = [];
  const positions = [];
  const parties   = [];
  const states    = [];

  for (const [positionLabel, members] of Object.entries(votes ?? {})) {
    for (const member of members) {
      if (!member.id) continue;
      memberIds.push(member.id);
      positions.push(positionLabel);
      parties.push(member.party ?? null);
      states.push(member.state ?? null);
    }
  }

  if (memberIds.length === 0) return;

  await client.query(
    'DELETE FROM vote_positions WHERE vote_id = $1',
    [voteId],
  );

  // Senate vote files identify members by lis_id (from the Senate XML);
  // House vote files use bioguide_id directly.
  // The JOIN silently drops any ID not present in the legislators table
  // (VP tie-breaks, historical gaps, etc.).
  const isSenate = chamber === 's';
  const { rowCount } = await client.query(
    isSenate
      ? `INSERT INTO vote_positions (vote_id, bioguide_id, position, party, state)
         SELECT $1, l.bioguide_id, v.position, v.party, v.state
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS v(member_id, position, party, state)
         JOIN legislators l ON l.lis_id = v.member_id`
      : `INSERT INTO vote_positions (vote_id, bioguide_id, position, party, state)
         SELECT $1, l.bioguide_id, v.position, v.party, v.state
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS v(member_id, position, party, state)
         JOIN legislators l ON l.bioguide_id = v.member_id`,
    [voteId, memberIds, positions, parties, states],
  );

  const skipped = memberIds.length - rowCount;
  if (skipped > 0) {
    const { rows } = await client.query(
      isSenate
        ? `SELECT v.member_id FROM unnest($1::text[]) AS v(member_id)
           WHERE NOT EXISTS (SELECT 1 FROM legislators l WHERE l.lis_id = v.member_id)`
        : `SELECT v.member_id FROM unnest($1::text[]) AS v(member_id)
           WHERE NOT EXISTS (SELECT 1 FROM legislators l WHERE l.bioguide_id = v.member_id)`,
      [memberIds],
    );
    const unknownIds = rows.map(r => r.member_id);
    logger.warn(
      `${voteId}: ${skipped} position(s) skipped — unknown ` +
      `${isSenate ? 'lis_id' : 'bioguide_id'}: ${unknownIds.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Process one vote file.
// Returns 'ingested', 'skipped', or 'failed'.
// ---------------------------------------------------------------------------
async function processVoteFile(client, filePath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.error(`Failed to parse ${filePath}: ${err.message}`);
    return 'failed';
  }

  const { vote_id, chamber, votes, bill } = data;
  if (!vote_id) {
    logger.warn(`No vote_id in ${filePath} — skipping`);
    return 'failed';
  }

  if (!(await needsIngestion(client, vote_id, data.updated_at))) {
    return 'skipped';
  }

  try {
    await client.query('BEGIN');
    if (bill?.bill_id) await upsertBillStub(client, bill);
    await upsertVote(client, data);
    await replacePositions(client, vote_id, chamber, votes);
    await client.query('COMMIT');
    return 'ingested';
  } catch (err) {
    await client.query('ROLLBACK');
    const detail = [
      err.message,
      err.detail     && `detail: ${err.detail}`,
      err.column     && `column: ${err.column}`,
      err.constraint && `constraint: ${err.constraint}`,
    ].filter(Boolean).join(' | ');
    logger.error(`Failed to ingest vote ${vote_id}: ${detail}`);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Congresses whose vote_similarity rows are stale: their max(votes.updated_at)
// is newer than the watermark from their last successful rebuild (or they have
// never been built). votes.updated_at is a reliable signal — upsertVote runs in
// the same transaction as replacePositions and the trg_votes_updated_at trigger
// bumps it on every change, so any position change moves the parent vote's
// updated_at. Cheap: votes is small and congress is indexed.
//
// Returns an array of congress numbers. The watermark itself is captured inside
// rebuildAggregatesForCongress (from the same MVCC snapshot it builds from), not
// here — so it keeps full microsecond precision rather than being truncated by a
// round-trip through a JS Date (which only holds milliseconds, and made every
// congress look perpetually stale).
// ---------------------------------------------------------------------------
async function staleCongresses(client) {
  const { rows } = await client.query(
    `SELECT v.congress AS congress
     FROM votes v
     LEFT JOIN vote_similarity_state s ON s.congress = v.congress
     GROUP BY v.congress, s.built_through
     HAVING s.built_through IS NULL OR max(v.updated_at) > s.built_through
     ORDER BY v.congress`,
  );
  return rows.map((r) => r.congress);
}

// ---------------------------------------------------------------------------
// Rebuild the per-congress precomputed aggregates (vote_similarity and
// member_party_agreement) for a single congress, and advance its watermark —
// all in one transaction.
//
// Each table's rows for the congress are DELETE+INSERTed and the watermark is
// UPSERTed inside one transaction, so concurrent readers see the old rows until
// the new ones commit atomically (never an empty slice), and the watermark can
// only advance if the whole rebuild committed. Each build is scoped to one
// congress via a CTE prefilter so cost is independent of how much historical
// data exists. Only Yea/Nay positions count (Present / Not Voting / VP ignored).
//
// The transaction runs at REPEATABLE READ so both builds and the watermark
// capture (max(votes.updated_at), computed in SQL) read one consistent snapshot:
// built_through reflects exactly the data that was built, and any vote changed
// after that snapshot stays ahead of the watermark and is rebuilt next run.
// Capturing the watermark in SQL (rather than passing a JS value in) keeps its
// full microsecond precision — a JS Date truncates to milliseconds, which made
// max(updated_at) > built_through perpetually true.
// ---------------------------------------------------------------------------
async function rebuildAggregatesForCongress(client, congress) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    // Pairwise member-to-member agreement.
    await client.query('DELETE FROM vote_similarity WHERE congress = $1', [
      congress,
    ]);
    await client.query(
      `INSERT INTO vote_similarity
         (congress, chamber, member_a, member_b, shared_votes, agreed)
       WITH cpos AS (
         SELECT vp.vote_id, vp.bioguide_id, vp.position, v.congress, v.chamber
         FROM vote_positions vp
         JOIN votes v ON v.vote_id = vp.vote_id
         WHERE v.congress = $1 AND vp.position IN ('Yea', 'Nay')
       )
       SELECT a.congress, a.chamber, a.bioguide_id, b.bioguide_id,
              count(*)::int,
              count(*) FILTER (WHERE a.position = b.position)::int
       FROM cpos a
       JOIN cpos b ON b.vote_id = a.vote_id AND a.bioguide_id < b.bioguide_id
       GROUP BY a.congress, a.chamber, a.bioguide_id, b.bioguide_id`,
      [congress],
    );

    // Member-vs-party agreement: each member compared to every party's
    // strict-majority position per vote (incl. their own party = loyalty).
    await client.query(
      'DELETE FROM member_party_agreement WHERE congress = $1',
      [congress],
    );
    await client.query(
      `INSERT INTO member_party_agreement
         (congress, chamber, bioguide_id, member_party, other_party, shared_votes, agreed)
       WITH pos AS (
         SELECT vp.vote_id, vp.bioguide_id, vp.position, vp.party, v.chamber
         FROM vote_positions vp
         JOIN votes v ON v.vote_id = vp.vote_id
         WHERE v.congress = $1 AND vp.position IN ('Yea', 'Nay')
       ),
       party_majority AS (
         SELECT vote_id, party AS other_party,
                CASE
                  WHEN count(*) FILTER (WHERE position = 'Yea')
                     > count(*) FILTER (WHERE position = 'Nay') THEN 'Yea'
                  WHEN count(*) FILTER (WHERE position = 'Nay')
                     > count(*) FILTER (WHERE position = 'Yea') THEN 'Nay'
                  ELSE NULL
                END AS majority_position
         FROM pos
         GROUP BY vote_id, party
       )
       SELECT $1, p.chamber, p.bioguide_id, p.party, pm.other_party,
              count(*)::int,
              count(*) FILTER (WHERE p.position = pm.majority_position)::int
       FROM pos p
       JOIN party_majority pm
         ON pm.vote_id = p.vote_id AND pm.majority_position IS NOT NULL
       GROUP BY p.chamber, p.bioguide_id, p.party, pm.other_party`,
      [congress],
    );

    await client.query(
      `INSERT INTO vote_similarity_state (congress, built_through)
       SELECT $1, max(updated_at) FROM votes WHERE congress = $1
       ON CONFLICT (congress) DO UPDATE SET built_through = EXCLUDED.built_through`,
      [congress],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
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

    let totalIngested = 0;
    let totalSkipped  = 0;
    let totalFailed   = 0;

    for await (const filePath of walkVoteFiles(DATA_DIR)) {
      const result = await processVoteFile(client, filePath);
      if      (result === 'ingested') totalIngested++;
      else if (result === 'skipped')  totalSkipped++;
      else                            totalFailed++;
    }

    await client.query(
      `UPDATE ingestion_runs
       SET finished_at = now(), status = 'success', records_upserted = $1
       WHERE id = $2`,
      [totalIngested, runId],
    );

    logger.info(
      `Votes ingestion complete — ingested: ${totalIngested}, ` +
      `skipped (up to date): ${totalSkipped}, failed: ${totalFailed}`,
    );

    // Rebuild the per-congress precomputed aggregates (vote_similarity and
    // member_party_agreement) for every congress whose vote data has changed
    // since its last successful rebuild (see staleCongresses). This is driven by
    // actual staleness, not by what was ingested this run, so a rebuild that
    // failed or was interrupted on a previous run is retried automatically — its
    // watermark was never advanced. On a fresh DB every congress is stale (full
    // backfill); steady state, only the current congress is stale. Each rebuild
    // is its own transaction: failures are logged but non-fatal (the ingestion
    // is already committed and the run marked 'success'), and the congress simply
    // remains stale for the next run.
    const stale = await staleCongresses(client);
    for (const congress of stale) {
      try {
        const t0 = Date.now();
        await rebuildAggregatesForCongress(client, congress);
        logger.info(
          `Rebuilt aggregates for congress ${congress} in ${Date.now() - t0} ms`,
        );
      } catch (err) {
        logger.error(
          `aggregate rebuild for congress ${congress} failed ` +
          `(votes are ingested; aggregates are stale, will retry next run): ${err.message}`,
        );
      }
    }

    if (process.env.HEALTHCHECK_VOTES_INGEST_URL) {
      await fetch(process.env.HEALTHCHECK_VOTES_INGEST_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Votes ingestion failed: ${err.message}`);
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
