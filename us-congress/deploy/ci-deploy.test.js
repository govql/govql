// Behavioral tests for deploy/ci-deploy.sh — the forced command bound to the
// CI deploy key in authorized_keys. It is the entire attack surface the key
// exposes, so the contract is narrow: a 40-hex sha of a commit reachable from
// origin/main in SSH_ORIGINAL_COMMAND, or nothing happens.
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

// Ignore the developer's global/system git config (gpg signing, hooksPath, …)
// so the sandbox behaves the same on every machine.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

/** Bare origin + clone; committed deploy.sh stub logs its version + stdin. */
function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'govql-ci-deploy-'));
  const origin = join(sandbox, 'origin.git');
  const clone = join(sandbox, 'clone');
  const log = join(sandbox, 'log');
  const env = { ...process.env, ...GIT_ENV };
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { env });
  execFileSync('git', ['clone', '-q', origin, clone], { env });

  const git = (...a) =>
    execFileSync('git', ['-C', clone, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { env })
      .toString()
      .trim();

  const commitDeployStub = (version) => {
    const deployDir = join(clone, 'us-congress', 'deploy');
    mkdirSync(deployDir, { recursive: true });
    writeFileSync(
      join(deployDir, 'deploy.sh'),
      `#!/bin/sh\necho "deploy.sh ${version} at $(git rev-parse HEAD) args=$* stdin=$(cat)" >> '${log}'\n`
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
      env: { ...env, SSH_ORIGINAL_COMMAND: sshCommand, GOVQL_ROOT: clone },
    });

  return { clone, git, commitDeployStub, run, log };
}

/** assert.throws matcher that also pins which guard fired via its stderr. */
const refusedWith = (pattern) => (err) => {
  assert.match(String(err.stderr), pattern, `stderr names the guard: ${pattern}`);
  return true;
};

test('ci-deploy.sh rejects anything that is not a 40-hex commit sha', () => {
  const { commitDeployStub, run, log } = makeSandbox();
  commitDeployStub('v1');
  for (const bad of ['', 'main', 'rm -rf /', 'HEAD', 'abc123', `$(reboot)`]) {
    assert.throws(() => run(bad), refusedWith(/expected a 40-hex commit sha/), `rejects ${JSON.stringify(bad)}`);
  }
  assert.ok(!existsSync(log), 'deploy.sh never ran');
});

test('ci-deploy.sh rejects a well-formed sha that names no commit', () => {
  const { git, commitDeployStub, run, log } = makeSandbox();
  const v1 = commitDeployStub('v1');
  assert.throws(() => run('f'.repeat(40)), refusedWith(/unknown commit/));
  assert.ok(!existsSync(log), 'deploy.sh never ran');
  assert.equal(git('rev-parse', 'HEAD'), v1, 'checkout untouched');
});

test('ci-deploy.sh rejects a commit that is not reachable from origin/main', () => {
  const { git, commitDeployStub, run, log } = makeSandbox();
  const v1 = commitDeployStub('v1');
  // A real commit, fetched, but only on an unmerged side branch.
  git('checkout', '-q', '-b', 'feature');
  const unmerged = commitDeployStub('feature-v1');
  git('checkout', '-q', 'main');
  assert.throws(() => run(unmerged), refusedWith(/not reachable from origin\/main/));
  assert.ok(!existsSync(log), 'deploy.sh never ran');
  assert.equal(git('rev-parse', 'HEAD'), v1, 'checkout untouched');
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
    `deploy.sh v2 at ${v2} args= stdin=scraper sha256:aaa`,
    'the target commit is checked out and its own deploy.sh receives stdin, no rollback flag'
  );
  assert.equal(git('rev-parse', 'HEAD'), v2, 'clone left at the deployed commit');
});

test('ci-deploy.sh refuses to roll back to an ancestor of the deployed commit', () => {
  const { git, commitDeployStub, run, log } = makeSandbox();
  const v1 = commitDeployStub('v1');
  const v2 = commitDeployStub('v2');
  assert.throws(() => run(v1), refusedWith(/refusing rollback/), 'ancestor sha is refused');
  assert.ok(!existsSync(log), 'deploy.sh never ran');
  assert.equal(git('rev-parse', 'HEAD'), v2, 'checkout untouched');
  // Re-deploying the current commit stays allowed (idempotent re-run).
  run(v2, '');
  assert.match(readFileSync(log, 'utf8'), /deploy\.sh v2/, 'same-sha redeploy runs');
});

test('ci-deploy.sh "rollback <sha>" deploys an ancestor the plain form refuses (0007)', () => {
  const { git, commitDeployStub, run, log } = makeSandbox();
  const v1 = commitDeployStub('v1');
  const v2 = commitDeployStub('v2');
  // The plain form refuses v1 (an ancestor of the deployed v2); the explicit
  // rollback form is the operator's break-glass that bypasses that guard.
  assert.throws(() => run(v1), refusedWith(/refusing rollback/), 'plain form still refuses the ancestor');
  run(`rollback ${v1}`, '');
  assert.match(readFileSync(log, 'utf8'), new RegExp(`deploy\\.sh v1 at ${v1}`), 'rollback checks out v1 and runs its deploy.sh');
  assert.equal(git('rev-parse', 'HEAD'), v1, 'clone left at the rolled-back commit');
});

test('ci-deploy.sh "rollback" keeps the sha-shape and reachable-from-main guards (0007)', () => {
  const { git, commitDeployStub, run, log } = makeSandbox();
  const v1 = commitDeployStub('v1');
  // Anything but a bare 40-hex sha after the keyword is rejected — the rollback
  // form must not become an injection hole.
  for (const bad of [
    'rollback',
    'rollback main',
    'rollback abc123',
    `rollback ${'f'.repeat(39)}`, // one hex short of 40
    `rollback ${'f'.repeat(41)}`, // one hex over 40
    `rollback ${v1} ; reboot`,
  ]) {
    assert.throws(() => run(bad), refusedWith(/expected a 40-hex commit sha/), `rejects ${JSON.stringify(bad)}`);
  }
  // A real commit that never landed on main is still refused, even via rollback.
  git('checkout', '-q', '-b', 'feature');
  const unmerged = commitDeployStub('feature-v1');
  git('checkout', '-q', 'main');
  assert.throws(() => run(`rollback ${unmerged}`), refusedWith(/not reachable from origin\/main/));
  assert.ok(!existsSync(log), 'deploy.sh never ran');
});

test('ci-deploy.sh signals rollback to deploy.sh with --rollback, plain deploys without it (0007)', () => {
  const { commitDeployStub, run, log } = makeSandbox();
  const v1 = commitDeployStub('v1');
  run(`rollback ${v1}`, '');
  assert.match(readFileSync(log, 'utf8'), /deploy\.sh v1 .* args=--rollback /, 'rollback hands deploy.sh the --rollback flag');
  run(v1, 'scraper sha256:aaa');
  assert.match(readFileSync(log, 'utf8'), /deploy\.sh v1 .* args= stdin=scraper/, 'a plain deploy carries no rollback flag and gets the digests');
});
