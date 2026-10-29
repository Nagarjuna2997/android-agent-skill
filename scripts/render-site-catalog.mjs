#!/usr/bin/env node
// Renders capabilities/catalog.json into site/capabilities.js so the website
// lists the same recipes the skill ships. Run after editing the catalog:
//   node scripts/render-site-catalog.mjs          # write
//   node scripts/render-site-catalog.mjs --check  # exit 1 if stale (CI)
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const catalog = JSON.parse(readFileSync(join(root, 'capabilities', 'catalog.json'), 'utf8'));
const rows = catalog.capabilities.map(({ id, name, category, summary, path, minSdk }) => ({
  id,
  name,
  category,
  summary,
  path,
  minSdk,
}));
const expected = 'window.capabilityCatalog = ' + JSON.stringify(rows, null, 2) + ';\n';
const target = join(root, 'site', 'capabilities.js');
let current = '';
try {
  current = readFileSync(target, 'utf8');
} catch {
  current = '';
}
if (current === expected) process.exit(0);
if (check) {
  console.error('site/capabilities.js is out of date with capabilities/catalog.json.');
  process.exit(1);
}
writeFileSync(target, expected);
console.log(`Wrote site/capabilities.js (${rows.length} capabilities)`);
