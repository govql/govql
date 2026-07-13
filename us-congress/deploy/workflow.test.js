// Invariants on the CI workflow's deploy half (.github/workflows/us-congress.yml):
// the one-click production gate, SSH hardening, the secrets allow-list, and the
// Slack notifications. These guard the deploy pipeline's shape against drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(HERE, '..', '..', '.github', 'workflows');
const WORKFLOW_PATH = join(WORKFLOWS_DIR, 'us-congress.yml');
const raw = readFileSync(WORKFLOW_PATH, 'utf8');
const workflow = yaml.load(raw);

test('deploy job waits on the images build and the production environment gate', () => {
  const deploy = workflow.jobs.deploy;
  assert.ok(deploy, 'workflow has a deploy job');
  assert.equal(deploy.needs, 'images', 'deploy depends on the images build');
  assert.equal(deploy.environment?.name, 'production', 'deploy is gated on the production environment');
  assert.match(deploy.if ?? '', /push/, 'deploy runs only on push to main, never on PRs');
});

test('deploy SSHes as the unprivileged govql user with a pinned host key', () => {
  const runs = workflow.jobs.deploy.steps.map((s) => s.run ?? '').join('\n');
  assert.match(raw, /vars\.DROPLET_HOST_KEY/, 'host key comes from the pinned environment variable');
  assert.match(runs, /StrictHostKeyChecking=yes/, 'strict host-key checking is on');
  assert.match(runs, /govql@/, 'connects as the govql user, not root');
  assert.match(runs, /git checkout --detach/, 'checks out the exact pushed commit');
  assert.match(runs, /up\.sh --pull/, 'delegates to the shared up.sh tag-derivation path');
});

test('CI reads no application secrets — deploy key, Slack webhook, GITHUB_TOKEN only', () => {
  // App secrets live on the droplet in dotenvx and must never enter CI.
  const allowed = new Set(['GITHUB_TOKEN', 'DEPLOY_SSH_KEY', 'SLACK_WEBHOOK_URL']);
  for (const file of readdirSync(WORKFLOWS_DIR)) {
    const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
    for (const [, name] of text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
      assert.ok(allowed.has(name), `${file} references non-allow-listed secret ${name}`);
    }
  }
});

test('Slack is pinged on awaiting-approval, success, and failure with sha + run link', () => {
  const slackStep = (s) => /SLACK_WEBHOOK_URL/.test(JSON.stringify(s));
  const carriesShaAndLink = (s) => {
    const text = JSON.stringify(s);
    assert.match(text, /GITHUB_SHA|github\.sha/, `${s.name} carries the commit sha`);
    assert.match(text, /RUN_URL/, `${s.name} carries the run link`);
  };

  // Awaiting approval: must fire before the gate, so it lives in its own job
  // outside the production environment.
  const pending = workflow.jobs['notify-pending'];
  assert.ok(pending, 'workflow has a notify-pending job');
  assert.equal(pending.needs, 'images', 'pending ping waits for the build');
  assert.match(pending.if ?? '', /push/, 'pending ping only fires for real deploys');
  assert.equal(pending.environment, undefined, 'pending ping is not blocked by the approval gate');
  const pendingStep = pending.steps.find(slackStep);
  assert.ok(pendingStep, 'notify-pending posts to Slack');
  carriesShaAndLink(pendingStep);

  // Success and failure: steps inside the deploy job.
  const outcomes = workflow.jobs.deploy.steps.filter(slackStep);
  const byIf = Object.fromEntries(outcomes.map((s) => [s.if, s]));
  assert.ok(byIf['success()'], 'deploy posts to Slack on success');
  assert.ok(byIf['failure()'], 'deploy posts to Slack on failure');
  carriesShaAndLink(byIf['success()']);
  carriesShaAndLink(byIf['failure()']);
});
