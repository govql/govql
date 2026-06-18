#!/usr/bin/env node
/**
 * Renders the canonical us-congress/CHANGELOG.md into the docs site as
 * docs/schema/changelog.md so it shows up as a section in the API Reference
 * sidebar (alongside Overview and Tables). URL stays /docs/changelog via slug.
 *
 * Run via:  node scripts/sync-changelog.mjs
 * Or via:   npm run sync-changelog   (from us-congress/docs/)
 *
 * CHANGELOG.md is the source of truth — edit it there, not the generated page.
 * Re-run (or rebuild — this is wired into prebuild/prestart) after editing it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '../../CHANGELOG.md');
const OUTPUT_DIR = join(__dirname, '../docs/schema');
const OUTPUT_PATH = join(OUTPUT_DIR, 'changelog.md');

const source = readFileSync(SOURCE_PATH, 'utf8');

// Drop the leading "# Changelog" H1 — the front matter supplies the page title,
// and Docusaurus renders sidebar_label / title from it. Keeps one H1 on the page.
const body = source.replace(/^#\s+Changelog\s*\n+/, '');

const frontMatter = [
  '---',
  '# AUTO-GENERATED — do not edit. Edit us-congress/CHANGELOG.md and re-run: npm run sync-changelog',
  'title: Changelog',
  'sidebar_label: Changelog',
  'sidebar_position: 3',
  'slug: /changelog',
  '---',
  '',
].join('\n');

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(OUTPUT_PATH, frontMatter + body);

console.log(`Wrote ${OUTPUT_PATH}`);
