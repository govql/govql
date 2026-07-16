// Congress.gov bills connector — first implementer of the source-connector
// contract (see ingester/CONNECTORS.md): discover → fetch(→raw) → transform →
// load, with staged source_state cursors as the watermark.
//
// Everything in this module is pool-free and side-effect-free at import time so
// it can be unit-tested with stub clients and a stubbed fetch; the thin cron
// entrypoints (src/fetch-bills.js, src/ingest-bills.js) do the wiring.

import { advanceFetchCursor } from '../cursor-state.js';

export const SOURCE_NAME = 'congress-bills';

// Endpoint tag for raw_payloads rows written by this connector's list fetch.
// Task 0011's per-bill sub-entity fetches will use their own tags.
export const LIST_ENDPOINT = 'bill-list';

/**
 * source_state key for one congress's fetch cursor. Keyed per congress —
 * unlike the load cursor, which spans the source — because the cursor is the
 * max updateDate *within* the target congress: reusing one cursor across
 * congresses would make a later CONGRESS_GOV_TARGET_CONGRESS change filter the
 * new congress's backfill behind the old congress's watermark, silently
 * fetching almost nothing.
 */
export function fetchStateName(congress) {
  return `${SOURCE_NAME}-${congress}`;
}

// Congress.gov bill types, as they appear (uppercased) in the list endpoint,
// matching the CHECK constraint on bills.bill_type.
const BILL_TYPES = new Set(['hr', 'hres', 'hjres', 'hconres', 's', 'sres', 'sjres', 'sconres']);

export const DEFAULT_BASE_URL = 'https://api.congress.gov/v3';
export const DEFAULT_PAGE_SIZE = 250;

/**
 * Async generator over bill-list pages for one congress, sorted by updateDate
 * ascending so the fetch cursor can advance monotonically page by page.
 * `fromDateTime` (the fetch cursor) is omitted when null — that is the
 * backfill: same code path, no lower bound. Pagination is offset-based; the
 * loop ends when the API stops advertising a `pagination.next` page.
 */
export async function* listPages({
  congress,
  apiKey,
  fromDateTime = null,
  limit = DEFAULT_PAGE_SIZE,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
}) {
  let offset = 0;
  for (;;) {
    const params = new URLSearchParams({
      format: 'json',
      sort: 'updateDate asc',
      limit: String(limit),
      offset: String(offset),
    });
    if (fromDateTime !== null) params.set('fromDateTime', fromDateTime);
    const url = `${baseUrl}/bill/${congress}?${params}`;
    // The key goes in the X-Api-Key header, never the URL: query strings land
    // in proxy/access logs and in error objects that carry the failing URL.
    const response = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey } });
    if (!response.ok) {
      throw new Error(`Congress.gov bill list request failed with HTTP ${response.status} (congress ${congress}, offset ${offset})`);
    }
    const page = await response.json();
    yield page;
    if (!page.pagination?.next) return;
    offset += page.bills?.length ?? 0;
  }
}

/**
 * Format a cursor value (full-precision ISO string from readCursor, or a bare
 * updateDate) as the `YYYY-MM-DDTHH:MM:SSZ` shape the API's fromDateTime
 * parameter requires. Pure string surgery — never a JS Date round-trip.
 */
export function toFromDateTime(cursor) {
  if (cursor == null) return null;
  const s = String(cursor);
  if (!s.includes('T')) return `${s}T00:00:00Z`;
  return `${s.slice(0, 19)}Z`;
}

/**
 * Natural key for raw_payloads: the same `hr3590-111` shape as bills.bill_id.
 * Deliberately lenient — raw storage keeps whatever the API returns; the
 * transform (load side) is where unknown types are rejected.
 */
function naturalKey(item) {
  return `${String(item.type ?? '').toLowerCase()}${item.number}-${item.congress}`;
}

/**
 * Lexical max of the page's updateDate values against the running cursor.
 * ISO-8601 strings compare correctly as strings; no Date round-trip.
 */
function maxUpdateDate(bills, current) {
  let max = current;
  for (const item of bills) {
    const d = item.updateDate ?? null;
    if (d !== null && (max === null || d > max)) max = d;
  }
  return max;
}

/**
 * Fetch stage core: page the list endpoint and land each page in raw_payloads,
 * committing the page's upserts AND the fetch-cursor advance (max consumed
 * updateDate) in one transaction — a crash resumes from the last committed
 * page, and a NULL starting cursor is the backfill. The payload-diff guard on
 * the upsert means unchanged bills don't touch fetched_at, so a rerun with
 * nothing new upstream stays a no-op for the load stage too.
 */
export async function fetchPagesIntoRaw({
  client,
  congress,
  apiKey,
  fromDateTime = null,
  limit = DEFAULT_PAGE_SIZE,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  onPage = () => {},
}) {
  let cursor = fromDateTime;
  let pages = 0;
  let upserted = 0;
  let unchanged = 0;

  for await (const page of listPages({ congress, apiKey, fromDateTime, limit, baseUrl, fetchImpl })) {
    const bills = page.bills ?? [];
    if (bills.length === 0) break;

    await client.query('BEGIN');
    try {
      for (const item of bills) {
        const { rowCount } = await client.query(
          `INSERT INTO raw_payloads (source_name, natural_key, endpoint, payload, fetched_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (source_name, natural_key, endpoint)
             DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()
             WHERE raw_payloads.payload IS DISTINCT FROM EXCLUDED.payload`,
          [SOURCE_NAME, naturalKey(item), LIST_ENDPOINT, JSON.stringify(item)],
        );
        if (rowCount === 1) upserted += 1;
        else unchanged += 1;
      }
      const pageMax = maxUpdateDate(bills, cursor);
      if (pageMax !== null && pageMax !== cursor) {
        await advanceFetchCursor(client, fetchStateName(congress), pageMax);
        cursor = pageMax;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    pages += 1;
    onPage({ pages, upserted, unchanged, cursor });
  }

  return { pages, upserted, unchanged, cursor };
}

/**
 * Fetch with skip-proofing. Offset pagination over an updateDate-ascending
 * sort is not stable while the list mutates: if Congress.gov bumps an
 * already-consumed bill mid-run, every later item shifts one position earlier
 * and the item straddling the next page boundary is silently skipped — then
 * the advanced cursor excludes it from future runs. So after any multi-page
 * pass that wrote something, re-walk from the SAME starting fromDateTime until
 * a pass writes nothing new (idempotent, diff-guarded upserts make the overlap
 * cost API calls only). A single-page pass has no boundary to skip across and
 * needs no re-walk. Cursor regression during a re-walk is safe — a lower
 * cursor only ever over-fetches.
 */
export async function fetchPagesUntilClean({ maxPasses = 5, log = () => {}, ...opts }) {
  let passes = 0;
  let pages = 0;
  let upserted = 0;
  let unchanged = 0;
  let cursor = opts.fromDateTime ?? null;

  for (;;) {
    const result = await fetchPagesIntoRaw(opts);
    passes += 1;
    pages += result.pages;
    upserted += result.upserted;
    unchanged += result.unchanged;
    cursor = result.cursor ?? cursor;

    if (result.pages <= 1 || result.upserted === 0) break;
    if (passes >= maxPasses) {
      log(
        `Bills fetch verification did not converge after ${passes} passes — ` +
        `proceeding; the next hourly run re-checks from the advanced cursor`,
      );
      break;
    }
  }

  return { passes, pages, upserted, unchanged, cursor };
}

/**
 * Load-stage readiness. raw_payloads is an owned table, so per the plan's
 * gating rule this is a staleness comparison — max(fetched_at) vs the load
 * cursor — not the file-source fetch↔load handshake. Reads max(fetched_at)
 * as a full-precision string (see cursor-state.js on why never a JS Date).
 */
export async function rawReadiness(client, loadCursor) {
  const { rows } = await client.query(
    `SELECT to_char(max(fetched_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS max_fetched_at
     FROM raw_payloads WHERE source_name = $1 AND endpoint = $2`,
    [SOURCE_NAME, LIST_ENDPOINT],
  );
  const maxFetchedAt = rows[0]?.max_fetched_at ?? null;
  const ready = maxFetchedAt !== null && (loadCursor === null || maxFetchedAt > loadCursor);
  return { maxFetchedAt, ready };
}

/**
 * Load stage core: transform every raw_payloads row fetched past the load
 * cursor into a bills upsert. ON CONFLICT (bill_id) DO UPDATE enriches the
 * vote-stub rows the votes ingester writes with DO NOTHING; identity columns
 * (bill_type, bill_number, congress) are part of the key and not updated.
 *
 * The backlog is read in keyset batches — (fetched_at, natural_key) tuple
 * bounds, never a bare fetched_at bound, because every row of a fetch page
 * shares one transaction-start now() and a bare bound would skip the rest of
 * a tie group cut by LIMIT. Bounded batches keep the first post-backfill run
 * (the whole congress) inside the ingester's small heap.
 *
 * Error handling is deliberately asymmetric: a transform reject (unknown
 * type) is deterministic — logged, counted, and skipped past, since it will
 * never succeed. A database error on the upsert is NOT caught: it fails the
 * run so the caller leaves the load cursor unadvanced and the idempotent
 * rerun re-reads the row — swallowing it would advance the cursor past a row
 * that was never consumed, and the payload-diff guard means that row's
 * fetched_at may never move again.
 *
 * Returns the max consumed fetched_at so the caller can advance the load
 * cursor to exactly that value.
 */
export async function loadStaleRawsIntoBills({ client, loadCursor, batchSize = 500, log = console.error }) {
  let ingested = 0;
  let failed = 0;
  let maxFetchedAt = loadCursor;
  let after = null; // {fetchedAt, naturalKey} keyset position within this run

  for (;;) {
    const { rows } = after === null
      ? await client.query(
          `SELECT natural_key, payload,
                  to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fetched_at
           FROM raw_payloads
           WHERE source_name = $1 AND endpoint = $2
             AND ($3::timestamptz IS NULL OR fetched_at > $3)
           ORDER BY fetched_at, natural_key
           LIMIT $4`,
          [SOURCE_NAME, LIST_ENDPOINT, loadCursor, batchSize],
        )
      : await client.query(
          `SELECT natural_key, payload,
                  to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fetched_at
           FROM raw_payloads
           WHERE source_name = $1 AND endpoint = $2
             AND (fetched_at, natural_key) > ($3, $4)
           ORDER BY fetched_at, natural_key
           LIMIT $5`,
          [SOURCE_NAME, LIST_ENDPOINT, after.fetchedAt, after.naturalKey, batchSize],
        );

    for (const raw of rows) {
      let row = null;
      try {
        row = transform(raw.payload);
      } catch (err) {
        failed += 1;
        log(`Failed to transform raw payload ${raw.natural_key}: ${err.message}`);
      }
      if (row !== null) {
        await client.query(
          `INSERT INTO bills (
             bill_id, bill_type, bill_number, congress,
             title, latest_action, latest_action_at, source_updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (bill_id) DO UPDATE SET
             title             = EXCLUDED.title,
             latest_action     = EXCLUDED.latest_action,
             latest_action_at  = EXCLUDED.latest_action_at,
             source_updated_at = EXCLUDED.source_updated_at,
             updated_at        = now()`,
          [
            row.bill_id,
            row.bill_type,
            row.bill_number,
            row.congress,
            row.title,
            row.latest_action,
            row.latest_action_at,
            row.source_updated_at,
          ],
        );
        ingested += 1;
      }
      if (maxFetchedAt === null || raw.fetched_at > maxFetchedAt) maxFetchedAt = raw.fetched_at;
    }

    if (rows.length < batchSize) break;
    const last = rows[rows.length - 1];
    after = { fetchedAt: last.fetched_at, naturalKey: last.natural_key };
  }

  return { ingested, failed, maxFetchedAt };
}

/**
 * Map one raw bill-list item to a bills-table row. Only the fields the list
 * endpoint carries — sponsor, introduced date, policy area etc. come from
 * per-bill endpoints (task 0011) and are left untouched by the upsert.
 * Throws on payloads that cannot form a valid natural key.
 */
export function transform(item) {
  const type = String(item.type ?? '').toLowerCase();
  if (!BILL_TYPES.has(type)) {
    throw new Error(`unknown bill type ${JSON.stringify(item.type)} (congress ${item.congress}, number ${item.number})`);
  }
  const number = Number.parseInt(item.number, 10);
  const congress = Number.parseInt(item.congress, 10);
  if (!Number.isInteger(number) || !Number.isInteger(congress)) {
    throw new Error(`unparseable bill number/congress: ${JSON.stringify({ number: item.number, congress: item.congress })}`);
  }
  return {
    bill_id: `${type}${number}-${congress}`,
    bill_type: type,
    bill_number: number,
    congress,
    title: item.title ?? null,
    latest_action: item.latestAction?.text ?? null,
    latest_action_at: item.latestAction?.actionDate ?? null,
    source_updated_at: item.updateDateIncludingText ?? item.updateDate ?? null,
  };
}
