<!-- AUTO-GENERATED — do not edit. Source of truth: ingester/pipeline.manifest.js.
     Re-run: npm run generate-pipeline-docs (in us-congress/ingester). -->

# Ingestion pipeline

The pipeline DAG, generated from `ingester/pipeline.manifest.js`. Each node is one
cron-triggered stage; edges are `upstream[]` dependencies, enforced at runtime by
cursor readiness gates rather than by the cron schedule.

```mermaid
graph LR
  scrape-votes["scrape-votes<br/>(fetch)"]
  ingest-votes["ingest-votes<br/>(load)"]
  build-aggregates["build-aggregates<br/>(build)"]
  fetch-bills["fetch-bills<br/>(fetch)"]
  ingest-bills["ingest-bills<br/>(load)"]
  scrape-legislators["scrape-legislators<br/>(fetch)"]
  ingest-legislators["ingest-legislators<br/>(load)"]
  scrape-votes --> ingest-votes
  ingest-legislators --> ingest-votes
  ingest-votes --> build-aggregates
  fetch-bills --> ingest-bills
  scrape-legislators --> ingest-legislators
```

## Nodes

| Node | Stage | Domain | Cron | Readiness gate | Reads | Writes | Watermark | Idempotency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `scrape-votes` | fetch | votes | `35 * * * *` (scraper/scrape_cron) | — (producer) | `external:House/Senate roll-call vote feeds (unitedstates/congress usc-run)` | `file:data/{congress}/votes/{session}/{chamber}{number}/data.json`<br/>`table:source_state` | `source_state` (source_name='congress-votes', stage='fetch') — advances to now() via write-fetch-cursor.sh, &&-gated on scrape success | scrape output is a file tree keyed by vote id; cursor write is INSERT … ON CONFLICT (source_name, stage) DO UPDATE |
| `ingest-votes` | load | votes | `50 * * * *` (ingester/ingest_cron) | runs iff source_state fetch.cursor is set and (fetch.cursor > load.cursor or load.cursor is unset), for 'congress-votes' (loadReadiness) | `file:data/{congress}/votes/{session}/{chamber}{number}/data.json`<br/>`table:legislators`<br/>`table:votes`<br/>`table:source_state` | `table:votes`<br/>`table:vote_positions`<br/>`table:bills`<br/>`table:ingestion_runs`<br/>`table:source_state` | `source_state` (source_name='congress-votes', stage='load') — advances to the fetch cursor captured at run start, atomically with the ingestion_runs success row | votes ON CONFLICT (vote_id) DO UPDATE; bills ON CONFLICT DO NOTHING; positions DELETE+re-INSERT per vote; per-file skip when source_updated_at is current |
| `build-aggregates` | build | votes | `55 * * * *` (ingester/ingest_cron) | staleness self-gate: rebuilds each congress where max(votes.updated_at) > built_through | `table:votes`<br/>`table:vote_positions`<br/>`table:vote_similarity_state` | `table:vote_similarity`<br/>`table:member_party_agreement`<br/>`table:vote_similarity_state`<br/>`table:ingestion_runs` | `vote_similarity_state` (congress) — advances to max(votes.updated_at), in SQL inside the REPEATABLE READ rebuild transaction | per-congress DELETE + rebuild of both aggregate tables and the watermark, in one transaction |
| `fetch-bills` | fetch | bills | `5 * * * *` (ingester/ingest_cron) | loud clean skip when CONGRESS_GOV_API_KEY is unset; otherwise pages fromDateTime = fetch cursor (NULL cursor = backfill) | `external:Congress.gov API v3 bill-list endpoint (api.congress.gov)` | `table:raw_payloads`<br/>`table:source_state`<br/>`table:ingestion_runs` | `source_state` (source_name='congress-bills', stage='fetch') — advances to the max consumed updateDate, in the same transaction as each committed page of raw_payloads (crash resumes from the last committed page) | raw_payloads ON CONFLICT (source_name, natural_key, endpoint) DO UPDATE, guarded by payload IS DISTINCT FROM so unchanged bills do not touch fetched_at |
| `ingest-bills` | load | bills | `20 * * * *` (ingester/ingest_cron) | staleness gate on the owned raw_payloads table: runs iff max(fetched_at) > load.cursor (or load.cursor unset), for 'congress-bills' (rawReadiness) | `table:raw_payloads`<br/>`table:source_state` | `table:bills`<br/>`table:ingestion_runs`<br/>`table:source_state` | `source_state` (source_name='congress-bills', stage='load') — advances to the max consumed raw_payloads.fetched_at, atomically with the ingestion_runs success row | bills ON CONFLICT (bill_id) DO UPDATE (enriches vote-stub rows; identity columns never change) |
| `scrape-legislators` | fetch | legislators | `0 2 * * *` (scraper/scrape_cron) | — (producer) | `external:unitedstates/congress-legislators git repo` | `file:data/legislators/*.yaml`<br/>`table:source_state` | `source_state` (source_name='congress-legislators', stage='fetch') — advances to now() via write-fetch-cursor.sh, after a successful sync (set -e) | sync is a git clone/pull --ff-only; cursor write is INSERT … ON CONFLICT (source_name, stage) DO UPDATE |
| `ingest-legislators` | load | legislators | `15 2 * * *` (ingester/ingest_cron) | runs iff source_state fetch.cursor is set and (fetch.cursor > load.cursor or load.cursor is unset), for 'congress-legislators' (loadReadiness) | `file:data/legislators/legislators-current.yaml`<br/>`file:data/legislators/legislators-historical.yaml`<br/>`table:source_state` | `table:legislators`<br/>`table:legislator_terms`<br/>`table:ingestion_runs`<br/>`table:source_state` | `source_state` (source_name='congress-legislators', stage='load') — advances to the fetch cursor captured at run start, atomically with the ingestion_runs success row | legislators ON CONFLICT (bioguide_id) DO UPDATE; terms DELETE+re-INSERT per legislator |
