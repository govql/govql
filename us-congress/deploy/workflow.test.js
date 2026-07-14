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
  // Runs on a merge to main OR a manual rollback/redeploy dispatch — never on a PR.
  assert.match(deploy.if, /github\.event_name == 'push'/, 'deploy runs on push');
  assert.match(deploy.if, /github\.event_name == 'workflow_dispatch'/, 'deploy also runs on a manual dispatch');
  assert.doesNotMatch(deploy.if, /pull_request/, 'deploy never runs on a PR');
  // The "to main" half of the gate lives in the trigger, not the job condition.
  assert.deepEqual(workflow.on.push.branches, ['main'], 'push trigger is filtered to main');
});

test('a manual workflow_dispatch takes a target sha and warns that migrations are forward-only (0007)', () => {
  const dispatch = workflow.on.workflow_dispatch;
  assert.ok(dispatch, 'workflow has a workflow_dispatch entry point');
  const input = dispatch.inputs?.sha;
  assert.ok(input, 'dispatch takes a `sha` input — the commit to (re)deploy');
  assert.equal(input.required, true, 'the target sha is required');
  assert.match(input.description, /forward-only/i, 'the input description surfaces the forward-only-migrations caveat');

  // The caveat is also surfaced in the run itself (step summary), not just the
  // dispatch form, so it is visible after the fact.
  const summaryStep = workflow.jobs.deploy.steps.find(
    (s) => /GITHUB_STEP_SUMMARY/.test(s.run ?? '') && /forward-only/i.test(s.run ?? '')
  );
  assert.ok(summaryStep, 'the deploy job writes the forward-only caveat to the run summary');
  assert.match(summaryStep.if ?? '', /workflow_dispatch/, 'the caveat summary is a dispatch-only step');
});

test('a dispatch deploys retained images: images build is skipped and the rollback command form is used (0007)', () => {
  // A rollback/redeploy pulls the target sha's already-built images — it must
  // not rebuild. So the images job does not run on a dispatch, and the deploy
  // job tolerates that skip.
  assert.match(workflow.jobs.images.if ?? '', /workflow_dispatch/, 'images job references the dispatch event to skip it');
  // The skipped-images allowance is scoped to the dispatch path. On a push,
  // images is also skipped by the changelog-stamp loop backstop, and deploy
  // must NOT run then — so a push still requires images to have succeeded.
  assert.match(
    workflow.jobs.deploy.if,
    /github\.event_name == 'workflow_dispatch' && needs\.images\.result == 'skipped'/,
    'a dispatch deploys even though images was skipped'
  );
  assert.match(
    workflow.jobs.deploy.if,
    /github\.event_name == 'push' && needs\.images\.result == 'success'/,
    'a push still requires a successful images build — skipped images (stamp-commit backstop) must not deploy'
  );

  const deploySteps = workflow.jobs.deploy.steps;
  // The target sha comes from the dispatch input on a dispatch, else the pushed sha.
  const sshStep = deploySteps.find((s) => /ssh /.test(s.run ?? ''));
  assert.match(JSON.stringify(sshStep.env ?? {}), /inputs\.sha/, 'TARGET_SHA resolves to the dispatch input');
  // The remote forced command gets the explicit `rollback <sha>` form so it
  // bypasses the ancestor guard and skips digest verification.
  assert.match(sshStep.run, /rollback \$TARGET_SHA/, 'a dispatch uses the rollback command form');
  // The digest artifacts only exist for a fresh build, so the download is push-only.
  const download = deploySteps.find((s) => /download-artifact/.test(s.uses ?? '') && /digest/.test(JSON.stringify(s)));
  assert.match(download.if ?? '', /push/, 'digest download is skipped on a dispatch (no fresh build)');

  // An empty/malformed dispatch input must fail loudly, not silently fall back
  // to deploying main's tip through the no-verification rollback path.
  const validate = deploySteps.find(
    (s) => /workflow_dispatch/.test(s.if ?? '') && /\[0-9a-f\]\{40\}/.test(s.run ?? '')
  );
  assert.ok(validate, 'a dispatch validates the target sha is a full 40-hex commit before deploying');
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

  // The stamp input is main's current changelog, not this sha's copy: a
  // re-run of an old sha (the redeploy path) must publish main's already-
  // stamped state, not re-stamp old entries with the re-run date.
  assert.match(stamp.run, /git fetch .*origin main/, 'stamp fetches main');
  assert.match(stamp.run, /git restore --source=FETCH_HEAD .*CHANGELOG\.md/, 'stamps main’s copy');
  // The stamp only runs when the changelog blob is identical between the
  // deployed sha and main's tip: a redeploy of an older sha (main's copy was
  // stamped since) must not assign today's date to entries whose code is not
  // in this image, while a race with a non-changelog merge stamps through.
  // A skip must be visible, not a silent unstamped publish.
  assert.match(
    stamp.run,
    /"\$\(git rev-parse FETCH_HEAD:us-congress\/CHANGELOG\.md\)" = "\$\(git rev-parse "\$GITHUB_SHA:us-congress\/CHANGELOG\.md"\)"/,
    'the stamp is gated on changelog-blob equality with main’s tip'
  );
  assert.match(stamp.run, /::warning::/, 'a skipped stamp annotates the run');

  // The stamped file travels to the commit-back job by artifact, so main
  // receives exactly the bytes the image published — not a re-stamp whose
  // date could drift if the approval gate spans midnight in Chicago. The
  // pre-stamp input rides along for the concurrent-edit guard to diff.
  const upload = imagesSteps.find(
    (s) => /upload-artifact/.test(s.uses ?? '') && /CHANGELOG\.md/.test(s.with?.path ?? '')
  );
  assert.ok(upload, 'the stamped changelog is uploaded as an artifact');
  assert.match(upload.with.path, /changelog-input/, 'the pre-stamp input is uploaded too');
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
  // trigger workflow runs. No PAT or app token may sneak in here — the only
  // secret this job may touch is the Slack webhook for the skip warning.
  const secretRefs = [...stepsText.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(secretRefs)],
    ['SLACK_WEBHOOK_URL'],
    'the push rides the built-in token from checkout; only the Slack webhook is referenced'
  );

  const runText = job.steps.map((s) => s.run ?? '').join('\n');
  // The concurrent-edit guard diffs main against the pre-stamp input the
  // artifact carried, and a skip must be loud: the deploy shipped healthy
  // but main stays unstamped until the next deploy.
  assert.match(runText, /changelog-input/, 'guard compares main against the stamped input');
  assert.match(runText, /::warning::/, 'a skipped commit-back annotates the run');
  assert.match(runText, /SLACK_WEBHOOK_URL/, 'a skipped commit-back pings Slack');
  // A merge landing between checkout and push must not strand the stamp.
  assert.match(runText, /git pull --rebase origin main/, 'push retries once after a rebase');
});

test('the bot stamp commit cannot re-trigger the pipeline (secondary loop guard)', () => {
  // Primary guard: the commit-back push rides the built-in GITHUB_TOKEN,
  // whose pushes never trigger workflow runs. Backstop: the images job skips
  // runs whose head commit is the stamp commit — and everything that could
  // loop (deploy, docs publish) needs images — so the guard holds even if
  // that push token is ever swapped for a PAT.
  const guard = workflow.jobs.images.if ?? '';
  const prefix = guard.match(/!startsWith\(github\.event\.head_commit\.message, '([^']+)'\)/);
  assert.ok(prefix, 'images job skips on the stamp commit-message prefix');
  assert.match(guard, /github\.event_name == 'pull_request'/, 'PRs (no head_commit) still build');
  assert.ok([].concat(workflow.jobs.deploy.needs).includes('images'), 'skipping images kills the deploy');

  // The guarded prefix must be the message commit-changelog actually writes,
  // or the backstop is inert.
  const commitRun = workflow.jobs['commit-changelog'].steps.map((s) => s.run ?? '').join('\n');
  const message = commitRun.match(/git commit -m "([^"]+)"/);
  assert.ok(message, 'commit-changelog commits with an inline message');
  assert.ok(
    message[1].startsWith(prefix[1]),
    `commit message "${message[1]}" carries the guarded prefix "${prefix[1]}"`
  );

  // No paths negation: it would also stop human changelog-only merges from
  // republishing the docs site, and strand changelog-only PRs with no CI.
  for (const event of ['push', 'pull_request']) {
    assert.ok(
      !workflow.on[event].paths.some((p) => p.startsWith('!')),
      `${event} paths filter has no negation`
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
