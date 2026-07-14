// Changelog stamp — the pure core. No file and no clock access in this module:
// the changelog text and the date string are both passed in, so the
// Unreleased-section rewrite is unit-testable. The thin wrapper that reads
// us-congress/CHANGELOG.md and computes the America/Chicago date lives in
// stamp-changelog-run.js.

// Rewrite the `## [Unreleased]` heading to `## [<date>]` and insert a fresh
// empty `## [Unreleased]` section above it. No-op when the Unreleased section
// holds no content (a plumbing-only deploy must not fabricate an empty release
// entry). Returns { text, changed, reason } — reason is 'stamped', 'empty', or
// 'no-heading', so a missing heading can fail loudly instead of reading as the
// routine empty no-op.
export function stampChangelog(text, date) {
  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === '## [Unreleased]');
  if (headingIndex === -1) return { text, changed: false, reason: 'no-heading' };

  const nextHeadingIndex = lines.findIndex(
    (line, i) => i > headingIndex && line.startsWith('## ')
  );
  const sectionEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const sectionIsEmpty = lines
    .slice(headingIndex + 1, sectionEnd)
    .every((line) => line.trim() === '');
  if (sectionIsEmpty) return { text, changed: false, reason: 'empty' };

  // A second deploy on the same day merges its entries into the existing
  // date section instead of inserting a duplicate `## [<date>]` heading
  // (duplicates also collide as docs-site anchors). Newer entries go on top.
  if (nextHeadingIndex !== -1 && lines[nextHeadingIndex].trim() === `## [${date}]`) {
    const content = lines.slice(headingIndex + 1, sectionEnd);
    while (content.length && content[0].trim() === '') content.shift();
    while (content.length && content[content.length - 1].trim() === '') content.pop();
    const rest = lines.slice(nextHeadingIndex + 1);
    const merged = [
      ...lines.slice(0, headingIndex),
      '## [Unreleased]',
      '',
      lines[nextHeadingIndex],
      '',
      ...content,
      ...(rest[0]?.trim() === '' ? [] : ['']),
      ...rest,
    ];
    return { text: merged.join('\n'), changed: true, reason: 'stamped' };
  }

  const stamped = [
    ...lines.slice(0, headingIndex),
    '## [Unreleased]',
    '',
    `## [${date}]`,
    ...lines.slice(headingIndex + 1),
  ];
  return { text: stamped.join('\n'), changed: true, reason: 'stamped' };
}
