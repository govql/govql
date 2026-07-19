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
 *  - module (load-stage nodes only) names the connector module implementing
 *    the documented contract (CONNECTORS.md); src/connectors/conformance.test.js
 *    asserts each named module exports that shape, so manifest↔module drift
 *    fails the suite.
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
    module: 'src/connectors/congress-votes.js',
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
      readiness:
        "runs iff source_state fetch.cursor is set and (fetch.cursor > load.cursor or load.cursor is unset), for 'congress-votes' (loadReadiness)",
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
    id: 'fetch-bills',
    stage: 'fetch',
    domain: 'bills',
    upstream: [],
    reads: [
      'external:Congress.gov API v3 bill-list endpoint (api.congress.gov)',
      'external:Congress.gov API v3 per-bill endpoints — detail, cosponsors, subjects, summaries, titles (fan-out per changed bill)',
    ],
    writes: ['table:raw_payloads', 'table:source_state', 'table:ingestion_runs'],
    trigger: {
      cron: { file: 'ingester/ingest_cron', schedule: '5 * * * *', match: 'src/fetch-bills.js' },
      readiness:
        'loud clean skip when CONGRESS_GOV_API_KEY is unset or another fetch run holds the pg advisory lock; otherwise a catch-up pass from the fetch cursor (NULL = backfill), then verification re-walks from the fetch_verified cursor until a pass writes nothing new (offset-pagination skip-proofing, crash-safe); a per-run request budget (CONGRESS_GOV_HOURLY_REQUEST_BUDGET, default 4000) bails the run out cleanly under the api.data.gov hourly rate limit — the next tick resumes',
    },
    watermark: {
      table: 'source_state',
      key: "source_name='congress-bills-<congress>', stages 'fetch' (resume) + 'fetch_verified' (verified-through), per target congress",
      advances:
        "'fetch' to the max consumed updateDate per committed chunk — each chunk commits its bills' list rows AND their five per-bill endpoint payloads atomically, so a resumed run re-fetches no completed bill; 'fetch_verified' only after a clean verification pass",
    },
    idempotency:
      'raw_payloads ON CONFLICT (source_name, natural_key, endpoint) DO UPDATE, guarded by payload IS DISTINCT FROM so unchanged bills do not touch fetched_at — and, unchanged, do not fan out',
  },
  {
    id: 'ingest-bills',
    stage: 'load',
    module: 'src/connectors/congress-bills.js',
    domain: 'bills',
    upstream: ['fetch-bills'],
    reads: ['table:raw_payloads', 'table:source_state', 'table:legislators'],
    writes: [
      'table:bills',
      'table:bill_cosponsors',
      'table:bill_subjects',
      'table:bill_summaries',
      'table:ingestion_runs',
      'table:source_state',
    ],
    trigger: {
      cron: { file: 'ingester/ingest_cron', schedule: '20 * * * *', match: 'src/ingest-bills.js' },
      readiness:
        "skip if another load run holds the pg advisory lock; otherwise staleness gate on the owned raw_payloads table: runs iff max(fetched_at) > load.cursor (or load.cursor unset), source-wide across all six 'congress-bills' endpoints (rawReadiness)",
    },
    watermark: {
      table: 'source_state',
      key: "source_name='congress-bills', stage='load' (one cursor spans all six endpoints; each loader consumes its endpoint's whole backlog past it)",
      advances:
        'to the max consumed raw_payloads.fetched_at — grace-capped a few minutes before the run so in-flight fetch transactions can land — atomically with the ingestion_runs success row',
    },
    idempotency:
      'bills ON CONFLICT (bill_id) DO UPDATE (enriches vote-stub rows; identity columns never change); detail/titles enrichment COALESCEs per column (never NULLs a populated value); cosponsors/subjects/summaries are replaced per bill (DELETE + re-INSERT in one transaction), with unknown bioguide ids dropped FK-safely via the legislators JOIN',
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
    module: 'src/connectors/congress-legislators.js',
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
      readiness:
        "runs iff source_state fetch.cursor is set and (fetch.cursor > load.cursor or load.cursor is unset), for 'congress-legislators' (loadReadiness)",
    },
    watermark: {
      table: 'source_state',
      key: "source_name='congress-legislators', stage='load'",
      advances: 'to the fetch cursor captured at run start, atomically with the ingestion_runs success row',
    },
    idempotency: 'legislators ON CONFLICT (bioguide_id) DO UPDATE; terms DELETE+re-INSERT per legislator',
  },
];
