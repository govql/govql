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

  const { text, changed } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, false);
  assert.equal(text, input);
});

test('no Unreleased heading → no-op', () => {
  const input = ['# Changelog', '', '## [2026-06-25]', '', '- An old field.', ''].join('\n');

  const { text, changed } = stampChangelog(input, '2026-07-13');

  assert.equal(changed, false);
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
