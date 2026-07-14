// Changelog stamp — the pure core. No file and no clock access in this module:
// the changelog text and the date string are both passed in, so the
// Unreleased-section rewrite is unit-testable. The thin wrapper that reads
// us-congress/CHANGELOG.md and computes the America/Chicago date lives in
// stamp-changelog-run.js.

// Rewrite the `## [Unreleased]` heading to `## [<date>]` and insert a fresh
// empty `## [Unreleased]` section above it. No-op when the Unreleased section
// holds no content (a plumbing-only deploy must not fabricate an empty release
// entry). Returns { text, changed }.
export function stampChangelog(text, date) {
  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === '## [Unreleased]');
  if (headingIndex === -1) return { text, changed: false };

  const nextHeadingIndex = lines.findIndex(
    (line, i) => i > headingIndex && line.startsWith('## ')
  );
  const sectionEnd = nextHeadingIndex === -1 ? lines.length : nextHeadingIndex;
  const sectionIsEmpty = lines
    .slice(headingIndex + 1, sectionEnd)
    .every((line) => line.trim() === '');
  if (sectionIsEmpty) return { text, changed: false };

  const stamped = [
    ...lines.slice(0, headingIndex),
    '## [Unreleased]',
    '',
    `## [${date}]`,
    ...lines.slice(headingIndex + 1),
  ];
  return { text: stamped.join('\n'), changed: true };
}
