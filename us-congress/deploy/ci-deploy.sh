#!/usr/bin/env bash
# Forced command for the CI deploy key (the `command=` option on its
# authorized_keys line) — the only thing the key can do. Validates the
# requested commit, checks it out, and hands off to that commit's deploy.sh;
# stdin passes through, carrying the expected image digests. Kept tiny and
# stable: the deploy logic itself is versioned with the code it deploys.
set -euo pipefail

sha="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ci-deploy: expected a 40-hex commit sha, got: ${sha}" >&2
  exit 1
fi

cd "${GOVQL_ROOT:-/opt/govql}"
git fetch origin

if ! git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null; then
  echo "ci-deploy: unknown commit ${sha}" >&2
  exit 1
fi

# Refuse silent rollbacks: approving an older queued run after a newer one
# already deployed must not downgrade production. (Task 0007 adds an explicit
# rollback path.)
current="$(git rev-parse HEAD)"
if [[ "$sha" != "$current" ]] && git merge-base --is-ancestor "$sha" "$current"; then
  echo "ci-deploy: refusing rollback — ${sha} is an ancestor of deployed ${current}" >&2
  exit 1
fi

git checkout --detach "$sha"
exec us-congress/deploy/deploy.sh
