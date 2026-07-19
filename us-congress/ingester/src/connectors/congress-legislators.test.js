import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_NAME, findLegislatorFiles, load, parseLegislatorFile, replaceTerms, transform, upsertLegislator } from './congress-legislators.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/legislators-current.yaml', import.meta.url));

function silentLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// Stub pg client: records every query and returns canned rows.
// (Same shape as congress-bills.test.js / cursor-state.test.js.)
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

test('SOURCE_NAME is the source_state key for the legislators handshake', () => {
  assert.equal(SOURCE_NAME, 'congress-legislators');
});

test('transform maps a YAML legislator record to the legislators row and its term rows', () => {
  const [senator] = parseLegislatorFile(FIXTURE);
  const { bioguideId, legislator, terms } = transform(senator);

  assert.equal(bioguideId, 'A000001');
  assert.deepEqual(legislator, {
    bioguideId: 'A000001',
    thomasId: '01234',
    lisId: 'S307',
    govtrackId: 400001,
    opensecretsId: 'N00001234',
    votesmartId: 53270,
    icpsrId: 29389,
    cspanId: 5051,
    firstName: 'Alexandra',
    middleName: 'Jean',
    lastName: 'Adams',
    nameSuffix: null,
    nickname: null,
    officialFull: 'Alexandra J. Adams',
    birthday: '1962-02-20',
    gender: 'F',
  });
  assert.equal(terms.length, 2);
  assert.deepEqual(terms[0], {
    termType: 'sen',
    startDate: '2019-01-03',
    endDate: '2025-01-03',
    state: 'KY',
    party: 'Republican',
    caucus: null,
    district: null,
    senateClass: 2,
    stateRank: 'senior',
    how: 'election',
    url: 'https://www.adams.senate.gov',
    address: '317 Russell Senate Office Building Washington DC 20510',
    phone: '202-224-0001',
    office: null,
  });
});

test('transform coalesces missing optional ids and bio to null, and district for representatives', () => {
  const [, rep] = parseLegislatorFile(FIXTURE);
  const { bioguideId, legislator, terms } = transform(rep);

  assert.equal(bioguideId, 'B000002');
  assert.equal(legislator.thomasId, null);
  assert.equal(legislator.lisId, null);
  assert.equal(legislator.middleName, null);
  assert.equal(legislator.nickname, 'Benny');
  assert.equal(legislator.birthday, null);
  assert.deepEqual(terms[0].district, 12);
  assert.equal(terms[0].senateClass, null);
  assert.equal(terms[0].url, null);
});

test('upsertLegislator issues the legislators upsert keyed on bioguide_id with the params the pre-refactor ingester sent', async () => {
  const client = stubClient();
  const [senator] = parseLegislatorFile(FIXTURE);
  const { legislator } = transform(senator);

  await upsertLegislator(client, legislator);

  assert.equal(client.calls.length, 1);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO legislators/);
  assert.match(text, /ON CONFLICT \(bioguide_id\) DO UPDATE SET/);
  assert.deepEqual(params, [
    'A000001', '01234', 'S307', 400001, 'N00001234', 53270, 29389, 5051,
    'Alexandra', 'Jean', 'Adams', null, null, 'Alexandra J. Adams',
    '1962-02-20', 'F',
  ]);
});

test('replaceTerms deletes existing terms then inserts each term row in order', async () => {
  const client = stubClient();
  const [senator] = parseLegislatorFile(FIXTURE);
  const { bioguideId, terms } = transform(senator);

  await replaceTerms(client, bioguideId, terms);

  assert.equal(client.calls.length, 3);
  assert.equal(client.calls[0].text, 'DELETE FROM legislator_terms WHERE bioguide_id = $1');
  assert.deepEqual(client.calls[0].params, ['A000001']);
  assert.match(client.calls[1].text, /INSERT INTO legislator_terms/);
  assert.deepEqual(client.calls[1].params, [
    'A000001', 'sen', '2019-01-03', '2025-01-03', 'KY',
    'Republican', null, null, 2, 'senior',
    'election', 'https://www.adams.senate.gov',
    '317 Russell Senate Office Building Washington DC 20510', '202-224-0001', null,
  ]);
  assert.deepEqual(client.calls[2].params.slice(0, 5), ['A000001', 'sen', '2025-01-03', '2031-01-03', 'KY']);
});

test('findLegislatorFiles resolves only the YAML files that exist on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legislators-'));
  mkdirSync(join(dir, 'data/legislators'), { recursive: true });
  writeFileSync(join(dir, 'data/legislators/legislators-current.yaml'), '[]');

  assert.deepEqual(findLegislatorFiles(dir), [join(dir, 'data/legislators/legislators-current.yaml')]);
  assert.deepEqual(findLegislatorFiles(mkdtempSync(join(tmpdir(), 'legislators-'))), []);
});

test('load upserts each legislator and its terms in a per-record transaction and tallies results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legislators-'));
  mkdirSync(join(dir, 'data/legislators'), { recursive: true });
  copyFileSync(FIXTURE, join(dir, 'data/legislators/legislators-current.yaml'));

  const client = stubClient();
  const infos = [];
  const result = await load({
    client,
    files: findLegislatorFiles(dir),
    log: { info: (m) => infos.push(m), warn: () => {}, error: () => {} },
  });

  assert.deepEqual(result, { upserted: 2, failed: 0 });
  assert.deepEqual(infos, ['Processing legislators-current.yaml …']);
  const texts = client.calls.map((c) => c.text);
  // Senator: BEGIN, upsert, DELETE terms, 2 term INSERTs, COMMIT — then the rep.
  assert.equal(texts[0], 'BEGIN');
  assert.match(texts[1], /INSERT INTO legislators/);
  assert.equal(texts[2], 'DELETE FROM legislator_terms WHERE bioguide_id = $1');
  assert.match(texts[3], /INSERT INTO legislator_terms/);
  assert.match(texts[4], /INSERT INTO legislator_terms/);
  assert.equal(texts[5], 'COMMIT');
  assert.equal(texts[6], 'BEGIN');
  assert.equal(texts.at(-1), 'COMMIT');
});

test('load counts a record with no bioguide_id as failed without touching the DB, and rolls back a failing record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legislators-'));
  mkdirSync(join(dir, 'data/legislators'), { recursive: true });
  writeFileSync(
    join(dir, 'data/legislators/legislators-current.yaml'),
    [
      '- name: { first: No, last: Id }',
      '- id: { bioguide: C000003 }',
      '  name: { first: Carla, last: Cruz }',
    ].join('\n'),
  );

  const warnings = [];
  const errors = [];
  const client = stubClient((text) => {
    if (/INSERT INTO legislators/.test(text)) throw new Error('boom');
    return { rows: [], rowCount: 1 };
  });

  const result = await load({
    client,
    files: findLegislatorFiles(dir),
    log: { info: () => {}, warn: (m) => warnings.push(m), error: (m) => errors.push(m) },
  });

  assert.deepEqual(result, { upserted: 0, failed: 2 });
  assert.deepEqual(warnings, ['Skipping legislator record with no bioguide_id']);
  assert.deepEqual(errors, ['Failed to upsert legislator C000003: boom']);
  assert.deepEqual(client.calls.map((c) => c.text).filter((t) => t === 'ROLLBACK'), ['ROLLBACK']);
});
