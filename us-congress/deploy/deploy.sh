#!/usr/bin/env bash
# On-box CI deploy for the checked-out commit: pull the four SHA-tagged app
# images, verify they are byte-for-byte the digests CI just built, then hand
# off to up.sh. Invoked by ci-deploy.sh with the expected digests on stdin,
# one "<service> <sha256:...>" line per app service.
#
# A GHCR tag is mutable — between the build and the one-click approval it
# could have been overwritten by anyone with packages:write — so nothing
# starts unless every pulled image matches the digest CI reported.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# dotenvx lives in the govql user's ~/.local/bin (see up.sh).
export PATH="$HOME/.local/bin:$PATH"

IMAGE_TAG="$(git rev-parse HEAD)"
export IMAGE_TAG

APP_SERVICES=(scraper ingester server nginx)

digests="$(cat)"
digest_for() {
  printf '%s\n' "$digests" | awk -v n="$1" '$1 == n { print $2; exit }'
}

# Every app service must come with an expected digest before anything pulls.
for name in "${APP_SERVICES[@]}"; do
  if [[ -z "$(digest_for "$name")" ]]; then
    echo "deploy: no expected digest for ${name} on stdin" >&2
    exit 1
  fi
done

dotenvx run -- docker compose pull "${APP_SERVICES[@]}"

for name in "${APP_SERVICES[@]}"; do
  ref="ghcr.io/govql/us-congress-${name}:${IMAGE_TAG}"
  want="ghcr.io/govql/us-congress-${name}@$(digest_for "$name")"
  if ! docker image inspect --format '{{join .RepoDigests "\n"}}' "$ref" | grep -qxF "$want"; then
    echo "deploy: digest mismatch for ${name} — pulled ${ref} is not $(digest_for "$name")" >&2
    exit 1
  fi
done

exec "$SCRIPT_DIR/up.sh"
