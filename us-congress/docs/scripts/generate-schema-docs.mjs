#!/usr/bin/env node
/**
 * Parses the Flyway migration SQL (db/migrations/V*.sql) and generates per-table
 * MDX docs under docs/schema/tables/.
 * Run via:  node scripts/generate-schema-docs.mjs
 * Or via:   npm run generate-schema-docs   (from us-congress/docs/)
 *
 * Files are stamped with a header so editors know not to edit them directly.
 * Re-run whenever the schema changes.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_DIR = join(__dirname, '../../db/migrations');
const OUTPUT_DIR = join(__dirname, '../docs/schema/tables');

// ── Type mapping ─────────────────────────────────────────────────────────────

const PG_TO_GQL = {
  text: 'String',
  boolean: 'Boolean',
  bool: 'Boolean',
  int: 'Int',
  integer: 'Int',
  bigint: 'BigInt',
  bigserial: 'BigInt',
  smallint: 'Int',
  smallserial: 'Int',
  serial: 'Int',
  date: 'Date',
  timestamptz: 'Datetime',
  timestamp: 'Datetime',
  jsonb: 'JSON',
  json: 'JSON',
};

function pgTypeToGql(pgType) {
  const n = pgType.toLowerCase().trim();
  if (PG_TO_GQL[n]) return PG_TO_GQL[n];
  if (/^char\(\d+\)$/.test(n)) return 'String';
  if (n.endsWith('[]')) return '[String]';
  return 'String';
}

// ── Naming conventions (PostGraphile v5) ─────────────────────────────────────

// Explicit map: table name → singular GraphQL type name
const TYPE_NAME = {
  votes: 'Vote',
  vote_positions: 'VotePosition',
  legislators: 'Legislator',
  legislator_terms: 'LegislatorTerm',
  committees: 'Committee',
  bills: 'Bill',
  bill_cosponsors: 'BillCosponsor',
  bill_subjects: 'BillSubject',
  bill_summaries: 'BillSummary',
  bill_committees: 'BillCommittee',
  committee_memberships: 'CommitteeMembership',
  api_keys: 'ApiKey',
  ingestion_runs: 'IngestionRun',
};

// Connection type: plural of type name + Connection
const CONNECTION_NAME = {
  votes: 'VotesConnection',
  vote_positions: 'VotePositionsConnection',
  legislators: 'LegislatorsConnection',
  legislator_terms: 'LegislatorTermsConnection',
  committees: 'CommitteesConnection',
  bills: 'BillsConnection',
  bill_cosponsors: 'BillCosponsorsConnection',
  bill_subjects: 'BillSubjectsConnection',
  bill_summaries: 'BillSummariesConnection',
  bill_committees: 'BillCommitteesConnection',
  committee_memberships: 'CommitteeMembershipsConnection',
};

// allXxx query names
const ALL_QUERY = {
  votes: 'allVotes',
  vote_positions: 'allVotePositions',
  legislators: 'allLegislators',
  legislator_terms: 'allLegislatorTerms',
  committees: 'allCommittees',
  bills: 'allBills',
  bill_cosponsors: 'allBillCosponsors',
  bill_subjects: 'allBillSubjects',
  bill_summaries: 'allBillSummaries',
  bill_committees: 'allBillCommittees',
  committee_memberships: 'allCommitteeMemberships',
};

// Sidebar order and slugs
const TABLE_ORDER = [
  'legislators',
  'legislator_terms',
  'votes',
  'vote_positions',
  'bills',
  'committees',
  'bill_cosponsors',
  'bill_subjects',
  'bill_summaries',
  'bill_committees',
  'committee_memberships',
];

const FILE_SLUG = {
  legislators: 'legislators',
  legislator_terms: 'legislator-terms',
  votes: 'votes',
  vote_positions: 'vote-positions',
  bills: 'bills',
  committees: 'committees',
  bill_cosponsors: 'bill-cosponsors',
  bill_subjects: 'bill-subjects',
  bill_summaries: 'bill-summaries',
  bill_committees: 'bill-committees',
  committee_memberships: 'committee-memberships',
};

// Curated example queries for each table — show the most useful patterns
const EXAMPLE_QUERIES = {
  legislators: `{
  allLegislators(
    filter: { lastName: { equalTo: "Warren" } }
    orderBy: LAST_NAME_ASC
    first: 5
  ) {
    nodes {
      bioguideId
      officialFull
      birthday
      gender
    }
  }
}`,
  legislator_terms: `{
  allLegislatorTerms(
    filter: { state: { equalTo: "TX" }, termType: { equalTo: "sen" } }
    orderBy: START_DATE_DESC
    first: 10
  ) {
    nodes {
      startDate
      endDate
      party
      state
      legislatorByBioguideId {
        officialFull
      }
    }
  }
}`,
  votes: `{
  allVotes(
    filter: {
      category: { equalTo: "nomination" }
      chamber: { equalTo: "s" }
    }
    orderBy: VOTED_AT_DESC
    first: 10
  ) {
    nodes {
      voteId
      votedAt
      question
      result
    }
  }
}`,
  vote_positions: `{
  allVotePositions(
    filter: {
      voteId: { equalTo: "s83-119.2025" }
    }
  ) {
    nodes {
      position
      party
      state
      legislatorByBioguideId {
        officialFull
      }
    }
  }
}`,
  bills: `{
  allBills(
    filter: { congress: { equalTo: 119 }, billType: { equalTo: "hr" } }
    orderBy: INTRODUCED_AT_DESC
    first: 10
  ) {
    nodes {
      billId
      officialTitle
      shortTitle
      status
      introducedAt
    }
  }
}`,
  committees: `{
  allCommittees(
    filter: {
      chamber: { equalTo: "senate" }
      isCurrent: { equalTo: true }
      parentThomasId: { isNull: true }
    }
    orderBy: NAME_ASC
  ) {
    nodes {
      thomasId
      name
      jurisdiction
    }
  }
}`,
  bill_cosponsors: `{
  allBillCosponsors(
    filter: { billId: { equalTo: "hr3590-111" } }
  ) {
    nodes {
      originalCosponsor
      sponsoredAt
      legislatorByBioguideId {
        officialFull
      }
    }
  }
}`,
  bill_committees: `{
  allBillCommittees(
    filter: { billId: { equalTo: "hr3590-111" } }
  ) {
    nodes {
      activities
      committeeByThomasId {
        name
        chamber
      }
    }
  }
}`,
  committee_memberships: `{
  allCommitteeMemberships(
    filter: { thomasId: { equalTo: "SSEG" } }
    orderBy: RANK_ASC
  ) {
    nodes {
      title
      party
      rank
      legislatorByBioguideId {
        officialFull
      }
    }
  }
}`,
};

// ── SQL helpers ───────────────────────────────────────────────────────────────

function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function snakeToPascal(s) {
  const c = snakeToCamel(s);
  return c[0].toUpperCase() + c.slice(1);
}

function lcFirst(s) {
  return s[0].toLowerCase() + s.slice(1);
}

// ── SQL parser ────────────────────────────────────────────────────────────────

function parseColumns(block) {
  const cols = [];

  for (let raw of block.split('\n')) {
    // Strip inline comments and trailing comma
    const line = raw.trim().replace(/\s*--.*$/, '').replace(/,\s*$/, '').trim();
    if (!line) continue;

    // Skip table-level constraints
    if (/^(UNIQUE|CONSTRAINT|PRIMARY\s+KEY|CHECK|FOREIGN\s+KEY)\b/i.test(line)) continue;

    // Match: col_name  TYPE[(n)][]  [rest...]
    const m = line.match(/^([a-z_]\w*)\s+(\w+(?:\(\d+\))?\s*(?:\[\])?)\s*(.*)?$/i);
    if (!m) continue;

    const name = m[1];
    // Guard against accidentally matching SQL keywords
    if (/^(UNIQUE|CONSTRAINT|PRIMARY|FOREIGN|CHECK|INDEX|REFERENCES|NOT|NULL|DEFAULT)$/i.test(name)) continue;

    const pgType = m[2].trim();
    const rest = m[3] || '';

    const isPk = /\bPRIMARY KEY\b/i.test(rest);
    const isUnique = /\bUNIQUE\b/i.test(rest) && !isPk;
    const isNotNull = isPk || /\bNOT NULL\b/i.test(rest);
    const hasDefault = /\bDEFAULT\b/i.test(rest);

    const refM = rest.match(/REFERENCES\s+(\w+)\s*\((\w+)\)/i);
    const references = refM ? { table: refM[1], column: refM[2] } : null;

    const checkM = rest.match(/CHECK\s*\([^)]*IN\s*\(([^)]+)\)\)/i);
    const allowedValues = checkM
      ? checkM[1].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, ''))
      : null;

    cols.push({
      name,
      gqlName: snakeToCamel(name),
      pgType,
      gqlType: pgTypeToGql(pgType),
      required: isNotNull && !hasDefault,
      isPk,
      isUnique,
      references,
      allowedValues,
      comment: null,
    });
  }

  return cols;
}

function parseSchema(sql) {
  const tables = {};

  // CREATE TABLE blocks — terminated by \n); on its own line
  const tableRe = /CREATE TABLE (\w+)\s*\(([\s\S]*?)\n\);/g;
  for (const m of sql.matchAll(tableRe)) {
    tables[m[1]] = {
      name: m[1],
      columns: parseColumns(m[2]),
      comment: null,
      omit: false,
      forwardRefs: [],
      reverseRefs: [],
    };
  }

  // ALTER TABLE … ADD COLUMN — later migrations extend earlier tables (one
  // column per statement; keep migrations written that way for parseability)
  const addColRe = /ALTER TABLE (\w+)\s+ADD COLUMN\s+([^;]+);/gi;
  for (const m of sql.matchAll(addColRe)) {
    const t = tables[m[1]];
    if (!t) continue;
    t.columns.push(...parseColumns(m[2]));
  }

  // COMMENT ON TABLE — both plain 'text' and E'escape\ntext' forms
  const tblCmtRe = /COMMENT ON TABLE (\w+) IS E?'([\s\S]*?)';/g;
  for (const m of sql.matchAll(tblCmtRe)) {
    const t = tables[m[1]];
    if (!t) continue;
    const raw = m[2].replace(/\\n/g, '\n');
    t.omit = raw.includes('@omit');
    t.comment = raw.replace(/@omit\s*/g, '').trim();
  }

  // COMMENT ON COLUMN
  const colCmtRe = /COMMENT ON COLUMN (\w+)\.(\w+) IS E?'([\s\S]*?)';/g;
  for (const m of sql.matchAll(colCmtRe)) {
    const t = tables[m[1]];
    if (!t) continue;
    const raw = m[3].replace(/\\n/g, '\n');
    const nameOverride = raw.match(/@name\s+(\w+)/)?.[1] ?? null;
    const comment = raw.replace(/@\w+[^\n]*\n?/, '').trim();

    const col = t.columns.find((c) => c.name === m[2]);
    if (col) {
      col.comment = comment;
      if (nameOverride) col.gqlName = nameOverride;
    }
  }

  // Build FK relationships — only among documented tables (those with per-type
  // pages, i.e. in TABLE_ORDER). Aggregate tables like member_party_agreement and
  // vote_similarity are documented in the hand-written Aggregation section rather
  // than as first-class pages, so their FKs are not surfaced as relationships on
  // the core entity pages.
  for (const [tName, table] of Object.entries(tables)) {
    if (!TABLE_ORDER.includes(tName)) continue;
    for (const col of table.columns) {
      if (!col.references) continue;
      const { table: refTable } = col.references;
      if (!TABLE_ORDER.includes(refTable)) continue;

      // Forward: on this table's type, field → referenced type
      const refTypeName = TYPE_NAME[refTable] || snakeToPascal(refTable);
      const fwdField = `${lcFirst(refTypeName)}By${snakeToPascal(col.name)}`;
      table.forwardRefs.push({
        field: fwdField,
        returns: refTypeName,
        nullable: !col.required,
        viaField: col.gqlName,
      });

      // Reverse: on referenced table's type, connection → this table
      const revField = `${snakeToCamel(tName)}By${snakeToPascal(col.name)}`;
      tables[refTable].reverseRefs.push({
        field: revField,
        returns: CONNECTION_NAME[tName] || `${TYPE_NAME[tName]}sConnection`,
        viaField: col.gqlName,
        fromTable: tName,
      });
    }
  }

  return tables;
}

// ── Lookup query generation ───────────────────────────────────────────────────

function lookupQueries(table) {
  const typeName = TYPE_NAME[table.name] || snakeToPascal(table.name);
  const queries = [];

  for (const col of table.columns) {
    if (col.isPk) {
      queries.push({
        name: `${lcFirst(typeName)}By${snakeToPascal(col.name)}`,
        args: `${col.gqlName}: ${col.gqlType}!`,
        returns: typeName,
        description: 'Look up by primary key',
      });
    } else if (col.isUnique) {
      queries.push({
        name: `${lcFirst(typeName)}By${snakeToPascal(col.name)}`,
        args: `${col.gqlName}: ${col.gqlType}!`,
        returns: typeName,
        description: `Look up by unique \`${col.gqlName}\``,
      });
    }
  }

  return queries;
}

// ── MDX generation ────────────────────────────────────────────────────────────

function renderBadge(text, variant) {
  // Docusaurus uses badge CSS vars; we use inline styles for portability
  const COLORS = {
    pk: { bg: '#1877f2', fg: '#fff' },
    unique: { bg: '#6c757d', fg: '#fff' },
    required: { bg: '#dc3545', fg: '#fff' },
    optional: { bg: '#e9ecef', fg: '#495057' },
    fk: { bg: '#198754', fg: '#fff' },
  };
  const c = COLORS[variant] || COLORS.optional;
  return `<span style={{background:'${c.bg}',color:'${c.fg}',borderRadius:'3px',padding:'1px 5px',fontSize:'0.7rem',fontWeight:600,whiteSpace:'nowrap'}}>${text}</span>`;
}

function mdEscape(s) {
  return (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function generateTableMdx(table, position) {
  const typeName = TYPE_NAME[table.name] || snakeToPascal(table.name);
  const connName = CONNECTION_NAME[table.name] || `${typeName}sConnection`;
  const allQuery = ALL_QUERY[table.name] || `all${typeName}s`;
  const lookups = lookupQueries(table);
  const example = EXAMPLE_QUERIES[table.name] || '';

  const lines = [];

  lines.push(`---`);
  lines.push(`# AUTO-GENERATED — do not edit. Re-run: npm run generate-schema-docs`);
  lines.push(`sidebar_label: ${typeName}`);
  lines.push(`sidebar_position: ${position}`);
  lines.push(`---`);
  lines.push(``);
  lines.push(`# ${typeName}`);
  lines.push(``);

  if (table.comment) {
    lines.push(`${table.comment}`);
    lines.push(``);
  }

  lines.push(`**GraphQL type:** \`${typeName}\` · **Connection:** \`${connName}\``);
  lines.push(``);

  // ── Queries section ──
  lines.push(`## Queries`);
  lines.push(``);
  lines.push(`| Query | Returns | Description |`);
  lines.push(`|-------|---------|-------------|`);
  lines.push(
    `| \`${allQuery}(filter, orderBy, first, last, before, after)\` | \`${connName}\` | Paginated list with filtering and ordering |`
  );
  for (const q of lookups) {
    lines.push(`| \`${q.name}(${q.args})\` | \`${q.returns}\` | ${q.description} |`);
  }
  lines.push(``);

  // ── Fields section ──
  lines.push(`## Fields`);
  lines.push(``);
  lines.push(`| Field | GraphQL Type | Notes |`);
  lines.push(`|-------|-------------|-------|`);

  for (const col of table.columns) {
    const badges = [];
    if (col.isPk) badges.push(renderBadge('PK', 'pk'));
    if (col.isUnique && !col.isPk) badges.push(renderBadge('unique', 'unique'));
    if (col.required && !col.isPk) badges.push(renderBadge('required', 'required'));
    if (col.references) badges.push(renderBadge('FK', 'fk'));

    const badgeStr = badges.length ? ' ' + badges.join(' ') : '';
    let notes = (col.comment ? mdEscape(col.comment) : '') + badgeStr;
    if (col.allowedValues) {
      const vals = col.allowedValues.map((v) => `\`${v}\``).join(', ');
      notes = (notes ? notes + '. ' : '') + `One of: ${vals}`;
    }

    lines.push(`| \`${col.gqlName}\` | \`${col.gqlType}\` | ${notes} |`);
  }
  lines.push(``);

  // ── Relationships ──
  const hasFwd = table.forwardRefs.length > 0;
  const hasRev = table.reverseRefs.length > 0;

  if (hasFwd || hasRev) {
    lines.push(`## Relationships`);
    lines.push(``);

    if (hasFwd) {
      lines.push(`### Belongs to`);
      lines.push(``);
      lines.push(`| Field | Returns | Via |`);
      lines.push(`|-------|---------|-----|`);
      for (const r of table.forwardRefs) {
        const nullable = r.nullable ? ' *(nullable)*' : '';
        lines.push(`| \`${r.field}\` | \`${r.returns}\`${nullable} | \`${r.viaField}\` |`);
      }
      lines.push(``);
    }

    if (hasRev) {
      lines.push(`### Has many`);
      lines.push(``);
      lines.push(`| Field | Returns | Via |`);
      lines.push(`|-------|---------|-----|`);
      for (const r of table.reverseRefs) {
        lines.push(`| \`${r.field}\` | \`${r.returns}\` | \`${r.viaField}\` |`);
      }
      lines.push(``);
    }
  }

  // ── Example query ──
  if (example) {
    lines.push(`## Example`);
    lines.push(``);
    lines.push('```graphql');
    lines.push(example);
    lines.push('```');
    lines.push(``);
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  // Schema lives across the Flyway migrations (V001__*.sql, V002__*.sql, ...).
  // Concatenate them in filename order so the parser sees the full schema and
  // later migrations' changes (new tables, restated comments) apply on top.
  // Non-DDL migrations (e.g. grant-only files) simply contribute no tables.
  const sql = readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(DB_DIR, f), 'utf8'))
    .join('\n');
  const tables = parseSchema(sql);

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Sidebar category label. The folder is lowercase ('tables') to keep URLs
  // lowercase, but the sidebar should read "Tables" to match sibling labels.
  writeFileSync(
    join(OUTPUT_DIR, '_category_.json'),
    JSON.stringify({ label: 'Tables', position: 2 }, null, 2) + '\n',
    'utf8',
  );

  let written = 0;
  for (let i = 0; i < TABLE_ORDER.length; i++) {
    const tableName = TABLE_ORDER[i];
    const table = tables[tableName];
    if (!table) {
      console.warn(`⚠  Table not found in schema: ${tableName}`);
      continue;
    }
    if (table.omit) {
      console.log(`⏭  Skipping omitted table: ${tableName}`);
      continue;
    }

    const slug = FILE_SLUG[tableName] || tableName.replace(/_/g, '-');
    const outPath = join(OUTPUT_DIR, `${slug}.mdx`);
    const content = generateTableMdx(table, i + 1);
    writeFileSync(outPath, content, 'utf8');
    console.log(`✓  ${outPath}`);
    written++;
  }

  console.log(`\nGenerated ${written} table doc(s) → ${OUTPUT_DIR}`);
}

main();
