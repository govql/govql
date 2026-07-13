// Behavioral tests for deploy/up.sh — the single script both the systemd unit
// (boot) and the CI deploy (--pull) use to bring the stack up, so boot and
// deploy derive the image tag identically.
//
// The script is copied into a sandbox that mimics the droplet layout
// (a git checkout with an us-congress/ subdir) and run against a stub
// `dotenvx` that records how it was invoked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Build a sandbox droplet checkout and run up.sh in it; return the stub log. */
function runUp(args = []) {
  const sandbox = mkdtempSync(join(tmpdir(), 'govql-up-'));
  const repo = join(sandbox, 'repo');
  const deployDir = join(repo, 'us-congress', 'deploy');
  mkdirSync(deployDir, { recursive: true });

  // A real git repo so `git rev-parse HEAD` yields a genuine commit sha.
  // Hermetic git: ignore the developer's global/system config (gpg signing, …).
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...a) =>
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], {
      env: gitEnv,
    });
  git('init', '-q');
  writeFileSync(join(repo, 'f'), 'x');
  git('add', 'f');
  git('commit', '-q', '-m', 'init');
  const sha = git('rev-parse', 'HEAD').toString().trim();

  copyFileSync(join(HERE, 'up.sh'), join(deployDir, 'up.sh'));
  chmodSync(join(deployDir, 'up.sh'), 0o755);

  // Stub dotenvx: record IMAGE_TAG plus the full argv, run nothing.
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  const log = join(sandbox, 'log');
  writeFileSync(join(bin, 'dotenvx'), `#!/bin/sh\necho "IMAGE_TAG=$IMAGE_TAG dotenvx $@" >> '${log}'\n`);
  chmodSync(join(bin, 'dotenvx'), 0o755);

  // HOME points into the sandbox: up.sh re-prepends $HOME/.local/bin to PATH
  // (where dotenvx really lives on the droplet), which would otherwise beat
  // the stub on any machine with dotenvx installed.
  execFileSync(join(deployDir, 'up.sh'), args, {
    env: { ...process.env, HOME: sandbox, PATH: `${bin}:${process.env.PATH}` },
  });
  return { sha, log: readFileSync(log, 'utf8').trim().split('\n') };
}

test('up.sh brings the stack up detached, pinned to the checked-out commit', () => {
  const { sha, log } = runUp();
  assert.deepEqual(log, [`IMAGE_TAG=${sha} dotenvx run -- docker compose up -d`]);
});

test('up.sh --pull pulls only the pinned app images before bringing the stack up', () => {
  // Only the four SHA-tagged app services: an unscoped pull would also
  // re-resolve the floating third-party tags (vector, pdc-agent), silently
  // upgrading them on every deploy.
  const { sha, log } = runUp(['--pull']);
  assert.deepEqual(log, [
    `IMAGE_TAG=${sha} dotenvx run -- docker compose pull scraper ingester server nginx`,
    `IMAGE_TAG=${sha} dotenvx run -- docker compose up -d`,
  ]);
});
