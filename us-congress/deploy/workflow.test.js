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
  assert.ok([].concat(deploy.needs).includes('images'), 'deploy depends on the images build');
  assert.equal(deploy.environment?.name, 'production', 'deploy is gated on the production environment');
  assert.equal(deploy.if, "github.event_name == 'push'", 'deploy runs only on push, never on PRs');
  // The "to main" half of the gate lives in the trigger, not the job condition.
  assert.deepEqual(workflow.on.push.branches, ['main'], 'push trigger is filtered to main');
});

test('deploy SSHes as the unprivileged govql user with a pinned host key', () => {
  const runs = workflow.jobs.deploy.steps.map((s) => s.run ?? '').join('\n');
  assert.match(raw, /vars\.DROPLET_HOST_KEY/, 'host key comes from the pinned environment variable');
  assert.match(runs, /StrictHostKeyChecking=yes/, 'strict host-key checking is on');
  assert.match(runs, /govql@/, 'connects as the govql user, not root');
  // The remote side is the forced command (ci-deploy.sh): the ssh command is
  // nothing but the target sha, and the built digests ride in on stdin.
  assert.match(runs, /"\$TARGET_SHA"\s*<\s*digests\.txt/, 'sends only the sha, digests on stdin');
  assert.doesNotMatch(runs, /git checkout|up\.sh|deploy\.sh/, 'no remote script inline — the forced command owns it');
});

test('the built digests travel from the images job to the deploy job', () => {
  const imagesSteps = workflow.jobs.images.steps;
  const upload = imagesSteps.find((s) => /upload-artifact/.test(s.uses ?? ''));
  assert.ok(upload, 'images uploads a digest artifact per matrix leg');
  assert.equal(upload.with.overwrite, true, 'a re-run of the same sha must not 409 on the artifact');
  assert.ok(
    upload.with['retention-days'] >= 30,
    'digests must outlive the 30-day environment approval window'
  );
  assert.match(
    imagesSteps.map((s) => s.run ?? '').join('\n'),
    /steps\.build\.outputs\.digest/,
    'the recorded digest is the one the build step reported'
  );
  const download = workflow.jobs.deploy.steps.find((s) => /download-artifact/.test(s.uses ?? ''));
  assert.ok(download, 'deploy downloads the digest artifacts');
});

test('CI runs the invariant tests and deploy waits on them', () => {
  const testJob = workflow.jobs.test;
  assert.ok(testJob, 'workflow has a test job');
  const runs = testJob.steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /us-congress\/deploy/, 'runs the deploy invariant tests');
  assert.match(runs, /us-congress\/ingester/, 'runs the ingester tests');
  assert.deepEqual(workflow.jobs.deploy.needs, ['images', 'test'], 'deploy waits on build and tests');
});

test('packages: write is scoped to the images job, not PR-triggered jobs at large', () => {
  assert.equal(workflow.permissions?.packages, undefined, 'no workflow-level packages permission');
  assert.equal(workflow.jobs.images.permissions?.packages, 'write', 'images job pushes');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'images') continue;
    assert.equal(job.permissions?.packages, undefined, `${name} cannot write packages`);
  }
});

test('deploy is verified from outside: external health check is the last step of the deploy job', () => {
  const steps = workflow.jobs.deploy.steps;
  const sshIndex = steps.findIndex((s) => /ssh /.test(s.run ?? ''));
  const healthIndex = steps.findIndex((s) => /health-check-run\.js/.test(s.run ?? ''));
  assert.ok(sshIndex !== -1, 'deploy has an SSH step — the ordering check below depends on it');
  assert.ok(healthIndex !== -1, 'deploy runs the external health-check poller');
  assert.ok(healthIndex > sshIndex, 'health check runs after the stack is brought up over SSH');
  assert.equal(
    healthIndex,
    steps.length - 1,
    'health check is the final step — its exit code is the deploy verdict notify-outcome reports'
  );
  // The poller lives in the repo, so the deploy job must check it out first.
  const checkoutIndex = steps.findIndex((s) => /actions\/checkout/.test(s.uses ?? ''));
  assert.ok(checkoutIndex !== -1, 'deploy checks out the repo to get the poller');
  assert.ok(checkoutIndex < healthIndex, 'checkout happens before the health check needs the poller');
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

test('the changelog is stamped before the docs image build, on deploys only', () => {
  const imagesSteps = workflow.jobs.images.steps;
  const stampIndex = imagesSteps.findIndex((s) => /stamp-changelog-run\.js/.test(s.run ?? ''));
  const buildIndex = imagesSteps.findIndex((s) => /build-push-action/.test(s.uses ?? ''));
  assert.ok(stampIndex !== -1, 'images job stamps the changelog');
  assert.ok(buildIndex !== -1, 'images job builds via build-push-action');
  assert.ok(stampIndex < buildIndex, 'stamp runs before the build so the published site carries the date');
  const stamp = imagesSteps[stampIndex];
  assert.match(stamp.if ?? '', /matrix\.name == 'nginx'/, 'stamp runs only for the docs image leg');
  assert.match(stamp.if ?? '', /github\.event_name == 'push'/, 'PR builds are never stamped');

  // The stamped file travels to the commit-back job by artifact, so main
  // receives exactly the bytes the image published — not a re-stamp whose
  // date could drift if the approval gate spans midnight in Chicago.
  const upload = imagesSteps.find(
    (s) => /upload-artifact/.test(s.uses ?? '') && /CHANGELOG\.md/.test(s.with?.path ?? '')
  );
  assert.ok(upload, 'the stamped changelog is uploaded as an artifact');
  assert.match(upload.if ?? '', /matrix\.name == 'nginx'/, 'uploaded once, from the stamped leg');
  assert.ok(
    upload.with['retention-days'] >= 30,
    'must outlive the 30-day environment approval window'
  );
  assert.equal(upload.with.overwrite, true, 'a re-run of the same sha must not 409 on the artifact');
});

test('the stamped changelog is committed back to main only after a healthy deploy', () => {
  const job = workflow.jobs['commit-changelog'];
  assert.ok(job, 'workflow has a commit-changelog job');
  assert.deepEqual(job.needs, ['deploy'], 'waits on the deploy');
  assert.match(
    job.if,
    /needs\.deploy\.result == 'success'/,
    'runs only when the deploy — health check included — succeeded'
  );
  assert.doesNotMatch(job.if, /always\(\)|failure\(\)/, 'a failed deploy discards the stamp');
  assert.equal(job.permissions?.contents, 'write', 'pushing to main needs contents: write');
  assert.equal(job.environment, undefined, 'not gated on a second approval');
  const stepsText = JSON.stringify(job.steps);
  assert.match(stepsText, /download-artifact/, 'commits the artifact the image was built from');
  assert.match(stepsText, /git push/, 'pushes the stamp back to main');
  // The built-in GITHUB_TOKEN is the primary loop guard: its pushes never
  // trigger workflow runs. No PAT or app token may sneak in here.
  assert.doesNotMatch(stepsText, /secrets\./, 'uses only the built-in token from checkout');
});

test('a changelog-only commit does not trigger the pipeline (secondary loop guard)', () => {
  for (const event of ['push', 'pull_request']) {
    assert.ok(
      workflow.on[event].paths.includes('!us-congress/CHANGELOG.md'),
      `${event} paths filter excludes the changelog`
    );
  }
});

test('Slack is pinged on awaiting-approval and on every deploy outcome, with sha + run link', () => {
  const slackStep = (s) => /SLACK_WEBHOOK_URL/.test(JSON.stringify(s));
  const carriesShaAndLink = (s) => {
    const text = JSON.stringify(s);
    assert.match(text, /GITHUB_SHA|github\.sha/, `${s.name} carries the commit sha`);
    assert.match(text, /RUN_URL/, `${s.name} carries the run link`);
  };

  // Awaiting approval: must fire before the gate, so it lives in its own job
  // outside the production environment. It waits on the tests too — a failed
  // test job skips the deploy, and a ping for a deploy that will never wait
  // at the gate is a false announcement.
  const pending = workflow.jobs['notify-pending'];
  assert.ok(pending, 'workflow has a notify-pending job');
  assert.deepEqual(pending.needs, ['images', 'test'], 'pending ping waits for build and tests');
  assert.equal(pending.if, "github.event_name == 'push'", 'pending ping only fires for real deploys');
  assert.equal(pending.environment, undefined, 'pending ping is not blocked by the approval gate');
  const pendingStep = pending.steps.find(slackStep);
  assert.ok(pendingStep, 'notify-pending posts to Slack');
  carriesShaAndLink(pendingStep);
  assert.equal(pendingStep['continue-on-error'], true, 'a Slack outage cannot fail the job');

  // Outcomes report from a follow-up job, not steps inside deploy: a deploy
  // cancelled before it starts (superseded in the concurrency group, or
  // rejected at the gate) never runs its steps, so only a needs:-dependent
  // job with an always() condition can report it.
  const outcome = workflow.jobs['notify-outcome'];
  assert.ok(outcome, 'workflow has a notify-outcome job');
  assert.deepEqual(outcome.needs, ['deploy'], 'outcome job watches the deploy');
  assert.match(outcome.if, /always\(\)/, 'runs even when deploy failed or was cancelled');
  assert.equal(outcome.environment, undefined, 'not blocked by the approval gate');
  assert.equal(outcome['continue-on-error'], true, 'a Slack outage cannot fail the run');
  const outcomeStep = outcome.steps.find(slackStep);
  assert.ok(outcomeStep, 'notify-outcome posts to Slack');
  carriesShaAndLink(outcomeStep);
  assert.match(JSON.stringify(outcome), /needs\.deploy\.result/, 'message keyed on the deploy result');
  for (const result of ['success', 'failure', 'cancelled']) {
    assert.match(outcomeStep.run, new RegExp(result), `handles ${result}`);
  }
  // No outcome pings inside deploy itself — they'd be skipped in exactly the
  // cases the follow-up job exists for.
  assert.equal(workflow.jobs.deploy.steps.filter(slackStep).length, 0, 'deploy has no Slack steps');
});
