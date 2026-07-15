# Task 0006: Automated changelog stamp

**Branch**: `43-changelog-stamp`
**Depends on**: 0004, 0005
**Source**: PRD [`plans/prds/us-congress-continuous-delivery.md`](../prds/us-congress-continuous-delivery.md) · GitHub issue #43 · **User stories**: 15, 16, 17, 18, 19, 20, 21, 34 — as the operator, I want the `## [Unreleased]` changelog section stamped with my local (America/Chicago) deploy date automatically so shipped API changes never sit stranded under "Unreleased," while I keep writing entries by hand; the published docs must reflect the stamped date in the same deploy, the stamped file must be committed back to `main` only after the deploy is confirmed healthy, and that commit must not trigger another deploy.
**PR**: reference #43 (`Part of #43`); do **not** close it.

## What to build

Module A — the changelog stamp. Depends on 0004 (the deploy pipeline it plugs into) and
0005 (commit-back is gated on the health check passing).

A **pure function** taking changelog text and a date and returning the stamped text plus a
changed/unchanged flag. It locates the `## [Unreleased]` heading, decides whether it holds
real content, rewrites it to a dated heading, and inserts a fresh empty `## [Unreleased]`
section above it. It is a **no-op** when Unreleased is empty (a plumbing-only deploy must
not fabricate an empty release entry). All file and clock access lives in a thin CLI
wrapper **outside** the pure core.

Only the canonical `us-congress/CHANGELOG.md` is touched (it follows the Keep a Changelog
"Unreleased" idiom and is rendered into the docs site by the existing sync step). The
`mcp-server` changelog is left alone.

Pipeline wiring (in the 0004 workflow):
- The stamp is applied to the working copy in CI **before the docs image is built** (0003's
  nginx multi-stage build), so the published site shows the date within the same deploy.
- The stamped file is committed back to `main` **only after the 0005 health check passes**,
  using the built-in workflow token so the commit **cannot trigger another deploy**; a
  `paths`-filter guard on the build trigger is the secondary safety net.
- A failed deploy **discards** the stamp rather than committing it.
- The date is the operator's local **America/Chicago** date.

## AFK tasks

- [x] Write the pure `stampChangelog(text, date) -> { text, changed }`: find `## [Unreleased]`, detect real content vs empty, rewrite to `## [<date>]` (Keep a Changelog format), insert a fresh empty `## [Unreleased]` above; return `changed: false` and unchanged text when Unreleased is empty.
- [x] Write the thin CLI wrapper: read `us-congress/CHANGELOG.md`, compute the America/Chicago date, call the pure fn, write back only when `changed`.
- [x] Unit-test the pure boundary with string fixtures: empty Unreleased (no-op), populated Unreleased (stamped + fresh empty section), prior dated entries below (preserved, ordering correct), malformed/duplicate headings (handled predictably).
- [x] In the 0004 workflow: run the stamp on the working copy **before** the docs image build so the published site carries the date.
- [x] In the 0004 workflow: after the 0005 health check passes, commit the stamped `CHANGELOG.md` back to `main` with the workflow token; ensure the trigger's `paths` filter + token prevent a re-deploy loop; on failure, discard the stamp. *(Deviation, user-approved: the loop backstop is a commit-message skip on the `images` job, not a `paths` filter — a paths negation would have blocked human changelog-only merges from ever republishing the docs site.)*

## Human-in-the-loop tasks

- [ ] [verify] In a real deploy with content under Unreleased, the published docs site shows the stamped date in the same deploy, `main` gets the stamped commit only after health passes, and that commit does not kick off another deploy — the loop-prevention + same-deploy-publish behavior is only observable end-to-end.

## Acceptance criteria

- [x] `stampChangelog` is a pure function with all file/clock I/O in a separate CLI wrapper.
- [x] Unit tests cover empty (no-op), populated, prior-dated-entries, and malformed-heading fixtures.
- [x] The stamp uses the America/Chicago date and only ever edits `us-congress/CHANGELOG.md`.
- [ ] The published docs site reflects the stamped date within the same deploy. *(built; confirmation is the end-to-end [verify] above)*
- [ ] The stamped file is committed back to `main` only after the health check passes, via the workflow token, and does not trigger another deploy; a failed deploy leaves `main` unstamped. *(built; confirmation is the end-to-end [verify] above)*

## Implementation log (2026-07-13)

Built on branch `43-changelog-stamp` (3 commits + fixes). Key files:
`us-congress/deploy/stamp-changelog.js` (pure core, returns `{text, changed, reason}`),
`stamp-changelog-run.js` (CLI wrapper: America/Chicago date via `Intl` en-CA; exits 1 on a
missing `## [Unreleased]` heading), `stamp-changelog.test.js` + `stamp-changelog-run.test.js`
(12 tests), workflow wiring + invariants in `.github/workflows/us-congress.yml` and
`us-congress/deploy/workflow.test.js` (41 tests green). Three review passes
(`reviews/0006-changelog-stamp-review.md` on the branch); Security clean in both full passes.

Decisions (all user-approved via talk-through of review findings):
- **Loop backstop**: commit-message skip (`docs(us-congress): stamp changelog` prefix) on the
  `images` job, replacing the spec's paths filter (which over-blocked human changelog edits).
  Primary guard remains the built-in `GITHUB_TOKEN` (its pushes never trigger workflows).
- **Stamp input** is `origin/main`'s changelog, gated on changelog-blob equality between the
  deployed sha and main's tip — a redeploy of an older sha publishes main's already-stamped
  state instead of re-dating entries; skips emit `::warning::`.
- **Commit-back** is a separate `commit-changelog` job (`needs: [deploy]`, success-only,
  `contents: write`); the stamped bytes travel by artifact with the pre-stamp input, and a
  concurrent-edit guard skips loudly (`::warning::` + Slack) rather than clobbering.
- **Same-day second deploy** merges into the existing `## [<date>]` section, folding
  case-insensitively under existing `### Category` headings.
- **Accepted limitations**: back-to-back-deploy commit-back skip (self-heals next deploy,
  date may shift across midnight); `####` sub-headings inside category blocks unsupported
  (none exist).
