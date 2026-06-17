// =============================================================================
// Automation config — per-user rules that a (future) execution worker will use
// to place broker orders from matching signals. This module only persists the
// config to /users/{uid}/automation/config; it never places orders itself.
//
// ⚠️ SAFETY: `enabled` defaults to false and `mode` defaults to 'paper'. Nothing
// here connects to a broker — the settings page is config-only until the
// server-side execution worker ships (see the Automation guide).
// =============================================================================

import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { initFirebase } from './firebase.js';

// Single source of truth for defaults. Every field the settings page edits must
// exist here so load() can fill gaps for users whose doc predates a new field.
export const DEFAULT_AUTOMATION = {
  enabled: false,            // master switch — OFF until the user opts in
  mode: 'paper',             // 'paper' | 'live'

  // --- Broker connection ---
  broker: 'alpaca',          // 'alpaca' | 'zerodha' | 'dhan' | 'other'
  restApiBase: 'https://paper-api.alpaca.markets',
  apiKey: '',
  apiSecret: '',

  // --- Signal selection ---
  markets: ['US'],           // which markets to auto-trade
  tiers: ['A+'],             // A+ / Tier 1 / Tier 2
  strategies: [],            // strategyKey allow-list; [] = all strategies
  sides: ['buy'],

  // --- Scheduling ---
  tradeDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  respectRegime: true,       // block new longs when the market regime is risk-off

  // --- Universe filters ---
  excludeTickers: [],        // never auto-trade these symbols
  minPrice: 20,              // skip signals priced below this
  maxPrice: 1500,            // skip signals priced above this
  minAdvUsd: 20_000_000,     // liquidity floor (20d avg dollar volume)

  // --- Risk & sizing ---
  sizingMode: 'risk',        // 'risk' (% of equity) | 'fixed' ($ per trade)
  riskPerTradePct: 0.5,      // [risk mode] % of equity risked per trade (off SL distance)
  fixedNotional: 100,        // [fixed mode] $ to deploy per trade
  maxPositionNotional: 0,    // hard $ cap per position (0 = no cap), both modes
  maxConcurrentPositions: 8,
  maxPositionsPerSector: 2,
  maxPortfolioHeatPct: 4,    // cap on summed open risk across all positions
  dailyLossHaltPct: 3,       // halt new entries after this daily drawdown
  maxDrawdownHaltPct: 20,    // halt new entries when equity is this far below its peak (0 = off)
  slippageBudgetPct: 0.3,    // skip if live price ran past entry by more than this

  updatedAt: null,
};

function configRef(db, uid) {
  return doc(db, 'users', uid, 'automation', 'config');
}

async function currentUid() {
  const auth = (await import('firebase/auth')).getAuth();
  return auth.currentUser?.uid || null;
}

// Reads the user's config, merged over defaults so missing fields are filled.
export async function loadAutomationConfig() {
  const { db, ok } = initFirebase();
  if (!ok) return { ...DEFAULT_AUTOMATION };
  const uid = await currentUid();
  if (!uid) return { ...DEFAULT_AUTOMATION };
  try {
    const snap = await getDoc(configRef(db, uid));
    if (!snap.exists()) return { ...DEFAULT_AUTOMATION };
    return { ...DEFAULT_AUTOMATION, ...snap.data() };
  } catch (e) {
    console.warn('[automation] load failed', e.message);
    return { ...DEFAULT_AUTOMATION };
  }
}

// Persists a full config object (merge:true so we never drop unknown fields a
// newer client may have written).
export async function saveAutomationConfig(cfg) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const uid = await currentUid();
  if (!uid) throw new Error('Sign in required.');
  const clean = { ...cfg, updatedAt: serverTimestamp() };
  await setDoc(configRef(db, uid), clean, { merge: true });
}
