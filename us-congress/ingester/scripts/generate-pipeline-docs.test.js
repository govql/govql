import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCrontab, collectTableNames, renderPipelineMd, runCheck, loadInputs } from './generate-pipeline-docs.mjs';
import { nodes as realNodes } from '../pipeline.manifest.js';

// Crontabs and migrations consistent with makeNodes().
function makeInputs(nodes = makeNodes()) {
  return {
    nodes,
    crontabs: {
      'scraper/scrape_cron': 'SHELL=/bin/sh\n35 * * * * root usc-run widgets --force; true\n',
      'ingester/ingest_cron': '# widgets\n50 * * * * . /etc/environment; cd /app && node src/ingest-widgets.js\n',
    },
    migrationsSql: 'CREATE TABLE source_state (\n  x INT\n);\nCREATE TABLE widgets (\n  y INT\n);',
    committedDoc: renderPipelineMd(nodes),
  };
}

// A minimal two-node pipeline mirroring the manifest's shape.
function makeNodes() {
  return [
    {
      id: 'scrape-widgets',
      stage: 'fetch',
      domain: 'widgets',
      upstream: [],
      reads: ['external:widget API'],
      writes: ['file:data/widgets/*.json', 'table:source_state'],
      trigger: {
        cron: { file: 'scraper/scrape_cron', schedule: '35 * * * *', match: 'usc-run widgets' },
        readiness: null,
      },
      watermark: {
        table: 'source_state',
        key: "source_name='widgets', stage='fetch'",
        advances: 'to now() on scrape success',
      },
      idempotency: 'cursor upsert ON CONFLICT (source_name, stage) DO UPDATE',
    },
    {
      id: 'ingest-widgets',
      stage: 'load',
      domain: 'widgets',
      upstream: ['scrape-widgets'],
      reads: ['file:data/widgets/*.json', 'table:source_state'],
      writes: ['table:widgets', 'table:source_state'],
      trigger: {
        cron: { file: 'ingester/ingest_cron', schedule: '50 * * * *', match: 'src/ingest-widgets.js' },
        readiness: 'runs iff fetch.cursor > load.cursor',
      },
      watermark: {
        table: 'source_state',
        key: "source_name='widgets', stage='load'",
        advances: 'to the consumed fetch cursor on success',
      },
      idempotency: 'ON CONFLICT (widget_id) DO UPDATE',
    },
  ];
}

test('parseCrontab extracts schedule and command from a 5-field crontab, skipping comments and blanks', () => {
  const text = [
    '# Load votes every hour at :50.',
    '',
    '50 * * * * . /etc/environment; cd /app && node src/ingest-votes.js > /proc/1/fd/1 2>/proc/1/fd/2',
  ].join('\n');
  const jobs = parseCrontab(text);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].schedule, '50 * * * *');
  assert.ok(jobs[0].command.includes('src/ingest-votes.js'));
});

test('parseCrontab handles system cron.d format (SHELL= line, user field folded into command)', () => {
  const text = [
    'SHELL=/bin/sh',
    '',
    '35 * * * * root . /etc/environment; cd /congress && /usr/local/bin/usc-run votes --force; true',
    '0  2 * * * root /usr/local/bin/update-legislators.sh',
  ].join('\n');
  const jobs = parseCrontab(text);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].schedule, '35 * * * *');
  assert.ok(jobs[0].command.includes('usc-run votes'));
  assert.equal(jobs[1].schedule, '0 2 * * *');
  assert.ok(jobs[1].command.includes('update-legislators.sh'));
});

test('collectTableNames finds every CREATE TABLE across concatenated migration SQL', () => {
  const sql = [
    'CREATE TABLE votes (',
    '  vote_id TEXT PRIMARY KEY,',
    '  updated_at TIMESTAMPTZ NOT NULL',
    ');',
    '',
    "COMMENT ON TABLE votes IS 'Roll-call votes.';",
    '',
    'CREATE TABLE IF NOT EXISTS source_state (',
    '  source_name TEXT NOT NULL',
    ');',
  ].join('\n');
  const tables = collectTableNames(sql);
  assert.deepEqual([...tables].sort(), ['source_state', 'votes']);
});

test('renderPipelineMd emits a generated-file header, a Mermaid DAG with the upstream edges, and one table row per node', () => {
  const md = renderPipelineMd(makeNodes());
  assert.match(md, /AUTO-GENERATED — do not edit/);
  assert.match(md, /npm run generate-pipeline-docs/);
  assert.match(md, /```mermaid\ngraph LR/);
  assert.match(md, /scrape-widgets --> ingest-widgets/);
  assert.match(md, /\| `scrape-widgets` \|/);
  assert.match(md, /\| `ingest-widgets` \|/);
});

test('runCheck passes (no errors) when manifest, crontabs, schema, and committed doc all agree', () => {
  assert.deepEqual(runCheck(makeInputs()), []);
});

test('runCheck fails when a manifest node has no matching crontab line', () => {
  const inputs = makeInputs();
  inputs.crontabs['ingester/ingest_cron'] = '# emptied\n';
  const errors = runCheck(inputs);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ingest-widgets/);
  assert.match(errors[0], /found 0/);
});

test('runCheck fails when a crontab job has no manifest node', () => {
  const inputs = makeInputs();
  inputs.crontabs['ingester/ingest_cron'] += '5 * * * * . /etc/environment; node src/ingest-gadgets.js\n';
  const errors = runCheck(inputs);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /has no manifest node/);
  assert.match(errors[0], /ingest-gadgets/);
});

test('runCheck fails when a node schedule matches a crontab line but the command does not', () => {
  const nodes = makeNodes();
  nodes[1].trigger.cron.match = 'src/ingest-doodads.js';
  const errors = runCheck(makeInputs(nodes));
  // Both directions report: the node finds no line, and the line goes unclaimed.
  assert.equal(errors.length, 2);
  assert.match(errors[0], /ingest-widgets.*found 0/);
  assert.match(errors[1], /has no manifest node/);
});

test('runCheck fails when a referenced table does not exist in the migrations', () => {
  const nodes = makeNodes();
  nodes[1].writes.push('table:gadgets');
  const errors = runCheck(makeInputs(nodes));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /table 'gadgets' not created in db\/migrations\//);
});

test('runCheck fails when the watermark table does not exist in the migrations', () => {
  const nodes = makeNodes();
  nodes[0].watermark.table = 'cursor_state';
  const errors = runCheck(makeInputs(nodes));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /table 'cursor_state'/);
});

test('runCheck fails when the committed PIPELINE.md is stale', () => {
  const inputs = makeInputs();
  inputs.committedDoc = inputs.committedDoc.replace('(fetch)', '(FETCH)');
  const errors = runCheck(inputs);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /PIPELINE\.md is stale/);
});

test('runCheck fails when an upstream edge names an unknown node', () => {
  const nodes = makeNodes();
  nodes[1].upstream.push('scrape-doodads');
  const errors = runCheck(makeInputs(nodes));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /upstream 'scrape-doodads'.*unknown/);
});

test('runCheck fails on duplicate node ids', () => {
  const nodes = makeNodes();
  nodes.push({ ...nodes[0] });
  const inputs = makeInputs(nodes);
  const errors = runCheck(inputs);
  assert.ok(errors.some((e) => /duplicate node id 'scrape-widgets'/.test(e)));
});

test('runCheck ignores file: and external: entries — only table: entries are validated', () => {
  const nodes = makeNodes();
  nodes[0].reads.push('external:something not a table', 'file:not/in/migrations.json');
  const inputs = makeInputs(nodes);
  assert.deepEqual(runCheck(inputs), []);
});

test('the real manifest names the five pipeline nodes', () => {
  assert.deepEqual(
    realNodes.map((n) => n.id),
    ['scrape-votes', 'ingest-votes', 'build-aggregates', 'scrape-legislators', 'ingest-legislators'],
  );
});

test('the real repo is drift-free: manifest ↔ crontabs ↔ migrations ↔ committed PIPELINE.md', () => {
  assert.deepEqual(runCheck(loadInputs()), []);
});
