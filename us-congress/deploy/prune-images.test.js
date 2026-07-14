// Behavioral tests for deploy/prune-images.sh — the rollback-aware on-box image
// prune run after a successful swap. Each deploy leaves a ~1.7 GB SHA-tagged
// image set and nothing else removes them, so the droplet fills up. The prune
// keeps the current deploy plus one previous SHA set (so a quick rollback still
// has images to pull) and drops everything older — and it must NEVER remove the
// currently-deployed tag, even when a rollback made "current" an older build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PRUNE = join(HERE, 'prune-images.sh');
const APPS = ['scraper', 'ingester', 'server', 'nginx'];
const sha = (c) => c.repeat(40);

/**
 * Sandbox with a docker stub whose `image ls <repo>` prints TAGS (newest-first,
 * the documented default order) and whose `image rm <ref>` logs the ref. Runs
 * the real prune-images.sh with IMAGE_TAG set to the "current" deploy.
 */
function runPrune({ tags, current }) {
  const sandbox = mkdtempSync(join(tmpdir(), 'govql-prune-'));
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  const log = join(sandbox, 'log');
  // The ls stub honors the format flag: with '--format {{.Tag}}' it emits bare
  // tags (newest-first); without it, it emits full table rows the way real
  // docker does — whose first column is a repo path, not a 40-hex tag — so a
  // regression that drops the format flag prunes nothing and fails the tests.
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
if [ "$1" = "image" ] && [ "$2" = "ls" ]; then
  case "$*" in
    *"{{.Tag}}"*) printf '%s\\n' $TAGS ;;
    *) for t in $TAGS; do printf 'ghcr.io/govql/us-congress-x %s abc123 1 day ago 500MB\\n' "$t"; done ;;
  esac
elif [ "$1" = "image" ] && [ "$2" = "rm" ]; then
  printf 'rm %s\\n' "$3" >> "$LOG"
fi
`
  );
  chmodSync(join(bin, 'docker'), 0o755);

  const env = {
    ...process.env,
    HOME: sandbox,
    PATH: `${bin}:${process.env.PATH}`,
    LOG: log,
    TAGS: tags.join(' '),
    IMAGE_TAG: current,
  };
  execFileSync(PRUNE, [], { env });
  let removed = [];
  try {
    removed = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.replace(/^rm /, ''));
  } catch {
    /* nothing removed */
  }
  return { removed };
}

test('prune keeps the current + previous SHA set and removes older ones, per app image', () => {
  const [c, b, a] = [sha('c'), sha('b'), sha('a')];
  // Newest-first: latest, current (c), previous (b), oldest (a).
  const { removed } = runPrune({ tags: ['latest', c, b, a], current: c });
  for (const svc of APPS) {
    const repo = `ghcr.io/govql/us-congress-${svc}`;
    assert.ok(removed.includes(`${repo}:${a}`), `${svc}: the oldest SHA set is pruned`);
    assert.ok(!removed.includes(`${repo}:${c}`), `${svc}: the current deploy is kept`);
    assert.ok(!removed.includes(`${repo}:${b}`), `${svc}: the previous SHA is kept for a quick rollback`);
    assert.ok(!removed.includes(`${repo}:latest`), `${svc}: the floating latest tag is never pruned`);
  }
});

test('prune never removes the current deploy even when a rollback made it the oldest build', () => {
  const [c, b, a] = [sha('c'), sha('b'), sha('a')];
  // Rolled back to the oldest build (a); it is "current" despite being oldest.
  const { removed } = runPrune({ tags: ['latest', c, b, a], current: a });
  for (const svc of APPS) {
    const repo = `ghcr.io/govql/us-congress-${svc}`;
    assert.ok(!removed.includes(`${repo}:${a}`), `${svc}: the rolled-back-to (current) build is never pruned`);
    assert.ok(!removed.includes(`${repo}:${c}`), `${svc}: one previous set (newest other) is kept to roll forward`);
    assert.ok(removed.includes(`${repo}:${b}`), `${svc}: the extra middle set is pruned`);
  }
});
