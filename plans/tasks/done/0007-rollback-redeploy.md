# Task 0007: Rollback & on-demand redeploy

**Branch**: `43-rollback-redeploy`
**Depends on**: 0004
**Source**: PRD [`plans/prds/us-congress-continuous-delivery.md`](../prds/us-congress-continuous-delivery.md) · GitHub issue #43 · **User stories**: 24, 25, 26, 27 — as the operator, I want to roll back to a previous version with one click and redeploy a specific commit on demand without a code change, so recovering from a bad deploy is fast and needs no SSH; previous images stay in the registry, and I understand migrations are forward-only so an image rollback won't undo a schema change.
**PR**: reference #43 (`Part of #43`); do **not** close it.

## What to build

Rollback and on-demand redeploy as the **same deploy path (0004) pointed at an arbitrary
commit**, invoked manually. A `workflow_dispatch` run takes a target commit/SHA input and
runs the existing gated deploy against it: check out that commit, derive its image tag, pull
the retained SHA-tagged images, `up -d`. This is both the rollback mechanism (point at an
earlier known-good commit) and the escape hatch for reruns (redeploy the current commit
without a code change).

Prior SHA-tagged images must be **retained** in GHCR so a rollback has something to pull
(no aggressive prune that would delete the rollback target). Rollback restores code and
docs cleanly; **database migrations are forward-only** and additive, so an older server
image keeps working against a newer schema — but a schema-caused failure may need hands-on
intervention. This forward-only caveat must be stated wherever rollback is offered so nobody
expects an image rollback to reverse a migration (fully covered in the 0008 docs).

## AFK tasks

- [x] Add a `workflow_dispatch` entry point taking a target commit/SHA input that runs the 0004 gated deploy path against that commit (reuse the deploy job, don't fork it).
- [x] Ensure the tag derivation works for an arbitrary historical commit (not just `HEAD` of `main`), so pointing at an older SHA pulls that SHA's images.
- [x] Confirm/adjust GHCR retention so prior SHA-tagged images are not pruned out from under a rollback; document the retention expectation.
- [x] Surface the forward-only-migrations caveat in the workflow's dispatch description/summary output (the full explanation lives in 0008).

## Human-in-the-loop tasks

- [ ] [verify] A `workflow_dispatch` at a prior SHA actually rolls the live droplet back to those images (and an on-demand redeploy of the current commit re-runs cleanly) — a live-droplet outcome that can't be asserted in CI. **Post-merge**: a dispatch can only run once the workflow is on `main`.

## Acceptance criteria

- [x] A manual `workflow_dispatch` with a target commit runs the same gated deploy path against that commit.
- [x] Pointing at a prior SHA pulls that commit's retained images and swaps the stack to them.
- [x] Redeploying the current commit with no code change works as a rerun escape hatch.
- [x] Prior SHA-tagged images are retained in GHCR; the rollback target is guaranteed pullable.
- [x] The forward-only-migrations limitation is surfaced at the rollback entry point.

## Notes from 0004's live deploy (2026-07-13)

- **On-box image retention is this task's problem**: each deploy leaves a ~1.7 GB
  SHA-tagged image set on the droplet (24 GB disk) and nothing prunes old ones —
  0004's first deploy hit 95% disk. Pruning must be rollback-aware: keep the
  current and at least the previous SHA locally, prune older (e.g. in
  `deploy/deploy.sh` after a successful swap).
- **ci-deploy.sh refuses ancestor SHAs by design** (`refusing rollback`) — the
  rollback path added here must bypass that guard explicitly (a flag or a
  separate forced-command entry), not weaken the default.

## Decisions

- **Digest verification is relaxed on the rollback path** (decided 2026-07-14).
  The normal push deploy verifies each pulled image against the digest CI
  recorded for *this run's* build. A rollback/redeploy deploys a commit built by
  a *prior* run, so there is no current-run digest to compare against. Rather
  than reconstruct old digests (cross-run artifact lookup, bounded by the 90-day
  artifact window) or add on-box digest bookkeeping, the rollback path **skips
  digest verification** and trusts the human `production` approval gate as the
  re-authorization boundary. The normal path keeps full verification. The two
  alternatives were considered and declined as over-scoped for a human-gated
  break-glass path.

## Implementation log (2026-07-14)

Built on `43-rollback-redeploy`, PR #82. TDD throughout; 49/49 deploy tests
green, shellcheck clean.

- **`.github/workflows/us-congress.yml`** — `workflow_dispatch` with a required
  40-hex `sha` input (description carries the forward-only caveat). The `images`
  build is skipped on a dispatch; the deploy job's `if` tolerates that skip but
  is **scoped per event** — `(push && images==success) || (dispatch &&
  images==skipped)` — so a changelog-stamp-commit push (images skipped by the
  anti-loop backstop) still cannot deploy. A dispatch-only "Validate rollback
  target" step rejects a non-40-hex input before the SSH step; a run-summary step
  restates the forward-only caveat; the digest-artifact download is push-only.
  `TARGET_SHA` = `inputs.sha` on dispatch, else `github.sha`. Still gated by the
  `production` environment; never runs on a PR.
- **`us-congress/deploy/ci-deploy.sh`** — second accepted forced-command form
  `rollback <sha>` that bypasses the ancestor-refusal guard while keeping the
  40-hex and reachable-from-`origin/main` checks; hands `deploy.sh --rollback`.
- **`us-congress/deploy/deploy.sh`** — `--rollback` mode skips the digest
  read+verify (pulls retained images only); restructured from `exec up.sh` to
  call `up.sh` then `prune-images.sh` (best-effort) after a successful swap.
- **`us-congress/deploy/prune-images.sh`** (new) — rollback-aware prune: keeps
  the current `IMAGE_TAG` (never pruned, even when a rollback made it the oldest
  build) plus one previous SHA set, drops older; best-effort.
- **GHCR retention** — confirmed no action under `.github/` prunes GHCR, so prior
  SHA tags stay pullable; documented the expectation in the workflow and in
  `AGENTS.md`'s deploy bullet (full runbook lands in 0008).
- **Tests** — `ci-deploy.test.js`, `deploy.test.js`, `prune-images.test.js`
  (new), `workflow.test.js`. A `task-review` panel (Standards/Spec/Bug/Security)
  found one major regression (the deploy `if` initially re-opened the stamp-loop
  backstop) plus four minors; all fixed and confirmed clean on re-review.
- **Left for merge**: the `[verify]` live-droplet rollback (needs the workflow on
  `main`); `sync-main` will flip `[>]→[x]` and move this file to `tasks/done/`.
