import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SOURCE_NAME, load, loadVoteFile, needsIngestion, walkVoteFiles, replacePositions, transform, upsertBillStub, upsertVote } from './congress-votes.js';

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

function loadFixture(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8'));
}

test('SOURCE_NAME is the source_state key for the votes handshake', () => {
  assert.equal(SOURCE_NAME, 'congress-votes');
});

test('transform maps a house vote file to the vote row, bill stub, and flattened positions', () => {
  const { vote, billStub, positions } = transform(loadFixture('vote-house.json'));

  assert.deepEqual(vote, {
    voteId: 'h5-119.2025',
    chamber: 'h',
    congress: 119,
    session: '2025',
    number: 5,
    votedAt: '2025-01-03T13:00:00-05:00',
    question: 'On Passage of the Bill',
    voteType: 'On Passage of the Bill',
    category: 'passage',
    result: 'Passed',
    resultText: 'Passed 220-215',
    requires: '1/2',
    relatedBillId: 'hr1-119',
    sourceUrl: 'https://clerk.house.gov/Votes/20255',
    sourceUpdatedAt: '2025-01-03T18:22:01-05:00',
  });

  assert.deepEqual(billStub, {
    billId: 'hr1-119',
    billType: 'hr',
    billNumber: 1,
    congress: 119,
    officialTitle: 'An Act to authorize appropriations',
  });

  assert.deepEqual(positions, [
    { memberId: 'H001001', position: 'Aye', party: 'R', state: 'TX' },
    { memberId: 'H001002', position: 'Aye', party: 'R', state: 'FL' },
    { memberId: 'H001003', position: 'No', party: 'D', state: 'CA' },
    { memberId: 'H001004', position: 'Not Voting', party: 'D', state: 'NY' },
  ]);
});

test('transform handles a senate vote: numeric session stringified, no bill → null stub, missing fields → null', () => {
  const { vote, billStub, positions } = transform(loadFixture('vote-senate.json'));

  assert.equal(vote.session, '2025');
  assert.equal(vote.resultText, null);
  assert.equal(vote.relatedBillId, null);
  assert.equal(billStub, null);
  // The VP row keeps its 'VP' member id here; the load-side JOIN drops
  // unknown ids, not the transform.
  assert.deepEqual(positions.map((p) => p.memberId), ['S901', 'S902', 'S903', 'VP']);
  assert.deepEqual(positions[3], { memberId: 'VP', position: 'Not Voting', party: null, state: null });
});

test('transform normalises an unknown category to unknown and drops members without an id', () => {
  const { vote, positions } = transform({
    vote_id: 'h9-119.2025',
    chamber: 'h',
    congress: 119,
    session: '2025',
    number: 9,
    category: 'motion-to-table',
    votes: { Aye: [{ party: 'R', state: 'TX' }, { id: 'H001001', party: 'R', state: 'TX' }] },
  });

  assert.equal(vote.category, 'unknown');
  assert.deepEqual(positions, [{ memberId: 'H001001', position: 'Aye', party: 'R', state: 'TX' }]);
});

test('upsertVote issues the votes upsert keyed on vote_id with the params the pre-refactor ingester sent', async () => {
  const client = stubClient();
  const { vote } = transform(loadFixture('vote-house.json'));

  await upsertVote(client, vote);

  assert.equal(client.calls.length, 1);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO votes/);
  assert.match(text, /ON CONFLICT \(vote_id\) DO UPDATE SET/);
  assert.match(text, /source_updated_at = EXCLUDED\.source_updated_at/);
  assert.deepEqual(params, [
    'h5-119.2025', 'h', 119, '2025', 5,
    '2025-01-03T13:00:00-05:00',
    'On Passage of the Bill', 'On Passage of the Bill', 'passage',
    'Passed', 'Passed 220-215', '1/2',
    'hr1-119', 'https://clerk.house.gov/Votes/20255', '2025-01-03T18:22:01-05:00',
  ]);
});

test('upsertBillStub inserts a minimal bills row with DO NOTHING, and no-ops on a null stub', async () => {
  const client = stubClient();
  const { billStub } = transform(loadFixture('vote-house.json'));

  await upsertBillStub(client, billStub);
  await upsertBillStub(client, null);

  assert.equal(client.calls.length, 1);
  const { text, params } = client.calls[0];
  assert.match(text, /INSERT INTO bills/);
  assert.match(text, /ON CONFLICT \(bill_id\) DO NOTHING/);
  assert.deepEqual(params, ['hr1-119', 'hr', 1, 119, 'An Act to authorize appropriations']);
});

test('replacePositions deletes then re-inserts positions via the bioguide JOIN for house votes', async () => {
  const client = stubClient((text) => (/INSERT INTO vote_positions/.test(text) ? { rows: [], rowCount: 4 } : { rows: [], rowCount: 1 }));
  const warnings = [];
  const { vote, positions } = transform(loadFixture('vote-house.json'));

  await replacePositions(client, vote.voteId, vote.chamber, positions, { log: { warn: (m) => warnings.push(m) } });

  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].text, 'DELETE FROM vote_positions WHERE vote_id = $1');
  assert.deepEqual(client.calls[0].params, ['h5-119.2025']);
  assert.match(client.calls[1].text, /JOIN legislators l ON l\.bioguide_id = v\.member_id/);
  assert.deepEqual(client.calls[1].params, [
    'h5-119.2025',
    ['H001001', 'H001002', 'H001003', 'H001004'],
    ['Aye', 'Aye', 'No', 'Not Voting'],
    ['R', 'R', 'D', 'D'],
    ['TX', 'FL', 'CA', 'NY'],
  ]);
  assert.deepEqual(warnings, []);
});

test('replacePositions joins on lis_id for senate votes and warns with the unknown ids the JOIN dropped', async () => {
  const client = stubClient((text) => {
    if (/INSERT INTO vote_positions/.test(text)) return { rows: [], rowCount: 3 };
    if (/NOT EXISTS/.test(text)) return { rows: [{ member_id: 'VP' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const warnings = [];
  const { vote, positions } = transform(loadFixture('vote-senate.json'));

  await replacePositions(client, vote.voteId, vote.chamber, positions, { log: { warn: (m) => warnings.push(m) } });

  assert.match(client.calls[1].text, /JOIN legislators l ON l\.lis_id = v\.member_id/);
  assert.match(client.calls[2].text, /WHERE NOT EXISTS \(SELECT 1 FROM legislators l WHERE l\.lis_id = v\.member_id\)/);
  assert.deepEqual(client.calls[2].params, [['S901', 'S902', 'S903', 'VP']]);
  assert.deepEqual(warnings, ['s17-119.2025: 1 position(s) skipped — unknown lis_id: VP']);
});

test('replacePositions issues no queries when the vote has no positions with member ids', async () => {
  const client = stubClient();
  await replacePositions(client, 'h9-119.2025', 'h', [], { log: { warn: () => { throw new Error('no warn expected'); } } });
  assert.equal(client.calls.length, 0);
});

test('needsIngestion: force bypasses the DB, absent/stale rows reingest, current rows skip', async () => {
  const forced = stubClient(() => { throw new Error('no query expected under force'); });
  assert.equal(await needsIngestion(forced, 'h5-119.2025', '2025-01-03T18:22:01-05:00', { force: true }), true);

  const absent = stubClient(() => ({ rows: [], rowCount: 0 }));
  assert.equal(await needsIngestion(absent, 'h5-119.2025', '2025-01-03T18:22:01-05:00', { force: false }), true);
  assert.deepEqual(absent.calls[0].params, ['h5-119.2025']);
  assert.match(absent.calls[0].text, /SELECT source_updated_at FROM votes WHERE vote_id = \$1/);

  const noTimestamp = stubClient(() => ({ rows: [{ source_updated_at: null }], rowCount: 1 }));
  assert.equal(await needsIngestion(noTimestamp, 'h5-119.2025', '2025-01-03T18:22:01-05:00', { force: false }), true);

  const noFileTimestamp = stubClient(() => ({ rows: [{ source_updated_at: '2025-01-03T18:22:01-05:00' }], rowCount: 1 }));
  assert.equal(await needsIngestion(noFileTimestamp, 'h5-119.2025', undefined, { force: false }), false);

  const stale = stubClient(() => ({ rows: [{ source_updated_at: '2025-01-01T00:00:00-05:00' }], rowCount: 1 }));
  assert.equal(await needsIngestion(stale, 'h5-119.2025', '2025-01-03T18:22:01-05:00', { force: false }), true);

  const current = stubClient(() => ({ rows: [{ source_updated_at: '2025-01-03T18:22:01-05:00' }], rowCount: 1 }));
  assert.equal(await needsIngestion(current, 'h5-119.2025', '2025-01-03T18:22:01-05:00', { force: false }), false);
});

test('loadVoteFile wraps stub+vote+positions in one transaction and reports ingested', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'votes-'));
  const file = join(dir, 'data.json');
  writeFileSync(file, JSON.stringify(loadFixture('vote-house.json')));

  const client = stubClient((text) => {
    if (/SELECT source_updated_at/.test(text)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO vote_positions/.test(text)) return { rows: [], rowCount: 4 };
    return { rows: [], rowCount: 1 };
  });

  const result = await loadVoteFile(client, file, { force: false, log: silentLog() });

  assert.equal(result, 'ingested');
  const texts = client.calls.map((c) => c.text);
  assert.equal(texts[0].includes('SELECT source_updated_at'), true);
  assert.equal(texts[1], 'BEGIN');
  assert.match(texts[2], /INSERT INTO bills/);
  assert.match(texts[3], /INSERT INTO votes/);
  assert.match(texts[4], /DELETE FROM vote_positions/);
  assert.match(texts[5], /INSERT INTO vote_positions/);
  assert.equal(texts[6], 'COMMIT');
});

test('loadVoteFile skips a vote whose DB row is already current', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'votes-'));
  const file = join(dir, 'data.json');
  writeFileSync(file, JSON.stringify(loadFixture('vote-house.json')));

  const client = stubClient(() => ({ rows: [{ source_updated_at: '2025-01-03T18:22:01-05:00' }], rowCount: 1 }));
  const result = await loadVoteFile(client, file, { force: false, log: silentLog() });

  assert.equal(result, 'skipped');
  assert.equal(client.calls.length, 1);
});

test('loadVoteFile reports failed on unparseable JSON and on a missing vote_id, without touching the DB', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'votes-'));
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{nope');
  const noVoteId = join(dir, 'novote.json');
  writeFileSync(noVoteId, JSON.stringify({ chamber: 'h' }));

  const errors = [];
  const warnings = [];
  const log = { info: () => {}, warn: (m) => warnings.push(m), error: (m) => errors.push(m) };
  const client = stubClient(() => { throw new Error('no query expected'); });

  assert.equal(await loadVoteFile(client, badJson, { force: false, log }), 'failed');
  assert.equal(await loadVoteFile(client, noVoteId, { force: false, log }), 'failed');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Failed to parse/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /No vote_id/);
});

test('loadVoteFile rolls back the transaction and reports failed when a write throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'votes-'));
  const file = join(dir, 'data.json');
  writeFileSync(file, JSON.stringify(loadFixture('vote-house.json')));

  const errors = [];
  const client = stubClient((text) => {
    if (/SELECT source_updated_at/.test(text)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO votes/.test(text)) { const err = new Error('boom'); err.constraint = 'votes_category_check'; throw err; }
    return { rows: [], rowCount: 1 };
  });

  const result = await loadVoteFile(client, file, { force: false, log: { warn: () => {}, error: (m) => errors.push(m) } });

  assert.equal(result, 'failed');
  assert.equal(client.calls.at(-1).text, 'ROLLBACK');
  assert.match(errors[0], /Failed to ingest vote h5-119\.2025: boom \| constraint: votes_category_check/);
});

test('walkVoteFiles yields every data.json under numeric congress dirs and warns when data/ is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'votes-'));
  mkdirSync(join(dir, 'data/119/votes/2025/h5'), { recursive: true });
  mkdirSync(join(dir, 'data/119/votes/2025/s17'), { recursive: true });
  mkdirSync(join(dir, 'data/119/votes/2025/empty'), { recursive: true });
  mkdirSync(join(dir, 'data/legislators'), { recursive: true });
  mkdirSync(join(dir, 'data/119/bills'), { recursive: true });
  writeFileSync(join(dir, 'data/119/votes/2025/h5/data.json'), '{}');
  writeFileSync(join(dir, 'data/119/votes/2025/s17/data.json'), '{}');
  writeFileSync(join(dir, 'data/119/votes/2025/notes.txt'), 'not a vote dir');

  const found = [];
  for await (const f of walkVoteFiles(dir, { log: silentLog() })) found.push(f);
  assert.deepEqual(found.sort(), [
    join(dir, 'data/119/votes/2025/h5/data.json'),
    join(dir, 'data/119/votes/2025/s17/data.json'),
  ]);

  const warnings = [];
  const missing = mkdtempSync(join(tmpdir(), 'votes-'));
  for await (const _ of walkVoteFiles(missing, { log: { warn: (m) => warnings.push(m) } })) void _;
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Data directory not found/);
});

test('load walks the tree and tallies ingested / skipped / failed per file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'votes-'));
  mkdirSync(join(dir, 'data/119/votes/2025/h5'), { recursive: true });
  mkdirSync(join(dir, 'data/119/votes/2025/s17'), { recursive: true });
  mkdirSync(join(dir, 'data/119/votes/2025/h6'), { recursive: true });
  writeFileSync(join(dir, 'data/119/votes/2025/h5/data.json'), JSON.stringify(loadFixture('vote-house.json')));
  writeFileSync(join(dir, 'data/119/votes/2025/s17/data.json'), JSON.stringify(loadFixture('vote-senate.json')));
  writeFileSync(join(dir, 'data/119/votes/2025/h6/data.json'), '{nope');

  // h5 is absent from the DB (ingested); s17 is already current (skipped).
  const client = stubClient((text, params) => {
    if (/SELECT source_updated_at/.test(text)) {
      return params[0] === 's17-119.2025'
        ? { rows: [{ source_updated_at: '2025-01-23T20:05:00-05:00' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/INSERT INTO vote_positions/.test(text)) return { rows: [], rowCount: 4 };
    return { rows: [], rowCount: 1 };
  });

  const result = await load({ client, dataDir: dir, force: false, log: silentLog() });

  assert.deepEqual(result, { ingested: 1, skipped: 1, failed: 1 });
});

test('loadVoteFile counts a file whose transform throws as failed instead of crashing the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'votes-'));
  const file = join(dir, 'data.json');
  // votes maps a position to null: Object.entries yields a non-iterable
  // member list and the flattening throws mid-transform.
  writeFileSync(file, JSON.stringify({
    vote_id: 'h7-119.2025', chamber: 'h', congress: 119, session: '2025', number: 7,
    votes: { Aye: null },
  }));

  const errors = [];
  const client = stubClient((text) => {
    if (/SELECT source_updated_at/.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });

  const result = await loadVoteFile(client, file, { force: false, log: { warn: () => {}, error: (m) => errors.push(m) } });

  assert.equal(result, 'failed');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Failed to ingest vote h7-119\.2025/);
  // The throw happened after BEGIN, so the transaction was rolled back.
  assert.equal(client.calls.at(-1).text, 'ROLLBACK');
});
