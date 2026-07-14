// Changelog stamp — the pure core. No file and no clock access in this module:
// the changelog text and the date string are both passed in, so the
// Unreleased-section rewrite is unit-testable. The thin wrapper that reads
// us-congress/CHANGELOG.md and computes the America/Chicago date lives in
// stamp-changelog-run.js.

// Split a section body into `### <category>` blocks; lines before the first
// category heading form a headingless block. All-blank blocks are dropped.
function parseCategoryBlocks(lines) {
  const blocks = [{ heading: null, lines: [] }];
  for (const line of lines) {
    if (line.startsWith('### ')) blocks.push({ heading: line.trim(), lines: [] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks.filter((b) => b.heading !== null || b.lines.some((l) => l.trim() !== ''));
}

function trimBlankEdges(lines) {
  const out = [...lines];
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

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
  // (duplicates also collide as docs-site anchors). Entries sharing a
  // `### <category>` heading fold under the existing one — a date section
  // must not carry two "### Added" headings either — and newer entries go
  // on top within their category.
  if (nextHeadingIndex !== -1 && lines[nextHeadingIndex].trim() === `## [${date}]`) {
    const dateSectionEnd = ((i) => (i === -1 ? lines.length : i))(
      lines.findIndex((line, i) => i > nextHeadingIndex && line.startsWith('## '))
    );
    const fresh = parseCategoryBlocks(lines.slice(headingIndex + 1, sectionEnd));
    const existing = parseCategoryBlocks(lines.slice(nextHeadingIndex + 1, dateSectionEnd));
    const standalone = [];
    for (const block of fresh) {
      const match = block.heading && existing.find((b) => b.heading === block.heading);
      if (match) match.lines = [...trimBlankEdges(block.lines), ...trimBlankEdges(match.lines)];
      else standalone.push(block);
    }
    const body = [];
    for (const block of [...standalone, ...existing]) {
      body.push('');
      if (block.heading) body.push(block.heading, '');
      body.push(...trimBlankEdges(block.lines));
    }
    body.push('');
    const merged = [
      ...lines.slice(0, headingIndex),
      '## [Unreleased]',
      '',
      lines[nextHeadingIndex],
      ...body,
      ...lines.slice(dateSectionEnd),
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
