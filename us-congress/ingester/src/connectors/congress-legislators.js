/**
 * congress-legislators.js — connector for the scraped legislators source.
 *
 * File-landed source: the scraper's update-legislators.sh clones/pulls
 * unitedstates/congress-legislators onto the shared volume; this module's
 * discover resolves the two YAML files, transform maps one YAML record to
 * rows, and load upserts legislators + replaces their terms per record.
 *
 * Pool-free and side-effect-free at import time: every function takes a
 * `client` (and a logger-shaped `log`) as arguments. The thin cron entrypoint
 * (src/ingest-legislators.js) does the wiring: pool, logger, readiness gate,
 * run logging, cursor advance, exit codes.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// The source_state key for the staged fetch→load cursor handshake.
export const SOURCE_NAME = 'congress-legislators';

export const LEGISLATOR_FILES = [
  'data/legislators/legislators-current.yaml',
  'data/legislators/legislators-historical.yaml',
];

// ---------------------------------------------------------------------------
// discover: resolve the legislator YAML files that actually exist on disk.
// ---------------------------------------------------------------------------
export function findLegislatorFiles(dataDir) {
  return LEGISLATOR_FILES
    .map(f => path.join(dataDir, f))
    .filter(f => fs.existsSync(f));
}

/** Parse a raw YAML file and return its array of legislator objects. */
export function parseLegislatorFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return yaml.load(raw);
}

// ---------------------------------------------------------------------------
// transform: pure raw→row mapping for one YAML legislator record.
// Returns { bioguideId, legislator, terms }. Malformed records (no id/name
// object) throw, matching the per-record failure path in load.
// ---------------------------------------------------------------------------
export function transform(leg) {
  const { id, name, bio = {} } = leg;

  return {
    bioguideId: id.bioguide,
    legislator: {
      bioguideId: id.bioguide,
      thomasId: id.thomas ?? null,
      lisId: id.lis ?? null,
      govtrackId: id.govtrack ?? null,
      opensecretsId: id.opensecrets ?? null,
      votesmartId: id.votesmart ?? null,
      icpsrId: id.icpsr ?? null,
      cspanId: id.cspan ?? null,
      firstName: name.first,
      middleName: name.middle ?? null,
      lastName: name.last,
      nameSuffix: name.suffix ?? null,
      nickname: name.nickname ?? null,
      officialFull: name.official_full ?? null,
      birthday: bio.birthday ?? null,
      gender: bio.gender ?? null,
    },
    terms: (leg.terms ?? []).map((term) => ({
      termType: term.type,
      startDate: term.start,
      endDate: term.end,
      state: term.state,
      party: term.party ?? null,
      caucus: term.caucus ?? null,
      district: term.district ?? null,  // House only; null for senators
      senateClass: term.class ?? null,  // Senate class (1/2/3); null for reps
      stateRank: term.state_rank ?? null,
      how: term.how ?? null,
      url: term.url ?? null,
      address: term.address ?? null,
      phone: term.phone ?? null,
      office: term.office ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Upsert a single legislator row.
// ---------------------------------------------------------------------------
export async function upsertLegislator(client, legislator) {
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
      legislator.bioguideId,
      legislator.thomasId,
      legislator.lisId,
      legislator.govtrackId,
      legislator.opensecretsId,
      legislator.votesmartId,
      legislator.icpsrId,
      legislator.cspanId,
      legislator.firstName,
      legislator.middleName,
      legislator.lastName,
      legislator.nameSuffix,
      legislator.nickname,
      legislator.officialFull,
      legislator.birthday,
      legislator.gender,
    ],
  );
}

// ---------------------------------------------------------------------------
// Replace all terms for a legislator.
// DELETE + INSERT is simpler and correct here: terms can have end dates
// updated, districts changed, or contact info refreshed. There are no
// other tables that FK into legislator_terms, so delete is safe.
// ---------------------------------------------------------------------------
export async function replaceTerms(client, bioguideId, terms = []) {
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
        term.termType,
        term.startDate,
        term.endDate,
        term.state,
        term.party,
        term.caucus,
        term.district,
        term.senateClass,
        term.stateRank,
        term.how,
        term.url,
        term.address,
        term.phone,
        term.office,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Load one legislator record: upsert the row and replace its terms in a
// single transaction. Returns true on success, false on failure (rolled
// back and logged — one bad record never poisons the rest of the file).
// ---------------------------------------------------------------------------
export async function loadLegislator(client, leg, { log }) {
  const bioguideId = leg?.id?.bioguide;
  if (!bioguideId) {
    log.warn('Skipping legislator record with no bioguide_id');
    return false;
  }

  try {
    await client.query('BEGIN');
    const { legislator, terms } = transform(leg);
    await upsertLegislator(client, legislator);
    await replaceTerms(client, bioguideId, terms);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    log.error(`Failed to upsert legislator ${bioguideId}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// load: the load-stage orchestrator — parse each discovered YAML file and
// load every legislator record, tallying results. The entrypoint owns the
// readiness gate, run logging, and cursor advance around this call.
// ---------------------------------------------------------------------------
export async function load({ client, files, log }) {
  let upserted = 0;
  let failed = 0;

  for (const file of files) {
    log.info(`Processing ${path.basename(file)} …`);

    // A file that fails to parse counts as one failure and never poisons the
    // run: the remaining files still load, mirroring the votes connector's
    // handling of an unparseable data.json. The cursor still advances (the
    // same broken file would fail again next run regardless), and the failure
    // is visible in the log and the run's failed tally.
    let legislators;
    try {
      legislators = parseLegislatorFile(file);
    } catch (err) {
      log.error(`Failed to parse ${file}: ${err.message}`);
      failed++;
      continue;
    }

    for (const leg of legislators) {
      if (await loadLegislator(client, leg, { log })) upserted++;
      else failed++;
    }
  }

  return { upserted, failed };
}
