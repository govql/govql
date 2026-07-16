# Task 0011: Bill sub-entities — cosponsors, subjects, summaries

**Branch**: `feature/bill-sub-entities`
**Depends on**: 0010
**Source**: talk-it-through 2026-07-15 · GitHub issue #89 (sub-issue of #56)

## What to build

Extend the bills connector's fetch stage with the **per-bill fan-out**: for each bill
whose `updateDate` moved, pull the cosponsors, subjects, and summaries endpoints into
`raw_payloads`; extend the load stage to transform those rows into the existing
`bill_cosponsors` table and new `bill_subjects` / `bill_summaries` tables. This is the
task that exercises chunked, checkpointed batching under real request volume: the
initial fan-out over congress 119 is ~50k requests against the 5,000/hour api.data.gov
budget — several hours of drip-feeding that must survive interruption.

Amendments and full bill text stay out of scope (deferred in #89 until something
consumes them).

## AFK tasks

- [ ] Migration: `bill_subjects` and `bill_summaries` tables (natural-keyed on
      `bill_id` + the sub-entity's own identity, idempotent upserts or
      DELETE+re-INSERT per bill, matching the repo's existing child-row pattern).
- [ ] Fetch fan-out: after each consumed list page, fetch the three sub-entity
      endpoints per changed bill into `raw_payloads` (one row per endpoint per bill),
      still committing and advancing the fetch cursor per chunk so an interrupted
      fan-out resumes without re-fetching completed bills.
- [ ] Rate-budget guard: stay under the hourly request limit (throttle or bail out
      cleanly mid-run and resume next cron tick — either is fine, pick one and
      document it in the connector contract).
- [ ] Load stage: transform sub-entity raw rows into `bill_cosponsors` (existing
      table), `bill_subjects`, `bill_summaries`, in the same cursor-gated transaction
      pattern as 0010.
- [ ] Update the two manifest nodes' reads/writes; regenerate `PIPELINE.md`;
      `--check` green.
- [ ] Tests: transforms from recorded fixtures for all three sub-entities;
      resume-after-interrupt behavior for the fan-out; rate-guard behavior.

## Human-in-the-loop tasks

- [ ] [verify] Watch the live fan-out complete for congress 119 (cosponsors, subjects,
      summaries populated, request rate within budget) — it runs over hours on the
      live rate-limited API, which a test can't compress.

## Acceptance criteria

- [ ] Cosponsors, subjects, and summaries for congress-119 bills are queryable via
      GraphQL and consistent with the Congress.gov site for spot-checked bills
- [ ] Interrupting the fan-out mid-run loses no completed work and re-fetches no
      completed bill on resume
- [ ] Steady-state hourly runs fetch only bills whose `updateDate` moved
- [ ] `PIPELINE.md` reflects the updated nodes; pipeline `--check` green in CI
- [ ] PR says `Part of #89` and closes nothing
