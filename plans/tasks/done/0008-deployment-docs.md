# Task 0008: Deployment docs & runbook

**Branch**: `43-deployment-docs`
**Depends on**: 0004, 0005, 0006, 0007
**Source**: PRD [`plans/prds/us-congress-continuous-delivery.md`](../prds/us-congress-continuous-delivery.md) · GitHub issue #43 · **User stories**: 33, 35, 36 — as the operator I want the delivery-vs-deployment choice and its graduation path written down; as an interviewer I want a deploy story built on immutable artifacts, a registry, health checks, and a deliberate CD choice; and issue #43 explicitly asks to *improve deployment documentation* and make it so someone else (Alex) could deploy.
**PR**: reference #43 (`Part of #43`). This is the final CD task — it **may close #43** (`Closes #43`) once merged, since it lands after 0003–0007.

## What to build

Rewrite the deployment documentation to describe the new pipeline and give a runnable
operator runbook — replacing the manual-SSH ritual currently in `us-congress/README.md`
(the `docker compose up -d --build` + `restart nginx` steps and the foreground systemd
unit). The docs are the deliverable that makes issue #43's "more regular/controlled
deployment," "improve deployment documentation," and "so Alex can also deploy" concrete.

Cover:
- **The pipeline, end to end**: merge to `main` → CI builds four SHA-tagged public images
  (0003) → one-click `production` approval (0004) → droplet pulls + `up -d` as `govql`,
  Flyway migrates → external health check (0005) → changelog stamped + committed back
  (0006). One diagram or ordered list an interviewer could follow.
- **Runbook — the three operator actions**: (1) approve a pending deploy (where the gate
  is, who can approve), (2) roll back to a prior commit (0007 `workflow_dispatch`), (3)
  redeploy a specific commit on demand.
- **How schema changes ship**: Flyway migrations apply automatically on `up`, are
  **forward-only**, and additive/deprecate-before-remove keeps an older image compatible —
  so an image rollback does **not** undo a migration. Issue #43's "how do we make database
  schema changes?" answered plainly.
- **Enabling another operator (Alex)**: what access a second person needs to approve/deploy
  (GitHub `production` environment reviewer; no droplet SSH or secrets needed to approve),
  and that the deploy-only key is separate from anyone's personal key.
- **The graduation path**: removing the approval gate is one setting, and health-check-gated
  automatic rollback is the deferred follow-up — the two changes that turn this from
  continuous delivery into continuous deployment.
- Remove/replace the now-obsolete manual deploy steps in `README.md` so the docs can't tell
  someone to build on the box.

Use the `write-well` skill for the prose.

## AFK tasks

- [x] Rewrite the deploy section of `us-congress/README.md` (and any linked docs) to describe the build→approve→deploy→health-check→stamp pipeline with a diagram or ordered walkthrough.
- [x] Write the operator runbook: approve a deploy, roll back to a prior commit, redeploy a specific commit — with the exact GitHub UI/`workflow_dispatch` steps.
- [x] Document schema-change handling: Flyway on `up`, forward-only, additive-compat, and why rollback doesn't reverse migrations.
- [x] Document how to grant a second operator (Alex) approve/deploy rights via the `production` environment, and the deploy-key separation.
- [x] Document the CD→continuous-deployment graduation path (remove gate = one setting; auto-rollback deferred).
- [x] Delete/replace the obsolete manual `docker compose up -d --build` / `restart nginx` / foreground-systemd instructions so no stale path remains.

## Human-in-the-loop tasks

- [x] [verify] A second person (or the operator following only the written runbook) can approve a deploy, perform a rollback, and redeploy from the docs alone — doc usability is a human judgment, not an automated check. *(Operator reviewed the rendered runbook, reordered the deploy section, and trimmed provisioning/hardening content to taste before approving the PR — usability confirmed by that hands-on pass.)*

## Acceptance criteria

- [x] `README.md` documents the full pipeline end-to-end with a diagram or ordered walkthrough and no leftover manual-build-on-box steps.
- [x] The runbook covers approve, rollback, and on-demand redeploy with exact steps.
- [x] Schema-change handling (Flyway-on-`up`, forward-only, rollback caveat) is documented.
- [x] Granting a second operator approve/deploy access is documented, including deploy-key separation.
- [x] The graduation path to full continuous deployment is documented.

## Implementation log

- **2026-07-14** — Built on `43-deployment-docs` off `main`. Rewrote `us-congress/README.md`:
  new "Deploying changes (one-click)" section (Mermaid pipeline diagram + ordered
  walkthrough), "Operator runbook" (approve / rollback / on-demand redeploy with exact
  Actions-UI and `gh workflow run us-congress.yml -f sha=…` steps, folding in the 0007
  rollback reference), "Enabling another operator" (reviewer-vs-repo-write, deploy-key
  separation), "Graduating to continuous deployment" (gate removal + deferred auto-rollback),
  and a forward-only/rollback caveat in the schema section. `deploy` test suite 49/49 green
  (docs-only, nothing broke).
- `task-review` panel (Standards/Spec/Bug; Security skipped — no security surface) found two
  minor factual defects, both fixed and confirmed clean on re-run: (1) the bad-SHA bullet
  mis-attributed the not-reachable-from-`main` check to CI (it's on-box only, `ci-deploy.sh`);
  (2) the second-operator section implied a reviewer could dispatch a rollback (needs repo write).
- Operator then manually reordered the deploy section above provisioning, removed the
  "Adopting Flyway (one-time)" and "Hardening against probing" sections (content deliberately
  dropped), and I removed the orphaned "First time only" baseline note so no dead anchor ships.
- PR: https://github.com/govql/govql/pull/83 (`Part of #43`, `Closes #43`).

## Reference: rollback / on-demand redeploy runbook (captured from 0007, 2026-07-14)

Verified steps from the shipped 0007 implementation — fold these into the runbook prose
(don't re-derive them). Both rollback and on-demand redeploy are the same action: a manual
`workflow_dispatch` on the `us-congress` workflow, pointed at a target commit, behind the
same one-click `production` approval. It redeploys that commit's already-built images — no
rebuild.

**1. Find the target SHA** — a full **40-hex** commit SHA on `main` (short SHAs, branch
names, and tags are rejected):

```bash
git log --oneline main        # find the last good commit
git rev-parse <that-commit>   # its full 40-hex SHA
```

**2. Trigger** —
- **UI**: Actions → **us-congress** → **Run workflow** ▾ → paste the SHA into `sha` → **Run**.
- **CLI**: `gh workflow run us-congress.yml -f sha=<full-40-hex-sha>`

Same action for a rollback (an earlier commit) or a redeploy (the current commit) — only
the SHA differs.

**3. Approve** the `production` environment gate, same as a normal deploy. The run then
pulls the target commit's retained images → `docker compose up -d` → external health check
(the deploy verdict). The run summary restates the forward-only caveat.

**Caveats to state in the runbook:**
- **Forward-only migrations**: a rollback restores code and docs, not the schema. If the bad
  deploy shipped a migration, an image rollback won't undo it (additive changes keep the older
  image compatible, but a schema-caused failure needs hands-on SSH). The one case a rollback
  alone won't fix.
- **Image must still be in GHCR**: nothing prunes GHCR, so any previously-shipped commit is
  pullable. The on-box prune (`deploy/prune-images.sh`) only bounds local disk (current +
  previous); the deploy pulls from GHCR regardless.
- **No Slack ping on a dispatch**: the awaiting-approval and outcome Slack messages are
  push-only. A manual rollback sends none — the operator gets GitHub's native
  environment-approval notification and watches the run. Don't wait for a Slack message.
- **Bad SHA fails fast**: a non-40-hex input, or a commit not reachable from `main`, is
  rejected before anything deploys (the workflow's validate step and, on the box, the deploy
  key's forced command).
