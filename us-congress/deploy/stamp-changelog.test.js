import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stampChangelog } from './stamp-changelog.js';

test('empty Unreleased → no-op', () => {
  const input = [
    '# Changelog',
    '',
    '### What belongs here',
    '',
    'Only changes visible to people querying the API.',
    '',
    '## [Unreleased]',
    '',
    '## 2026-06-29',
    '',
    '### Security',
    '',
    '- Hardened the service. (#36)',
    '',
  ].join('\n');

  const { text, changed, reason } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, false);
  assert.equal(reason, 'empty');
  assert.equal(text, input);
});

test('no Unreleased heading → no-op with a no-heading reason', () => {
  const input = ['# Changelog', '', '## [2026-06-25]', '', '- An old field.', ''].join('\n');

  const { text, changed, reason } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, false);
  assert.equal(reason, 'no-heading');
  assert.equal(text, input);
});

test('near-miss heading (no brackets) is not recognized → no-op with a no-heading reason', () => {
  const input = ['## Unreleased', '', '- An entry under a malformed heading.', ''].join('\n');

  const { text, changed, reason } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, false);
  assert.equal(reason, 'no-heading');
  assert.equal(text, input);
});

test('populated Unreleased as the last section → stamped at end of file', () => {
  const input = ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- First ever entry.', ''].join('\n');

  const { text, changed } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, true);
  assert.equal(
    text,
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [2026-07-13]',
      '',
      '### Added',
      '',
      '- First ever entry.',
      '',
    ].join('\n')
  );
});

test('second deploy on the same day → new entries merge into the existing date section', () => {
  const input = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Fixed',
    '',
    '- Second entry of the day. (#101)',
    '',
    '## [2026-07-13]',
    '',
    '### Added',
    '',
    '- First entry of the day. (#100)',
    '',
    '## [2026-06-25]',
    '',
  ].join('\n');

  const { text, changed, reason } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, true);
  assert.equal(reason, 'stamped');
  assert.equal(
    text,
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [2026-07-13]',
      '',
      '### Fixed',
      '',
      '- Second entry of the day. (#101)',
      '',
      '### Added',
      '',
      '- First entry of the day. (#100)',
      '',
      '## [2026-06-25]',
      '',
    ].join('\n')
  );
});

test('duplicate Unreleased headings → only the first is stamped', () => {
  const input = [
    '## [Unreleased]',
    '',
    '- New entry.',
    '',
    '## [Unreleased]',
    '',
    '- Stray duplicate.',
    '',
  ].join('\n');

  const { text, changed } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, true);
  assert.equal(
    text,
    [
      '## [Unreleased]',
      '',
      '## [2026-07-13]',
      '',
      '- New entry.',
      '',
      '## [Unreleased]',
      '',
      '- Stray duplicate.',
      '',
    ].join('\n')
  );
});

test('populated Unreleased → stamped heading with fresh empty Unreleased above', () => {
  const input = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- A new field. (#99)',
    '',
    '## [2026-06-25]',
    '',
    '### Added',
    '',
    '- An old field. (#49)',
    '',
  ].join('\n');

  const { text, changed } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, true);
  assert.equal(
    text,
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [2026-07-13]',
      '',
      '### Added',
      '',
      '- A new field. (#99)',
      '',
      '## [2026-06-25]',
      '',
      '### Added',
      '',
      '- An old field. (#49)',
      '',
    ].join('\n')
  );
});
