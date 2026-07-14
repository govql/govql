# Task 0009: Target node24-runtime action versions in the us-congress workflow

**Branch**: `43-workflow-node24-actions`
**Depends on**: 0003, 0004, 0005, 0006, 0007
**Source**: talk-it-through 2026-07-14 (this conversation) · GitHub issue #43 · **User story**: as the operator I want the CI/CD workflow free of the "Node.js 20 is deprecated" annotations, targeting the Node runtime GitHub actually supports, so the pipeline stays green and forward-compatible past the Sept 16 2026 removal of node20 from runners.

## What to build

Bump every GitHub Actions `uses:` pin in `.github/workflows/us-congress.yml` to the release
whose **declared action runtime** is `node24`, clearing the deprecation annotations that appear
on the `test` job and the four `images` matrix builds.

Root cause this fixes (so the implementer understands the distinction): an action's runtime
(`using: node20` in its own `action.yml`) is **independent** of the `node-version: 24` the jobs
install for their own `npm ci`/`npm test`. The workflow already sets `node-version: 24` (the
toolchain), but the pinned action **majors** still declare the node20 runtime, so the runner
force-runs them on node24 and emits a non-failing deprecation warning. Bumping the pins to the
node24-runtime majors is the fix. Nothing is broken today; this is hygiene ahead of node20's
Sept 16 2026 removal.

The pins to change (verify each exact tag against its release page before pinning — do not trust
this list blindly, especially `metadata-action`):

| Action | Current | Target |
|---|---|---|
| `actions/setup-node` (×3) | `@v4` | node24 major (`@v5`) |
| `actions/upload-artifact` (×2) | `@v4` | node24 major (`@v5`) |
| `actions/download-artifact` (×2) | `@v4` | node24 major (`@v5`) |
| `docker/setup-buildx-action` | `@v3` | node24 major (`@v4`) |
| `docker/login-action` | `@v3` | node24 major (`@v4`) |
| `docker/metadata-action` | `@v5` | node24 major (confirm `@v5` latest vs `@v6`) |
| `docker/build-push-action` | `@v6` | node24 major (`@v7`) |
| `actions/checkout` | `@v5` | already node24 — **no change** |

Each bump crossing a major (docker build-push v6→v7, login v3→v4, buildx v3→v4; actions
artifact/setup-node v4→v5) can carry breaking changes beyond the runtime bump — scan each
release's changelog for API changes touching our usage (all our `with:` inputs are vanilla).

Add a regression guard so a future edit can't silently reintroduce a node20-runtime pin: extend
`us-congress/deploy/workflow.test.js` to assert every action `uses:` in the workflow is at or
above its known node24-runtime major (an allowlist/minimum-major map). The existing deploy
invariant tests match actions by name, not version, so they stay green through the bump — this
new check is what actually pins the runtime hygiene.

## AFK tasks

- [x] Add a failing test to `us-congress/deploy/workflow.test.js` that parses `.github/workflows/us-congress.yml` and asserts every action `uses:` meets its node24-runtime minimum major (map of action → min major; `checkout` ≥ v5, `setup-node` ≥ v5, `upload-artifact`/`download-artifact` ≥ v5, `docker/build-push-action` ≥ v7, `docker/login-action` ≥ v4, `docker/setup-buildx-action` ≥ v4, `docker/metadata-action` ≥ confirmed min). Red first.
- [x] Verify each target tag against its GitHub release page (confirm the release notes state the node24 runtime), correcting the map if any differs from the table above.
- [x] Bump every `uses:` pin in `.github/workflows/us-congress.yml` to its node24-runtime major; leave `actions/checkout@v5` unchanged. Green the new test.
- [x] Run the full `us-congress/deploy` test suite and confirm all existing deploy invariant tests still pass (they match actions by name, so behavior is unchanged).

## Human-in-the-loop tasks

- [x] [verify] After merge, confirm on a live GitHub Actions run (a normal push deploy or a `workflow_dispatch`) that the "Node.js 20 is deprecated" annotations no longer appear on the `test` job or the `images` builds — a real runner is the only place the runtime annotation is emitted; it cannot be reproduced locally. **Confirmed 2026-07-14 by operator: deprecation annotations gone on a live run.**

## Acceptance criteria

- [x] Every node20-runtime action pin in `us-congress.yml` is bumped to its node24-runtime major; `actions/checkout` is left at `@v5` (already node24).
- [x] `us-congress/deploy/workflow.test.js` fails if any workflow action is pinned below its node24-runtime minimum major (regression guard).
- [x] All existing `us-congress/deploy` invariant tests still pass.
- [x] The "Node.js 20 is deprecated" annotations no longer appear on the `test` and `images` jobs on a live run. *(confirmed 2026-07-14 on a live run)*

## Implementation log

**2026-07-14 · PR [#84](https://github.com/govql/govql/pull/84) (branch `43-workflow-node24-actions`, cut from `main`).**

Bumped all eight step-level action pins in `.github/workflows/us-congress.yml`; `actions/checkout@v5` left unchanged. Targets were verified against each action's own `action.yml` `runs.using`, and **three diverged from the task's assumed table** — the table's minima were assumptions the task told the implementer to confirm:

- `actions/upload-artifact` → **v6** (v5 still declares node20).
- `actions/download-artifact` → **v7** (both v5 and v6 declare node20; the v4→v7 jump is real).
- `docker/metadata-action` → **v6** (v5 declares node20).
- Matched the table: `setup-node@v5`, `setup-buildx-action@v4`, `login-action@v4`, `build-push-action@v7`, `checkout@v5` (no change).

All `with:` inputs are vanilla and unchanged across these majors (bumps are runtime-only). Every node24 major requires Actions Runner ≥ 2.327.1 — satisfied on GitHub-hosted runners.

Regression guard added to `us-congress/deploy/workflow.test.js`: parses the workflow via the existing `js-yaml` `workflow` object, flattens step-level `uses:` across all jobs, and asserts every official `actions/`/`docker/` pin is at or above a `MIN_MAJOR` map. Written red-first (failed on `setup-node@v4`), green after the bump. Full `us-congress/deploy` suite: **50/50 pass**.

Review: `reviews/0009-workflow-node24-actions-review.md` (branch-scoped). Standards / Spec / Security clean. Bug lens raised two low-severity guard-hardening edges — SHA-pin mis-grading and uncovered job-level reusable-workflow `uses:` — both about pin forms this workflow does not use; noted in the PR as out-of-scope future hardening, not fixed.
