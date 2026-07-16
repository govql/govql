# Task 0011: Bill sub-entities + detail — cosponsors, subjects, summaries, detail, titles

**Branch**: `feature/bill-sub-entities`
**Depends on**: 0010
**Source**: talk-it-through 2026-07-15 · GitHub issue #89 (sub-issue of #56) ·
extended 2026-07-16 after 0010's verify (detail + titles endpoints added)

## What to build

Extend the bills connector's fetch stage with the **per-bill fan-out**: for each bill
whose `updateDate` moved, pull **five** endpoints into `raw_payloads` — cosponsors,
subjects, and summaries (child tables), plus the **bill detail** endpoint
(`/bill/{congress}/{type}/{number}`) and the **titles** endpoint (`/titles`), which
enrich the `bills` row itself. Extend the load stage to transform those rows into the
existing `bill_cosponsors` table, new `bill_subjects` / `bill_summaries` tables, and
the `bills` columns that 0010's list endpoint could not populate: `sponsor_bioguide_id`,
`introduced_at`, `policy_area`, `enacted_as_law_type`/`enacted_as_number` (detail) and
`official_title`/`short_title`/`popular_title` (titles). This closes 0010's deferred
"sponsors" acceptance criterion.

This is the task that exercises chunked, checkpointed batching under real request
volume: the initial fan-out over congress 119 (~17.5k bills × 5 endpoints) is ~90k
requests against the 5,000/hour api.data.gov budget — roughly a day of drip-feeding
that must survive interruption.

Amendments and full bill text stay out of scope (deferred in #89 until something
consumes them). Whether to *derive* `status`/`status_at` from the action history is
parked separately in issue #91 — not this task.

## AFK tasks

- [ ] Migration: `bill_subjects` and `bill_summaries` tables (natural-keyed on
      `bill_id` + the sub-entity's own identity, idempotent upserts or
      DELETE+re-INSERT per bill, matching the repo's existing child-row pattern).
- [ ] Fetch fan-out: after each consumed list page, fetch the five per-bill
      endpoints (cosponsors, subjects, summaries, detail, titles) per changed bill
      into `raw_payloads` (one row per endpoint per bill), still committing and
      advancing the fetch cursor per chunk so an interrupted fan-out resumes without
      re-fetching completed bills.
- [ ] Rate-budget guard: stay under the hourly request limit (throttle or bail out
      cleanly mid-run and resume next cron tick — either is fine, pick one and
      document it in the connector contract).
- [ ] Load stage: transform sub-entity raw rows into `bill_cosponsors` (existing
      table), `bill_subjects`, `bill_summaries`, in the same cursor-gated transaction
      pattern as 0010.
- [ ] Bills-row enrichment from detail + titles raws: `sponsor_bioguide_id`
      (FK-safe — drop/NULL unknown bioguide ids with a logged count, like the votes
      ingester's positions JOIN), `introduced_at`, `policy_area`,
      `enacted_as_law_type`/`enacted_as_number` from detail; `official_title`,
      `short_title`, `popular_title` from the titles endpoint (pick the current/most
      recent title per type). Never overwrite a populated column with NULL when the
      endpoint omits a field.
- [ ] Update the two manifest nodes' reads/writes; regenerate `PIPELINE.md`;
      `--check` green.
- [ ] Tests: transforms from recorded fixtures for all five endpoints;
      resume-after-interrupt behavior for the fan-out; rate-guard behavior;
      no-NULL-overwrite behavior for the bills-row enrichment.

## Human-in-the-loop tasks

- [ ] [verify] Watch the live fan-out complete for congress 119 (cosponsors, subjects,
      summaries populated, request rate within budget) — it runs over hours on the
      live rate-limited API, which a test can't compress.

## Acceptance criteria

- [ ] Cosponsors, subjects, and summaries for congress-119 bills are queryable via
      GraphQL and consistent with the Congress.gov site for spot-checked bills
- [ ] Congress-119 `bills` rows carry sponsor, introduced date, policy area,
      enacted-as, and the official/short/popular titles where Congress.gov provides
      them (closes 0010's deferred "sponsors" criterion)
- [ ] Interrupting the fan-out mid-run loses no completed work and re-fetches no
      completed bill on resume
- [ ] Steady-state hourly runs fetch only bills whose `updateDate` moved
- [ ] `PIPELINE.md` reflects the updated nodes; pipeline `--check` green in CI
- [ ] PR says `Part of #89` and closes nothing
