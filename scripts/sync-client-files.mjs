#!/usr/bin/env node
// Regenerates CLAUDE.md and GEMINI.md from the body of SKILL.md so the three
// client entry files never drift. Run after editing SKILL.md:
//   node scripts/sync-client-files.mjs          # write files
//   node scripts/sync-client-files.mjs --check  # exit 1 if out of date (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const skill = readFileSync(join(root, 'SKILL.md'), 'utf8');

const match = skill.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
if (!match) {
  console.error('SKILL.md must start with a YAML frontmatter block.');
  process.exit(1);
}
const body = match[1].trim();
const footer =
  '<!-- Generated from SKILL.md; edit SKILL.md and re-run `node scripts/sync-client-files.mjs`. -->';
const expected = `${body}\n\n${footer}\n`;

let stale = false;
for (const name of ['CLAUDE.md', 'GEMINI.md']) {
  const path = join(root, name);
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = '';
  }
  if (current === expected) continue;
  if (check) {
    console.error(`${name} is out of date with SKILL.md.`);
    stale = true;
  } else {
    writeFileSync(path, expected);
    console.log(`Wrote ${name}`);
  }
}
process.exit(stale ? 1 : 0);
