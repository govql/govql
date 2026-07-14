#!/usr/bin/env bash
# Rollback-aware image prune, run on the box after a successful swap (task 0007).
#
# Each deploy leaves a ~1.7 GB SHA-tagged image set and nothing else removes
# them, so the 24 GB droplet fills up (0004's first deploy hit 95%). Keep the
# current deploy plus one previous SHA set — so a quick rollback still has images
# to pull — and drop everything older. The currently-deployed tag is kept
# unconditionally regardless of age: after a rollback "current" is an older
# build, and it must never be pruned out from under the running stack.
#
# Best-effort: a prune hiccup must not fail an otherwise-healthy deploy, so the
# individual removals swallow their errors and the caller ignores this script's.
set -euo pipefail

# dotenvx/docker live in the govql user's ~/.local/bin (see up.sh); match it.
export PATH="$HOME/.local/bin:$PATH"

: "${IMAGE_TAG:?prune-images: IMAGE_TAG (the current deploy sha) must be set}"

APP_SERVICES=(scraper ingester server nginx)
KEEP_PREVIOUS=1 # prior SHA sets to retain beyond the current deploy

for svc in "${APP_SERVICES[@]}"; do
  repo="ghcr.io/govql/us-congress-${svc}"
  kept=0
  # `docker image ls <repo>` lists newest-first (its documented default), so
  # walking the SHA-tagged rows top-down keeps the newest previous sets and
  # prunes the tail.
  while IFS= read -r tag; do
    [[ "$tag" =~ ^[0-9a-f]{40}$ ]] || continue # skip 'latest' and other non-sha tags
    [[ "$tag" == "$IMAGE_TAG" ]] && continue    # never remove the current deploy
    if ((kept < KEEP_PREVIOUS)); then
      kept=$((kept + 1))
      continue
    fi
    docker image rm "${repo}:${tag}" >/dev/null 2>&1 || true
  done < <(docker image ls --format '{{.Tag}}' "$repo")
done
