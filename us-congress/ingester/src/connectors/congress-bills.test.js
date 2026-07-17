import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  capWatermark,
  fetchPagesIntoRaw,
  fetchPagesUntilClean,
  fetchStateName,
  listPages,
  loadStaleCosponsorRaws,
  loadStaleRawsIntoBills,
  loadStaleDetailRaws,
  loadStaleSubjectRaws,
  loadStaleSummaryRaws,
  loadStaleTitleRaws,
  rawReadiness,
  requestBudget,
  toFromDateTime,
  transform,
  transformCosponsors,
  transformDetail,
  transformSubjects,
  transformSummaries,
  transformTitles,
} from './congress-bills.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/bill-list-page.json', import.meta.url)), 'utf8'),
);

function loadFixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

// ---------------------------------------------------------------------------
// Task 0011: per-bill sub-entity transforms (detail, titles, cosponsors,
// subjects, summaries). Each consumes the payload shape the fan-out stores in
// raw_payloads for its endpoint.
// ---------------------------------------------------------------------------

test('transformDetail maps the bill detail payload to the bills enrichment columns', () => {
  // Recorded from /v3/bill/119/s/5 (Laken Riley Act, enacted PL 119-1).
  const detail = loadFixture('bill-detail.json');
  assert.deepEqual(transformDetail(detail.bill), {
    sponsor_bioguide_id: 'B001319',
    introduced_at: '2025-01-06',
    policy_area: 'Immigration',
    enacted_as_law_type: 'Public Law',
    enacted_as_number: '119-1',
  });
});

test('transformTitles picks the most recent title per type and ignores other title types', () => {
  // Recorded from /v3/bill/119/s/5: three short-title variants (the ENR one
  // has the latest updateDate and wins), no popular title, and a "Display
  // Title" that is neither official/short/popular (it feeds bills.title via
  // the list endpoint) and must not leak in.
  const titles = loadFixture('bill-titles.json');
  assert.deepEqual(transformTitles(titles), {
    official_title: 'A bill to require the Secretary of Homeland Security to take into custody aliens who have been charged in the United States with theft, and for other purposes.',
    short_title: 'Laken Riley Act',
    popular_title: null,
  });
});

test('transformTitles maps missing title types to null and picks the most recent within a family', () => {
  const mixed = {
    titles: [
      { title: 'An official title.', titleType: 'Official Title as Introduced', updateDate: '2025-01-03T00:00:00Z' },
      { title: 'Old Popular Name', titleType: 'Popular Title', updateDate: '2025-01-01T00:00:00Z' },
      { title: 'New Popular Name', titleType: 'Popular Title', updateDate: '2025-02-01T00:00:00Z' },
    ],
  };
  assert.deepEqual(transformTitles(mixed), {
    official_title: 'An official title.',
    short_title: null,
    popular_title: 'New Popular Name',
  });
  assert.deepEqual(transformTitles({}), { official_title: null, short_title: null, popular_title: null });
});

test('transformCosponsors maps cosponsor entries to bill_cosponsors rows', () => {
  // Recorded from /v3/bill/119/s/5/cosponsors (trimmed to 3 of 53).
  const cosponsors = loadFixture('bill-cosponsors.json');
  assert.deepEqual(transformCosponsors(cosponsors), [
    { bioguide_id: 'R000584', original_cosponsor: true, sponsored_at: '2025-01-06', withdrawn_at: null },
    { bioguide_id: 'S001227', original_cosponsor: true, sponsored_at: '2025-01-06', withdrawn_at: null },
    { bioguide_id: 'L000575', original_cosponsor: true, sponsored_at: '2025-01-06', withdrawn_at: null },
  ]);
});

test('transformCosponsors maps a withdrawn cosponsor, drops entries without a bioguideId, and returns [] for an empty payload', () => {
  assert.deepEqual(
    transformCosponsors({
      cosponsors: [
        { bioguideId: 'C001132', isOriginalCosponsor: false, sponsorshipDate: '2025-02-10', sponsorshipWithdrawnDate: '2025-03-01' },
        { fullName: 'No id', sponsorshipDate: '2025-01-03' },
      ],
    }),
    [{ bioguide_id: 'C001132', original_cosponsor: false, sponsored_at: '2025-02-10', withdrawn_at: '2025-03-01' }],
  );
  assert.deepEqual(transformCosponsors({}), []);
});

test('transformSubjects maps legislative subjects to a deduplicated term list', () => {
  // Recorded from /v3/bill/119/s/5/subjects (trimmed to 4 of 11).
  const subjects = loadFixture('bill-subjects.json');
  assert.deepEqual(transformSubjects(subjects.subjects), [
    'Border security and unlawful immigration',
    'Civil actions and liability',
    'Crimes against property',
    'Criminal investigation, prosecution, interrogation',
  ]);
  // A repeated term collapses — UNIQUE(bill_id, subject) at load time.
  assert.deepEqual(
    transformSubjects({ legislativeSubjects: [{ name: 'Immigration' }, { name: 'Immigration' }] }),
    ['Immigration'],
  );
  assert.deepEqual(transformSubjects({}), []);
});

test('transformSummaries maps summary versions to bill_summaries rows, deduplicated by version keeping the latest', () => {
  // Recorded from /v3/bill/119/s/5/summaries: the Introduced version ('00')
  // and the Public Law version ('49').
  const summaries = loadFixture('bill-summaries.json');
  assert.deepEqual(transformSummaries(summaries), [
    {
      version_code: '00',
      action_desc: 'Introduced in Senate',
      action_date: '2025-01-06',
      summary_text: summaries.summaries[0].text,
      source_updated_at: '2025-01-13T16:21:37Z',
    },
    {
      version_code: '49',
      action_desc: 'Public Law',
      action_date: '2025-01-29',
      summary_text: summaries.summaries[1].text,
      source_updated_at: '2026-06-22T13:54:33Z',
    },
  ]);
  // Same versionCode twice → the later updateDate wins (UNIQUE bill_id/version).
  const dup = transformSummaries({
    summaries: [
      { versionCode: '00', text: 'old', updateDate: '2025-01-01T00:00:00Z' },
      { versionCode: '00', text: 'new', updateDate: '2025-02-01T00:00:00Z' },
    ],
  });
  assert.equal(dup.length, 1);
  assert.equal(dup[0].summary_text, 'new');
  // No versionCode → no natural key → dropped.
  assert.deepEqual(transformSummaries({ summaries: [{ text: 'x' }] }), []);
});

test('requestBudget tracks spent requests and reports exhaustion at a refused check', () => {
  const budget = requestBudget(3);
  assert.equal(budget.has(1), true);
  budget.take(1);            // list page
  assert.equal(budget.has(2), true);
  budget.take(2);            // two more requests
  assert.equal(budget.used, 3);
  assert.equal(budget.exhausted, false);   // fully spent but never refused
  assert.equal(budget.has(1), false);      // the refusal marks exhaustion
  assert.equal(budget.exhausted, true);
  // No limit → never exhausts.
  const unlimited = requestBudget();
  unlimited.take(1_000_000);
  assert.equal(unlimited.has(1_000_000), true);
  assert.equal(unlimited.exhausted, false);
});

// Routed fetch stub for fan-out tests: dispatches on URL pathname (the list
// endpoint plus the five per-bill endpoints), recording every request.
// A route returning null → 404; the sentinel 'FAIL' → 500.
function routedFetch(routes) {
  const urls = [];
  const fetchImpl = (url, opts) => {
    urls.push({ url, opts });
    const { pathname, searchParams } = new URL(url);
    const body = routes(pathname, searchParams, url);
    if (body === 'FAIL') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    if (!body) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { urls, fetchImpl };
}

// Stub for the fan-out's read-only changed check (phase 1, outside the
// transaction): `changedKeys` names the bills whose stored list payload
// differs (or is absent) — everything else reports unchanged.
function changedCheckResponse(params, changedKeys) {
  return { rows: [{ changed: changedKeys.includes(params[1]) }], rowCount: 1 };
}
const CHANGED_CHECK_RE = /SELECT \(payload IS DISTINCT FROM/i;

const detailFixture = loadFixture('bill-detail.json');
const cosponsorsFixture = loadFixture('bill-cosponsors.json');
const subjectsFixture = loadFixture('bill-subjects.json');
const summariesFixture = loadFixture('bill-summaries.json');
const titlesFixture = loadFixture('bill-titles.json');

// Serves the hr1234-119 sub-endpoints from the recorded fixtures.
function billSubEndpointRoutes(pathname) {
  const routes = {
    '/v3/bill/119/hr/1234': detailFixture,
    '/v3/bill/119/hr/1234/cosponsors': cosponsorsFixture,
    '/v3/bill/119/hr/1234/subjects': subjectsFixture,
    '/v3/bill/119/hr/1234/summaries': summariesFixture,
    '/v3/bill/119/hr/1234/titles': titlesFixture,
  };
  return routes[pathname] ?? null;
}

test('fetchPagesIntoRaw fan-out: a changed bill lands all five per-bill endpoints in the same chunk transaction; an unchanged bill fetches nothing', async () => {
  const page = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  const { urls, fetchImpl } = routedFetch((pathname) =>
    pathname === '/v3/bill/119' ? page : billSubEndpointRoutes(pathname));

  // hr1234-119's list payload changed; sres22-119's did not — only the
  // changed bill fans out. The changed check drives the fan-out; the upsert
  // rowCount drives the upserted/unchanged counts.
  const client = stubClient((text, params) => {
    if (CHANGED_CHECK_RE.test(text)) return changedCheckResponse(params, ['hr1234-119']);
    if (/INSERT INTO raw_payloads/i.test(text) && params[2] === 'bill-list') {
      return { rows: [], rowCount: params[1] === 'hr1234-119' ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });

  const result = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', fetchImpl, fanout: {} });
  assert.equal(result.upserted, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.complete, true);

  // 1 list page + 5 sub-endpoints for the one changed bill.
  assert.equal(urls.length, 6);
  const subUrls = urls.slice(1).map((u) => new URL(u.url));
  assert.deepEqual(subUrls.map((u) => u.pathname), [
    '/v3/bill/119/hr/1234',
    '/v3/bill/119/hr/1234/cosponsors',
    '/v3/bill/119/hr/1234/subjects',
    '/v3/bill/119/hr/1234/summaries',
    '/v3/bill/119/hr/1234/titles',
  ]);
  for (const [i, u] of subUrls.entries()) {
    assert.equal(u.searchParams.get('format'), 'json');
    assert.equal(u.searchParams.has('api_key'), false);          // header, never URL
    assert.deepEqual(urls[i + 1].opts.headers, { 'X-Api-Key': 'k' });
    assert.ok(urls[i + 1].opts.signal instanceof AbortSignal);   // per-request timeout
  }

  // The changed checks (and the HTTP fetches they trigger) run BEFORE the
  // transaction opens — fetched_at is transaction-start now(), so slow HTTP
  // inside the transaction would backdate rows behind the load cursor. The
  // DB writes — list + five sub-endpoints — then commit atomically with the
  // cursor advance: an interrupt rolls back the whole chunk, so a resumed
  // run's changed check fans out exactly the bills that didn't land.
  const shape = client.calls.map((c) =>
    c.text === 'BEGIN' || c.text === 'COMMIT' ? c.text
    : CHANGED_CHECK_RE.test(c.text) ? 'check'
    : /INSERT INTO raw_payloads/i.test(c.text) ? `raw:${c.params[2]}`
    : /INSERT INTO source_state/i.test(c.text) ? 'cursor'
    : 'other');
  assert.deepEqual(shape, [
    'check', 'check',
    'BEGIN',
    'raw:bill-list',
    'raw:bill-detail', 'raw:bill-cosponsors', 'raw:bill-subjects', 'raw:bill-summaries', 'raw:bill-titles',
    'raw:bill-list',
    'cursor',
    'COMMIT',
  ]);

  // Sub-endpoint payloads are stored in their merged shape under the bill's
  // natural key: detail unwraps `bill`; subjects keeps legislativeSubjects
  // plus policyArea; the collection endpoints wrap their item arrays.
  const rawByEndpoint = Object.fromEntries(
    client.calls.filter((c) => /INSERT INTO raw_payloads/i.test(c.text) && c.params[2] !== 'bill-list')
      .map((c) => [c.params[2], c]));
  for (const call of Object.values(rawByEndpoint)) assert.equal(call.params[1], 'hr1234-119');
  assert.deepEqual(JSON.parse(rawByEndpoint['bill-detail'].params[3]), detailFixture.bill);
  assert.deepEqual(JSON.parse(rawByEndpoint['bill-cosponsors'].params[3]), { cosponsors: cosponsorsFixture.cosponsors });
  assert.deepEqual(JSON.parse(rawByEndpoint['bill-subjects'].params[3]), {
    legislativeSubjects: subjectsFixture.subjects.legislativeSubjects,
    policyArea: subjectsFixture.subjects.policyArea,
  });
  assert.deepEqual(JSON.parse(rawByEndpoint['bill-summaries'].params[3]), { summaries: summariesFixture.summaries });
  assert.deepEqual(JSON.parse(rawByEndpoint['bill-titles'].params[3]), { titles: titlesFixture.titles });
});

test('fetchPagesIntoRaw fan-out: an exhausted budget stops cleanly before the next bill, keeping completed bills committed', async () => {
  const page = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  const { urls, fetchImpl } = routedFetch((pathname) =>
    pathname === '/v3/bill/119' ? page : billSubEndpointRoutes(pathname));
  const client = stubClient();

  // 1 list page + 5 fan-out requests = 6; the second bill's check (6 + 5 > 7)
  // is refused, so the run bails BEFORE touching its list row — landing it
  // without its fan-out would hide it from the resumed run.
  const budget = requestBudget(7);
  const result = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', fetchImpl, fanout: {}, budget });

  assert.equal(result.upserted, 1);
  assert.equal(result.unchanged, 0);
  assert.equal(result.complete, false);          // truncated — verification stays owed
  assert.equal(result.cursor, '2025-04-02');     // advanced only through the completed bill
  assert.equal(budget.used, 6);
  assert.equal(urls.length, 6);

  // The partial chunk still committed: one COMMIT, no ROLLBACK, and the
  // cursor write carries the completed bill's updateDate.
  const texts = client.calls.map((c) => c.text);
  assert.equal(texts.filter((t) => t === 'COMMIT').length, 1);
  assert.equal(texts.filter((t) => t === 'ROLLBACK').length, 0);
  const cursorWrite = client.calls.find((c) => /INSERT INTO source_state/i.test(c.text));
  assert.deepEqual(cursorWrite.params, ['congress-bills-119', '2025-04-02']);
  // The second bill's list row was never written.
  const listKeys = client.calls
    .filter((c) => /INSERT INTO raw_payloads/i.test(c.text) && c.params[2] === 'bill-list')
    .map((c) => c.params[1]);
  assert.deepEqual(listKeys, ['hr1234-119']);
});

test('fetchPagesUntilClean: an exhausted budget skips verification and leaves the verified cursor for the next run', async () => {
  const page = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  const { fetchImpl } = routedFetch((pathname) =>
    pathname === '/v3/bill/119' ? page : billSubEndpointRoutes(pathname));
  const client = cursorAwareClient({ resume: null, verified: null });

  const warnings = [];
  const budget = requestBudget(7);
  const result = await fetchPagesUntilClean({
    client, congress: 119, apiKey: 'k', fetchImpl, fanout: {}, budget,
    log: (m) => warnings.push(m),
  });

  // No verification passes burned against an empty budget: one truncated
  // catch-up pass, verified untouched, and the run says so.
  assert.equal(result.passes, 1);
  assert.equal(result.verified, false);
  assert.equal(verifiedWrites(client).length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /budget/i);
});

test('fetchPagesIntoRaw fan-out: an interrupt mid-fan-out rolls back only that chunk, and the resumed run re-fetches no completed bill', async () => {
  const page = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  // sres22-119's sub-endpoints, for the resumed run.
  const sres22Routes = (pathname) => {
    if (pathname.startsWith('/v3/bill/119/sres/22')) return billSubEndpointRoutes(pathname.replace('/sres/22', '/hr/1234'));
    return null;
  };

  // Run 1: hr1234-119's chunk commits; sres22-119's cosponsors fetch dies
  // with a 500 (a 404 is handled as an empty payload, but a 5xx must fail
  // the run and be retried).
  const run1 = routedFetch((pathname) => {
    if (pathname === '/v3/bill/119') return page;
    if (pathname === '/v3/bill/119/sres/22/cosponsors') return 'FAIL';
    if (pathname.startsWith('/v3/bill/119/sres/22')) return sres22Routes(pathname);
    return billSubEndpointRoutes(pathname);
  });
  const client1 = stubClient();
  await assert.rejects(
    () => fetchPagesIntoRaw({ client: client1, congress: 119, apiKey: 'k', fetchImpl: run1.fetchImpl, fanout: { chunkSize: 1 } }),
    /bill-cosponsors request failed with HTTP 500/,
  );
  const texts1 = client1.calls.map((c) => c.text);
  assert.equal(texts1.filter((t) => t === 'COMMIT').length, 1);   // hr1234's chunk landed
  // sres22's fetch died in phase 1, before its transaction ever opened —
  // nothing to roll back, nothing written.
  assert.equal(texts1.filter((t) => t === 'ROLLBACK').length, 0);
  assert.equal(texts1.filter((t) => t === 'BEGIN').length, 1);

  // Run 2 (resume): hr1234's list payload is unchanged → no fan-out for it;
  // sres22 is still "changed" (its chunk never landed) → fans out now.
  const run2 = routedFetch((pathname) => {
    if (pathname === '/v3/bill/119') return page;
    if (pathname.startsWith('/v3/bill/119/sres/22')) return sres22Routes(pathname);
    return null; // hr1234 sub-endpoints must NOT be hit again
  });
  const client2 = stubClient((text, params) => {
    if (CHANGED_CHECK_RE.test(text)) return changedCheckResponse(params, ['sres22-119']);
    if (/INSERT INTO raw_payloads/i.test(text) && params[2] === 'bill-list') {
      return { rows: [], rowCount: params[1] === 'sres22-119' ? 1 : 0 };
    }
    return { rows: [], rowCount: 1 };
  });
  const result = await fetchPagesIntoRaw({ client: client2, congress: 119, apiKey: 'k', fetchImpl: run2.fetchImpl, fanout: { chunkSize: 1 } });

  assert.equal(result.upserted, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.complete, true);
  const subPaths = run2.urls.slice(1).map((u) => new URL(u.url).pathname);
  assert.deepEqual(subPaths, [
    '/v3/bill/119/sres/22',
    '/v3/bill/119/sres/22/cosponsors',
    '/v3/bill/119/sres/22/subjects',
    '/v3/bill/119/sres/22/summaries',
    '/v3/bill/119/sres/22/titles',
  ]);
});

test('fetchPagesIntoRaw fan-out: a paginated sub-endpoint is merged into one complete payload, each page charged to the budget', async () => {
  const page = { bills: [fixture.bills[0]], pagination: { count: 1 } };
  const cosponsorsPageTwo = {
    cosponsors: [{ bioguideId: 'D000096', isOriginalCosponsor: false, sponsorshipDate: '2025-03-15' }],
    pagination: { count: 3 },
  };
  const cosponsorsPageOne = {
    cosponsors: cosponsorsFixture.cosponsors,
    pagination: { count: 3, next: 'https://api.congress.gov/v3/bill/119/hr/1234/cosponsors?offset=2&format=json' },
  };
  const { urls, fetchImpl } = routedFetch((pathname, searchParams) => {
    if (pathname === '/v3/bill/119') return page;
    if (pathname === '/v3/bill/119/hr/1234/cosponsors') {
      return searchParams.get('offset') === '2' ? cosponsorsPageTwo : cosponsorsPageOne;
    }
    return billSubEndpointRoutes(pathname);
  });
  const client = stubClient();
  const budget = requestBudget(1000);

  await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', fetchImpl, fanout: {}, budget });

  // 1 list + 6 fan-out (cosponsors took two pages).
  assert.equal(urls.length, 7);
  assert.equal(budget.used, 7);
  const cosponsorsRaw = client.calls.find((c) =>
    /INSERT INTO raw_payloads/i.test(c.text) && c.params[2] === 'bill-cosponsors');
  assert.deepEqual(JSON.parse(cosponsorsRaw.params[3]), {
    cosponsors: [...cosponsorsFixture.cosponsors, ...cosponsorsPageTwo.cosponsors],
  });
});

test('fetchPagesIntoRaw fan-out: a malformed list item lands raw but skips fan-out instead of 404ing the run forever', async () => {
  const malformed = { ...fixture.bills[0], type: 'AMDT' }; // no valid per-bill URL
  const page = { bills: [malformed], pagination: { count: 1 } };
  const { urls, fetchImpl } = routedFetch((pathname) => (pathname === '/v3/bill/119' ? page : null));
  const client = stubClient();

  const warnings = [];
  const result = await fetchPagesIntoRaw({
    client, congress: 119, apiKey: 'k', fetchImpl, fanout: {}, log: (m) => warnings.push(m),
  });

  assert.equal(result.upserted, 1);       // raw storage stays lenient
  assert.equal(result.fanoutSkipped, 1);  // but no garbage per-bill URL is fetched
  assert.equal(urls.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /amdt1234-119/);
});

// ---------------------------------------------------------------------------
// Task 0011: sub-entity load stage. Each loader consumes its endpoint's stale
// raws in the same cursor-gated keyset-batch pattern as the bills load.
// ---------------------------------------------------------------------------

test('loadStaleCosponsorRaws replaces a bill\'s cosponsors, dropping unknown bioguide ids FK-safely with a logged count', async () => {
  const staleRow = {
    natural_key: 'hr1234-119',
    payload: { cosponsors: cosponsorsFixture.cosponsors },
    fetched_at: '2026-07-16T09:30:00.000001Z',
  };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [staleRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    // The unnest JOIN inserts only the known bioguide ids (2 of 3).
    if (/INSERT INTO bill_cosponsors/i.test(text)) return { rows: [], rowCount: 2 };
    if (/NOT EXISTS/i.test(text)) return { rows: [{ bioguide_id: 'L000575' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });

  const warnings = [];
  const result = await loadStaleCosponsorRaws({
    client,
    loadCursor: '2026-07-16T09:00:00.000000Z',
    log: (m) => warnings.push(m),
  });
  assert.deepEqual(result, {
    processed: 1,
    failed: 0,
    skippedMissingBill: 0,
    maxFetchedAt: '2026-07-16T09:30:00.000001Z',
  });

  // The stale-raw read targets this endpoint's rows past the load cursor.
  const read = client.calls[0];
  assert.deepEqual(read.params.slice(0, 3), ['congress-bills', 'bill-cosponsors', '2026-07-16T09:00:00.000000Z']);

  // Replace-per-bill inside a transaction: DELETE then unnest JOIN INSERT —
  // the JOIN drops unknown bioguide ids instead of violating the FK.
  const texts = client.calls.map((c) => c.text);
  const del = client.calls.find((c) => /DELETE FROM bill_cosponsors/i.test(c.text));
  assert.deepEqual(del.params, ['hr1234-119']);
  const insert = client.calls.find((c) => /INSERT INTO bill_cosponsors/i.test(c.text));
  assert.match(insert.text, /JOIN legislators l ON l\.bioguide_id = v\.bioguide_id/i);
  assert.deepEqual(insert.params, [
    'hr1234-119',
    ['R000584', 'S001227', 'L000575'],
    [true, true, true],
    ['2025-01-06', '2025-01-06', '2025-01-06'],
    [null, null, null],
  ]);
  assert.ok(texts.indexOf('BEGIN') < texts.indexOf(del.text));
  assert.ok(texts.indexOf(insert.text) < texts.indexOf('COMMIT'));

  // The dropped id is named in the log, like the votes ingester's positions JOIN.
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hr1234-119/);
  assert.match(warnings[0], /L000575/);
});

test('loadStaleCosponsorRaws skips (and counts) a raw whose bills row does not exist instead of violating the FK', async () => {
  const staleRow = {
    natural_key: 'hr99999-119',
    payload: { cosponsors: cosponsorsFixture.cosponsors },
    fetched_at: '2026-07-16T09:30:00.000001Z',
  };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [staleRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });

  const result = await loadStaleCosponsorRaws({ client, loadCursor: null, log: () => {} });
  assert.equal(result.processed, 0);
  assert.equal(result.skippedMissingBill, 1);
  assert.equal(client.calls.some((c) => /DELETE FROM bill_cosponsors/i.test(c.text)), false);
});

test('loadStaleSubjectRaws replaces a bill\'s subject terms per bill', async () => {
  const staleRow = {
    natural_key: 'hr1234-119',
    payload: { legislativeSubjects: subjectsFixture.subjects.legislativeSubjects, policyArea: subjectsFixture.subjects.policyArea },
    fetched_at: '2026-07-16T09:30:00.000001Z',
  };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [staleRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    return { rows: [], rowCount: 2 };
  });

  const result = await loadStaleSubjectRaws({ client, loadCursor: null, log: () => {} });
  assert.deepEqual(result, { processed: 1, failed: 0, skippedMissingBill: 0, maxFetchedAt: '2026-07-16T09:30:00.000001Z' });

  assert.equal(client.calls[0].params[1], 'bill-subjects');
  const del = client.calls.find((c) => /DELETE FROM bill_subjects/i.test(c.text));
  assert.deepEqual(del.params, ['hr1234-119']);
  const insert = client.calls.find((c) => /INSERT INTO bill_subjects/i.test(c.text));
  assert.deepEqual(insert.params, ['hr1234-119', [
    'Border security and unlawful immigration',
    'Civil actions and liability',
    'Crimes against property',
    'Criminal investigation, prosecution, interrogation',
  ]]);
});

test('loadStaleSummaryRaws replaces a bill\'s summaries per bill', async () => {
  const staleRow = {
    natural_key: 'hr1234-119',
    payload: { summaries: summariesFixture.summaries },
    fetched_at: '2026-07-16T09:30:00.000001Z',
  };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [staleRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    return { rows: [], rowCount: 2 };
  });

  const result = await loadStaleSummaryRaws({ client, loadCursor: null, log: () => {} });
  assert.deepEqual(result, { processed: 1, failed: 0, skippedMissingBill: 0, maxFetchedAt: '2026-07-16T09:30:00.000001Z' });

  assert.equal(client.calls[0].params[1], 'bill-summaries');
  const del = client.calls.find((c) => /DELETE FROM bill_summaries/i.test(c.text));
  assert.deepEqual(del.params, ['hr1234-119']);
  const insert = client.calls.find((c) => /INSERT INTO bill_summaries/i.test(c.text));
  assert.deepEqual(insert.params, [
    'hr1234-119',
    ['00', '49'],
    ['Introduced in Senate', 'Public Law'],
    ['2025-01-06', '2025-01-29'],
    [summariesFixture.summaries[0].text, summariesFixture.summaries[1].text],
    ['2025-01-13T16:21:37Z', '2026-06-22T13:54:33Z'],
  ]);
});

test('loadStaleDetailRaws enriches the bills row via COALESCE — a populated column is never overwritten with NULL', async () => {
  const staleRow = {
    natural_key: 'hr1234-119',
    payload: detailFixture.bill,
    fetched_at: '2026-07-16T09:30:00.000001Z',
  };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [staleRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    if (/SELECT 1 FROM legislators/i.test(text)) return { rows: [{}], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });

  const result = await loadStaleDetailRaws({ client, loadCursor: null, log: () => {} });
  assert.deepEqual(result, { processed: 1, failed: 0, skippedMissingBill: 0, maxFetchedAt: '2026-07-16T09:30:00.000001Z' });

  assert.equal(client.calls[0].params[1], 'bill-detail');
  const update = client.calls.find((c) => /UPDATE bills/i.test(c.text));
  // Every enrichment column falls back to its current value when the
  // endpoint omitted the field — the no-NULL-overwrite rule.
  assert.match(update.text, /sponsor_bioguide_id = COALESCE\(\$2, sponsor_bioguide_id\)/i);
  assert.match(update.text, /introduced_at\s+= COALESCE\(\$3, introduced_at\)/i);
  assert.match(update.text, /policy_area\s+= COALESCE\(\$4, policy_area\)/i);
  assert.match(update.text, /enacted_as_law_type = COALESCE\(\$5, enacted_as_law_type\)/i);
  assert.match(update.text, /enacted_as_number\s+= COALESCE\(\$6, enacted_as_number\)/i);
  assert.deepEqual(update.params, ['hr1234-119', 'B001319', '2025-01-06', 'Immigration', 'Public Law', '119-1']);
});

test('loadStaleDetailRaws NULLs an unknown sponsor bioguide id FK-safely, with a logged count', async () => {
  const staleRow = {
    natural_key: 'hr1234-119',
    payload: detailFixture.bill,
    fetched_at: '2026-07-16T09:30:00.000001Z',
  };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [staleRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    if (/SELECT 1 FROM legislators/i.test(text)) return { rows: [], rowCount: 0 }; // unknown sponsor
    return { rows: [], rowCount: 1 };
  });

  const warnings = [];
  const result = await loadStaleDetailRaws({ client, loadCursor: null, log: (m) => warnings.push(m) });
  assert.equal(result.processed, 1);

  const update = client.calls.find((c) => /UPDATE bills/i.test(c.text));
  assert.equal(update.params[1], null);                 // sponsor dropped, not FK-violated
  assert.equal(update.params[2], '2025-01-06');         // the rest still applied
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hr1234-119/);
  assert.match(warnings[0], /B001319/);
});

test('loadStaleTitleRaws enriches the title columns via COALESCE from the titles payload', async () => {
  const staleRow = {
    natural_key: 'hr1234-119',
    payload: { titles: titlesFixture.titles },
    fetched_at: '2026-07-16T09:30:00.000001Z',
  };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [staleRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });

  const result = await loadStaleTitleRaws({ client, loadCursor: null, log: () => {} });
  assert.deepEqual(result, { processed: 1, failed: 0, skippedMissingBill: 0, maxFetchedAt: '2026-07-16T09:30:00.000001Z' });

  assert.equal(client.calls[0].params[1], 'bill-titles');
  const update = client.calls.find((c) => /UPDATE bills/i.test(c.text));
  assert.match(update.text, /official_title = COALESCE\(\$2, official_title\)/i);
  assert.match(update.text, /short_title\s+= COALESCE\(\$3, short_title\)/i);
  assert.match(update.text, /popular_title\s+= COALESCE\(\$4, popular_title\)/i);
  assert.deepEqual(update.params, [
    'hr1234-119',
    'A bill to require the Secretary of Homeland Security to take into custody aliens who have been charged in the United States with theft, and for other purposes.',
    'Laken Riley Act',
    null,
  ]);
});

test('fetchPagesIntoRaw fan-out: a 404 sub-endpoint stores an empty payload instead of wedging the pipeline on that bill forever', async () => {
  const page = { bills: [fixture.bills[0]], pagination: { count: 1 } };
  const { fetchImpl } = routedFetch((pathname) => {
    if (pathname === '/v3/bill/119') return page;
    if (pathname === '/v3/bill/119/hr/1234/summaries') return null; // persistent 404
    if (pathname === '/v3/bill/119/hr/1234') return null;           // detail 404 too
    return billSubEndpointRoutes(pathname);
  });
  const client = stubClient();

  const warnings = [];
  const result = await fetchPagesIntoRaw({
    client, congress: 119, apiKey: 'k', fetchImpl, fanout: {}, log: (m) => warnings.push(m),
  });

  // The run completes — a permanently-404ing bill must not stall every bill
  // behind it — and the 404s are named in the log.
  assert.equal(result.complete, true);
  assert.equal(warnings.filter((w) => /404/.test(w)).length, 2);

  const rawByEndpoint = Object.fromEntries(
    client.calls.filter((c) => /INSERT INTO raw_payloads/i.test(c.text) && c.params[2] !== 'bill-list')
      .map((c) => [c.params[2], JSON.parse(c.params[3])]));
  assert.equal(rawByEndpoint['bill-detail'], null);                     // single → null
  assert.deepEqual(rawByEndpoint['bill-summaries'], { summaries: [] }); // collection → empty set
  assert.deepEqual(rawByEndpoint['bill-cosponsors'], { cosponsors: cosponsorsFixture.cosponsors });
});

test('fetchPagesIntoRaw fan-out: a pagination.next URL off the API origin is refused, never fetched with the key attached', async () => {
  const page = { bills: [fixture.bills[0]], pagination: { count: 1 } };
  const hostileCosponsors = {
    cosponsors: cosponsorsFixture.cosponsors,
    pagination: { count: 300, next: 'https://evil.example.com/v3/bill/119/hr/1234/cosponsors?offset=250' },
  };
  const { urls, fetchImpl } = routedFetch((pathname, searchParams, url) => {
    if (url.startsWith('https://evil.example.com')) throw new Error('hostile host was fetched');
    if (pathname === '/v3/bill/119') return page;
    if (pathname === '/v3/bill/119/hr/1234/cosponsors') return hostileCosponsors;
    return billSubEndpointRoutes(pathname);
  });

  await assert.rejects(
    () => fetchPagesIntoRaw({ client: stubClient(), congress: 119, apiKey: 'k', fetchImpl, fanout: {} }),
    /pagination\.next left the API origin/,
  );
  assert.equal(urls.some((u) => u.url.includes('evil.example.com')), false);
});

test('transformDetail maps a null detail payload (stored for a 404) to all-null enrichment, not a transform reject', () => {
  const allNull = {
    sponsor_bioguide_id: null,
    introduced_at: null,
    policy_area: null,
    enacted_as_law_type: null,
    enacted_as_number: null,
  };
  assert.deepEqual(transformDetail(null), allNull);
});

test('transformCosponsors deduplicates a repeated bioguideId (first entry wins) so the load\'s skipped count means unknown ids only', () => {
  const rows = transformCosponsors({
    cosponsors: [
      { bioguideId: 'B001316', isOriginalCosponsor: true, sponsorshipDate: '2025-01-03' },
      { bioguideId: 'B001316', isOriginalCosponsor: false, sponsorshipDate: '2025-02-01' },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].original_cosponsor, true); // first occurrence, deterministically
});

test('sub-entity loaders: a transform reject is counted and logged, and a DB error propagates un-swallowed', async () => {
  // Reject path: a summaries payload that throws in transform (null) is
  // counted as failed, logged, and skipped past — the designed skip path.
  const badRow = { natural_key: 'hr1234-119', payload: null, fetched_at: '2026-07-16T09:30:00.000001Z' };
  const rejectClient = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [badRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const warnings = [];
  const rejected = await loadStaleSummaryRaws({ client: rejectClient, loadCursor: null, log: (m) => warnings.push(m) });
  assert.equal(rejected.failed, 1);
  assert.equal(rejected.processed, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hr1234-119/);

  // DB-error path: an apply failure must fail the run so the unadvanced
  // cursor re-reads the row — never a silent skip.
  const goodRow = { natural_key: 'hr1234-119', payload: { summaries: summariesFixture.summaries }, fetched_at: '2026-07-16T09:30:00.000001Z' };
  const dbErrorClient = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [goodRow], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr1234-119' }], rowCount: 1 };
    if (/DELETE FROM bill_summaries/i.test(text)) throw new Error('deadlock detected');
    return { rows: [], rowCount: 1 };
  });
  await assert.rejects(
    () => loadStaleSummaryRaws({ client: dbErrorClient, loadCursor: null, log: () => {} }),
    /deadlock detected/,
  );
});

test('detail/titles enrichment: a payload omitting fields yields all-null UPDATE params, never fabricated values', async () => {
  // The COALESCE SQL (asserted elsewhere) makes null params no-ops in
  // Postgres; this pins the transform+loader side of the contract — omitted
  // fields arrive at the UPDATE as nulls, not as clobbering values.
  const bareDetail = { natural_key: 'hr9-119', payload: { congress: 119, type: 'HR', number: '9' }, fetched_at: '2026-07-16T09:30:00.000001Z' };
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [bareDetail], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr9-119' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  await loadStaleDetailRaws({ client, loadCursor: null, log: () => {} });
  const update = client.calls.find((c) => /UPDATE bills/i.test(c.text));
  assert.deepEqual(update.params, ['hr9-119', null, null, null, null, null]);

  const bareTitles = { natural_key: 'hr9-119', payload: { titles: [] }, fetched_at: '2026-07-16T09:30:00.000001Z' };
  const titlesClient = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: [bareTitles], rowCount: 1 };
    if (/SELECT bill_id FROM bills/i.test(text)) return { rows: [{ bill_id: 'hr9-119' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  await loadStaleTitleRaws({ client: titlesClient, loadCursor: null, log: () => {} });
  const titlesUpdate = titlesClient.calls.find((c) => /UPDATE bills/i.test(c.text));
  assert.deepEqual(titlesUpdate.params, ['hr9-119', null, null, null]);
});

test('transformDetail maps fields the endpoint omits to null (never fabricated)', () => {
  assert.deepEqual(transformDetail({ congress: 119, type: 'HR', number: '9' }), {
    sponsor_bioguide_id: null,
    introduced_at: null,
    policy_area: null,
    enacted_as_law_type: null,
    enacted_as_number: null,
  });
});

test('transform rejects an item whose type cannot satisfy the bills.bill_type constraint', () => {
  assert.throws(
    () => transform({ ...fixture.bills[0], type: 'AMDT' }),
    /unknown bill type "AMDT"/,
  );
});

test('transform rejects a non-numeric bill number instead of silently clobbering another bill', () => {
  // parseInt('12A') === 12 would map a malformed item onto the REAL hr12-119
  // row via ON CONFLICT DO UPDATE; the natural key must be strictly numeric.
  assert.throws(() => transform({ ...fixture.bills[0], number: '12A' }), /unparseable bill number/);
  assert.throws(() => transform({ ...fixture.bills[0], congress: '119th' }), /unparseable bill number/);
});

test('transform maps a bill-list item to a bills row with the hr3590-111 natural key', () => {
  const row = transform(fixture.bills[0]);
  assert.deepEqual(row, {
    bill_id: 'hr1234-119',
    bill_type: 'hr',
    bill_number: 1234,
    congress: 119,
    title: 'Example Tax Relief Act of 2025',
    latest_action: 'Referred to the Committee on Ways and Means.',
    latest_action_at: '2025-04-01',
    source_updated_at: '2025-04-02T07:15:31Z',
  });
});

function stubFetch(pages) {
  const urls = [];
  const options = [];
  const fetchImpl = (url, opts) => {
    urls.push(url);
    options.push(opts);
    const body = pages[urls.length - 1];
    if (!body) throw new Error(`unexpected extra fetch: ${url}`);
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  return { urls, options, fetchImpl };
}

test('listPages pages the bill-list endpoint with cursor, sort, and offset until the last page', async () => {
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'https://api.congress.gov/v3/bill/119?offset=1' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { urls, options, fetchImpl } = stubFetch([pageOne, pageTwo]);

  const pages = [];
  for await (const page of listPages({
    congress: 119,
    apiKey: 'test-key',
    fromDateTime: '2025-04-01T00:00:00Z',
    limit: 1,
    fetchImpl,
  })) {
    pages.push(page);
  }

  assert.deepEqual(pages, [pageOne, pageTwo]);
  assert.equal(urls.length, 2);
  const first = new URL(urls[0]);
  assert.equal(first.origin + first.pathname, 'https://api.congress.gov/v3/bill/119');
  // The key travels in the X-Api-Key header, never the URL — query strings
  // leak into proxy/access logs and error objects.
  assert.equal(first.searchParams.has('api_key'), false);
  assert.deepEqual(options[0].headers, { 'X-Api-Key': 'test-key' });
  // Every request carries a timeout so a stalled response can't wedge the run.
  assert.ok(options[0].signal instanceof AbortSignal);
  assert.equal(first.searchParams.get('fromDateTime'), '2025-04-01T00:00:00Z');
  assert.equal(first.searchParams.get('sort'), 'updateDate asc');
  assert.equal(first.searchParams.get('limit'), '1');
  assert.equal(first.searchParams.get('offset'), '0');
  assert.equal(first.searchParams.get('format'), 'json');
  assert.equal(new URL(urls[1]).searchParams.get('offset'), '1');
});

test('listPages omits fromDateTime on a NULL-cursor backfill', async () => {
  const { urls, fetchImpl } = stubFetch([{ bills: [], pagination: { count: 0 } }]);
  for await (const _ of listPages({ congress: 119, apiKey: 'k', fromDateTime: null, fetchImpl })) void _;
  assert.equal(new URL(urls[0]).searchParams.has('fromDateTime'), false);
});

test('listPages surfaces a non-OK API response as an error', async () => {
  const fetchImpl = () => Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) });
  await assert.rejects(async () => {
    for await (const _ of listPages({ congress: 119, apiKey: 'k', fetchImpl })) void _;
  }, /429/);
});

// Stub pg client: records every query and returns canned rows by call order.
// (Same shape as cursor-state.test.js; raw upserts get a rowCount response.)
function stubClient(respond = () => ({ rows: [], rowCount: 1 })) {
  const calls = [];
  return {
    calls,
    query(text, params) {
      calls.push({ text, params });
      return Promise.resolve(respond(text, params));
    },
  };
}

test('fetchPagesIntoRaw commits each page atomically: raw upserts + fetch-cursor advance', async () => {
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { fetchImpl } = stubFetch([pageOne, pageTwo]);
  const client = stubClient();

  const result = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', limit: 1, fetchImpl });

  assert.equal(result.pages, 2);
  assert.equal(result.upserted, 2);
  assert.equal(result.cursor, '2025-04-03');

  const texts = client.calls.map((c) => c.text);
  // Two page transactions, each: BEGIN, raw upsert, cursor advance, COMMIT.
  const shape = texts.map((t) =>
    t === 'BEGIN' || t === 'COMMIT' ? t
    : /INSERT INTO raw_payloads/i.test(t) ? 'raw'
    : /INSERT INTO source_state/i.test(t) ? 'cursor'
    : 'other');
  assert.deepEqual(shape, ['BEGIN', 'raw', 'cursor', 'COMMIT', 'BEGIN', 'raw', 'cursor', 'COMMIT']);

  // The raw upsert carries the connector's source/natural-key/endpoint identity
  // and only touches fetched_at when the payload actually changed.
  const raw = client.calls[1];
  assert.match(raw.text, /ON CONFLICT \(source_name, natural_key, endpoint\)/i);
  assert.match(raw.text, /IS DISTINCT FROM/i);
  assert.deepEqual(raw.params.slice(0, 3), ['congress-bills', 'hr1234-119', 'bill-list']);
  assert.deepEqual(JSON.parse(raw.params[3]), fixture.bills[0]);

  // Per-page cursor advance goes to that page's max consumed updateDate,
  // keyed per congress so changing the target congress starts a fresh
  // backfill instead of silently filtering behind another congress's cursor.
  assert.deepEqual(client.calls[2].params, ['congress-bills-119', '2025-04-02']);
  assert.deepEqual(client.calls[6].params, ['congress-bills-119', '2025-04-03']);
});

// Stub client for fetchPagesUntilClean runs: serves the resume ('fetch') and
// verified ('fetch_verified') cursors to readCursor, canned rowCounts to raw
// upserts, and records every source_state write.
function cursorAwareClient({ resume = null, verified = null, rawRowCount = () => 1 } = {}) {
  const calls = [];
  let rawWrites = 0;
  return {
    calls,
    query(text, params) {
      calls.push({ text, params });
      if (/FROM source_state/i.test(text)) {
        const cursor = params[1] === 'fetch' ? resume : verified;
        return Promise.resolve({ rows: cursor === null ? [] : [{ cursor }] });
      }
      if (/INSERT INTO raw_payloads/i.test(text)) {
        rawWrites += 1;
        return Promise.resolve({ rows: [], rowCount: rawRowCount(rawWrites) });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    },
  };
}

function verifiedWrites(client) {
  return client.calls.filter((c) => /'fetch_verified'/.test(c.text) && /INSERT INTO source_state/i.test(c.text));
}

test('fetchPagesUntilClean: multi-page pass triggers a verification re-walk from the VERIFIED cursor, then advances it', async () => {
  // Prior state verified (resume == verified). Pass 1 from the resume cursor
  // is multi-page (boundary skips possible); the verification pass re-walks
  // from the verified cursor and finds nothing new → verified advances.
  const anchor = '2025-04-01T00:00:00.000000Z';
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { urls, fetchImpl } = stubFetch([pageOne, pageTwo, pageOne, pageTwo]);
  const client = cursorAwareClient({
    resume: anchor,
    verified: anchor,
    rawRowCount: (n) => (n <= 2 ? 1 : 0), // verification pass: payloads identical
  });

  const pageEvents = [];
  const result = await fetchPagesUntilClean({
    client,
    congress: 119,
    apiKey: 'k',
    limit: 1,
    fetchImpl,
    onPage: (p) => pageEvents.push(p),
  });

  assert.equal(result.passes, 2);
  assert.equal(result.verified, true);
  assert.equal(result.upserted, 2); // distinct bills, not per-pass double counts
  assert.equal(result.unchanged, 2);
  assert.equal(urls.length, 4);
  for (const i of [0, 2]) {
    const u = new URL(urls[i]);
    assert.equal(u.searchParams.get('fromDateTime'), '2025-04-01T00:00:00Z');
    assert.equal(u.searchParams.get('offset'), '0');
  }
  // onPage events carry the pass number so run logs are unambiguous.
  assert.deepEqual(pageEvents.map((p) => p.pass), [1, 1, 2, 2]);
  // The verified cursor advances exactly once, to the final resume position.
  const vw = verifiedWrites(client);
  assert.equal(vw.length, 1);
  assert.deepEqual(vw[0].params, ['congress-bills-119', '2025-04-03']);
});

test('fetchPagesUntilClean: single-page pass on a verified baseline skips verification and advances the verified cursor', async () => {
  const anchor = '2025-04-01T00:00:00.000000Z';
  const { urls, fetchImpl } = stubFetch([{ bills: [fixture.bills[0]], pagination: { count: 1 } }]);
  const client = cursorAwareClient({ resume: anchor, verified: anchor });

  const result = await fetchPagesUntilClean({ client, congress: 119, apiKey: 'k', fetchImpl });

  assert.equal(result.passes, 1);
  assert.equal(result.verified, true);
  assert.equal(urls.length, 1);
  assert.equal(verifiedWrites(client).length, 1);
});

test('fetchPagesUntilClean: a resume cursor ahead of the verified cursor forces verification even for a single-page pass', async () => {
  // The previous run crashed (or was capped) mid-verification: resume moved,
  // verified did not. This run must re-walk from the verified cursor even
  // though its own catch-up pass was trivially small.
  const resume = '2025-04-03T00:00:00.000000Z';
  const verified = '2025-04-01T00:00:00.000000Z';
  const emptyPage = { bills: [], pagination: { count: 0 } };
  const fullPage = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  const { urls, fetchImpl } = stubFetch([emptyPage, fullPage]);
  const client = cursorAwareClient({ resume, verified, rawRowCount: () => 0 });

  const result = await fetchPagesUntilClean({ client, congress: 119, apiKey: 'k', fetchImpl });

  assert.equal(result.passes, 2);
  assert.equal(result.verified, true);
  assert.equal(new URL(urls[0]).searchParams.get('fromDateTime'), '2025-04-03T00:00:00Z');
  assert.equal(new URL(urls[1]).searchParams.get('fromDateTime'), '2025-04-01T00:00:00Z');
  // Clean verification → verified catches up to the resume position.
  const vw = verifiedWrites(client);
  assert.equal(vw.length, 1);
  assert.deepEqual(vw[0].params, ['congress-bills-119', resume]);
});

test('fetchPagesUntilClean: a verification pass truncated by an empty-page-with-next is NOT clean', async () => {
  // Anomalous API response: zero bills but pagination.next present. Such a
  // pass wrote nothing, but it also never re-walked the territory — treating
  // it as clean would advance fetch_verified over a possibly-skipped bill.
  const anchor = '2025-04-01T00:00:00.000000Z';
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const truncated = { bills: [], pagination: { count: 2, next: 'x' } };
  // Pass 1: multi-page catch-up. Pass 2: truncated (not clean). Pass 3: full
  // re-walk, everything unchanged → clean.
  const { fetchImpl } = stubFetch([pageOne, pageTwo, truncated, pageOne, pageTwo]);
  const client = cursorAwareClient({
    resume: anchor,
    verified: anchor,
    rawRowCount: (n) => (n <= 2 ? 1 : 0),
  });

  const result = await fetchPagesUntilClean({
    client,
    congress: 119,
    apiKey: 'k',
    limit: 1,
    fetchImpl,
    maxPasses: 5,
  });

  assert.equal(result.passes, 3);
  assert.equal(result.verified, true);
  assert.equal(verifiedWrites(client).length, 1);
});

test('fetchPagesUntilClean: hitting the pass cap leaves the verified cursor untouched for the next run', async () => {
  // Every pass keeps finding changes → cap fires. The verified cursor must NOT
  // advance: the next hourly run re-walks from it, so nothing is stranded.
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  const pageTwo = { bills: [fixture.bills[1]], pagination: { count: 2 } };
  const { fetchImpl } = stubFetch([pageOne, pageTwo, pageOne, pageTwo]);
  const client = cursorAwareClient({ resume: null, verified: null, rawRowCount: () => 1 });

  const warnings = [];
  const result = await fetchPagesUntilClean({
    client,
    congress: 119,
    apiKey: 'k',
    limit: 1,
    fetchImpl,
    maxPasses: 2,
    log: (m) => warnings.push(m),
  });

  assert.equal(result.passes, 2);
  assert.equal(result.verified, false);
  assert.equal(verifiedWrites(client).length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did not converge/);
});

test('capWatermark bounds the load-cursor advance: never past the grace cap, never backwards', () => {
  const loadCursor = '2026-07-15T09:00:00.000000Z';
  const graceCap = '2026-07-15T10:15:00.000000Z';
  // Normal: consumed below the cap → advance to consumed.
  assert.equal(
    capWatermark({ consumed: '2026-07-15T10:00:00.000000Z', graceCap, loadCursor }),
    '2026-07-15T10:00:00.000000Z',
  );
  // Consumed inside the grace window (in-flight fetch transactions may still
  // land behind it) → clamp to the cap.
  assert.equal(
    capWatermark({ consumed: '2026-07-15T10:19:00.000000Z', graceCap, loadCursor }),
    graceCap,
  );
  // Clamp would regress an already-ahead cursor → keep the cursor.
  assert.equal(
    capWatermark({ consumed: '2026-07-15T10:19:00.000000Z', graceCap: '2026-07-15T08:00:00.000000Z', loadCursor }),
    loadCursor,
  );
  // Nothing consumed → cursor unchanged.
  assert.equal(capWatermark({ consumed: null, graceCap, loadCursor }), loadCursor);
});

test('fetchPagesIntoRaw: a crash mid-run keeps earlier pages committed, and the rerun resumes from the committed cursor', async () => {
  const pageOne = { bills: [fixture.bills[0]], pagination: { count: 2, next: 'x' } };
  let callCount = 0;
  const urls = [];
  const fetchImpl = (url) => {
    urls.push(url);
    callCount += 1;
    if (callCount === 1) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(pageOne) });
    return Promise.reject(new Error('network down'));  // the "kill" mid-backfill
  };
  const client = stubClient();

  await assert.rejects(
    () => fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', limit: 1, fetchImpl }),
    /network down/,
  );

  // Page one was committed (BEGIN..COMMIT completed) before the crash.
  const texts = client.calls.map((c) => c.text);
  assert.equal(texts.filter((t) => t === 'COMMIT').length, 1);
  assert.equal(texts.filter((t) => t === 'ROLLBACK').length, 0);

  // Rerun with the cursor that page-one transaction committed: the query
  // restarts at offset 0 with fromDateTime = the committed watermark.
  const resumed = stubFetch([{ bills: [], pagination: { count: 0 } }]);
  await fetchPagesIntoRaw({
    client: stubClient(),
    congress: 119,
    apiKey: 'k',
    fromDateTime: toFromDateTime('2025-04-02T00:00:00.000000Z'),
    fetchImpl: resumed.fetchImpl,
  });
  const resumeUrl = new URL(resumed.urls[0]);
  assert.equal(resumeUrl.searchParams.get('fromDateTime'), '2025-04-02T00:00:00Z');
  assert.equal(resumeUrl.searchParams.get('offset'), '0');
});

test('fetchPagesIntoRaw counts unchanged payloads separately (rerun is a cheap no-op)', async () => {
  const page = { bills: [fixture.bills[0], fixture.bills[1]], pagination: { count: 2 } };
  const { fetchImpl } = stubFetch([page]);
  // rowCount 0 = the WHERE payload IS DISTINCT FROM guard suppressed the write.
  const client = stubClient((text) => (/INSERT INTO raw_payloads/i.test(text) ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 }));

  const result = await fetchPagesIntoRaw({ client, congress: 119, apiKey: 'k', fetchImpl });
  assert.equal(result.upserted, 0);
  assert.equal(result.unchanged, 2);
});

test('toFromDateTime truncates a full-precision cursor to the API format', () => {
  assert.equal(toFromDateTime('2025-04-02T07:15:31.905108Z'), '2025-04-02T07:15:31Z');
  assert.equal(toFromDateTime(null), null);
});

test('rawReadiness gates the load on raw_payloads staleness, not the fetch↔load handshake', async () => {
  const maxFetched = '2026-07-15T10:00:00.123456Z';
  const respond = () => ({ rows: [{ max_fetched_at: maxFetched }], rowCount: 1 });

  // Something fetched past the load cursor → ready. Source-wide, not
  // per-endpoint: since task 0011 the load consumes six endpoints under one
  // cursor, so freshness on ANY of them must trigger the run.
  let client = stubClient(respond);
  let r = await rawReadiness(client, '2026-07-15T09:00:00.000000Z');
  assert.deepEqual(r, { maxFetchedAt: maxFetched, ready: true });
  assert.match(client.calls[0].text, /max\(fetched_at\)/i);
  assert.equal(/endpoint/i.test(client.calls[0].text), false);
  assert.deepEqual(client.calls[0].params, ['congress-bills']);

  // Load already caught up → skip.
  r = await rawReadiness(stubClient(respond), maxFetched);
  assert.equal(r.ready, false);

  // Never loaded → ready.
  r = await rawReadiness(stubClient(respond), null);
  assert.equal(r.ready, true);

  // Nothing fetched yet → skip.
  r = await rawReadiness(stubClient(() => ({ rows: [{ max_fetched_at: null }] })), null);
  assert.equal(r.ready, false);
});

test('loadStaleRawsIntoBills upserts transformed raws and reports the consumed watermark', async () => {
  const staleRows = [
    { natural_key: 'hr1234-119', payload: fixture.bills[0], fetched_at: '2026-07-15T09:30:00.000001Z' },
    { natural_key: 'sres22-119', payload: fixture.bills[1], fetched_at: '2026-07-15T09:30:00.000002Z' },
  ];
  const client = stubClient((text) =>
    /FROM raw_payloads/i.test(text) ? { rows: staleRows, rowCount: 2 } : { rows: [], rowCount: 1 });

  const result = await loadStaleRawsIntoBills({
    client,
    loadCursor: '2026-07-15T09:00:00.000000Z',
    batchSize: 500,
  });

  assert.deepEqual(result, { ingested: 2, failed: 0, maxFetchedAt: '2026-07-15T09:30:00.000002Z' });

  // The stale-raw read is cursor-filtered, ordered, precision-preserving, and
  // bounded — batches of batchSize, never the whole backlog in memory.
  const read = client.calls[0];
  assert.match(read.text, /fetched_at > \$3/i);
  assert.match(read.text, /ORDER BY fetched_at, natural_key/i);
  assert.match(read.text, /LIMIT \$4/i);
  assert.match(read.text, /to_char\(\s*fetched_at AT TIME ZONE 'UTC'/i);
  assert.deepEqual(read.params, ['congress-bills', 'bill-list', '2026-07-15T09:00:00.000000Z', 500]);

  // Bills upsert enriches existing stub rows instead of DO NOTHING-ing them.
  const upsert = client.calls[1];
  assert.match(upsert.text, /INSERT INTO bills/i);
  assert.match(upsert.text, /ON CONFLICT \(bill_id\) DO UPDATE/i);
  assert.equal(upsert.params[0], 'hr1234-119');
});

test('loadStaleRawsIntoBills pages through the backlog in keyset batches', async () => {
  // Three stale rows, batchSize 2: batch one fills (2 rows), so a second read
  // follows keyed on the last row's (fetched_at, natural_key) — tuple keyset,
  // not a bare fetched_at bound, because a whole fetch page shares one now().
  const ts = '2026-07-15T09:30:00.000001Z';
  const batchOne = [
    { natural_key: 'hr1234-119', payload: fixture.bills[0], fetched_at: ts },
    { natural_key: 'sres22-119', payload: fixture.bills[1], fetched_at: ts },
  ];
  const batchTwo = [
    { natural_key: 'sres23-119', payload: { ...fixture.bills[1], number: '23' }, fetched_at: ts },
  ];
  let reads = 0;
  const client = stubClient((text) => {
    if (!/FROM raw_payloads/i.test(text)) return { rows: [], rowCount: 1 };
    reads += 1;
    return reads === 1 ? { rows: batchOne, rowCount: 2 } : { rows: batchTwo, rowCount: 1 };
  });

  const result = await loadStaleRawsIntoBills({ client, loadCursor: null, batchSize: 2 });

  assert.deepEqual(result, { ingested: 3, failed: 0, maxFetchedAt: ts });
  const secondRead = client.calls.filter((c) => /FROM raw_payloads/i.test(c.text))[1];
  assert.match(secondRead.text, /\(fetched_at, natural_key\) > \(\$3, \$4\)/i);
  assert.deepEqual(secondRead.params, ['congress-bills', 'bill-list', ts, 'sres22-119', 2]);
});

test('loadStaleRawsIntoBills counts a transform reject as failed and keeps going', async () => {
  const staleRows = [
    { natural_key: 'amdt1-119', payload: { ...fixture.bills[0], type: 'AMDT' }, fetched_at: '2026-07-15T09:30:00.000001Z' },
    { natural_key: 'sres22-119', payload: fixture.bills[1], fetched_at: '2026-07-15T09:30:00.000002Z' },
  ];
  const client = stubClient((text) =>
    /FROM raw_payloads/i.test(text) ? { rows: staleRows, rowCount: 2 } : { rows: [], rowCount: 1 });

  const result = await loadStaleRawsIntoBills({ client, loadCursor: null, log: () => {} });
  assert.deepEqual(result, { ingested: 1, failed: 1, maxFetchedAt: '2026-07-15T09:30:00.000002Z' });
});

test('loadStaleRawsIntoBills lets a database upsert error propagate — the cursor must not advance past it', async () => {
  // Only transform rejects are the designed skip path. A row whose upsert
  // fails transiently (deadlock, timeout) must fail the run so the unadvanced
  // cursor re-reads it next hour — otherwise the payload-diff guard freezes
  // its fetched_at and the bill is dropped forever.
  const staleRows = [
    { natural_key: 'hr1234-119', payload: fixture.bills[0], fetched_at: '2026-07-15T09:30:00.000001Z' },
  ];
  const client = stubClient((text) => {
    if (/FROM raw_payloads/i.test(text)) return { rows: staleRows, rowCount: 1 };
    throw new Error('deadlock detected');
  });

  await assert.rejects(
    () => loadStaleRawsIntoBills({ client, loadCursor: null, log: () => {} }),
    /deadlock detected/,
  );
});
