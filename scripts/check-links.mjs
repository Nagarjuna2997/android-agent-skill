#!/usr/bin/env node
// Verifies that every relative Markdown link and SKILL.md backtick path in the
// knowledge content points at a file or directory that exists. External URLs
// are not fetched. Exit 1 on any broken reference.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['SKILL.md', 'README.md', 'patterns', 'capabilities', 'checklists', 'docs', 'templates'];
const skipDirs = new Set(['node_modules', 'dist', '.git', '.android-agent']);

function* walk(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (skipDirs.has(entry)) continue;
      yield* walk(join(path, entry));
    }
  } else if (path.endsWith('.md')) {
    yield path;
  }
}

const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const backtickPathPattern = /`((?:patterns|capabilities|checklists|docs|templates|data)\/[^`\s]+)`/g;
const failures = [];

for (const entry of roots) {
  const start = join(root, entry);
  if (!existsSync(start)) continue;
  for (const file of walk(start)) {
    const text = readFileSync(file, 'utf8');
    const refs = new Set();
    for (const match of text.matchAll(linkPattern)) {
      const target = match[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      refs.add(target.split('#')[0]);
    }
    // Backtick paths are only enforced in the top-level entry files, where they act as a table of contents.
    if (file === join(root, 'SKILL.md') || file === join(root, 'README.md')) {
      for (const match of text.matchAll(backtickPathPattern)) {
        const target = match[1].replace(/\/$/, '');
        if (target.includes('<')) continue;
        refs.add(target);
      }
    }
    for (const ref of refs) {
      if (!ref) continue;
      const candidate = ref.startsWith('/') ? join(root, ref) : resolve(dirname(file), ref);
      if (!existsSync(candidate)) failures.push(`${relative(root, file)} -> ${ref}`);
    }
  }
}

if (failures.length) {
  console.error(`Broken references (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('All relative references resolve.');
