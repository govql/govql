# Source-connector contract

Every ingestion source follows the same staged shape — **discover → fetch(→raw) →
transform → load**, watermarked by staged cursors — so each new source is a copy of a
known pattern, not a new design. The Congress.gov bills connector
([`src/connectors/congress-bills.js`](src/connectors/congress-bills.js)) is the
API-source reference; the votes and legislators connectors
([`src/connectors/congress-votes.js`](src/connectors/congress-votes.js),
[`src/connectors/congress-legislators.js`](src/connectors/congress-legislators.js))
are the file-source references.

## The module shape

A connector is one module under `src/connectors/<source>.js`. Three exports are
**required by name** — the conformance test
([`src/connectors/conformance.test.js`](src/connectors/conformance.test.js)) asserts
them for every load-stage node in `pipeline.manifest.js` (each such node names its
connector in a `module` field), so a module that drifts from this shape fails
`npm test`:

| Export | Role |
| --- | --- |
| `SOURCE_NAME` | The `source_state` key, e.g. `'congress-bills'`. Must match the manifest node's watermark key. |
| `transform` | Pure raw→row mapping. No I/O, no pool — unit-tested from recorded fixtures. Rejects rows that can't satisfy schema constraints; the load stage counts and logs those (deterministic, will never succeed) and skips past them. A narrower variance is allowed where the schema itself absorbs bad values: votes **normalises** an unknown category to `'unknown'` (a per-value fix-up, the row still loads) instead of rejecting the whole row. |
| `load` | The load-stage orchestrator: `load({ client, log, … })`, taking a connected client and a logger-shaped `log` ({info, warn, error}), returning the run's tallies. It composes the module's finer-grained loaders; the entrypoint owns everything around it (readiness, run logging, cursor advance). |

Beyond those three, each source keeps stage-appropriate exports:

| Stage | Shape |
| --- | --- |
| discover | Enumerating what to fetch. For bills this is config (the target congress); file sources walk the landed tree (`walkVoteFiles`, `findLegislatorFiles`). |
| fetch → raw | API sources only: pull from the source and land the **raw, untransformed** payload. Pages/chunks commit incrementally (see watermarks below). File sources have no fetch export — the scraper container is their fetch stage. |
| load internals | Idempotent writes into the domain tables. API sources read from raw in bounded **keyset batches** (tuple bounds, since a whole fetch page shares one `now()`), so a full backfill fits the ingester's small heap; file sources process per landed file. Two idempotency shapes: **upserts** (`ON CONFLICT … DO UPDATE`) for rows keyed by a natural id (bills, votes, legislators), and **per-entity replacement** (DELETE + re-INSERT in one transaction) for complete-set child rows whose payload is the entity's whole current set (cosponsors, subjects, summaries, vote positions, legislator terms — replacement also handles removals). **Database errors are not swallowed as a run outcome**: API loaders fail the run so the unadvanced cursor re-reads the rows; file loaders roll back the failed entity's transaction, count it, and continue, and the failed entity is retried on the next ready run — votes because the per-file skip check (`needsIngestion`) sees no current row for it, legislators because every record reprocesses each ready run anyway (there is no skip check; the idempotent upserts make that safe). The designed skip path differs by source type: API sources skip via **transform rejects** (deterministic, will never succeed); file sources skip via **pre-transform guards** that run before transform — an unparseable or wrong-shape file, or a record missing its natural id (vote_id, bioguide), is logged and counted failed, and votes additionally skip files whose DB row is already current (`needsIngestion`). File-source transforms don't reject: votes' only transform-level fix-up is the category normalisation above. |

Connector modules are **pool-free and side-effect-free at import time**: they take a
`client` (a logger-shaped `log`, and, for API sources, a `fetchImpl`) as arguments, so
everything is testable with stub clients and a stubbed fetch. The thin cron entrypoints
(`src/fetch-<source>.js`, `src/ingest-<source>.js`) do the wiring: pool, logger,
run logging, readiness gate, exit codes. Entry scripts invoke `run()` bare — never
import them; import the connector module instead.

## Where raw lands, per source type

- **Scraped file sources** (votes, legislators): raw lands as **files** on the shared
  `/congress` volume, written by the scraper container; the fetch cursor is written by
  `scraper/write-fetch-cursor.sh`. The files **are** the raw store — there is no
  `raw_payloads` row, no keyset batching, and no request budget for these sources.
  Load-side incrementality is per entity instead: votes skip a file whose
  `source_updated_at` in the DB is already current (`needsIngestion`; `--force`
  overrides), and each entity loads in its own small transaction (bill stub + vote +
  positions per vote file; legislator + terms per YAML record), so one bad entity
  rolls back alone and never poisons the run.
- **API sources** (Congress.gov bills): raw lands in the **`raw_payloads` table** —
  one row per `(source_name, natural_key, endpoint)`, latest payload wins. The upsert
  is guarded by `payload IS DISTINCT FROM EXCLUDED.payload`, so an unchanged payload
  does not touch `fetched_at` — which is what keeps a nothing-new rerun a cheap no-op
  end to end.
- **Per-entity fan-out endpoints** (bills: `bill-detail`, `bill-cosponsors`,
  `bill-subjects`, `bill-summaries`, `bill-titles` beside `bill-list`): each extra
  endpoint is its own `endpoint` tag under the **same natural key**, fetched only for
  entities whose list payload changed (the diff guard doubles as the change detector)
  and stored as the entity's **complete current set** — paginated endpoints are merged
  before the write, never stored page by page. An entity's list row and its fan-out
  rows commit **in one transaction**: landing the list row without its fan-out would
  make the resumed run see the entity as unchanged and skip its sub-entities forever.

## Watermarks and gating

Staged cursors live in `source_state` (see the master plan's "Staged cursors" and
"Gating rule" decisions):

- **Fetch cursors (a pair per discovery unit)** — API sources keep two watermarks in
  `source_state`, keyed per discovery unit (bills: `congress-bills-<congress>`, so
  retargeting the config knob starts a fresh backfill instead of filtering behind
  another unit's watermark):
  - `fetch` — the **resume** position: the max consumed source watermark (bills: max
    `updateDate`), advanced **in the same transaction as each committed chunk** of raw
    payloads and **monotonic** (never regresses), so a crash resumes from the last
    committed chunk and a verification re-walk can't rewind it. Backfill is the same
    code with a NULL starting cursor.
  - `fetch_verified` — the **verified-through** position: advanced only after a clean
    verification pass (below). A crash or pass-cap leaves it behind, and the next run
    resumes verification from it.

  File sources instead have the scraper write `now()` to a single `fetch` cursor on
  success.
- **Skip-proofing offset pagination** — an offset walk over a mutating, ascending
  sort can skip an item across a page boundary (an already-consumed row gets bumped
  to the tail; everything after it shifts one position earlier), leaving its
  watermark behind the resume cursor. So each run does a catch-up pass from `fetch`,
  then — whenever the catch-up was multi-page or `fetch` sits ahead of
  `fetch_verified` — **re-walks from `fetch_verified` until a pass writes nothing
  new**, and only then advances `fetch_verified` (`fetchPagesUntilClean`, capped at 5
  passes per run). Idempotent, diff-guarded upserts make every re-walk cost API calls
  only, and nothing can hide behind the resume cursor across crashes.
- **One fetch run at a time** — fetch entrypoints take a `pg_try_advisory_lock` keyed
  on the source and skip loudly if another run holds it. `fetched_at` is
  transaction-start `now()`, so overlapping fetch runs could commit rows behind an
  already-advanced load cursor.
- **Request budget (rate limiting)** — API fetch runs carry a per-run request budget
  (`requestBudget`; bills: `CONGRESS_GOV_HOURLY_REQUEST_BUDGET`, default 4000 against
  api.data.gov's 5,000/hour). The chosen strategy is **bail out cleanly, resume next
  tick** — not throttling: every list page and fan-out request spends from the budget,
  and when a check is refused the run stops **before the next entity**, commits what
  finished, and returns unverified so the next cron tick resumes from the committed
  cursors (a long backfill drip-feeds across hourly runs this way). Two invariants:
  a started entity always completes (its pagination follows may overrun the cap — the
  default leaves headroom), and the budget check happens **before** an entity's list
  upsert, never between it and its fan-out.
- **Grace-capped load advance** — for the same reason, the load never advances its
  cursor into the last few minutes (`capWatermark`): an in-flight fetch page
  transaction gets time to land, and the clamped tail is simply re-read next run.
- **Load readiness** — an opaque/external input (files) gets the fetch↔load cursor
  handshake (`loadReadiness` in `cursor-state.js`); an **owned DB table** like
  `raw_payloads` gets a **staleness comparison** against its watermark (bills:
  `max(fetched_at) > load cursor`, see `rawReadiness`).
- **Load cursor** — advances to exactly the consumed watermark, atomically with the
  `ingestion_runs` success row, so the cursor and the run status can never disagree.

Cursor values never round-trip through a JS `Date` (see AGENTS.md "JS millisecond vs
Postgres microsecond timestamps"); read them with `readCursor` and compare as strings.

## Shared helpers

| Helper | File | What it gives a connector |
| --- | --- | --- |
| `readCursor` / `advanceFetchCursor` / `advanceLoadCursor` / `loadReadiness` | [`src/cursor-state.js`](src/cursor-state.js) | Precision-preserving `source_state` reads/writes and the file-source handshake predicate. |
| `openRun` / `succeedRun` / `failRun` | [`src/run-log.js`](src/run-log.js) | The `ingestion_runs` lifecycle every stage records. |
| chunked commit + fan-out | `fetchPagesIntoRaw` in the bills connector | The per-chunk BEGIN → list raw upserts → per-entity fan-out → cursor advance → COMMIT loop; generalize it out of the bills connector when the second API source arrives, rather than speculatively now. |
| `requestBudget` | bills connector | The per-run request counter behind the bail-out-cleanly rate strategy above. |
| stale-raw keyset batches | `staleRawBatches` (internal) + `loadStaleEndpointRaws` in the bills connector | The cursor-bounded, tuple-keyset read loop every endpoint loader shares (extracted when the 0011 sub-entity loaders became its second consumer), plus the transform/apply runner with the missing-parent skip guard. |

## Adding a source, end to end

1. Migration for any new tables/columns (`db/migrations/Vnnn__…`; keep DDL parseable —
   see AGENTS.md).
2. Connector module under `src/connectors/`, with fixture-driven tests beside it. A
   guarantee that lives in Postgres semantics (jsonb comparison, COALESCE no-ops) goes
   in a `*.pg-integration.test.js` sibling instead — `npm run test:integration` runs
   those against a throwaway dockerized Postgres migrated with the real migrations;
   they skip themselves under plain `npm test`.
3. Thin entry script(s) in `src/`, mirroring `fetch-bills.js` / `ingest-bills.js`.
4. Crontab entries + manifest nodes + regenerated `PIPELINE.md` — the add-a-source
   ritual in AGENTS.md ("Ingestion pipeline manifest & docs"); `npm test` fails on
   drift. A load-stage node must carry a `module` field naming its connector — the
   conformance test imports it and asserts the contract exports.
5. Config knobs go in `compose.yml` `environment:` lists and dotenvx secrets; a
   missing secret must be a loud, clean skip — never a crashing cron.
