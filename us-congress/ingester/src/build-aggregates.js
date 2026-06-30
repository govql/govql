/**
 * build-aggregates.js
 *
 * The `build` stage of the fetch→load→build ingestion pipeline. Rebuilds the
 * per-congress precomputed aggregates (vote_similarity and member_party_agreement)
 * for every congress whose vote data has changed since its last successful
 * rebuild, and advances each congress's vote_similarity_state watermark.
 *
 * Self-gating: unlike the fetch→load handshake (an opaque scrape input gated by a
 * source_state cursor), the build stage reads an owned DB table (`votes`, which
 * has updated_at) and gates by staleness comparison — rebuild a congress when its
 * max(votes.updated_at) exceeds built_through (see staleCongresses). So this stage
 * needs no source_state cursor; its cron time is a soft schedule, and a rebuild
 * that failed or was interrupted is retried automatically next run because its
 * watermark was never advanced.
 *
 * This logic previously lived in ingest-votes.js; it moved here verbatim so
 * aggregate building runs as its own decoupled job with its own ingestion_runs
 * row (run_type = 'vote_aggregates'), independent of vote loading.
 */

import { pool } from './db.js';
import { logger } from './logger.js';

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
       VALUES ('vote_aggregates', 'running')
       RETURNING id`,
    );
    runId = rows[0].id;

    // Driven by actual staleness, not by what was ingested — so a rebuild that
    // failed or was interrupted on a previous run is retried automatically (its
    // watermark was never advanced). On a fresh DB every congress is stale (full
    // backfill); steady state, only the current congress is stale. Each rebuild is
    // its own transaction: failures are logged but non-fatal, and the congress
    // simply remains stale for the next run.
    const stale = await staleCongresses(client);
    let rebuilt = 0;
    for (const congress of stale) {
      try {
        const t0 = Date.now();
        await rebuildAggregatesForCongress(client, congress);
        rebuilt++;
        logger.info(
          `Rebuilt aggregates for congress ${congress} in ${Date.now() - t0} ms`,
        );
      } catch (err) {
        logger.error(
          `aggregate rebuild for congress ${congress} failed ` +
          `(aggregates are stale, will retry next run): ${err.message}`,
        );
      }
    }

    await client.query(
      `UPDATE ingestion_runs
       SET finished_at = now(), status = 'success', records_upserted = $1
       WHERE id = $2`,
      [rebuilt, runId],
    );

    logger.info(
      `Aggregate build complete — stale congresses: ${stale.length}, rebuilt: ${rebuilt}`,
    );

    if (process.env.HEALTHCHECK_VOTE_AGGREGATES_URL) {
      await fetch(process.env.HEALTHCHECK_VOTE_AGGREGATES_URL).catch(() => {});
    }
  } catch (err) {
    logger.error(`Aggregate build failed: ${err.message}`);
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
