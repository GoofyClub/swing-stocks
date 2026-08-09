// =============================================================================
// Load swing.env into process.env — imported for its SIDE EFFECT, at the top of
// every runner.
//
// systemd applies `EnvironmentFile=`; an interactive shell does not. That split
// meant the exact same command behaved differently depending on who ran it:
//
//   sudo systemctl start swing-maintenance   → works
//   npm run auto:maintenance                 → "FIREBASE_PROJECT_ID must be set"
//
// which reads as a broken config rather than a missing `set -a && . swing.env`.
// Worse, the workaround is easy to half-apply: source the file, forget to
// re-source it in the next shell, and conclude the problem is intermittent.
//
// So the scripts find their own config. Same resolution order as
// scripts/setup-vm.sh, so the units, a manual run and the setup checker all
// agree on which file is authoritative:
//
//   SWING_CONFIG_DIR → <repo>/swing-config → <repo>/../swing-config → $HOME/swing-config
//
// PRECEDENCE: anything already in the environment WINS. That keeps one-off
// overrides working (`DRY_RUN=true npm run auto:maintenance`) and means systemd's
// EnvironmentFile is never fought with — under systemd every value is already
// set, so this loads nothing and changes nothing.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function resolveConfigFile() {
  const candidates = [
    process.env.SWING_CONFIG_DIR && path.join(process.env.SWING_CONFIG_DIR, 'swing.env'),
    path.join(REPO_ROOT, 'swing-config', 'swing.env'),
    path.join(path.dirname(REPO_ROOT), 'swing-config', 'swing.env'),
    process.env.HOME && path.join(process.env.HOME, 'swing-config', 'swing.env'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

// Minimal KEY=VALUE parser. Deliberately not a dotenv dependency: this file is
// also read by bash (`set -a && . swing.env`), so it can only ever contain what
// both understand — no interpolation, no multi-line values.
function parse(text) {
  const out = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    // Strip one matching pair of surrounding quotes, the way `.` would.
    if ((val.startsWith('"') && val.endsWith('"') && val.length > 1)
     || (val.startsWith("'") && val.endsWith("'") && val.length > 1)) {
      val = val.slice(1, -1);
    }
    out.set(key, val);
  }
  return out;
}

// Returns { file, loaded, skipped } — `skipped` counts keys already in the
// environment, which is normal under systemd and not a problem.
export function loadEnvFile({ file = resolveConfigFile(), env = process.env } = {}) {
  if (!file) return { file: null, loaded: 0, skipped: 0 };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return { file: null, loaded: 0, skipped: 0 }; }

  let loaded = 0, skipped = 0;
  for (const [k, v] of parse(text)) {
    // An EMPTY existing value counts as unset. A stray `export ALPACA_KEY=` in a
    // shell profile must not shadow the real value here — a blank credential
    // fails with an authentication error that points at the broker rather than
    // at the shell, which is a genuinely hard thing to track down.
    if (env[k] !== undefined && env[k] !== '') { skipped++; continue; }
    env[k] = v;
    loaded++;
  }
  return { file, loaded, skipped };
}

// Where the config was looked for, for error messages. A "must be set" error
// that doesn't say which file it read is the least useful kind.
export function describeSearch() {
  const found = resolveConfigFile();
  return found
    ? `config: ${found}`
    : `no swing.env found (looked in ${path.join(REPO_ROOT, 'swing-config')}, `
      + `${path.join(path.dirname(REPO_ROOT), 'swing-config')}, ${process.env.HOME || '~'}/swing-config)`;
}

// Side effect on import — this module exists to be imported, not called.
export const RESULT = loadEnvFile();

// Publish the search description for src/config/configHint.js. That module is
// also in the browser bundle, so it cannot import this Node-only file; a global
// set here keeps the dependency one-way and lets the hint stay silent when the
// loader was never imported (e.g. under a bare `node -e`).
globalThis.__swingConfigSearch = describeSearch;
