# Task 0012: Refactor votes + legislators onto the connector contract

**Branch**: `feature/connector-contract-refactor`
**Depends on**: 0010
**Source**: talk-it-through 2026-07-15 · GitHub issue #89 (sub-issue of #56)

## What to build

A **behavior-preserving refactor**: restructure the existing votes and legislators
ingesters onto the connector contract that task 0010 established — same module shape,
same shared helpers (cursor readiness, chunked commits, run logging) — so the codebase
has one connector style, not three bespoke pipelines. This is the contract's second
shakeout: where the contract doesn't fit the file-landed scrape sources, fix the
contract (and its documentation), not just the callers.

No schema changes, no cron schedule changes, no cursor-semantics changes. The
file-based raw landing for scraped sources stays — the contract abstracts over where
raw lives, per the plan's raw-landing convention.

Opportunistic rider (from #89's Related section): if cursor writes end up routed
through one narrow shared path during the refactor, note in issue #58 how that
advances its least-privilege goal. Don't expand scope to solve #58 here.

## AFK tasks

- [x] Refactor `ingest-votes.js` and `ingest-legislators.js` to the connector module
      shape, replacing bespoke plumbing with the shared helpers from 0010.
- [x] Where the contract needed bending to fit file-landed sources, update the
      contract documentation so the next implementer inherits the fix.
- [x] Add a conformance check: a test asserting every load-stage module in
      `pipeline.manifest.js` exports the contract shape — so drift between manifest
      and modules fails the suite, matching the repo's manifest-as-source-of-truth
      idiom.
- [x] Keep all existing ingester tests green; update the manifest nodes only if
      their descriptive fields (idempotency text, reads/writes) drifted, and
      regenerate `PIPELINE.md` if touched.

## Acceptance criteria

- [x] Votes and legislators ingest runs produce identical rows from identical
      fixtures before and after the refactor (behavior-preserving, proven by tests)
- [x] All three sources (votes, legislators, bills) implement the same documented
      contract; the conformance test enforces it
- [x] Cron schedules and `source_state` cursor semantics unchanged
- [ ] Pipeline `--check` green in CI (green locally; CI runs on the PR)
- [ ] PR says `Part of #89` and closes nothing

## Implementation log (2026-07-19)

Built on `feature/connector-contract-refactor`, commit `ad41cb2`.

**What was built.** Two new connector modules extracted from the previously inline
entry scripts, matching the shape task 0010 established for bills:

- `us-congress/ingester/src/connectors/congress-votes.js` — `SOURCE_NAME`, discover
  (`walkVoteFiles`), pure `transform` (vote row + bill stub + flattened positions;
  keeps the category *normalisation* — unknown → `'unknown'` — rather than bills'
  reject-the-row philosophy), per-file loaders (`needsIngestion`, `upsertBillStub`,
  `upsertVote`, `replacePositions`, `loadVoteFile`), and a `load` orchestrator.
- `us-congress/ingester/src/connectors/congress-legislators.js` — `SOURCE_NAME`,
  discover (`findLegislatorFiles`), `parseLegislatorFile`, pure `transform`,
  `upsertLegislator`, `replaceTerms`, `loadLegislator`, `load`.
- `congress-bills.js` gained the same `load` orchestrator export (extracted verbatim
  from `ingest-bills.js`), so all three sources share one shape.
- All three entry scripts are now thin wiring (pool, logger, readiness gate,
  `openRun`/`succeedRun`/`failRun`, atomic cursor advance, healthcheck, exit codes)
  with unchanged filenames, cron lines, log messages, and cursor semantics.
- `pipeline.manifest.js` load-stage nodes carry a `module` field;
  `src/connectors/conformance.test.js` imports each named module and asserts
  `SOURCE_NAME` (matching the node's watermark key), `transform`, and `load`.
- `CONNECTORS.md` rewritten where API-first: required exports pinned (that's what the
  conformance test asserts), file-landed sources documented as a first-class path,
  votes' normalisation variance recorded. `AGENTS.md` manifest ritual mentions the
  new `module` field.
- Tests: 133 unit tests green (`npm test`), including characterization tests that pin
  the pre-refactor SQL text/params verbatim; 4 pg-integration tests green
  (`npm run test:integration`) proving identical rows from identical fixtures across
  reruns (idempotency, house bioguide + senate lis_id JOIN paths, VP dropped by JOIN,
  `--force` reprocessing). Pipeline `--check` green; `PIPELINE.md` needed no
  regeneration (the `module` field is not rendered).

**Decisions made (all AFK — the task had no `[decision]` items):**

- Contract shape pinned as three required named exports: `SOURCE_NAME`, `transform`,
  `load({ client, log, … })`. The old doc named only `SOURCE_NAME`/`transform`
  literally; a conformance test needs concrete names, and `load` was the natural
  third since every load-stage entry orchestrates one.
- `log` is a logger-shaped object (`{info, warn, error}`) passed as an argument —
  connectors stay pool-free and logger-free at import; bills' internal single-fn
  loader logs are unchanged.
- Known, deliberate delta: entry scripts now use the shared `succeedRun`, which
  writes `source_params = '{}'` where the old inline SQL left NULL — audit-table
  metadata only, domain rows identical. Also `failRun` is now `.catch()`-guarded
  (bills convention), strictly more robust on the failure path.
- Vote fixture member ids are disjoint from the legislators fixture ids so the two
  pg-integration suites (which share one throwaway database and run concurrently)
  can't collide; each suite scopes its deletes/snapshots to its own rows.

**Review round 1 fixes (2026-07-19, all findings user-approved):**

- Major (Bug/Spec): `transform(data)` moved inside `loadVoteFile`'s try block — a
  malformed vote file whose flattening throws now rolls back and counts as one
  failed file instead of crashing the run and wedging the hourly cron; pinned by a
  new unit test (`votes: { Aye: null }` → `'failed'` + ROLLBACK).
- Spec (equivalence proof): ran the actual pre-refactor entry scripts from `main`
  and the refactored ones against the same dockerized, Flyway-migrated Postgres and
  the same fixture tree (7 legislators incl. senate lis_ids, house + senate votes) —
  domain-row snapshots (legislators, legislator_terms, votes, vote_positions, bills;
  volatile columns excluded) were **byte-identical**. Harness:
  scratchpad `equiv/run-equivalence.sh`; result recorded for the PR body.
- Standards: CONNECTORS.md load-internals row no longer claims a per-file skip
  check for legislators (votes has `needsIngestion`; legislators reprocess every
  record each ready run); bills `load` gained a stub-client test where loaders
  return differing non-null watermarks (consumed = max, tallies sum, null ignored);
  conformance watermark-key check switched from an unescaped RegExp to plain
  `includes()`; legislators failing-load test now also covers a transform throw
  (record with id but no name → BEGIN/ROLLBACK, counted failed).
- Deferred to PR time (not code): disclose the `source_params` NULL→`'{}'` delta in
  the PR body; `Part of #89` / no closing keywords; post the #58 rider note after
  approval.

**Issue #58 rider note (for the PR / a #58 comment, needs approval to post):** after
this refactor, every `source_state` write goes through `cursor-state.js` and every
`ingestion_runs` write through `run-log.js` — two narrow modules instead of inline
SQL in three scripts — so a future least-privilege split can grant those tables'
permissions to exactly those code paths.
