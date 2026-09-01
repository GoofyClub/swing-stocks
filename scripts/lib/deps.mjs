#!/usr/bin/env node
// =============================================================================
// Are the dependencies actually installed?
//
// `[[ -d node_modules ]]` was the old check, and a directory being present says
// nothing about what is in it. An `npm ci` that dies part-way — on a 1 GB box
// the OOM killer is the usual reason — leaves the directory there, most packages
// installed, and the process exits non-zero into a scrollback nobody re-reads.
// Every later command then fails with ERR_MODULE_NOT_FOUND naming ONE package,
// which reads like a code problem rather than a broken install.
//
// npm puts every top-level dependency at node_modules/<name>, so their presence
// is a direct, cheap check that needs no network and no resolution of the whole
// tree.
//
// As a CLI:  node scripts/lib/deps.mjs   → lists what's missing, exit 1 if any
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function missingDependencies(root = REPO_ROOT, { includeDev = false } = {}) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); }
  catch { return { error: 'package.json unreadable', missing: [], checked: 0 }; }

  const wanted = Object.keys({
    ...(pkg.dependencies || {}),
    ...(includeDev ? (pkg.devDependencies || {}) : {}),
  });
  const nm = path.join(root, 'node_modules');
  if (!fs.existsSync(nm)) return { error: 'node_modules does not exist', missing: wanted, checked: wanted.length };

  // A package's own package.json, not just its directory: an interrupted write
  // can leave the folder created and empty.
  const missing = wanted.filter(d => !fs.existsSync(path.join(nm, d, 'package.json')));
  return { error: null, missing, checked: wanted.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { error, missing, checked } = missingDependencies(REPO_ROOT, {
    includeDev: process.argv.includes('--dev'),
  });
  if (error) { console.error(error); process.exit(1); }
  if (missing.length) {
    console.error(`${missing.length} of ${checked} dependencies missing: ${missing.join(' ')}`);
    process.exit(1);
  }
  console.log(`${checked} dependencies present`);
}
