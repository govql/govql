// Congress.gov bills connector — first implementer of the source-connector
// contract (see ingester/CONNECTORS.md): discover → fetch(→raw) → transform →
// load, with staged source_state cursors as the watermark.
//
// Everything in this module is pool-free and side-effect-free at import time so
// it can be unit-tested with stub clients and a stubbed fetch; the thin cron
// entrypoints (src/fetch-bills.js, src/ingest-bills.js) do the wiring.

import { advanceFetchCursor, advanceVerifiedFetchCursor, readCursor } from '../cursor-state.js';

export const SOURCE_NAME = 'congress-bills';

// Endpoint tag for raw_payloads rows written by this connector's list fetch.
export const LIST_ENDPOINT = 'bill-list';

// Endpoint tags for the per-bill fan-out (task 0011): one raw_payloads row
// per endpoint per bill, alongside the bill's bill-list row.
export const DETAIL_ENDPOINT = 'bill-detail';
export const COSPONSORS_ENDPOINT = 'bill-cosponsors';
export const SUBJECTS_ENDPOINT = 'bill-subjects';
export const SUMMARIES_ENDPOINT = 'bill-summaries';
export const TITLES_ENDPOINT = 'bill-titles';

// The five per-bill endpoints the fan-out pulls for every changed bill.
// `single` endpoints store one unwrapped object; `items` endpoints follow
// pagination.next and store the merged item array in `merge`'s wrap shape, so
// a stored payload is always the bill's complete current set.
const SUB_ENDPOINTS = [
  { endpoint: DETAIL_ENDPOINT, suffix: '', single: (page) => page.bill ?? null },
  {
    endpoint: COSPONSORS_ENDPOINT,
    suffix: '/cosponsors',
    items: (page) => page.cosponsors ?? [],
    merge: (items) => ({ cosponsors: items }),
  },
  {
    endpoint: SUBJECTS_ENDPOINT,
    suffix: '/subjects',
    items: (page) => page.subjects?.legislativeSubjects ?? [],
    merge: (items, firstPage) => ({
      legislativeSubjects: items,
      policyArea: firstPage?.subjects?.policyArea ?? null,
    }),
  },
  {
    endpoint: SUMMARIES_ENDPOINT,
    suffix: '/summaries',
    items: (page) => page.summaries ?? [],
    merge: (items) => ({ summaries: items }),
  },
  {
    endpoint: TITLES_ENDPOINT,
    suffix: '/titles',
    items: (page) => page.titles ?? [],
    merge: (items) => ({ titles: items }),
  },
];

// Requests one bill's fan-out needs when no sub-endpoint paginates — the
// budget check per bill. Pagination follows may overrun this; see
// requestBudget on why a started bill always finishes.
export const FANOUT_REQUESTS_PER_BILL = SUB_ENDPOINTS.length;

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
 * Per-run request budget against the api.data.gov hourly rate limit. `take`
 * records spending; `has` answers whether n more requests fit, and a refusal
 * latches `exhausted` — the signal the fetch stages use to stop cleanly (the
 * next cron tick resumes from the committed cursors). Spending is allowed to
 * finish what it started: once a bill's fan-out begins, its pagination
 * follows complete even past the limit, so a stored payload is never a
 * truncated merge — the default cap leaves headroom for that overrun.
 */
export function requestBudget(limit = Infinity) {
  let used = 0;
  let exhausted = false;
  return {
    take(n = 1) { used += n; },
    has(n = 1) {
      if (used + n > limit) exhausted = true;
      return used + n <= limit;
    },
    get used() { return used; },
    get exhausted() { return exhausted; },
  };
}

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
  budget = null,
}) {
  let offset = 0;
  for (;;) {
    // A refused budget check latches budget.exhausted, which the caller reads
    // as "this walk was truncated" (complete = false).
    if (budget && !budget.has(1)) return;
    budget?.take(1);
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
 * The per-bill API path for the fan-out, or null when the list item cannot
 * form one (unknown type, non-numeric number/congress). Same strictness as
 * `transform`: a malformed item must not produce a garbage URL that 404s the
 * whole run forever — it is skipped and counted instead.
 */
function fanoutPath(item) {
  const type = String(item.type ?? '').toLowerCase();
  if (!BILL_TYPES.has(type)) return null;
  if (!/^\d+$/.test(String(item.number ?? '')) || !/^\d+$/.test(String(item.congress ?? ''))) return null;
  return `/bill/${Number.parseInt(item.congress, 10)}/${type}/${Number.parseInt(item.number, 10)}`;
}

/**
 * Fetch one per-bill endpoint, following pagination.next for the collection
 * endpoints so the stored payload is the complete current set. Every request
 * (including pagination follows) is charged to the budget; a started bill is
 * never truncated mid-merge, so the overrun past a refused check is bounded
 * by one bill's pagination.
 */
async function fetchSubEndpoint({ descriptor, path, apiKey, baseUrl, limit, fetchImpl, budget }) {
  const failed = (status, url) => new Error(
    `Congress.gov ${descriptor.endpoint} request failed with HTTP ${status} (${url.replace(/\?.*$/, '')})`,
  );

  if (descriptor.single) {
    const url = `${baseUrl}${path}${descriptor.suffix}?format=json`;
    budget?.take(1);
    const response = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey } });
    if (!response.ok) throw failed(response.status, url);
    return descriptor.single(await response.json());
  }

  const items = [];
  let firstPage = null;
  let url = `${baseUrl}${path}${descriptor.suffix}?format=json&limit=${limit}`;
  for (;;) {
    budget?.take(1);
    const response = await fetchImpl(url, { headers: { 'X-Api-Key': apiKey } });
    if (!response.ok) throw failed(response.status, url);
    const page = await response.json();
    firstPage ??= page;
    items.push(...descriptor.items(page));
    if (!page.pagination?.next) break;
    url = page.pagination.next;
  }
  return descriptor.merge(items, firstPage);
}

/**
 * Land all five per-bill endpoints for one changed bill in raw_payloads,
 * inside the caller's open chunk transaction. Same diff-guarded upsert as the
 * list rows: an identical payload leaves fetched_at untouched, so the load
 * side only sees endpoints that actually changed.
 */
async function fetchSubEndpointsIntoRaw({ client, key, path, apiKey, baseUrl, limit, fetchImpl, budget }) {
  for (const descriptor of SUB_ENDPOINTS) {
    const payload = await fetchSubEndpoint({ descriptor, path, apiKey, baseUrl, limit, fetchImpl, budget });
    await client.query(
      `INSERT INTO raw_payloads (source_name, natural_key, endpoint, payload, fetched_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (source_name, natural_key, endpoint)
         DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()
         WHERE raw_payloads.payload IS DISTINCT FROM EXCLUDED.payload`,
      [SOURCE_NAME, key, descriptor.endpoint, JSON.stringify(payload)],
    );
  }
}

// Bills per fan-out chunk transaction. Small enough that one chunk's five
// fetches per changed bill stay a short transaction (the load's grace cap
// assumes fetch transactions land within minutes), large enough that the
// per-chunk cursor write is noise.
export const DEFAULT_FANOUT_CHUNK_SIZE = 25;

/**
 * Fetch stage core: page the list endpoint and land each page in raw_payloads,
 * committing in chunks — each chunk's list upserts, its changed bills' five
 * per-bill endpoint fetches (`fanout`), AND the fetch-cursor advance (max
 * consumed updateDate) in one transaction. A crash or budget bail-out resumes
 * from the last committed chunk, and a NULL starting cursor is the backfill.
 * The payload-diff guard on the upsert means unchanged bills don't touch
 * fetched_at AND don't fan out, so a resumed or no-op rerun never re-fetches
 * a completed bill's sub-entities.
 *
 * A bill's list row and its fan-out are atomic on purpose: committing the
 * list row without its sub-entities would make the resume see the bill as
 * unchanged and skip its fan-out forever.
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
  upsertedKeys = null, // optional Set: collects distinct written natural keys across passes
  fanout = null,       // {chunkSize?} — enable the per-bill sub-entity fan-out
  budget = null,       // requestBudget shared across list pages and fan-out
  log = () => {},
}) {
  let cursor = fromDateTime;
  let pages = 0;
  let upserted = 0;
  let unchanged = 0;
  let fanoutSkipped = 0; // malformed list items that cannot form a per-bill URL
  // A walk is complete when it ended because the API advertised no further
  // page — NOT when an anomalous empty-page-with-next truncated it, and not
  // when the request budget ran out. The verification logic must never treat
  // a truncated pass as proof of coverage.
  let complete = true;
  const chunkSize = fanout?.chunkSize ?? DEFAULT_FANOUT_CHUNK_SIZE;

  pageLoop:
  for await (const page of listPages({ congress, apiKey, fromDateTime, limit, baseUrl, fetchImpl, budget })) {
    const bills = page.bills ?? [];
    if (bills.length === 0) {
      complete = !page.pagination?.next;
      break;
    }

    for (let start = 0; start < bills.length; start += chunkSize) {
      const chunk = bills.slice(start, start + chunkSize);
      let stopped = false;
      await client.query('BEGIN');
      try {
        let chunkMax = cursor;
        for (const item of chunk) {
          // Stop BEFORE the bill's list upsert: landing the list row without
          // its fan-out would hide the bill from the resumed run.
          if (fanout && budget && !budget.has(FANOUT_REQUESTS_PER_BILL)) {
            stopped = true;
            break;
          }
          const key = naturalKey(item);
          const { rowCount } = await client.query(
            `INSERT INTO raw_payloads (source_name, natural_key, endpoint, payload, fetched_at)
             VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (source_name, natural_key, endpoint)
               DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()
               WHERE raw_payloads.payload IS DISTINCT FROM EXCLUDED.payload`,
            [SOURCE_NAME, key, LIST_ENDPOINT, JSON.stringify(item)],
          );
          if (rowCount === 1) {
            upserted += 1;
            upsertedKeys?.add(key);
            if (fanout) {
              const path = fanoutPath(item);
              if (path === null) {
                fanoutSkipped += 1;
                log(`Skipping sub-entity fan-out for malformed list item ${key} (type/number/congress unusable)`);
              } else {
                await fetchSubEndpointsIntoRaw({ client, key, path, apiKey, baseUrl, limit, fetchImpl, budget });
              }
            }
          } else {
            unchanged += 1;
          }
          const d = item.updateDate ?? null;
          if (d !== null && (chunkMax === null || d > chunkMax)) chunkMax = d;
        }
        if (chunkMax !== null && chunkMax !== cursor) {
          await advanceFetchCursor(client, fetchStateName(congress), chunkMax);
          cursor = chunkMax;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      if (stopped) {
        complete = false;
        break pageLoop;
      }
    }
    pages += 1;
    onPage({ pages, upserted, unchanged, cursor });
  }

  if (budget?.exhausted) complete = false;
  return { pages, upserted, unchanged, fanoutSkipped, cursor, complete };
}

/**
 * Fetch with crash-safe skip-proofing, built on two source_state watermarks
 * per congress:
 *
 *  - `fetch` — the RESUME position: max consumed updateDate, advanced per
 *    committed page (monotonic), so a kill mid-walk resumes from the last
 *    committed page.
 *  - `fetch_verified` — the VERIFIED-THROUGH position: advanced only after a
 *    clean verification pass, i.e. a re-walk that wrote nothing new.
 *
 * Why: offset pagination over an updateDate-ascending sort is not stable
 * while the list mutates — if Congress.gov bumps an already-consumed bill
 * mid-run, every later item shifts one position earlier and the item
 * straddling the next page boundary is silently skipped, with an updateDate
 * already behind the resume cursor. The run therefore does a catch-up pass
 * from the resume cursor, then (whenever the catch-up was multi-page, or a
 * previous run left resume ahead of verified) re-walks from the VERIFIED
 * cursor until a pass writes nothing new. Only then does verified catch up.
 * A crash or pass-cap leaves verified behind, so the next run re-walks from
 * it — nothing can hide behind the resume cursor. Idempotent, diff-guarded
 * upserts make every re-walk cost API calls only.
 *
 * Returns distinct written keys as `upserted` (a payload changing twice
 * across passes is one record, not two).
 */
export async function fetchPagesUntilClean({
  client,
  congress,
  apiKey,
  limit = DEFAULT_PAGE_SIZE,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  onPage = () => {},
  maxPasses = 5,
  log = () => {},
  fanout = null,
  budget = null,
}) {
  const stateName = fetchStateName(congress);
  const resume = await readCursor(client, stateName, 'fetch');
  const verified = await readCursor(client, stateName, 'fetch_verified');

  const upsertedKeys = new Set();
  let passes = 0;
  let pages = 0;
  let unchanged = 0;
  let cursor = resume;

  const runPass = async (anchor) => {
    passes += 1;
    const pass = passes;
    const anchorFormatted = toFromDateTime(anchor);
    const result = await fetchPagesIntoRaw({
      client,
      congress,
      apiKey,
      limit,
      baseUrl,
      fetchImpl,
      fromDateTime: anchorFormatted,
      upsertedKeys,
      onPage: (p) => onPage({ ...p, pass }),
      fanout,
      budget,
      log,
    });
    pages += result.pages;
    unchanged += result.unchanged;
    // Merge only a real advance: a pass that fetched nothing echoes its anchor
    // back in truncated API format, and comparing that against the
    // full-precision cursor string would clobber it (lexically 'Z' > '.').
    if (result.cursor !== null && result.cursor !== anchorFormatted && (cursor === null || result.cursor > cursor)) {
      cursor = result.cursor;
    }
    return result;
  };

  // Catch-up pass from the resume position.
  const first = await runPass(resume);

  // Verification is owed when this run's catch-up could have boundary-skipped
  // (multi-page), when a previous run left the resume cursor ahead of the
  // verified cursor (its verification crashed or hit the cap), or when the
  // catch-up itself was truncated by an anomalous empty page.
  let owesVerification = first.pages > 1 || resume !== verified || !first.complete;
  while (owesVerification) {
    // A drained budget cannot fund a verification re-walk — burning the
    // remaining passes on immediately-truncated walks would prove nothing.
    // The verified cursor stays behind and the next run resumes from it.
    if (budget?.exhausted) {
      log(
        `Bills fetch stopped at the request budget (${budget.used} requests) — ` +
        `verification deferred; the next run resumes from the committed cursors`,
      );
      return { passes, pages, upserted: upsertedKeys.size, unchanged, cursor, verified: false };
    }
    if (passes >= maxPasses) {
      log(
        `Bills fetch verification did not converge after ${passes} passes — ` +
        `the verified cursor stays behind and the next run resumes verification from it`,
      );
      return { passes, pages, upserted: upsertedKeys.size, unchanged, cursor, verified: false };
    }
    const pass = await runPass(verified);
    // Clean = the pass wrote nothing new AND actually walked to the end.
    // A truncated pass proves nothing about the territory it never reached.
    owesVerification = pass.upserted > 0 || !pass.complete;
  }

  if (cursor !== null) await advanceVerifiedFetchCursor(client, stateName, cursor);
  return { passes, pages, upserted: upsertedKeys.size, unchanged, cursor, verified: true };
}

/**
 * Bound the load-cursor advance. `consumed` is the max fetched_at the load
 * just processed; `graceCap` is a short interval before the load run started.
 * raw_payloads.fetched_at is transaction-start now(), so a fetch page
 * transaction still in flight while the load reads can commit rows dated
 * BEHIND the load's consumed max — advancing past them would strand those
 * rows forever (the payload-diff guard never bumps an unchanged row's
 * fetched_at). Clamping the advance to the grace cap leaves in-flight
 * transactions time to land; clamped rows are simply re-read next run
 * (idempotent upserts). Never regresses an already-ahead cursor.
 */
export function capWatermark({ consumed, graceCap, loadCursor }) {
  if (consumed === null) return loadCursor;
  let value = consumed;
  if (graceCap !== null && value > graceCap) value = graceCap;
  if (loadCursor !== null && value < loadCursor) value = loadCursor;
  return value;
}

/**
 * Load-stage readiness. raw_payloads is an owned table, so per the plan's
 * gating rule this is a staleness comparison — max(fetched_at) vs the load
 * cursor — not the file-source fetch↔load handshake. Source-wide across all
 * six endpoints (one load cursor spans them), so freshness on any endpoint
 * triggers the run. Reads max(fetched_at) as a full-precision string (see
 * cursor-state.js on why never a JS Date).
 */
export async function rawReadiness(client, loadCursor) {
  const { rows } = await client.query(
    `SELECT to_char(max(fetched_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS max_fetched_at
     FROM raw_payloads WHERE source_name = $1`,
    [SOURCE_NAME],
  );
  const maxFetchedAt = rows[0]?.max_fetched_at ?? null;
  const ready = maxFetchedAt !== null && (loadCursor === null || maxFetchedAt > loadCursor);
  return { maxFetchedAt, ready };
}

/**
 * Async generator over one endpoint's raw_payloads backlog past the load
 * cursor, in keyset batches — (fetched_at, natural_key) tuple bounds, never a
 * bare fetched_at bound, because every row of a fetch transaction shares one
 * transaction-start now() and a bare bound would skip the rest of a tie group
 * cut by LIMIT. This is the chunked-read helper CONNECTORS.md flagged for
 * extraction "when the second consumer arrives" — the 0011 sub-entity
 * loaders are that consumer.
 */
async function* staleRawBatches({ client, endpoint, loadCursor, batchSize }) {
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
          [SOURCE_NAME, endpoint, loadCursor, batchSize],
        )
      : await client.query(
          `SELECT natural_key, payload,
                  to_char(fetched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS fetched_at
           FROM raw_payloads
           WHERE source_name = $1 AND endpoint = $2
             AND (fetched_at, natural_key) > ($3, $4)
           ORDER BY fetched_at, natural_key
           LIMIT $5`,
          [SOURCE_NAME, endpoint, after.fetchedAt, after.naturalKey, batchSize],
        );
    if (rows.length > 0) yield rows;
    if (rows.length < batchSize) return;
    const last = rows[rows.length - 1];
    after = { fetchedAt: last.fetched_at, naturalKey: last.natural_key };
  }
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

  for await (const rows of staleRawBatches({ client, endpoint: LIST_ENDPOINT, loadCursor, batchSize })) {
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
  }

  return { ingested, failed, maxFetchedAt };
}

/**
 * Map one raw bill-list item to a bills-table row. Only the fields the list
 * endpoint carries — sponsor, introduced date, policy area etc. come from
 * per-bill endpoints (task 0011) and are left untouched by the upsert.
 * Throws on payloads that cannot form a valid natural key.
 */
// ---------------------------------------------------------------------------
// Task 0011: sub-entity load stage. Each loader walks its endpoint's stale
// raws (same cursor-gated keyset batches as the bills load), transforms, and
// applies per bill. Error asymmetry matches loadStaleRawsIntoBills: transform
// rejects are deterministic — counted, logged, skipped; DB errors propagate
// so the unadvanced cursor re-reads the row. A raw whose bills row is missing
// (its list item was transform-rejected) is counted and skipped — also
// deterministic, and inserting it would violate the bill_id FK.
// ---------------------------------------------------------------------------

async function loadStaleEndpointRaws({ client, endpoint, loadCursor, batchSize, log, transformRaw, apply }) {
  let processed = 0;
  let failed = 0;
  let skippedMissingBill = 0;
  let maxFetchedAt = loadCursor;

  for await (const rows of staleRawBatches({ client, endpoint, loadCursor, batchSize })) {
    for (const raw of rows) {
      let data = null;
      try {
        data = transformRaw(raw.payload);
      } catch (err) {
        failed += 1;
        log(`Failed to transform ${endpoint} raw payload ${raw.natural_key}: ${err.message}`);
      }
      if (data !== null) {
        const { rowCount } = await client.query('SELECT 1 FROM bills WHERE bill_id = $1', [raw.natural_key]);
        if (rowCount === 0) {
          skippedMissingBill += 1;
          log(`Skipping ${endpoint} raw ${raw.natural_key}: no bills row (its list item was rejected)`);
        } else {
          await apply({ client, billId: raw.natural_key, data, log });
          processed += 1;
        }
      }
      if (maxFetchedAt === null || raw.fetched_at > maxFetchedAt) maxFetchedAt = raw.fetched_at;
    }
  }

  return { processed, failed, skippedMissingBill, maxFetchedAt };
}

/**
 * Replace one bill's cosponsors from its cosponsors payload. DELETE +
 * re-INSERT inside a transaction (the payload is the bill's complete current
 * set, so replacement also handles withdrawals-turned-removals); the unnest
 * JOIN drops rows whose bioguide id the legislators table doesn't know —
 * FK-safe, with the dropped ids logged, mirroring the votes ingester's
 * positions JOIN.
 */
async function applyCosponsors({ client, billId, data: rows, log }) {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM bill_cosponsors WHERE bill_id = $1', [billId]);
    if (rows.length > 0) {
      const { rowCount } = await client.query(
        `INSERT INTO bill_cosponsors (bill_id, bioguide_id, original_cosponsor, sponsored_at, withdrawn_at)
         SELECT $1, l.bioguide_id, v.original_cosponsor, v.sponsored_at, v.withdrawn_at
         FROM unnest($2::text[], $3::boolean[], $4::date[], $5::date[])
           AS v(bioguide_id, original_cosponsor, sponsored_at, withdrawn_at)
         JOIN legislators l ON l.bioguide_id = v.bioguide_id
         ON CONFLICT (bill_id, bioguide_id) DO NOTHING`,
        [
          billId,
          rows.map((r) => r.bioguide_id),
          rows.map((r) => r.original_cosponsor),
          rows.map((r) => r.sponsored_at),
          rows.map((r) => r.withdrawn_at),
        ],
      );
      const skipped = rows.length - rowCount;
      if (skipped > 0) {
        const { rows: unknown } = await client.query(
          `SELECT v.bioguide_id FROM unnest($1::text[]) AS v(bioguide_id)
           WHERE NOT EXISTS (SELECT 1 FROM legislators l WHERE l.bioguide_id = v.bioguide_id)`,
          [rows.map((r) => r.bioguide_id)],
        );
        log(
          `${billId}: ${skipped} cosponsor(s) skipped — unknown bioguide_id: ` +
          `${unknown.map((r) => r.bioguide_id).join(', ')}`,
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function loadStaleCosponsorRaws({ client, loadCursor, batchSize = 500, log = console.error }) {
  return loadStaleEndpointRaws({
    client,
    endpoint: COSPONSORS_ENDPOINT,
    loadCursor,
    batchSize,
    log,
    transformRaw: transformCosponsors,
    apply: applyCosponsors,
  });
}

/**
 * Replace one bill's subject terms. Same replacement pattern as cosponsors;
 * no legislators JOIN needed, and ON CONFLICT DO NOTHING guards against a
 * pathological payload repeating a term (the transform already dedupes).
 */
async function applySubjects({ client, billId, data: subjects }) {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM bill_subjects WHERE bill_id = $1', [billId]);
    if (subjects.length > 0) {
      await client.query(
        `INSERT INTO bill_subjects (bill_id, subject)
         SELECT $1, v.subject FROM unnest($2::text[]) AS v(subject)
         ON CONFLICT (bill_id, subject) DO NOTHING`,
        [billId, subjects],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function loadStaleSubjectRaws({ client, loadCursor, batchSize = 500, log = console.error }) {
  return loadStaleEndpointRaws({
    client,
    endpoint: SUBJECTS_ENDPOINT,
    loadCursor,
    batchSize,
    log,
    transformRaw: transformSubjects,
    apply: applySubjects,
  });
}

/**
 * Replace one bill's summary versions. The payload carries every version's
 * full text, so replacement keeps the table exactly in step with the source.
 */
async function applySummaries({ client, billId, data: rows }) {
  await client.query('BEGIN');
  try {
    await client.query('DELETE FROM bill_summaries WHERE bill_id = $1', [billId]);
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO bill_summaries (bill_id, version_code, action_desc, action_date, summary_text, source_updated_at)
         SELECT $1, v.version_code, v.action_desc, v.action_date, v.summary_text, v.source_updated_at
         FROM unnest($2::text[], $3::text[], $4::date[], $5::text[], $6::timestamptz[])
           AS v(version_code, action_desc, action_date, summary_text, source_updated_at)
         ON CONFLICT (bill_id, version_code) DO NOTHING`,
        [
          billId,
          rows.map((r) => r.version_code),
          rows.map((r) => r.action_desc),
          rows.map((r) => r.action_date),
          rows.map((r) => r.summary_text),
          rows.map((r) => r.source_updated_at),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function loadStaleSummaryRaws({ client, loadCursor, batchSize = 500, log = console.error }) {
  return loadStaleEndpointRaws({
    client,
    endpoint: SUMMARIES_ENDPOINT,
    loadCursor,
    batchSize,
    log,
    transformRaw: transformSummaries,
    apply: applySummaries,
  });
}

/**
 * Enrich the bills row from the detail payload. Every column COALESCEs onto
 * its current value: the endpoint omitting a field must never NULL a
 * populated column. A sponsor whose bioguide id the legislators table
 * doesn't know is dropped to NULL (FK-safe) with a log line naming it.
 */
async function applyDetail({ client, billId, data, log }) {
  let sponsor = data.sponsor_bioguide_id;
  if (sponsor !== null) {
    const { rowCount } = await client.query('SELECT 1 FROM legislators WHERE bioguide_id = $1', [sponsor]);
    if (rowCount === 0) {
      log(`${billId}: sponsor skipped — unknown bioguide_id: ${sponsor}`);
      sponsor = null;
    }
  }
  await client.query(
    `UPDATE bills SET
       sponsor_bioguide_id = COALESCE($2, sponsor_bioguide_id),
       introduced_at       = COALESCE($3, introduced_at),
       policy_area         = COALESCE($4, policy_area),
       enacted_as_law_type = COALESCE($5, enacted_as_law_type),
       enacted_as_number   = COALESCE($6, enacted_as_number),
       updated_at          = now()
     WHERE bill_id = $1`,
    [billId, sponsor, data.introduced_at, data.policy_area, data.enacted_as_law_type, data.enacted_as_number],
  );
}

export async function loadStaleDetailRaws({ client, loadCursor, batchSize = 500, log = console.error }) {
  return loadStaleEndpointRaws({
    client,
    endpoint: DETAIL_ENDPOINT,
    loadCursor,
    batchSize,
    log,
    transformRaw: transformDetail,
    apply: applyDetail,
  });
}

/**
 * Enrich the bills title columns from the titles payload — the current
 * (most recently updated) title per family, COALESCEd like the detail
 * enrichment so an absent family never NULLs a populated column.
 */
async function applyTitles({ client, billId, data }) {
  await client.query(
    `UPDATE bills SET
       official_title = COALESCE($2, official_title),
       short_title    = COALESCE($3, short_title),
       popular_title  = COALESCE($4, popular_title),
       updated_at     = now()
     WHERE bill_id = $1`,
    [billId, data.official_title, data.short_title, data.popular_title],
  );
}

export async function loadStaleTitleRaws({ client, loadCursor, batchSize = 500, log = console.error }) {
  return loadStaleEndpointRaws({
    client,
    endpoint: TITLES_ENDPOINT,
    loadCursor,
    batchSize,
    log,
    transformRaw: transformTitles,
    apply: applyTitles,
  });
}

// ---------------------------------------------------------------------------
// Task 0011: per-bill sub-entity transforms. Each consumes the payload shape
// the fan-out stores in raw_payloads for its endpoint (see the endpoint
// descriptors above the fan-out) and, like `transform`, never fabricates a
// value the endpoint did not carry — enrichment columns the API omits map to
// null so the load side can leave existing values untouched (COALESCE).
// ---------------------------------------------------------------------------

/**
 * Map a bill detail payload (the response's `bill` object) to the bills
 * columns the list endpoint cannot populate. `laws` lists the slip-law
 * citations for an enacted bill; the first entry is the enacted-as citation.
 */
export function transformDetail(bill) {
  const law = bill.laws?.[0] ?? null;
  return {
    sponsor_bioguide_id: bill.sponsors?.[0]?.bioguideId ?? null,
    introduced_at: bill.introducedDate ?? null,
    policy_area: bill.policyArea?.name ?? null,
    enacted_as_law_type: law?.type ?? null,
    enacted_as_number: law?.number ?? null,
  };
}

/**
 * Map a cosponsors payload to bill_cosponsors rows. Entries without a
 * bioguideId cannot key a row and are dropped here; entries whose bioguideId
 * is unknown to the legislators table are dropped FK-safely at load time
 * (with a logged count), mirroring the votes ingester's positions JOIN.
 */
export function transformCosponsors(payload) {
  const rows = [];
  for (const item of payload.cosponsors ?? []) {
    if (item.bioguideId == null) continue;
    rows.push({
      bioguide_id: item.bioguideId,
      original_cosponsor: item.isOriginalCosponsor === true,
      sponsored_at: item.sponsorshipDate ?? null,
      withdrawn_at: item.sponsorshipWithdrawnDate ?? null,
    });
  }
  return rows;
}

/**
 * Map a subjects payload (the merged `subjects` object: legislativeSubjects
 * plus policyArea) to a deduplicated list of subject terms for bill_subjects.
 * The policy area is NOT included — it lives on bills.policy_area, populated
 * from the detail endpoint.
 */
export function transformSubjects(subjects) {
  const seen = new Set();
  for (const item of subjects.legislativeSubjects ?? []) {
    if (item.name != null) seen.add(item.name);
  }
  return [...seen];
}

/**
 * Map a summaries payload to bill_summaries rows, one per summary version.
 * Entries without a versionCode cannot key a row and are dropped; a repeated
 * versionCode keeps the latest updateDate (UNIQUE bill_id/version_code).
 */
export function transformSummaries(payload) {
  const byVersion = new Map();
  for (const item of payload.summaries ?? []) {
    if (item.versionCode == null) continue;
    const existing = byVersion.get(item.versionCode);
    if (existing && (existing.source_updated_at ?? '') > (item.updateDate ?? '')) continue;
    byVersion.set(item.versionCode, {
      version_code: item.versionCode,
      action_desc: item.actionDesc ?? null,
      action_date: item.actionDate ?? null,
      summary_text: item.text ?? null,
      source_updated_at: item.updateDate ?? null,
    });
  }
  return [...byVersion.values()];
}

// Title-type matchers for the /titles endpoint. Congress.gov titleType values
// are prose ("Official Title as Introduced", "Short Title(s) as Passed
// House", "Popular Title") with per-version variants; the current title per
// family is the one with the latest updateDate. "Display Title" matches none
// of these on purpose — it feeds bills.title via the list endpoint.
const TITLE_FAMILIES = [
  ['official_title', /official title/i],
  ['short_title', /short title/i],
  ['popular_title', /popular title/i],
];

/**
 * Map a titles payload to the bills official/short/popular title columns:
 * the most recently updated title of each family, null when the family is
 * absent. Lexical ISO-string comparison, like the fetch cursor.
 */
export function transformTitles(payload) {
  const result = { official_title: null, short_title: null, popular_title: null };
  const latest = { official_title: null, short_title: null, popular_title: null };
  for (const item of payload.titles ?? []) {
    const family = TITLE_FAMILIES.find(([, re]) => re.test(item.titleType ?? ''))?.[0];
    if (!family || item.title == null) continue;
    const updated = item.updateDate ?? '';
    if (latest[family] === null || updated > latest[family]) {
      latest[family] = updated;
      result[family] = item.title;
    }
  }
  return result;
}

export function transform(item) {
  const type = String(item.type ?? '').toLowerCase();
  if (!BILL_TYPES.has(type)) {
    throw new Error(`unknown bill type ${JSON.stringify(item.type)} (congress ${item.congress}, number ${item.number})`);
  }
  // Strictly numeric: parseInt('12A') === 12 would map a malformed item onto
  // the REAL hr12-119 row and clobber it via ON CONFLICT DO UPDATE.
  if (!/^\d+$/.test(String(item.number ?? '')) || !/^\d+$/.test(String(item.congress ?? ''))) {
    throw new Error(`unparseable bill number/congress: ${JSON.stringify({ number: item.number, congress: item.congress })}`);
  }
  const number = Number.parseInt(item.number, 10);
  const congress = Number.parseInt(item.congress, 10);
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
