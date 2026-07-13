#!/usr/bin/env bash
# Bring the us-congress stack up, pinned to the checked-out commit.
#
# The single tag-derivation path: both the systemd unit (boot, no args) and the
# CI deploy (--pull, after checking out the target commit) run this script, so
# a reboot always restores exactly the images that were deployed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# dotenvx lives in the govql user's ~/.local/bin, which systemd's default PATH lacks.
export PATH="$HOME/.local/bin:$PATH"

IMAGE_TAG="$(git rev-parse HEAD)"
export IMAGE_TAG

if [[ "${1:-}" == "--pull" ]]; then
  dotenvx run -- docker compose pull
fi

dotenvx run -- docker compose up -d
