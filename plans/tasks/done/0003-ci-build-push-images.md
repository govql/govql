# Task 0003: CI — build & push SHA-tagged images to GHCR

**Branch**: `43-ci-build-push-images`
**Depends on**: none
**Source**: PRD [`plans/prds/us-congress-continuous-delivery.md`](../prds/us-congress-continuous-delivery.md) · GitHub issue #43 · **User stories**: 1, 2, 3, 4, 8, 9, 30 — as the operator, I want a merge to `main` to build the whole `us-congress` stack once in CI into immutable, SHA-tagged, public images (never on the droplet), so what runs in production is byte-identical to what CI built and the memory-hungry builds never starve the live 1 GB host.
**PR**: reference #43 (`Part of #43`); do **not** close it — #43 spans the whole CD effort (tasks 0003–0008).

## What to build

The build half of the pipeline: merging to `main` builds four immutable images tagged
by commit SHA and pushes them to GitHub Container Registry as **public** packages. No
deploy yet — this task is done when the images reliably land in GHCR and local dev is
unchanged.

Four SHA-tagged images: `scraper`, `ingester`, `server` (the postgraphile-server), and a
custom **nginx image with the Docusaurus docs site baked in**. The nginx image is a
multi-stage build — one stage runs `npm run build` for the docs, the final stage copies
the built static output into nginx — which moves the memory-hungry docs build off the
droplet and turns a docs deploy into an atomic container swap. Upstream images
(`postgres`, `redis`, `flyway`, `vector`, `pdc-agent`) are unchanged and keep pulling
their public tags.

Each app service in `us-congress/compose.yml` carries **both** an `image:` reference
(GHCR, pinned by tag) and its existing `build:` section. Production sets the tag and
pulls; local development builds from source via the existing `compose.dev.yml` override,
which must keep working exactly as today. `nginx/nginx.conf` and the TLS certs stay
bind-mounted from the pinned checkout / host — config-only tweaks must not force an image
rebuild.

Path filter: only changes under `us-congress/` trigger this build, so an `mcp-server/` or
root-docs change does not needlessly rebuild the stack (mirrors the existing
`.github/workflows/mcp-server.yml` scoping).

## AFK tasks

- [x] Add a `nginx/Dockerfile` (multi-stage): build stage runs the Docusaurus build from `docs/`, final stage is `nginx:...` with the built site copied to the served root; keep `nginx.conf` as a bind mount, not baked in. → `us-congress/nginx/Dockerfile` (node:24-slim build stage → nginx:1.27-alpine; `db/migrations/` + `CHANGELOG.md` copied as siblings of `docs/` so the prebuild scripts resolve).
- [x] Add `image:` references (GHCR path, tag driven by a build arg / env, defaulting to a SHA tag) to the `scraper`, `ingester`, `server`, and `nginx` services in `compose.yml`, keeping each service's existing `build:` section so one compose file serves both prod-pull and local-build. → `${IMAGE_TAG:-latest}` on all four.
- [x] Confirm `compose.dev.yml` still builds all services from source locally with no GHCR access, and document the one-liner in the task PR (dev path must not regress). → `docker compose config` validated both prod (IMAGE_TAG set) and dev-merge; one-liner documented in PR #76.
- [x] Add `.github/workflows/deploy.yml` (or `build.yml`) triggered on push to `main` with a `paths: us-congress/**` filter: build all four images, tag each with the commit SHA (and optionally `latest`/`main`), and push to GHCR using the built-in `GITHUB_TOKEN` (no stored registry creds). → `.github/workflows/us-congress.yml` (matrix, full-SHA tag + `latest` on main, build-only on PRs).
- [x] Ensure the four GHCR packages are configured **public** so the droplet can pull with no credentials (document the one-time package-visibility step in the PR if it can't be set from the workflow). → Not settable from the workflow; the one-time visibility step is documented in PR #76 as a post-merge operator action.
- [ ] Verify the built `server`, `scraper`, `ingester` images run the same entrypoints as the current source build (smoke: `docker run` the built image locally or in CI shows the expected process starts). → **Deferred: Docker daemon unavailable locally; covered by the CI build on merge.**

## Human-in-the-loop tasks

- [ ] [verify] The four SHA-tagged images appear in GHCR as public packages after a real merge to `main`, and a `us-congress/`-scoped change triggers the build while an `mcp-server/`-only change does not — can't be fully asserted without an actual push to the live repo/registry.

## Acceptance criteria

- [ ] A merge to `main` touching `us-congress/` produces four images in GHCR, each tagged with the triggering commit SHA. → verified post-merge (workflow runs on merge).
- [ ] The nginx image serves the built docs site with no `npm run build` on the droplet. → verified post-merge (real image build).
- [x] `compose.yml` app services carry both `image:` and `build:`; `docker compose -f compose.yml -f compose.dev.yml up --build` still builds everything from source locally. → validated via `docker compose config`.
- [ ] The build does **not** run for a change confined to `mcp-server/` or root docs. → `paths:` filter set; verified post-merge on a real triggering/non-triggering change.
- [ ] Images are public; no registry credentials are required to pull. → post-merge operator step, documented in PR #76.

## Implementation log

- **2026-07-13** — Built on `43-ci-build-push-images`, opened as PR #76 (`Part of #43`). Four files: new `.github/workflows/us-congress.yml`, new `us-congress/nginx/Dockerfile`, new `us-congress/.dockerignore`, modified `us-congress/compose.yml`.
- **Task-review**: 4-lens panel (Standards/Spec/Bug/Security), no blockers/majors. Applied both suggested fixes — a comment explaining `node:24-slim` (required for docusaurus-faster's prebuilt binaries) and `.dockerignore` exclusions for key material (`.env.keys`, `*.pem`, `*.key`, `certs/`; `.env` left in as dotenvx ciphertext). Review at `reviews/0003-ci-build-push-images-review.md`.
- **Local verification limits**: Docker daemon unavailable, so image build/push, entrypoint smoke, and GHCR publish are verified by the CI run on merge (the task's `[verify]` item). Static checks passed: compose config valid, workflow YAML parses, all Dockerfile COPY sources present.
- **CI feedback fix (post-open)**: the first PR run failed all four builds — `cache-to: type=gha` isn't supported by the runner's default `docker` buildx driver. Added `docker/setup-buildx-action` (docker-container driver). Rerun: **all four images build green, including the nginx docusaurus multi-stage** — so the Dockerfile COPY layout is now validated by a real build, not just reasoning. (The review panel checked build logic but not the runner's buildx driver capability.)
- **Post-merge follow-ups**: set the four GHCR packages to Public; confirm the merge-to-main run *pushes* four SHA-tagged packages (the PR run is build-only) and that path-filtering behaves.
