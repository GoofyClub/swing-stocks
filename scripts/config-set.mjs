#!/usr/bin/env node
// =============================================================================
// config-set.mjs — read/change a user's automation settings from the VM.
//
// The trading rules do NOT live on the VM: they are per-user documents in
// Firestore (/users/{uid}/automation/config), which is why editing swing.env
// does nothing to maxConcurrentPositions or risk. This is the command-line way
// to change them; the app UI and the Telegram bot's /set are the other two.
//
//   node scripts/config-set.mjs                       # show current settings
//   node scripts/config-set.mjs maxConcurrentPositions 8
//   node scripts/config-set.mjs minAdvUsd 15000000
//
// Only NUMERIC risk/sizing fields are settable. Strategy / tier / index
// selection stays in the UI on purpose: those are multi-value, easy to corrupt
// from a shell line, and a corrupt allow-list silently stops ALL trading — the
// exact failure that once cost days of missed entries.
//
// Required env: FIREBASE_PROJECT_ID (+ credentials, or ADC on a GCE VM)
// Optional env: ONLY_UID — required when several users have automation enabled.
// =============================================================================

import { initFirestore, admin } from '../src/config/firebaseAdmin.js';

const NUMERIC_FIELDS = {
  riskPerTradePct:        '% of equity risked per trade (risk sizing mode)',
  maxConcurrentPositions: 'hard cap on simultaneous open positions',
  maxPositionsPerSector:  'cap per sector',
  maxPortfolioHeatPct:    'cap on summed open risk',
  dailyLossHaltPct:       'halt new entries after this daily drawdown',
  maxDrawdownHaltPct:     'halt when equity is this far below its peak (0 = off)',
  slippageBudgetPct:      'skip if price ran past entry by more than this',
  minPrice:               'skip signals priced below this',
  maxPrice:               'skip signals priced above this',
  minAdvUsd:              'liquidity floor, 20-day average dollar volume',
  fixedNotional:          '$ per trade in fixed sizing mode',
  maxPositionNotional:    'hard $ cap per position (0 = no cap)',
};

async function resolveUid(db) {
  if (process.env.ONLY_UID) return process.env.ONLY_UID;
  const snap = await db.collectionGroup('automation').get();
  const uids = [];
  snap.forEach(d => {
    if (d.id !== 'config' || d.data()?.enabled !== true) return;
    const uid = d.ref.parent.parent?.id;
    if (uid) uids.push(uid);
  });
  if (!uids.length) throw new Error('No automation-enabled user found.');
  if (uids.length > 1) throw new Error(`${uids.length} automation-enabled users — set ONLY_UID to choose one.`);
  return uids[0];
}

async function main() {
  const [field, rawValue] = process.argv.slice(2);
  const db = initFirestore({ log: (m) => console.log(`[config] ${m}`) });
  const uid = await resolveUid(db);
  const ref = db.collection('users').doc(uid).collection('automation').doc('config');
  const cur = (await ref.get()).data() || {};

  // No arguments → show everything settable, plus the read-only selections.
  if (!field) {
    console.log(`\nAutomation config for ${uid}\n`);
    console.log('SETTABLE (this script, or Telegram /set):');
    for (const [k, desc] of Object.entries(NUMERIC_FIELDS)) {
      console.log(`  ${k.padEnd(24)} ${String(cur[k] ?? '—').padEnd(12)} ${desc}`);
    }
    console.log('\nUI-ONLY (multi-value — change in the app):');
    for (const k of ['markets', 'tiers', 'indexes', 'strategies', 'sides', 'tradeDays', 'excludeTickers']) {
      const v = cur[k];
      console.log(`  ${k.padEnd(24)} ${Array.isArray(v) ? (v.length ? v.join(',') : '(all)') : String(v ?? '—')}`);
    }
    console.log(`\n  ${'enabled'.padEnd(24)} ${cur.enabled === true}`);
    console.log(`  ${'respectRegime'.padEnd(24)} ${cur.respectRegime !== false}`);
    console.log(`  ${'sizingMode'.padEnd(24)} ${cur.sizingMode || 'risk'}`);
    console.log('\nUsage: node scripts/config-set.mjs <field> <value>\n');
    return;
  }

  if (!(field in NUMERIC_FIELDS)) {
    console.error(`'${field}' is not settable here.\nSettable: ${Object.keys(NUMERIC_FIELDS).join(', ')}`);
    process.exit(1);
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`'${rawValue}' is not a valid non-negative number.`);
    process.exit(1);
  }

  await ref.set({ [field]: value, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  console.log(`${field}: ${cur[field] ?? '—'} -> ${value}   (user ${uid})`);
  console.log('Takes effect on the next worker run — nothing to restart.');
}

main().catch(e => { console.error('[config] fatal', e.message); process.exit(1); });
