# Task 0004: One-click production deploy + notifications

**Branch**: `43-one-click-production-deploy`
**Depends on**: 0003
**Source**: PRD [`plans/prds/us-congress-continuous-delivery.md`](../prds/us-congress-continuous-delivery.md) · GitHub issue #43 · **User stories**: 5, 6, 7, 10, 11, 12, 13, 14, 28, 29, 31, 32, 33 — as the operator, I want to approve each production deploy with one click, have the droplet pull the exact SHA-tagged images and swap to them as an unprivileged user with a deploy-only key, keep Flyway applying migrations on `up`, and hear about every outcome in Slack.
**PR**: reference #43 (`Part of #43`); do **not** close it.

## What to build

The deploy half of the pipeline. After images are built (0003), a **manual one-click
approval** through a GitHub `production` environment releases the deploy: a job SSHes to
the existing droplet as the unprivileged `govql` user (no sudo), fetches, checks out the
target commit, derives the image tag from that checked-out commit, pulls the pinned
images, and brings the stack up with `docker compose up -d`. Flyway keeps applying pending
migrations on `up`. The human gate is a required reviewer on the `production` environment,
and it is **removable later by changing one setting** (graduation to full continuous
deployment).

The on-box supervision model changes: the systemd `govql` unit goes from a **foreground**
`docker compose up` to a **one-shot** `docker compose up -d`, so an automated deploy can
recreate containers without fighting a foreground supervisor. Crash recovery relies on the
per-service `restart: always` already in compose (drop foreground supervision costs no
resilience). The invariant: running images always match the checked-out commit, so a
reboot brings back exactly what was deployed and boot + deploy derive the tag identically.

Credentials: a dedicated **deploy-only SSH key** (its public half authorizes the `govql`
user, its private half is a GitHub `production` environment secret) — separate from the
operator's personal key so revoking deploy access never touches it. The droplet's **host
key is pinned** and verified with strict host-key checking. Public GHCR images mean no
registry credentials on the box. **Application secrets stay on the droplet in dotenvx and
never enter CI** — the only environment secrets are the deploy key, the droplet host + its
pinned host key, and the Slack webhook.

The deploy is recorded as a **GitHub deployment against a named `production` environment**
for an audit trail of what shipped when.

**Notifications** (folded in — they ship with the deploy they describe): Slack on three
events — awaiting approval, success, and failure — each carrying the commit SHA and a link
to the run. GitHub's native environment notification for the approval prompt is kept as
well.

## AFK tasks

- [x] Extend the pipeline workflow with a `deploy` job gated on a GitHub `production` environment (required reviewer = the manual approval gate), depending on the 0003 build job.
- [x] Write the on-box deploy step as an SSH action running as `govql`: `git fetch` + checkout the target commit, derive the image tag from the checked-out commit, `docker compose pull`, `docker compose up -d` (dotenvx-wrapped for app secrets), with strict host-key checking against the pinned host key. *(Built as the forced-command pair `deploy/ci-deploy.sh` → `deploy/deploy.sh` with on-box digest verification — see Amendments.)*
- [x] Convert the systemd `govql` unit from foreground `docker compose up` to one-shot `docker compose up -d` (`Type=oneshot`, `RemainAfterExit=yes`), relying on compose `restart: always` for crash recovery; update the unit and the deploy docs in `us-congress/README.md`. *(Unit delegates to `deploy/up.sh`, the shared tag-derivation path.)*
- [x] Wire Slack notifications for awaiting-approval, success, and failure, each with the commit SHA and a run link, via a `SLACK_WEBHOOK_URL` environment secret; keep the native GitHub environment approval notification. *(Repo-level secret + outcomes from a `notify-outcome` follow-up job — see Amendments.)*
- [x] Record the run as a GitHub deployment against the `production` environment (deployment status transitions) for the audit trail. *(Via the deploy job's `environment:` key — GitHub creates the deployment + status transitions automatically.)*
- [x] Verify no application secret is read by CI — only the deploy key, droplet host/host-key, and Slack webhook are referenced as environment secrets. *(Enforced by a test: workflow.test.js allow-lists `secrets.*` across all workflows, and a CI `test` job runs it on every PR.)*

## Human-in-the-loop tasks

- [x] [decision] Confirm the operator + org setup: create the deploy-only SSH keypair, authorize its public half on the `govql` user, capture the pinned host key, and add the `production` environment secrets (deploy key, host, host key, Slack webhook) + required reviewer — this is operator/GitHub configuration, not code (talk-it-through).

### Decisions (talk-it-through 2026-07-13)

- **Host**: CI connects to `govql.us` (DNS name, not raw IP — survives re-provision).
- **Deploy key**: ed25519, no passphrase, generated locally as `~/.ssh/govql_deploy`.
  Public half installed in `~govql/.ssh/authorized_keys` prefixed with
  `no-port-forwarding,no-agent-forwarding,no-X11-forwarding`; a `command="…"`
  forced-command lock is deferred until the deploy script stabilizes. Direct
  SSH-as-`govql` is new — the user only had `authorized_keys` on their personal
  account; enablement is part of the operator runbook.
- **Host key pinning**: ed25519 host key only, captured with
  `ssh-keyscan -t ed25519 govql.us`, cross-checked against the operator's existing
  `known_hosts`; CI writes it to `known_hosts` and uses `StrictHostKeyChecking=yes`.
- **GitHub environment**: named `production`. Sensitivity split (deviates from the
  task text calling all four "secrets"): `DEPLOY_SSH_KEY` and `SLACK_WEBHOOK_URL`
  are environment **secrets**; `DROPLET_HOST` and `DROPLET_HOST_KEY` are environment
  **variables** (`vars.`) — both are public values, and unmasked logs make SSH/pinning
  failures debuggable. Required reviewer: Nathan (sole operator); prevent-self-review off.
- **Slack**: reuse the existing personal incoming webhook (the `SLACK_WEBHOOK_URL`
  already in `~/.zshenv`); a dedicated `#deploys` webhook is a later one-secret swap.
- **Execution**: the user runs the setup themselves from a copy-paste runbook
  (delivered in-chat 2026-07-13), after the workflow code is written and before the
  PR merges, so the first merge exercises the live approve→deploy path.

### Amendments (post-review, 2026-07-13)

Task-review findings applied in full after the user confirmed a **second repo
collaborator** with equivalent powers, which made the security majors live:

- **`SLACK_WEBHOOK_URL` is a repo-level secret, not an environment secret**
  (supersedes the decision above). The awaiting-approval ping must fire *before*
  the `production` gate, and a job outside the environment cannot read environment
  secrets. Residual risk accepted: a collaborator's PR-edited workflow run could
  exfiltrate the webhook — impact limited to forged chat messages.
- **The forced-command deferral is reversed.** The deploy key is bound to
  `command="/opt/govql/us-congress/deploy/ci-deploy.sh",restrict` in
  `authorized_keys`: the key can only hand a 40-hex sha to ci-deploy.sh, which
  refuses unknown commits and ancestor rollbacks (explicit rollback path arrives
  with task 0007). Rationale: `govql` is docker-group (root-equivalent), so an
  unrestricted key was a root path to the box.
- **Deploys verify image digests on-box** (addition). GHCR tags are mutable and
  `packages: write` reached PR-triggered runs, so: the images job records the
  digests it built (artifacts), the deploy job pipes them to the droplet, and
  `deploy.sh` refuses to start unless every pulled app image matches.
  `packages: write` also narrowed from workflow-level to the `images` job only.
- **A `test` job runs the deploy invariants + ingester suite in CI**, and
  `deploy` depends on it — the invariant tests were previously local-only.

### Round-2 amendments (2026-07-13, after re-review)

- **ci-deploy.sh also requires the sha to be reachable from `origin/main`** — a
  valid commit on an unmerged branch is refused.
- **Deploy serialization + a fourth notification** (both unrequested, kept):
  a `concurrency: production-deploy` group serializes deploys, and outcome
  pings come from a `notify-outcome` follow-up job keyed on
  `needs.deploy.result` (success/failure/cancelled) so a deploy cancelled
  before it starts — superseded in the queue or rejected at the gate — still
  reports. `notify-pending` waits on the tests too.
- **Digest artifacts kept 90 days** so a late one-click approval (GitHub allows
  up to 30 days) still finds them; `overwrite: true` keeps re-runs of the same
  sha deployable.

### Implementation log

- **Commits** (branch `43-one-click-production-deploy`): `65f06e3` feature,
  `9c50d46` round-1 review fixes, `0a4b8c0` round-2 review fixes.
- **Key paths**: `.github/workflows/us-congress.yml` (jobs: `images` → digest
  artifacts; `test`; `notify-pending`; `deploy` gated on `production`;
  `notify-outcome`), `us-congress/deploy/` (`up.sh` boot/manual path,
  `deploy.sh` pull+digest-verify, `ci-deploy.sh` forced command, five
  node:test files, own package.json), systemd unit + key setup + one-click
  docs in `us-congress/README.md`, deploy rule in `AGENTS.md`.
- **Reviews**: two full panel rounds in
  `reviews/0004-one-click-production-deploy-review.md` (branch-scoped).
  Round 1: 15 findings, all applied. Round 2: 14 findings; both majors, all
  four minors, retention nit applied and independently verified; remaining
  nits declined knowingly.
- **Operator runbook** delivered in-chat (env + secrets + forced-command
  authorized_keys line + optional hardening); droplet needs one manual
  `git pull` after merge so `ci-deploy.sh` exists before the first CI deploy.
- [x] [verify] A real merge → approve flow actually swaps the running stack on the droplet to the new SHA images, Flyway applies pending migrations on `up`, and a reboot brings back the same images — a live-droplet outcome that cannot be asserted in CI. *(Verified 2026-07-13 on PR #77's merge, `98920ae`: approve → stack swapped to the SHA-tagged images; reboot restored them — after the systemd unit was reinstalled (see live-deploy notes below). Flyway wiring confirmed — container exited 0, "no migration necessary" — but unexercised: this PR carried no migration; the first schema-carrying PR proves that half.)*
- [x] [verify] Slack receives the awaiting/success/failure pings with the right SHA and link — delivery to the live webhook can't be checked automatically. *(Verified 2026-07-13: ⏳ awaiting + ✅ success received with the merge SHA and a working run link.)*

### Live-deploy notes (2026-07-13, first run through the pipeline)

- **Runbook gap, fixed live**: updating `/etc/systemd/system/govql.service` on the
  droplet was in the README but missing from the operator runbook — the first
  reboot came back on the old foreground unit and `:latest` images. Reinstalling
  the unit (`tee` from the README + `daemon-reload` + `restart`) fixed it; the
  re-verify passed. Root cause matches the round-2 review's "unit test verifies
  docs, not the artifact" finding — extracting the unit into `deploy/` as a
  versioned file the droplet copies is a good 0008 item.
- **Disk**: the first pull duplicated the old locally-built image set; with the
  3.7 GB build cache the droplet hit 95%. One-time cleanup ran
  (`docker builder prune -af`, `docker image prune -af`, `docker volume prune -f`).
  Recurring concern handed to 0007: each deploy adds a ~1.7 GB image set and
  nothing prunes old ones — pruning must be rollback-aware (keep previous SHA).

## Acceptance criteria

- [x] A merge to `main` builds (0003) then **waits** on a one-click `production` approval before any production change.
- [x] On approval, the droplet pulls the SHA-tagged images and `up -d` swaps the stack as the unprivileged `govql` user with no sudo; Flyway applies pending migrations.
- [x] The systemd unit is one-shot `up -d`; a killed container is restarted by compose `restart: always`; a reboot restores the deployed images.
- [x] The deploy uses the deploy-only key with strict host-key checking; CI holds no application secrets.
- [x] The run appears as a GitHub deployment on the `production` environment, and Slack is pinged on awaiting/success/failure.
- [x] The approval gate can be removed by changing a single environment setting (documented).
