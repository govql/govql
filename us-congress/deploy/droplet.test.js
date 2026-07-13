// Invariants on the droplet's supervision model: the systemd unit (documented
// as a heredoc in us-congress/README.md) must be a one-shot `up -d` so an
// automated deploy can recreate containers without fighting a foreground
// supervisor — which is only safe while every app service carries compose
// `restart: always` for crash recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const HERE = dirname(fileURLToPath(import.meta.url));

test('the systemd unit in the README is a one-shot delegating to up.sh', () => {
  const readme = readFileSync(join(HERE, '..', 'README.md'), 'utf8');
  const unit = readme.match(/tee \/etc\/systemd\/system\/govql\.service <<EOF\n([\s\S]*?)\nEOF/)?.[1];
  assert.ok(unit, 'README documents the govql.service heredoc');
  assert.match(unit, /Type=oneshot/, 'one-shot, not a foreground supervisor');
  assert.match(unit, /RemainAfterExit=yes/, 'unit stays active after up -d returns');
  assert.match(unit, /ExecStart=.*deploy\/up\.sh/, 'boot uses the same up.sh as the deploy');
  assert.doesNotMatch(unit, /Restart=always/, 'crash recovery belongs to compose, not systemd');
});

test('every service has compose restart: always (what one-shot relies on)', () => {
  const compose = yaml.load(readFileSync(join(HERE, '..', 'compose.yml'), 'utf8'));
  // Run-to-completion services are the only exceptions.
  const runToCompletion = new Set(['flyway']);
  for (const [name, service] of Object.entries(compose.services)) {
    if (runToCompletion.has(name)) continue;
    assert.equal(service.restart, 'always', `${name} restarts on crash`);
  }
});
