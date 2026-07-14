// The wrapper's process contract, exercised through the real CLI via the
// CHANGELOG_PATH override: exit codes are what the workflow's stamp step
// acts on, so they are pinned here rather than left to the pure-core tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUN_JS = fileURLToPath(new URL('./stamp-changelog-run.js', import.meta.url));

const runOn = (content) => {
  const path = join(mkdtempSync(join(tmpdir(), 'stamp-')), 'CHANGELOG.md');
  writeFileSync(path, content);
  const result = spawnSync(process.execPath, [RUN_JS], {
    env: { ...process.env, CHANGELOG_PATH: path },
    encoding: 'utf8',
  });
  return { ...result, file: readFileSync(path, 'utf8') };
};

test('wrapper: populated Unreleased → exit 0, file stamped with a fresh empty section', () => {
  const { status, file } = runOn('## [Unreleased]\n\n### Added\n\n- An entry.\n');
  assert.equal(status, 0);
  assert.match(file, /^## \[Unreleased\]\n\n## \[\d{4}-\d{2}-\d{2}\]\n/);
  assert.match(file, /- An entry\./);
});

test('wrapper: empty Unreleased → exit 0, file untouched', () => {
  const input = '## [Unreleased]\n\n## [2026-06-25]\n\n- Old entry.\n';
  const { status, file, stdout } = runOn(input);
  assert.equal(status, 0);
  assert.equal(file, input);
  assert.match(stdout, /nothing to stamp/);
});

test('wrapper: missing Unreleased heading → exit 1, file untouched', () => {
  const input = '## Unreleased\n\n- Entry under a malformed heading.\n';
  const { status, file, stderr } = runOn(input);
  assert.equal(status, 1);
  assert.equal(file, input);
  assert.match(stderr, /no "## \[Unreleased\]" heading/);
});
