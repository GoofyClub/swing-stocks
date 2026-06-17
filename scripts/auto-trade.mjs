#!/usr/bin/env node
// =============================================================================
// auto-trade.mjs — Phase 2 paper-execution worker (GitHub Actions).
//
// For every user who has ENABLED automation, this:
//   1. Reads their automation config (/users/{uid}/automation/config).
//   2. Connects to their broker (Alpaca) — PAPER endpoint is forced unless the
//      user explicitly set mode='live'.
//   3. Reads today's signals for their markets, applies their selection rules +
//      portfolio guardrails, sizes each trade by fixed-fractional risk, and
//      submits a BRACKET order (entry + stop + target).
//   4. Journals every decision to /users/{uid}/autoOrders/{clientOrderId} and
//      reconciles previously-submitted orders' fill status.
//
// SAFETY:
//   • DRY_RUN defaults to TRUE — it logs intended orders WITHOUT submitting.
//     Set DRY_RUN=false to actually place (paper or live) orders.
//   • Idempotent: a deterministic client_order_id means a re-run never double-
//     submits the same user+signal.
//   • Only the Alpaca broker is implemented in Phase 2; other brokers are skipped.
//
// Required env (repo Secrets):
//   FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_PROJECT_ID
// Optional env:
//   DRY_RUN=false   — actually submit orders (default true = simulate only)
//   ONLY_UID=<uid>  — restrict the run to a single user (testing)
// =============================================================================

import admin from 'firebase-admin';
import {
  clientOrderId, sizePosition, signalMatchesRules, passesPortfolioGuards,
  isTradeDayAllowed, slippageOk, buildBracketOrder, regimeAllowsEntry,
} from '../src/auto/engine.js';
import { createAlpacaClient, resolveAlpacaBaseUrl } from '../src/broker/alpaca.js';
import { STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA } from '../src/data/markets.js';

const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const ONLY_UID = process.env.ONLY_UID || null;
// Operator kill switch via env (workflow input). A Firestore-based switch is
// also honored (see isGloballyPaused) so it can be flipped without a re-run.
const ENV_KILL = String(process.env.KILL_SWITCH ?? 'false').toLowerCase() === 'true';

function todayKey(now = new Date()) { return now.toISOString().slice(0, 10); }

function initAdmin() {
  if (admin.apps.length) return admin.firestore();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) throw new Error('FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be set.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)), projectId });
  return admin.firestore();
}

// symbol -> sector, built from both watchlists, for per-sector position caps
// (Alpaca only returns the symbol on a position, not its sector).
const SECTOR_BY_TICKER = (() => {
  const m = new Map();
  for (const it of [...STARTER_WATCHLIST, ...STARTER_WATCHLIST_INDIA]) m.set(it.t, it.s);
  return m;
})();

// Today's open signals for the given markets.
async function loadTodaySignals(db, markets) {
  const bucket = todayKey();
  const snap = await db.collection('marketData').doc(bucket).collection('signals').get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return rows.filter(r => r.status === 'open' && (!r.market || markets.includes(r.market)));
}

// Latest regime snapshot per market (/marketData/{today}/regime/{market}).
async function loadRegimes(db, markets) {
  const bucket = todayKey();
  const out = {};
  for (const m of markets) {
    try {
      const snap = await db.collection('marketData').doc(bucket).collection('regime').doc(m).get();
      out[m] = snap.exists ? snap.data() : null;
    } catch { out[m] = null; }
  }
  return out;
}

// Global kill switch via Firestore: /publicConfig/automation { paused: true }.
// Lets an operator pause ALL users' automation between runs (set in the console)
// without editing the workflow. Env KILL_SWITCH is checked separately.
async function isGloballyPaused(db) {
  try {
    const snap = await db.collection('publicConfig').doc('automation').get();
    return snap.exists && snap.data()?.paused === true;
  } catch { return false; }
}

// Users with automation enabled. Each config doc lives at users/{uid}/automation/config.
async function loadEnabledConfigs(db) {
  const snap = await db.collectionGroup('automation').where('enabled', '==', true).get();
  const out = [];
  snap.forEach(doc => {
    if (doc.id !== 'config') return;
    const uid = doc.ref.parent.parent?.id;
    if (!uid) return;
    if (ONLY_UID && uid !== ONLY_UID) return;
    out.push({ uid, cfg: doc.data() });
  });
  return out;
}

async function processUser(db, uid, cfg) {
  const log = (msg) => console.log(`[auto][${uid.slice(0, 6)}] ${msg}`);

  if (cfg.broker !== 'alpaca') { log(`broker '${cfg.broker}' not supported in Phase 2 — skipping`); return; }
  if (!isTradeDayAllowed(cfg)) { log('not an allowed trade day — skipping'); return; }
  if (!cfg.apiKey || !cfg.apiSecret) { log('no broker API credentials — skipping'); return; }

  const baseUrl = resolveAlpacaBaseUrl(cfg);
  const live = cfg.mode === 'live';
  const client = createAlpacaClient({ baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });

  let account, positions;
  try {
    account = await client.getAccount();
    positions = await client.getPositions();
  } catch (e) { log(`broker connect failed: ${e.message} — skipping`); return; }

  const equity = account.equity;
  const dayRealizedPct = account.lastEquity > 0 ? ((account.equity - account.lastEquity) / account.lastEquity) * 100 : 0;
  let openCount = positions.length;
  const sectorCount = new Map();
  for (const p of positions) {
    const sec = SECTOR_BY_TICKER.get(p.symbol) || '?';
    sectorCount.set(sec, (sectorCount.get(sec) || 0) + 1);
  }
  // Heat proxy: each open position carries ~riskPerTradePct of risk.
  let openHeatPct = openCount * (cfg.riskPerTradePct || 0);
  // Track remaining buying power so we never queue more than the account can fund.
  let availableBp = account.buyingPower;

  log(`mode=${cfg.mode} equity=${equity.toFixed(0)} open=${openCount} dayP/L=${dayRealizedPct.toFixed(2)}% dryRun=${DRY_RUN}`);

  const markets = cfg.markets || ['US'];
  const signals = await loadTodaySignals(db, markets);
  const regimes = cfg.respectRegime !== false ? await loadRegimes(db, markets) : {};
  // Best signals first so limited slots go to the highest-conviction names.
  const tierRank = { 'A+': 0, 'Tier 1': 1, 'Tier 2': 2 };
  signals.sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9));

  let placed = 0, skipped = 0;
  for (const sig of signals) {
    const coid = clientOrderId(uid, sig.id);
    const journalRef = db.collection('users').doc(uid).collection('autoOrders').doc(coid);

    // Idempotency: already acted on this user+signal.
    if ((await journalRef.get()).exists) { skipped++; continue; }

    const match = signalMatchesRules(sig, cfg);
    if (!match.ok) { skipped++; continue; }

    if (cfg.respectRegime !== false) {
      const reg = regimeAllowsEntry(regimes[sig.market || markets[0]], sig.side || 'buy');
      if (!reg.ok) { log(`skip ${sig.ticker}: ${reg.reason}`); skipped++; continue; }
    }

    if (!slippageOk(cfg, sig.entryPrice, sig.currentPrice, sig.side || 'buy')) {
      log(`skip ${sig.ticker}: slippage (live ${sig.currentPrice} vs entry ${sig.entryPrice})`); skipped++; continue;
    }

    const sec = sig.sector || SECTOR_BY_TICKER.get(sig.ticker) || '?';
    const guard = passesPortfolioGuards({
      cfg, openCount, sectorCount: sectorCount.get(sec) || 0,
      openHeatPct, addedHeatPct: cfg.riskPerTradePct || 0, dayRealizedPct,
    });
    if (!guard.ok) { log(`skip ${sig.ticker}: ${guard.reason}`); skipped++; continue; }

    const size = sizePosition({
      equity, sizingMode: cfg.sizingMode, riskPerTradePct: cfg.riskPerTradePct,
      fixedNotional: cfg.fixedNotional, maxPositionNotional: cfg.maxPositionNotional,
      entry: sig.entryPrice, sl: sig.slPrice,
    });
    if (size.shares < 1) { log(`skip ${sig.ticker}: size < 1 share (budget too small for price ${sig.entryPrice})`); skipped++; continue; }
    if (size.notional > availableBp + 1e-6) { log(`skip ${sig.ticker}: notional $${size.notional.toFixed(0)} > buying power $${availableBp.toFixed(0)}`); skipped++; continue; }

    const intent = buildBracketOrder({ signal: sig, shares: size.shares, clientOrderId: coid });
    const journal = {
      clientOrderId: coid, signalId: sig.id, ticker: sig.ticker, sector: sec,
      strategy: sig.strategy || null, strategyKey: sig.strategyKey || null, tier: sig.tier || null,
      side: intent.side, qty: size.shares, entry: sig.entryPrice, tp: sig.tpPrice, sl: sig.slPrice,
      dollarRisk: size.dollarRisk, mode: cfg.mode, live, dryRun: DRY_RUN,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (DRY_RUN) {
      journal.status = 'dryrun';
      await journalRef.set(journal);
      log(`DRYRUN would ${intent.side} ${size.shares} ${sig.ticker} @ ${sig.entryPrice} (TP ${sig.tpPrice}/SL ${sig.slPrice}, risk $${size.dollarRisk.toFixed(0)})`);
    } else {
      try {
        const order = await client.submitBracketOrder(intent);
        journal.status = 'submitted';
        journal.brokerOrderId = order?.id || null;
        await journalRef.set(journal);
        log(`PLACED ${intent.side} ${size.shares} ${sig.ticker} (order ${order?.id})`);
      } catch (e) {
        journal.status = 'error';
        journal.error = e.message;
        await journalRef.set(journal);
        log(`ERROR placing ${sig.ticker}: ${e.message}`);
        skipped++; continue;
      }
    }

    // Reserve the slot + capital for subsequent signals this run.
    placed++; openCount++; openHeatPct += cfg.riskPerTradePct || 0;
    availableBp -= size.notional;
    sectorCount.set(sec, (sectorCount.get(sec) || 0) + 1);
  }

  // --- Reconciliation: refresh status of previously-submitted (non-terminal) orders.
  if (!DRY_RUN) {
    const open = await db.collection('users').doc(uid).collection('autoOrders').where('status', '==', 'submitted').get();
    for (const d of open.docs) {
      const data = d.data();
      if (!data.brokerOrderId) continue;
      try {
        const o = await client.getOrder(data.brokerOrderId);
        if (o?.status && o.status !== 'new') {
          await d.ref.update({ status: o.status, filledQty: Number(o.filled_qty || 0), filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null, reconciledAt: admin.firestore.FieldValue.serverTimestamp() });
        }
      } catch (e) { log(`reconcile ${data.ticker} failed: ${e.message}`); }
    }
  }

  log(`done: placed=${placed} skipped=${skipped} of ${signals.length} signals`);
}

async function main() {
  const db = initAdmin();
  console.log(`[auto] start dryRun=${DRY_RUN}${ONLY_UID ? ` onlyUid=${ONLY_UID}` : ''}`);

  // Global kill switch — env (this run) or Firestore (persisted operator pause).
  if (ENV_KILL) { console.log('[auto] KILL_SWITCH env set — aborting, no orders.'); return; }
  if (await isGloballyPaused(db)) { console.log('[auto] globally paused (publicConfig/automation.paused) — aborting.'); return; }

  const configs = await loadEnabledConfigs(db);
  console.log(`[auto] ${configs.length} user(s) with automation enabled`);
  for (const { uid, cfg } of configs) {
    try { await processUser(db, uid, cfg); }
    catch (e) { console.error(`[auto][${uid.slice(0, 6)}] fatal: ${e.message}`); }
  }
  console.log('[auto] complete');
}

main().catch(e => { console.error('[auto] fatal', e); process.exit(1); });
