// Thin wrapper around the changelog stamp core (stamp-changelog.js): real file
// I/O and the real clock. Computes the operator's local America/Chicago date
// (the changelog is date-stamped in the operator's day, not UTC's), applies
// the stamp to us-congress/CHANGELOG.md, and writes back only when the
// Unreleased section held content. Exits 0 on both stamped and no-op — an
// empty Unreleased is a plumbing-only deploy, not a failure.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stampChangelog } from './stamp-changelog.js';

const changelogPath =
  process.env.CHANGELOG_PATH ?? fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

// en-CA formats as ISO-style YYYY-MM-DD, the changelog's heading format.
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());

const { text, changed, reason } = stampChangelog(readFileSync(changelogPath, 'utf8'), date);
if (reason === 'no-heading') {
  // A missing/reworded heading must fail the build, not read as the routine
  // empty no-op — otherwise entries silently accumulate unstamped forever.
  console.error(`changelog stamp: no "## [Unreleased]" heading found in ${changelogPath}`);
  process.exit(1);
}
if (!changed) {
  console.log(`changelog stamp: Unreleased is empty in ${changelogPath} — nothing to stamp`);
} else {
  writeFileSync(changelogPath, text);
  console.log(`changelog stamp: stamped ${changelogPath} with ${date}`);
}
