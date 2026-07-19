/**
 * congress-votes.js — connector for the scraped roll-call votes source.
 *
 * File-landed source: `usc-run votes` (scraper container) writes
 * data/{congress}/votes/{session}/{voteDir}/data.json under the shared
 * volume; this module's discover walks that tree, transform maps one file's
 * JSON to rows, and load upserts votes + replaces positions per file.
 *
 * Pool-free and side-effect-free at import time: every function takes a
 * `client` (and a logger-shaped `log`) as arguments. The thin cron entrypoint
 * (src/ingest-votes.js) does the wiring: pool, logger, readiness gate, run
 * logging, cursor advance, exit codes.
 */

import fs from 'fs';
import path from 'path';

// The source_state key for the staged fetch→load cursor handshake.
export const SOURCE_NAME = 'congress-votes';

// ---------------------------------------------------------------------------
// Valid category values per the schema CHECK constraint.
// Falls back to 'unknown' for anything not in this set — a per-value
// normalisation, not a transform reject: the vote is still loaded.
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
// discover: directory walker over the scraper's landed files.
// Yields absolute paths to every data.json found under votes/ directories.
// ---------------------------------------------------------------------------
export async function* walkVoteFiles(dataDir, { log }) {
  const dataPath = path.join(dataDir, 'data');

  if (!fs.existsSync(dataPath)) {
    log.warn(`Data directory not found: ${dataPath} — nothing to ingest`);
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
// transform: pure raw→row mapping for one vote file's parsed JSON.
// Returns { vote, billStub, positions }:
//   vote      — the votes-table row (named fields, load maps to params)
//   billStub  — minimal bills row satisfying the vote's FK, or null when the
//               file has no complete bill reference
//   positions — flattened member positions; members without an id are dropped
// ---------------------------------------------------------------------------
export function transform(data) {
  const bill = data.bill;
  const billStub =
    !bill?.bill_id || !bill?.type || bill?.number == null || !bill?.congress
      ? null
      : {
          billId: bill.bill_id,
          billType: bill.type,
          billNumber: Number(bill.number),
          congress: Number(bill.congress),
          officialTitle: bill.title ?? null,
        };

  const positions = [];
  for (const [positionLabel, members] of Object.entries(data.votes ?? {})) {
    for (const member of members) {
      if (!member.id) continue;
      positions.push({
        memberId: member.id,
        position: positionLabel,
        party: member.party ?? null,
        state: member.state ?? null,
      });
    }
  }

  return {
    vote: {
      voteId: data.vote_id,
      chamber: data.chamber,
      congress: data.congress,
      session: String(data.session),
      number: data.number,
      votedAt: data.date ?? null,
      question: data.question ?? null,
      voteType: data.type ?? null,
      category: normaliseCategory(data.category),
      result: data.result ?? null,
      resultText: data.result_text ?? null,
      requires: data.requires ?? null,
      relatedBillId: data.bill?.bill_id ?? null,
      sourceUrl: data.source_url ?? null,
      sourceUpdatedAt: data.updated_at ?? null,
    },
    billStub,
    positions,
  };
}

// ---------------------------------------------------------------------------
// Check whether a vote needs (re-)processing.
// Returns true if the vote is absent from the DB or has a newer updated_at.
// `force` reprocesses files that are already current in the DB — useful when
// the ingestion logic changes.
// ---------------------------------------------------------------------------
export async function needsIngestion(client, voteId, fileUpdatedAt, { force = false } = {}) {
  if (force) return true;
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
export async function upsertBillStub(client, billStub) {
  if (!billStub) return;

  await client.query(
    `INSERT INTO bills (bill_id, bill_type, bill_number, congress, official_title)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (bill_id) DO NOTHING`,
    [
      billStub.billId,
      billStub.billType,
      billStub.billNumber,
      billStub.congress,
      billStub.officialTitle,
    ],
  );
}

// ---------------------------------------------------------------------------
// Upsert the vote record itself.
// ---------------------------------------------------------------------------
export async function upsertVote(client, vote) {
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
      vote.voteId,
      vote.chamber,
      vote.congress,
      vote.session,
      vote.number,
      vote.votedAt,
      vote.question,
      vote.voteType,
      vote.category,
      vote.result,
      vote.resultText,
      vote.requires,
      vote.relatedBillId,
      vote.sourceUrl,
      vote.sourceUpdatedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// Replace vote positions.
//
// Positions are keyed by (vote_id, bioguide_id). We delete all existing rows
// for this vote_id and re-insert from the transformed positions — the set of
// positions for a historical vote doesn't change, and this avoids complex
// per-row diffing.
//
// The INSERT uses an unnest + JOIN against legislators so any member id
// not present in the DB is silently dropped instead of throwing an FK error.
// Unknown IDs are logged as a count for observability.
// ---------------------------------------------------------------------------
export async function replacePositions(client, voteId, chamber, positionRows, { log }) {
  // Flatten into parallel arrays for unnest.
  const memberIds = positionRows.map((p) => p.memberId);
  const positions = positionRows.map((p) => p.position);
  const parties   = positionRows.map((p) => p.party);
  const states    = positionRows.map((p) => p.state);

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
    log.warn(
      `${voteId}: ${skipped} position(s) skipped — unknown ` +
      `${isSenate ? 'lis_id' : 'bioguide_id'}: ${unknownIds.join(', ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Load one vote file: parse, skip if current, then upsert the bill stub, the
// vote, and its positions in a single transaction.
// Returns 'ingested', 'skipped', or 'failed'.
// ---------------------------------------------------------------------------
export async function loadVoteFile(client, filePath, { force = false, log }) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log.error(`Failed to parse ${filePath}: ${err.message}`);
    return 'failed';
  }

  if (!data.vote_id) {
    log.warn(`No vote_id in ${filePath} — skipping`);
    return 'failed';
  }

  if (!(await needsIngestion(client, data.vote_id, data.updated_at, { force }))) {
    return 'skipped';
  }

  const { vote, billStub, positions } = transform(data);

  try {
    await client.query('BEGIN');
    await upsertBillStub(client, billStub);
    await upsertVote(client, vote);
    await replacePositions(client, vote.voteId, vote.chamber, positions, { log });
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
    log.error(`Failed to ingest vote ${vote.voteId}: ${detail}`);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// load: the load-stage orchestrator — walk every landed vote file and load
// each one, tallying results. The entrypoint owns the readiness gate, run
// logging, and cursor advance around this call.
// ---------------------------------------------------------------------------
export async function load({ client, dataDir, force = false, log }) {
  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for await (const filePath of walkVoteFiles(dataDir, { log })) {
    const result = await loadVoteFile(client, filePath, { force, log });
    if      (result === 'ingested') ingested++;
    else if (result === 'skipped')  skipped++;
    else                            failed++;
  }

  return { ingested, skipped, failed };
}
