# Custom nginx image with the Docusaurus docs site baked in.
#
# Build context is the `us-congress/` root (not `nginx/`), because the docs
# `prebuild` hook renders inputs that live outside `docs/`:
#   docs/scripts/generate-schema-docs.mjs → reads ../../db/migrations
#   docs/scripts/sync-changelog.mjs       → reads ../../CHANGELOG.md
# so `db/migrations/` and `CHANGELOG.md` must sit next to `docs/` in the build
# stage, mirroring the repo layout the scripts resolve against.
#
# Only the built static site is baked in. `nginx.conf` and the TLS certs stay
# bind-mounted at runtime (see compose.yml) so a config-only or cert change is
# not an image rebuild.

# --- Stage 1: render the static docs site ------------------------------------
# node:24-slim (debian), not node:24-alpine like the other services: the
# @docusaurus/faster toolchain (Rspack/SWC) ships prebuilt glibc native
# binaries, so an alpine/musl base would fail to run them. The build stage is
# discarded in the final image, so its size doesn't matter.
FROM node:24-slim AS docs-build
WORKDIR /build

# Install deps first for layer caching (package manifests change rarely).
COPY docs/package.json docs/package-lock.json ./docs/
RUN cd docs && npm ci

# Inputs the prebuild hook reads, placed as siblings of docs/ per the paths above.
COPY db/migrations ./db/migrations
COPY CHANGELOG.md ./CHANGELOG.md
COPY docs ./docs

# `npm run build` runs the prebuild hook (schema docs + changelog sync) then
# `docusaurus build`, emitting the static site to docs/build.
RUN cd docs && npm run build

# --- Stage 2: nginx serving the baked site -----------------------------------
FROM nginx:1.27-alpine
COPY --from=docs-build /build/docs/build /usr/share/nginx/html
