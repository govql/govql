// Behavioral tests for deploy/deploy.sh — the on-box CI deploy step: pull the
// four SHA-tagged app images, verify they are byte-for-byte the digests CI
// built (stdin), then hand off to up.sh. GHCR tags are mutable; the digest
// check is what makes the one-click approval trustworthy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APPS = ['scraper', 'ingester', 'server', 'nginx'];

/**
 * Sandbox droplet checkout with the real deploy.sh + up.sh, a logging dotenvx
 * stub, and a docker stub whose `image inspect` answers from fixture files.
 * `pulled` maps service name → the digest the "registry" actually served.
 */
function runDeploy({ stdin, pulled, args = [] }) {
  const sandbox = mkdtempSync(join(tmpdir(), 'govql-deploy-'));
  const repo = join(sandbox, 'repo');
  const deployDir = join(repo, 'us-congress', 'deploy');
  mkdirSync(deployDir, { recursive: true });

  // Hermetic git: ignore the developer's global/system config (gpg signing, …).
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...a) =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      env: gitEnv,
    });
  git('init', '-q');
  for (const f of ['deploy.sh', 'up.sh', 'prune-images.sh']) {
    copyFileSync(join(HERE, f), join(deployDir, f));
    chmodSync(join(deployDir, f), 0o755);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const sha = git('rev-parse', 'HEAD').toString().trim();

  const fixtures = join(sandbox, 'fixtures');
  mkdirSync(fixtures);
  for (const [name, digest] of Object.entries(pulled)) {
    writeFileSync(join(fixtures, name), `ghcr.io/govql/us-congress-${name}@${digest}\n`);
  }

  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  const log = join(sandbox, 'log');
  // printf, not echo: an inspect --format arg contains a literal \n that
  // echo would expand into a real newline, splitting the log line.
  writeFileSync(
    join(bin, 'dotenvx'),
    `#!/bin/sh\nprintf 'IMAGE_TAG=%s dotenvx %s\\n' "$IMAGE_TAG" "$*" >> "$LOG"\n`
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$LOG"
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  for ref; do :; done
  name=$(printf '%s' "$ref" | sed -E 's|.*/us-congress-([a-z]+):.*|\\1|')
  cat "$FIXTURES/$name"
fi
`
  );
  chmodSync(join(bin, 'dotenvx'), 0o755);
  chmodSync(join(bin, 'docker'), 0o755);

  const env = {
    ...process.env,
    HOME: sandbox,
    PATH: `${bin}:${process.env.PATH}`,
    LOG: log,
    FIXTURES: fixtures,
  };
  const exec = () => execFileSync(join(deployDir, 'deploy.sh'), args, { input: stdin, env });
  const readLog = () => {
    try {
      return readFileSync(log, 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  return { sha, exec, readLog };
}

const digestsFor = (names) => Object.fromEntries(names.map((n) => [n, `sha256:d-${n}`]));
const stdinFor = (digests) =>
  Object.entries(digests)
    .map(([n, d]) => `${n} ${d}`)
    .join('\n') + '\n';

test('deploy.sh pulls the app images, verifies their digests, and hands off to up.sh', () => {
  const digests = digestsFor(APPS);
  const { sha, exec, readLog } = runDeploy({ stdin: stdinFor(digests), pulled: digests });
  exec();
  const log = readLog();
  assert.equal(log[0], `IMAGE_TAG=${sha} dotenvx run -- docker compose pull scraper ingester server nginx`);
  for (const name of APPS) {
    assert.ok(
      log.includes(`docker image inspect --format {{join .RepoDigests "\\n"}} ghcr.io/govql/us-congress-${name}:${sha}`),
      `verifies ${name}`
    );
  }
  const upIndex = log.indexOf(`IMAGE_TAG=${sha} dotenvx run -- docker compose up -d`);
  assert.ok(upIndex !== -1, 'brings the stack up via up.sh');
  const pruneIndex = log.findIndex((l) => /docker image ls/.test(l));
  assert.ok(pruneIndex > upIndex, 'prunes old images only after the swap succeeds');
});

test('deploy.sh refuses to start the stack when a pulled digest does not match', () => {
  const digests = digestsFor(APPS);
  // The registry serves a different server image than CI built (tag overwritten).
  const { exec, readLog } = runDeploy({
    stdin: stdinFor(digests),
    pulled: { ...digests, server: 'sha256:poisoned' },
  });
  assert.throws(exec, /Command failed/i, 'digest mismatch aborts');
  const log = readLog().join('\n');
  assert.match(log, /compose pull/, 'the pull itself happened');
  assert.doesNotMatch(log, /up -d/, 'nothing was started');
});

test('deploy.sh refuses to pull at all when an expected digest is missing from stdin', () => {
  const digests = digestsFor(APPS);
  delete digests.nginx;
  const { exec, readLog } = runDeploy({ stdin: stdinFor(digests), pulled: digestsFor(APPS) });
  assert.throws(exec, /Command failed/i, 'incomplete digest list aborts');
  assert.deepEqual(readLog(), [], 'nothing was pulled or started');
});

test('deploy.sh --rollback pulls the retained images and starts the stack without digest verification (0007)', () => {
  // A rollback/redeploy of an already-shipped commit has no fresh build, so no
  // CI-recorded digests to check against (relax-on-rollback: the human approval
  // gate is the trust boundary). It pulls the retained SHA-tagged images and
  // brings the stack up — no stdin digests, no image inspect, no mismatch abort.
  const { sha, exec, readLog } = runDeploy({
    stdin: '',
    args: ['--rollback'],
    pulled: { ...digestsFor(APPS), server: 'sha256:whatever-the-registry-serves' },
  });
  exec();
  const log = readLog();
  assert.equal(log[0], `IMAGE_TAG=${sha} dotenvx run -- docker compose pull scraper ingester server nginx`, 'pulls the four app images');
  assert.ok(!log.some((l) => /image inspect/.test(l)), 'no digest verification on the rollback path');
  const upIndex = log.indexOf(`IMAGE_TAG=${sha} dotenvx run -- docker compose up -d`);
  assert.ok(upIndex !== -1, 'brings the stack up');
  const pruneIndex = log.findIndex((l) => /docker image ls/.test(l));
  assert.ok(pruneIndex > upIndex, 'the rollback path also prunes old images after the swap');
});
