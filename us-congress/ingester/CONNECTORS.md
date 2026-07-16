# Source-connector contract

Every ingestion source follows the same staged shape — **discover → fetch(→raw) →
transform → load**, watermarked by staged cursors — so each new source is a copy of a
known pattern, not a new design. The Congress.gov bills connector
([`src/connectors/congress-bills.js`](src/connectors/congress-bills.js)) is the first
implementer and the reference.

## The module shape

A connector is one module under `src/connectors/<source>.js` exporting:

| Export | Role |
| --- | --- |
| `SOURCE_NAME` | The `source_state` key, e.g. `'congress-bills'`. |
| discover | Enumerating what to fetch. For bills this is config (the target congress); file sources walk a directory tree. |
| fetch → raw | Pull from the source and land the **raw, untransformed** payload. Pages/chunks commit incrementally (see watermarks below). |
| `transform` | Pure raw→row mapping. No I/O, no pool — unit-tested from recorded fixtures. Rejects rows that can't satisfy schema constraints; the load stage counts and logs them, never crashes. |
| load | Idempotent upserts into the domain tables (`ON CONFLICT … DO UPDATE`). |

Connector modules are **pool-free and side-effect-free at import time**: they take a
`client` (and, for API sources, a `fetchImpl`) as arguments, so everything is testable
with stub clients and a stubbed fetch. The thin cron entrypoints
(`src/fetch-<source>.js`, `src/ingest-<source>.js`) do the wiring: pool, logger,
run logging, readiness gate, exit codes. Entry scripts invoke `run()` bare — never
import them; import the connector module instead.

## Where raw lands, per source type

- **Scraped file sources** (votes, legislators): raw lands as **files** on the shared
  `/congress` volume, written by the scraper container; the fetch cursor is written by
  `scraper/write-fetch-cursor.sh`.
- **API sources** (Congress.gov bills): raw lands in the **`raw_payloads` table** —
  one row per `(source_name, natural_key, endpoint)`, latest payload wins. The upsert
  is guarded by `payload IS DISTINCT FROM EXCLUDED.payload`, so an unchanged payload
  does not touch `fetched_at` — which is what keeps a nothing-new rerun a cheap no-op
  end to end.

## Watermarks and gating

Staged cursors live in `source_state` (see the master plan's "Staged cursors" and
"Gating rule" decisions):

- **Fetch cursor** — for API sources, the max consumed source watermark (bills: the
  max `updateDate`), advanced **in the same transaction as each committed page** of
  raw payloads, so a crash resumes from the last committed page. Backfill is the same
  code with a NULL starting cursor. File sources instead have the scraper write
  `now()` on success.
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
| chunked per-page commit | `fetchPagesIntoRaw` in the bills connector | The per-page BEGIN → raw upserts → cursor advance → COMMIT loop; generalize it out of the bills connector when the second API source arrives, rather than speculatively now. |

## Adding a source, end to end

1. Migration for any new tables/columns (`db/migrations/Vnnn__…`; keep DDL parseable —
   see AGENTS.md).
2. Connector module under `src/connectors/`, with fixture-driven tests beside it.
3. Thin entry script(s) in `src/`, mirroring `fetch-bills.js` / `ingest-bills.js`.
4. Crontab entries + manifest nodes + regenerated `PIPELINE.md` — the add-a-source
   ritual in AGENTS.md ("Ingestion pipeline manifest & docs"); `npm test` fails on
   drift.
5. Config knobs go in `compose.yml` `environment:` lists and dotenvx secrets; a
   missing secret must be a loud, clean skip — never a crashing cron.
