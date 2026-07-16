/**
 * The ingestion pipeline DAG — single source of truth.
 *
 * One node per cron-triggered stage; `upstream` entries are node ids and form
 * the DAG's edge set. `us-congress/PIPELINE.md` is generated from this file
 * (npm run generate-pipeline-docs), and `--check` validates it against the
 * crontabs and the migration schema — see scripts/generate-pipeline-docs.mjs.
 *
 * Field conventions:
 *  - reads/writes entries are prefixed: `table:` (validated against
 *    db/migrations/), `file:` (paths on the shared /congress volume), or
 *    `external:` (network sources).
 *  - trigger.cron names the crontab file (repo-relative, under us-congress/),
 *    the exact 5-field schedule, and a stable substring of the job's command;
 *    --check requires exactly one matching job line, and every job line to be
 *    claimed by exactly one node.
 *  - trigger.readiness is the runtime gate (cron is only a soft schedule);
 *    null means the node is a producer with no gate.
 *  - watermark says where the node's cursor lives and when it advances.
 */
export const nodes = [
  {
    id: 'scrape-votes',
    stage: 'fetch',
    domain: 'votes',
    upstream: [],
    reads: ['external:House/Senate roll-call vote feeds (unitedstates/congress usc-run)'],
    writes: ['file:data/{congress}/votes/{session}/{chamber}{number}/data.json', 'table:source_state'],
    trigger: {
      cron: { file: 'scraper/scrape_cron', schedule: '35 * * * *', match: 'usc-run votes' },
      readiness: null,
    },
    watermark: {
      table: 'source_state',
      key: "source_name='congress-votes', stage='fetch'",
      advances: 'to now() via write-fetch-cursor.sh, &&-gated on scrape success',
    },
    idempotency:
      'scrape output is a file tree keyed by vote id; cursor write is INSERT … ON CONFLICT (source_name, stage) DO UPDATE',
  },
  {
    id: 'ingest-votes',
    stage: 'load',
    domain: 'votes',
    upstream: ['scrape-votes', 'ingest-legislators'],
    reads: [
      'file:data/{congress}/votes/{session}/{chamber}{number}/data.json',
      'table:legislators',
      'table:votes',
      'table:source_state',
    ],
    writes: ['table:votes', 'table:vote_positions', 'table:bills', 'table:ingestion_runs', 'table:source_state'],
    trigger: {
      cron: { file: 'ingester/ingest_cron', schedule: '50 * * * *', match: 'src/ingest-votes.js' },
      readiness: "runs iff source_state fetch.cursor > load.cursor for 'congress-votes' (loadReadiness)",
    },
    watermark: {
      table: 'source_state',
      key: "source_name='congress-votes', stage='load'",
      advances: 'to the fetch cursor captured at run start, atomically with the ingestion_runs success row',
    },
    idempotency:
      'votes ON CONFLICT (vote_id) DO UPDATE; bills ON CONFLICT DO NOTHING; positions DELETE+re-INSERT per vote; per-file skip when source_updated_at is current',
  },
  {
    id: 'build-aggregates',
    stage: 'build',
    domain: 'votes',
    upstream: ['ingest-votes'],
    reads: ['table:votes', 'table:vote_positions', 'table:vote_similarity_state'],
    writes: [
      'table:vote_similarity',
      'table:member_party_agreement',
      'table:vote_similarity_state',
      'table:ingestion_runs',
    ],
    trigger: {
      cron: { file: 'ingester/ingest_cron', schedule: '55 * * * *', match: 'src/build-aggregates.js' },
      readiness: 'staleness self-gate: rebuilds each congress where max(votes.updated_at) > built_through',
    },
    watermark: {
      table: 'vote_similarity_state',
      key: 'congress',
      advances: 'to max(votes.updated_at), in SQL inside the REPEATABLE READ rebuild transaction',
    },
    idempotency: 'per-congress DELETE + rebuild of both aggregate tables and the watermark, in one transaction',
  },
  {
    id: 'scrape-legislators',
    stage: 'fetch',
    domain: 'legislators',
    upstream: [],
    reads: ['external:unitedstates/congress-legislators git repo'],
    writes: ['file:data/legislators/*.yaml', 'table:source_state'],
    trigger: {
      cron: { file: 'scraper/scrape_cron', schedule: '0 2 * * *', match: 'update-legislators.sh' },
      readiness: null,
    },
    watermark: {
      table: 'source_state',
      key: "source_name='congress-legislators', stage='fetch'",
      advances: 'to now() via write-fetch-cursor.sh, after a successful sync (set -e)',
    },
    idempotency:
      'sync is a git clone/pull --ff-only; cursor write is INSERT … ON CONFLICT (source_name, stage) DO UPDATE',
  },
  {
    id: 'ingest-legislators',
    stage: 'load',
    domain: 'legislators',
    upstream: ['scrape-legislators'],
    reads: [
      'file:data/legislators/legislators-current.yaml',
      'file:data/legislators/legislators-historical.yaml',
      'table:source_state',
    ],
    writes: ['table:legislators', 'table:legislator_terms', 'table:ingestion_runs', 'table:source_state'],
    trigger: {
      cron: { file: 'ingester/ingest_cron', schedule: '15 2 * * *', match: 'src/ingest-legislators.js' },
      readiness: "runs iff source_state fetch.cursor > load.cursor for 'congress-legislators' (loadReadiness)",
    },
    watermark: {
      table: 'source_state',
      key: "source_name='congress-legislators', stage='load'",
      advances: 'to the fetch cursor captured at run start, atomically with the ingestion_runs success row',
    },
    idempotency: 'legislators ON CONFLICT (bioguide_id) DO UPDATE; terms DELETE+re-INSERT per legislator',
  },
];
