// Behavioral tests for deploy/ci-deploy.sh — the forced command bound to the
// CI deploy key in authorized_keys. It is the entire attack surface the key
// exposes, so the contract is narrow: a 40-hex commit sha in
// SSH_ORIGINAL_COMMAND, or nothing happens.
//
// Sandbox: a bare "origin" repo plus a clone standing in for /opt/govql
// (GOVQL_ROOT). The committed us-congress/deploy/deploy.sh is a stub that
// logs, so the tests observe exactly what the forced command hands off to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CI_DEPLOY = join(HERE, 'ci-deploy.sh');

/** Bare origin + clone; committed deploy.sh stub logs its version + stdin. */
function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'govql-ci-deploy-'));
  const origin = join(sandbox, 'origin.git');
  const clone = join(sandbox, 'clone');
  const log = join(sandbox, 'log');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['clone', '-q', origin, clone]);

  const git = (...a) =>
    execFileSync('git', ['-C', clone, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a])
      .toString()
      .trim();

  const commitDeployStub = (version) => {
    const deployDir = join(clone, 'us-congress', 'deploy');
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(
      join(deployDir, 'deploy.sh'),
      `#!/bin/sh\necho "deploy.sh ${version} at $(git rev-parse HEAD) stdin=$(cat)" >> '${log}'\n`
    );
    chmodSync(join(deployDir, 'deploy.sh'), 0o755);
    git('add', '-A');
    git('commit', '-q', '-m', version);
    git('push', '-q', 'origin', 'HEAD');
    return git('rev-parse', 'HEAD');
  };

  const run = (sshCommand, input = '') =>
    execFileSync(CI_DEPLOY, [], {
      input,
      env: { ...process.env, SSH_ORIGINAL_COMMAND: sshCommand, GOVQL_ROOT: clone },
    });

  return { clone, git, commitDeployStub, run, log };
}

test('ci-deploy.sh rejects anything that is not a 40-hex commit sha', () => {
  const { commitDeployStub, run, log } = makeSandbox();
  commitDeployStub('v1');
  for (const bad of ['', 'main', 'rm -rf /', 'HEAD', 'abc123', `$(reboot)`]) {
    assert.throws(() => run(bad), /Command failed|non-zero/i, `rejects ${JSON.stringify(bad)}`);
  }
  assert.ok(!existsSync(log), 'deploy.sh never ran');
});

test('ci-deploy.sh fetches, checks out the target commit, and runs its deploy.sh', () => {
  const { git, commitDeployStub, run, log } = makeSandbox();
  commitDeployStub('v1');
  const v2 = commitDeployStub('v2');
  // Rewind the clone to v1 so the target only exists on origin — proving the
  // fetch — and so the *new* commit's deploy.sh is what runs after checkout.
  git('reset', '--hard', '-q', 'HEAD~1');
  run(v2, 'scraper sha256:aaa');
  assert.equal(
    readFileSync(log, 'utf8').trim(),
    `deploy.sh v2 at ${v2} stdin=scraper sha256:aaa`,
    'the target commit is checked out and its own deploy.sh receives stdin'
  );
  assert.equal(git('rev-parse', 'HEAD'), v2, 'clone left at the deployed commit');
});

test('ci-deploy.sh refuses to roll back to an ancestor of the deployed commit', () => {
  const { git, commitDeployStub, run, log } = makeSandbox();
  const v1 = commitDeployStub('v1');
  const v2 = commitDeployStub('v2');
  assert.throws(() => run(v1), /Command failed/i, 'ancestor sha is refused');
  assert.ok(!existsSync(log), 'deploy.sh never ran');
  assert.equal(git('rev-parse', 'HEAD'), v2, 'checkout untouched');
  // Re-deploying the current commit stays allowed (idempotent re-run).
  run(v2, '');
  assert.match(readFileSync(log, 'utf8'), /deploy\.sh v2/, 'same-sha redeploy runs');
});
