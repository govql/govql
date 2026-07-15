#!/usr/bin/env bash
# Forced command for the CI deploy key (the `command=` option on its
# authorized_keys line) — the only thing the key can do. Validates the
# requested commit, checks it out, and hands off to that commit's deploy.sh;
# stdin passes through, carrying the expected image digests. Kept tiny and
# stable: the deploy logic itself is versioned with the code it deploys.
set -euo pipefail

# Two accepted forms in SSH_ORIGINAL_COMMAND, nothing else:
#   <sha>            normal deploy — refuses ancestor rollbacks, digests on stdin
#   rollback <sha>   explicit rollback / on-demand redeploy (task 0007) — bypasses
#                    the ancestor guard and skips digest verification (the images
#                    were built by a prior run; the human production-approval gate
#                    is the trust boundary for this break-glass path).
cmd="${SSH_ORIGINAL_COMMAND:-}"
rollback=""
if [[ "$cmd" == rollback\ * ]]; then
  rollback=1
  sha="${cmd#rollback }"
else
  sha="$cmd"
fi

if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ci-deploy: expected a 40-hex commit sha, got: ${cmd}" >&2
  exit 1
fi

cd "${GOVQL_ROOT:-/opt/govql}"
git fetch origin

if ! git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null; then
  echo "ci-deploy: unknown commit ${sha}" >&2
  exit 1
fi

# Only commits that made it onto main deploy — a valid sha on an unmerged
# branch must not get its deploy.sh executed.
if ! git merge-base --is-ancestor "$sha" origin/main; then
  echo "ci-deploy: refusing ${sha} — not reachable from origin/main" >&2
  exit 1
fi

# Refuse silent rollbacks: approving an older queued run after a newer one
# already deployed must not downgrade production. The explicit `rollback <sha>`
# form (task 0007) is the sanctioned bypass — it is the only way an ancestor
# deploys, so the default stays safe.
if [[ -z "$rollback" ]]; then
  current="$(git rev-parse HEAD)"
  if [[ "$sha" != "$current" ]] && git merge-base --is-ancestor "$sha" "$current"; then
    echo "ci-deploy: refusing rollback — ${sha} is an ancestor of deployed ${current}" >&2
    exit 1
  fi
fi

git checkout --detach "$sha"
if [[ -n "$rollback" ]]; then
  exec us-congress/deploy/deploy.sh --rollback
else
  exec us-congress/deploy/deploy.sh
fi
