#!/usr/bin/env node
// =============================================================================
// refresh-universe.mjs — weekly cron. Keeps the S&P universe (500/400/600) the
// scan uses current:
//   1. Start from the committed snapshot (src/data/universe.json).
//   2. Refresh S&P 500 members from the live constituents CSV (reliable, no HTML).
//      (Mid-cap 400 / small-cap 600 update when universe.json is regenerated.)
//   3. Validate every ticker against Alpaca's tradable-assets list — drop
//      delisted / untradable names.
//   4. Publish the result to Firestore /universe/config; the daily scan reads it
//      (falling back to the committed file if this hasn't run).
//
// Env: FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT_JSON, ALPACA_KEY, ALPACA_SECRET
// =============================================================================

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const norm = (s) => String(s).trim().toUpperCase().replace(/\./g, '-');

function initAdmin() {
  if (admin.apps.length) return admin.firestore();
  const projectId = process.env.FIREBASE_PROJECT_ID, saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) throw new Error('FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be set.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)), projectId });
  return admin.firestore();
}

const GICS_TO_XL = {
  'Information Technology': 'XLK', 'Health Care': 'XLV', 'Financials': 'XLF',
  'Consumer Discretionary': 'XLY', 'Communication Services': 'XLC', 'Industrials': 'XLI',
  'Consumer Staples': 'XLP', 'Energy': 'XLE', 'Utilities': 'XLU', 'Materials': 'XLB', 'Real Estate': 'XLRE',
};

// Live S&P 500 constituents (CSV: Symbol, Security, GICS Sector, ...).
async function fetchSp500() {
  const url = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const out = {};
  const lines = text.trim().split('\n').slice(1);
  for (const line of lines) {
    // naive CSV split is fine — Symbol/Security/Sector are the first 3 simple cols
    const m = line.match(/^([^,]+),("(?:[^"]|"")*"|[^,]*),([^,]+)/);
    if (!m) continue;
    const sym = norm(m[1]);
    const sector = GICS_TO_XL[m[3].trim()] || '';
    const name = m[2].replace(/^"|"$/g, '').replace(/""/g, '"').slice(0, 40);
    if (/^[A-Z][A-Z0-9-]{0,6}$/.test(sym)) out[sym] = { index: 'sp500', sector, name };
  }
  return out;
}

// Set of tradable US-equity symbols from Alpaca (normalized to dash form).
async function fetchAlpacaTradable() {
  const key = process.env.ALPACA_KEY, secret = process.env.ALPACA_SECRET;
  if (!key || !secret) return null;
  const res = await fetch('https://paper-api.alpaca.markets/v2/assets?status=active&asset_class=us_equity', {
    headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
  });
  if (!res.ok) throw new Error(`Alpaca assets HTTP ${res.status}`);
  const list = await res.json();
  const set = new Set();
  for (const a of list) if (a.tradable) set.add(norm(a.symbol));
  return set;
}

async function main() {
  const db = initAdmin();
  const committed = JSON.parse(readFileSync(path.join(__dir, '../src/data/universe.json'), 'utf8'));
  const tickers = { ...committed };

  // Refresh S&P 500 from the live CSV (keep 400/600 from the committed snapshot).
  try {
    const live500 = await fetchSp500();
    for (const [sym, v] of Object.entries(live500)) {
      if (!tickers[sym] || tickers[sym].index === 'sp500') tickers[sym] = v; // add new / refresh existing sp500
    }
    // Drop sp500 members no longer in the live list.
    for (const [sym, v] of Object.entries(tickers)) if (v.index === 'sp500' && !live500[sym]) delete tickers[sym];
    console.log(`[universe] S&P 500 live: ${Object.keys(live500).length}`);
  } catch (e) { console.warn(`[universe] live S&P 500 fetch failed, using committed: ${e.message}`); }

  // Validate vs Alpaca tradable assets.
  let dropped = [];
  try {
    const tradable = await fetchAlpacaTradable();
    if (tradable) {
      for (const sym of Object.keys(tickers)) if (!tradable.has(sym)) { dropped.push(sym); delete tickers[sym]; }
      console.log(`[universe] Alpaca validated; dropped ${dropped.length} untradable`);
    } else {
      console.log('[universe] no Alpaca keys — skipping validation');
    }
  } catch (e) { console.warn(`[universe] Alpaca validation failed: ${e.message}`); }

  const counts = { sp500: 0, sp400: 0, sp600: 0 };
  for (const v of Object.values(tickers)) if (counts[v.index] != null) counts[v.index]++;

  await db.collection('universe').doc('config').set({
    tickers, counts, total: Object.keys(tickers).length,
    dropped: dropped.slice(0, 100),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[universe] published: total=${Object.keys(tickers).length} sp500=${counts.sp500} sp400=${counts.sp400} sp600=${counts.sp600}`);
}

main().catch(e => { console.error('[universe] fatal', e); process.exit(1); });
