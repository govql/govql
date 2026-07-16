/**
 * Renders us-congress/PIPELINE.md from ingester/pipeline.manifest.js, and
 * validates (--check) that the manifest, the crontabs, the migration schema,
 * and the committed PIPELINE.md all agree. Sibling of
 * docs/scripts/generate-schema-docs.mjs ("generate docs from the executable
 * source of truth").
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { nodes } from '../pipeline.manifest.js';

// scripts/ lives in us-congress/ingester/; everything is relative to us-congress/.
const US_CONGRESS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = join(US_CONGRESS_DIR, 'db/migrations');
const PIPELINE_MD = join(US_CONGRESS_DIR, 'PIPELINE.md');

/**
 * Parse a crontab into [{ schedule, command }]. Handles both formats in this
 * repo: the 5-field busybox crontab (ingester/ingest_cron) and the system
 * cron.d format with a SHELL= line and a user field (scraper/scrape_cron) —
 * the user field is simply folded into the command, since jobs are matched on
 * schedule + a command substring, never on the whole line.
 */
export function parseCrontab(text) {
  const jobs = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^\w+=/.test(trimmed)) continue; // environment assignment (SHELL=...)
    const fields = trimmed.split(/\s+/);
    if (fields.length < 6) continue;
    jobs.push({
      schedule: fields.slice(0, 5).join(' '),
      command: fields.slice(5).join(' '),
    });
  }
  return jobs;
}

/**
 * The --check validation: returns a list of drift errors (empty = consistent).
 *  - manifest ↔ crontab parity, both directions (every node's trigger.cron
 *    matches exactly one job line; every job line is claimed by exactly one node)
 *  - every `table:`-prefixed reads/writes entry and every watermark table
 *    exists in the migration SQL
 *  - the committed PIPELINE.md matches a fresh render
 */
export function runCheck({ nodes, crontabs, migrationsSql, committedDoc }) {
  const errors = [];

  // Structural: unique ids, upstream edges point at real nodes.
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) errors.push(`duplicate node id '${node.id}'`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const up of node.upstream) {
      if (!ids.has(up)) errors.push(`node '${node.id}': upstream '${up}' is unknown`);
    }
  }

  // Manifest → crontab: each node's cron must match exactly one job line.
  const claimed = new Map(); // crontab file -> Set of claimed job indexes
  for (const file of Object.keys(crontabs)) claimed.set(file, new Set());
  for (const node of nodes) {
    const { file, schedule, match } = node.trigger.cron;
    const jobs = parseCrontab(crontabs[file] ?? '');
    const hits = jobs
      .map((job, i) => ({ job, i }))
      .filter(({ job }) => job.schedule === schedule && job.command.includes(match));
    if (hits.length !== 1) {
      errors.push(
        `node '${node.id}': expected exactly one ${file} line with schedule '${schedule}' ` +
          `and command containing '${match}', found ${hits.length}`,
      );
      continue;
    }
    claimed.get(file)?.add(hits[0].i);
  }

  // Crontab → manifest: every job line must be claimed by a node.
  for (const [file, text] of Object.entries(crontabs)) {
    parseCrontab(text).forEach((job, i) => {
      if (!claimed.get(file).has(i)) {
        errors.push(`crontab job in ${file} has no manifest node: '${job.schedule} ${job.command}'`);
      }
    });
  }

  // Every referenced table must exist in the migrations.
  const tables = collectTableNames(migrationsSql);
  for (const node of nodes) {
    const referenced = [...node.reads, ...node.writes]
      .filter((entry) => entry.startsWith('table:'))
      .map((entry) => entry.slice('table:'.length));
    referenced.push(node.watermark.table);
    for (const table of referenced) {
      if (!tables.has(table)) {
        errors.push(`node '${node.id}' references table '${table}' not created in db/migrations/`);
      }
    }
  }

  // The committed doc must match a fresh render.
  if (committedDoc !== renderPipelineMd(nodes)) {
    errors.push('PIPELINE.md is stale — re-run: npm run generate-pipeline-docs');
  }

  return errors;
}

/** Render PIPELINE.md (generated header + Mermaid DAG + per-node table). */
export function renderPipelineMd(nodes) {
  const lines = [];
  lines.push('<!-- AUTO-GENERATED — do not edit. Source of truth: ingester/pipeline.manifest.js.');
  lines.push('     Re-run: npm run generate-pipeline-docs (in us-congress/ingester). -->');
  lines.push('');
  lines.push('# Ingestion pipeline');
  lines.push('');
  lines.push('The pipeline DAG, generated from `ingester/pipeline.manifest.js`. Each node is one');
  lines.push('cron-triggered stage; edges are `upstream[]` dependencies, enforced at runtime by');
  lines.push('cursor readiness gates rather than by the cron schedule.');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph LR');
  for (const node of nodes) {
    lines.push(`  ${node.id}["${node.id}<br/>(${node.stage})"]`);
  }
  for (const node of nodes) {
    for (const up of node.upstream) {
      lines.push(`  ${up} --> ${node.id}`);
    }
  }
  lines.push('```');
  lines.push('');
  lines.push('## Nodes');
  lines.push('');
  lines.push('| Node | Stage | Domain | Cron | Readiness gate | Reads | Writes | Watermark | Idempotency |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const node of nodes) {
    const cell = (s) => String(s).replaceAll('|', '\\|');
    const list = (xs) => xs.map((x) => `\`${cell(x)}\``).join('<br/>');
    lines.push(
      `| \`${node.id}\` | ${node.stage} | ${node.domain} ` +
        `| \`${node.trigger.cron.schedule}\` (${cell(node.trigger.cron.file)}) ` +
        `| ${cell(node.trigger.readiness ?? '— (producer)')} ` +
        `| ${list(node.reads)} | ${list(node.writes)} ` +
        `| \`${cell(node.watermark.table)}\` (${cell(node.watermark.key)}) — advances ${cell(node.watermark.advances)} ` +
        `| ${cell(node.idempotency)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Collect table names from CREATE TABLE statements in migration SQL. Same
 * source-of-truth approach as docs/scripts/generate-schema-docs.mjs, which
 * parses the concatenated db/migrations/*.sql for its per-table docs.
 */
export function collectTableNames(sql) {
  const tables = new Set();
  for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)) {
    tables.add(m[1]);
  }
  return tables;
}

/** Assemble runCheck's inputs from the real repo files. */
export function loadInputs() {
  const crontabs = {};
  for (const node of nodes) {
    const file = node.trigger.cron.file;
    crontabs[file] ??= readFileSync(join(US_CONGRESS_DIR, file), 'utf8');
  }
  const migrationsSql = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
  const committedDoc = existsSync(PIPELINE_MD) ? readFileSync(PIPELINE_MD, 'utf8') : null;
  return { nodes, crontabs, migrationsSql, committedDoc };
}

function main() {
  const check = process.argv.includes('--check');
  const inputs = loadInputs();
  if (check) {
    const errors = runCheck(inputs);
    if (errors.length > 0) {
      for (const error of errors) console.error(`✖ ${error}`);
      process.exit(1);
    }
    console.log('✔ pipeline manifest, crontabs, migrations, and PIPELINE.md are consistent');
    return;
  }
  writeFileSync(PIPELINE_MD, renderPipelineMd(inputs.nodes));
  console.log(`Wrote ${PIPELINE_MD}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
