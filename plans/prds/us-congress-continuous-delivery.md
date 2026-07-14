# PRD: Continuous delivery for the `us-congress` stack

## Problem Statement

Deploying the `us-congress` stack is a manual SSH ritual, and the manual steps are
easy to get wrong. Building the Docusaurus site and forgetting to restart nginx takes
the docs site down. Shipping a batch of API changes and forgetting to date-stamp the
`## [Unreleased]` section leaves those changes stranded under "Unreleased" in the
public changelog. The heavy builds (`docker build`, `npm run build`) run on a 1 GB
droplet that already swaps, so a build competes with the live service for memory.
There is no record of what shipped when, no way to roll back except by hand, and no
signal when a deploy breaks something.

On top of the operational pain, this is a project used to build hireable skills. The
deploy story should hold up in an interview, not read as a hobby script.

## Solution

Merging to `main` builds the stack once, in CI, into immutable images tagged by commit
SHA and pushed to a public registry. The operator gets a notification, taps one button
to approve, and the droplet pulls those exact images and swaps to them. The docs site
is baked into its own image, so a docs change is an atomic container swap — there is no
separate build step on the box and no nginx restart to forget. The changelog is
date-stamped automatically as part of the deploy. After the stack comes up, the
pipeline checks the live site and API from the outside and reports success or failure
to Slack. Rolling back is the same one-button path pointed at an earlier commit.

The operator keeps a human gate in front of production but nothing else stays manual.

## User Stories

1. As the operator, I want a merge to `main` to build the stack automatically, so that I never build images by hand again.
2. As the operator, I want only changes under `us-congress/` to trigger a stack deploy, so that an mcp-server or root-docs change does not needlessly redeploy the API.
3. As the operator, I want the heavy image and docs builds to run in CI rather than on the droplet, so that a build never starves the live service of memory.
4. As the operator, I want every deploy built from immutable, SHA-tagged images, so that what runs in production is byte-identical to what CI tested.
5. As the operator, I want to approve each production deploy with a single click, so that a human still vets what ships without slowing me down.
6. As the operator, I want GitHub to notify me when a deploy is waiting on my approval, so that I know to go tap the button.
7. As the operator, I want a Slack ping when a deploy is awaiting approval, succeeds, or fails, so that I hear about every outcome where I live.
8. As the operator, I want the docs site baked into its own image, so that deploying docs is an atomic swap and "forgot to restart nginx" stops being possible.
9. As the operator, I want each app service to pull a prebuilt image in production but still build from source on my laptop, so that one compose file serves both without divergence.
10. As the operator, I want the running images to always match the checked-out commit on the box, so that a reboot brings back exactly what was deployed with no extra bookkeeping.
11. As the operator, I want the stack managed so that a deploy can recreate containers without fighting a foreground supervisor, so that automated deploys are not racy.
12. As the operator, I want a crashed container to restart on its own, so that dropping foreground supervision costs me no resilience.
13. As the operator, I want the deploy to run as an unprivileged user with no sudo, so that the deploy credential can do only what it needs.
14. As the operator, I want Flyway migrations to keep applying automatically on deploy, so that schema changes ship with the same flow as code.
15. As the operator, I want the `## [Unreleased]` changelog section stamped with the deploy date automatically, so that shipped API changes never sit stranded under "Unreleased."
16. As the operator, I want the changelog stamp to use my local (America/Chicago) date, so that the published date matches the day I shipped.
17. As the operator, I want the stamp to do nothing when there is nothing under "Unreleased," so that a plumbing-only deploy does not fabricate an empty release entry.
18. As the operator, I want to keep writing changelog entries by hand, so that the changelog stays curated to consumer-facing changes rather than filled with raw commit messages.
19. As the operator, I want the published docs changelog to reflect the freshly stamped date in the same deploy, so that the live site and the source never disagree.
20. As the operator, I want the stamped changelog committed back to `main` only after the deploy is confirmed healthy, so that the repo never claims a release that did not actually ship.
21. As the operator, I want the automated changelog commit to not trigger another deploy, so that stamping cannot loop.
22. As the operator, I want the pipeline to check the live docs site and API from the outside after a deploy, so that I know the real public path — DNS, TLS, nginx — is working, not just that a container started.
23. As the operator, I want the health check to retry for a couple of minutes, so that normal startup time is not mistaken for a failure.
24. As the operator, I want to roll back to a previous version with one click, so that recovering from a bad deploy is fast and needs no SSH.
25. As the operator, I want previous images retained in the registry, so that a rollback has something to pull.
26. As the operator, I want to know that database migrations are forward-only, so that I do not expect an image rollback to undo a schema change.
27. As the operator, I want to redeploy a specific commit on demand without a code change, so that I have an escape hatch for reruns and rollbacks.
28. As the operator, I want a deploy-only SSH key separate from my personal key, so that revoking deploy access never touches my own.
29. As the operator, I want the droplet's host key pinned, so that a spoofed host cannot harvest the deploy key.
30. As the operator, I want the images public so the droplet pulls them with no credentials, so that there is nothing to store or rotate on the box.
31. As the operator, I want CI to never hold my application secrets, so that the blast radius of the CI system is "can build and trigger a deploy," not "holds the database password."
32. As the operator, I want the deploy pipeline recorded as a deployment against a named environment, so that I have an audit trail of what shipped and when.
33. As the operator, I want the human approval gate to be removable later by changing one setting, so that I can graduate to fully automated deploys when my test coverage and monitoring justify it.
34. As an API consumer, I want the public changelog to carry accurate ship dates, so that I can reason about when a field or type actually became available.
35. As an API consumer, I want the docs site to stay up across deploys, so that reference material is available when I need it.
36. As a job interviewer, I want to hear a deploy story built on immutable artifacts, a registry, health checks, and a deliberate delivery-versus-deployment choice, so that I can gauge the candidate's judgment.

## Implementation Decisions

**Delivery model.** Continuous delivery, not continuous deployment. Building runs
automatically on merge to `main`; the production deploy waits on a one-click manual
approval through a GitHub `production` environment. The gate is removable later to
graduate to full continuous deployment. This choice was made deliberately over
auto-deploy-on-merge because the API is public and test coverage is thin.

**Artifact strategy.** Images are built in CI, tagged by commit SHA, and pushed to
GitHub Container Registry as **public** packages. The droplet pulls pinned tags and
never builds. Kamal and self-hosted PaaS options (Coolify, Dokploy) were evaluated and
rejected — Kamal for a Ruby dependency this Python/Node stack does not want and
adoption weaker than its profile suggests, PaaS for being too heavy for a 1 GB host and
for hiding the CI/CD primitives this project exists to learn.

**Images.** Four SHA-tagged images: `scraper`, `ingester`, `server`, and a custom
nginx image with the docs site baked in. The nginx image is a multi-stage build — one
stage builds the Docusaurus site, the final stage copies the built output into nginx.
This moves the memory-hungry `npm run build` off the droplet and makes a docs deploy an
atomic container swap. `nginx.conf` stays bind-mounted from the pinned checkout so
config-only tweaks do not force an image rebuild; TLS certificates stay a host mount.
Upstream images (`postgres`, `redis`, `flyway`, `vector`, `pdc-agent`) are unchanged.

**Compose wiring.** Each app service carries both an `image:` reference and a `build:`
section in one compose file. Production sets the tag and pulls; local development builds
from source with the existing dev override. Bind-mounted, pinned-checkout inputs remain
the migrations, database roles, nginx config, and vector config.

**On-box application.** The systemd unit changes from a foreground `docker compose up`
to a one-shot `docker compose up -d`; crash recovery relies on the per-service
`restart: always` already present in compose. The deploy runs as the existing
unprivileged `govql` user with no sudo: fetch, check out the target commit, derive the
image tag from the checked-out commit, pull, and bring the stack up. The invariant is
that running images always match the checked-out commit, so boot and deploy derive the
tag identically. Flyway continues to apply pending migrations on `up`.

**Module A — changelog stamp (deep, unit-tested).** A pure function taking changelog
text and a date and returning the stamped text plus a changed/unchanged flag. It locates
the `## [Unreleased]` heading, determines whether it holds real content, rewrites it to
a dated heading, and inserts a fresh empty Unreleased section above it. It is a no-op
when Unreleased is empty. All file and clock access lives in a thin CLI wrapper outside
the pure core. Tests exercise the pure boundary with string fixtures: empty Unreleased,
populated Unreleased, prior dated entries below, and malformed headings. Off-the-shelf
release automation (release-please, changesets, semantic-release) was rejected because
it derives entries from commits, which is the wrong content model for a curated,
consumer-facing changelog.

**Changelog ordering.** The stamp is applied to the working copy in CI before the docs
image is built, so the published site shows the date within the same deploy. The stamped
file is committed back to `main` only after the health check passes, using the built-in
workflow token so the commit cannot trigger another deploy; a path filter is added as a
secondary guard. A failed deploy discards the stamp rather than committing it. The
existing sync step renders the canonical changelog into the docs site on build, so no
second changelog is edited by hand. The mcp-server changelog is untouched.

**Module B — health-check poller (unit-tested).** Given the two public URLs, a trivial
GraphQL probe, and a timeout, it polls until both are green or the timeout elapses and
returns pass or fail. The retry, timeout, and aggregation logic is separated from the
HTTP call so it can be tested against a stubbed HTTP layer. The check runs from the CI
runner against the live public endpoints.

**Rollback.** Manual and one-click, via an on-demand workflow run pointed at a prior
commit — the same deploy path pointed backward. Prior SHA-tagged images are retained in
the registry. Rollback restores code and docs cleanly; database migrations are
forward-only, and additive schema evolution keeps the previous image compatible with the
newer schema, but a schema-caused failure may need hands-on intervention.

**Notifications.** Slack on three events — awaiting approval, success, and failure —
each carrying the commit SHA and a link to the run. GitHub's native environment
notification for the approval prompt is kept as well.

**Credentials.** A dedicated deploy-only SSH key; its public half authorizes the
`govql` user, its private half is a GitHub environment secret. The droplet's host key is
pinned and verified with strict checking. Public registry images mean no registry
credentials on the box; CI pushes with the built-in workflow token. Application secrets
stay on the droplet in dotenvx and never enter CI. Environment secrets are limited to
the deploy key, the droplet host and its pinned host key, and the Slack webhook.

## Out of Scope

- **GitHub review controls.** Branch protection, rulesets, and CODEOWNERS were
  discussed and deliberately parked. Reviews stay informal for now.
- **mcp-server publishing.** Automating the mcp-server release to PyPI (via Trusted
  Publishing / OIDC) is a separate follow-up. It shares no machinery with the droplet
  pipeline.
- **Automatic rollback.** Deferred to the same future step as removing the approval
  gate, when moving to full continuous deployment.
- **Forced-command hardening on the deploy key.** A worthwhile follow-up once the basic
  pipeline works, not part of the first version.
- **Staging environment and multi-server deploys.** The design targets the single
  existing droplet.
- **Undoing database migrations.** Migrations remain forward-only by design.

## Further Notes

The graduation path is explicit and intentional. Removing the approval gate and adding
health-check-gated automatic rollback are the two changes that convert this from
continuous delivery to continuous deployment; the pipeline is structured so both are
small, deliberate follow-ups rather than rewrites.

The forward-only nature of migrations is the one honest gap in "roll back to a previous
commit." It is acceptable here because the schema evolves additively — new columns and
tables, deprecate-before-remove — so an older server image keeps working against a newer
schema. It is called out so nobody expects an image rollback to reverse a migration.

There are two changelogs in the repository. This work automates only the
consumer-facing `us-congress` changelog, whose canonical file already follows the
Keep a Changelog "Unreleased" idiom and is rendered into the docs site by an existing
sync step. The mcp-server changelog is versioned, released to PyPI by hand, and left
alone.
