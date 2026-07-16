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

- [ ] Refactor `ingest-votes.js` and `ingest-legislators.js` to the connector module
      shape, replacing bespoke plumbing with the shared helpers from 0010.
- [ ] Where the contract needed bending to fit file-landed sources, update the
      contract documentation so the next implementer inherits the fix.
- [ ] Add a conformance check: a test asserting every load-stage module in
      `pipeline.manifest.js` exports the contract shape — so drift between manifest
      and modules fails the suite, matching the repo's manifest-as-source-of-truth
      idiom.
- [ ] Keep all existing ingester tests green; update the manifest nodes only if
      their descriptive fields (idempotency text, reads/writes) drifted, and
      regenerate `PIPELINE.md` if touched.

## Acceptance criteria

- [ ] Votes and legislators ingest runs produce identical rows from identical
      fixtures before and after the refactor (behavior-preserving, proven by tests)
- [ ] All three sources (votes, legislators, bills) implement the same documented
      contract; the conformance test enforces it
- [ ] Cron schedules and `source_state` cursor semantics unchanged
- [ ] Pipeline `--check` green in CI
- [ ] PR says `Part of #89` and closes nothing
