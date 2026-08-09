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
  isTradeDayAllowed, slippageOk, stopClearanceOk, buildBracketOrder, regimeAllowsEntry, drawdownHalted,
  marketClock, inEntryWindow, placedStopPrice, inReentryCooldown, REENTRY_COOLDOWN_DAYS,
} from '../src/auto/engine.js';
import { manageExits } from './lib/exit-pass.mjs';
import { attachFileLog } from './lib/logfile.mjs';
import { createAlpacaClient, resolveAlpacaBaseUrl, isLiveBaseUrl } from '../src/broker/alpaca.js';
import { STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA } from '../src/data/markets.js';
import { sendTelegram } from '../src/data/telegram.js';

const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const ONLY_UID = process.env.ONLY_UID || null;
// Operator kill switch via env (workflow input). A Firestore-based switch is
// also honored (see isGloballyPaused) so it can be flipped without a re-run.
const ENV_KILL = String(process.env.KILL_SWITCH ?? 'false').toLowerCase() === 'true';
// Hard live gate: real-money orders are blocked unless this repo variable is set.
const ALLOW_LIVE = String(process.env.ALLOW_LIVE ?? 'false').toLowerCase() === 'true';

// Everything this run prints also lands in the shared log file (see
// scripts/lib/logfile.mjs). Attach FIRST so the in-memory capture wraps it.
attachFileLog('auto');

// Capture console output so the Execution Status page can show the last run's log.
const RUN_LOG = [];
{
  const _log = console.log.bind(console), _warn = console.warn.bind(console), _err = console.error.bind(console);
  const push = (s) => { RUN_LOG.push(s); if (RUN_LOG.length > 150) RUN_LOG.shift(); };
  console.log = (...a) => { push(a.map(String).join(' ')); _log(...a); };
  console.warn = (...a) => { push('WARN ' + a.map(String).join(' ')); _warn(...a); };
  console.error = (...a) => { push('ERROR ' + a.map(String).join(' ')); _err(...a); };
}

function todayKey(now = new Date()) { return now.toISOString().slice(0, 10); }

// How the position's upside is managed, for logs and alerts. A trend entry has
// no take_profit leg on purpose — say so, rather than printing "TP null" and
// making a deliberate choice look like a missing value.
function exitLabel(intent) {
  return intent.takeProfit?.limitPrice != null
    ? `TP ${intent.takeProfit.limitPrice}`
    : 'TP none (trailing exit)';
}

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

// Open signals from a specific date bucket for the given markets. We read the
// PREVIOUS trading session's bucket (not today's), so the morning run acts on
// signals finalised the evening before — no dependency on today's (possibly
// delayed) refresh cron — and strict one-session freshness falls out naturally:
// each session's bucket is read on exactly one morning and never again.
async function loadSignalsForBucket(db, bucket, markets) {
  if (!bucket) return [];
  const snap = await db.collection('marketData').doc(bucket).collection('signals').get();
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return rows.filter(r => r.status === 'open' && (!r.market || markets.includes(r.market)));
}

// Most recent real trading session strictly before today (ET), via the broker's
// market calendar — so it skips weekends AND holidays. Returns a 'YYYY-MM-DD'
// bucket key, or null if none found in the lookback window.
async function previousSessionDate(client, now = new Date()) {
  const { date: todayET } = marketClock(now);
  const start = new Date(now.getTime() - 12 * 86400_000).toISOString().slice(0, 10);
  let cal;
  try { cal = await client.getCalendar(start, todayET); }
  catch (e) { console.warn(`[auto] calendar fetch failed: ${e.message}`); return null; }
  const prior = cal.filter(d => d.date && d.date < todayET);
  return prior.length ? prior[prior.length - 1].date : null;
}

// Regime snapshot per market from a specific date bucket (/marketData/{bucket}/regime/{market}).
async function loadRegimes(db, bucket, markets) {
  const out = {};
  if (!bucket) return out;
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
// The filtered query needs a collection-group index on `automation.enabled`; if it
// isn't deployed Firestore throws FAILED_PRECONDITION, which would crash the whole
// run. Fall back to an unfiltered collection-group scan (no index needed) and
// filter `enabled` in memory, so the worker runs with or without the index.
async function loadEnabledConfigs(db) {
  let snap;
  try {
    snap = await db.collectionGroup('automation').where('enabled', '==', true).get();
  } catch (e) {
    if (e.code === 9 || /index/i.test(e.message || '')) {
      console.warn(`[auto] automation.enabled index missing — scanning all automation docs + filtering in memory. Deploy firestore:indexes to make this efficient. (${e.message})`);
      snap = await db.collectionGroup('automation').get();
    } else {
      throw e;
    }
  }
  const out = [];
  snap.forEach(doc => {
    if (doc.id !== 'config') return;
    const cfg = doc.data();
    if (cfg.enabled !== true) return; // in-memory filter (no-op on the indexed path)
    const uid = doc.ref.parent.parent?.id;
    if (!uid) return;
    if (ONLY_UID && uid !== ONLY_UID) return;
    out.push({ uid, cfg });
  });
  return out;
}

// Best-effort Telegram alert for a user, if they configured + enabled it.
async function notify(db, uid, text) {
  try {
    const snap = await db.collection('users').doc(uid).collection('notifications').doc('config').get();
    const n = snap.exists ? snap.data() : null;
    if (n?.telegramEnabled && n.telegramBotToken && n.telegramChatId) {
      await sendTelegram(n.telegramBotToken, n.telegramChatId, text);
    }
  } catch (e) { console.warn(`[auto][${uid.slice(0, 6)}] telegram failed: ${e.message}`); }
}

async function processUser(db, uid, cfg) {
  const log = (msg) => console.log(`[auto][${uid.slice(0, 6)}] ${msg}`);

  if (cfg.broker !== 'alpaca') { log(`broker '${cfg.broker}' not supported in Phase 2 — skipping`); return; }
  if (!isTradeDayAllowed(cfg)) { log('not an allowed trade day — skipping'); return; }
  if (!cfg.apiKey || !cfg.apiSecret) { log('no broker API credentials — skipping'); return; }

  const baseUrl = resolveAlpacaBaseUrl(cfg);
  const live = isLiveBaseUrl(baseUrl); // paper-vs-live is decided by the broker URL
  // HARD LIVE GATE: a live broker URL only places real-money orders when the
  // operator has explicitly set the repo variable ALLOW_LIVE=true. Without it we
  // skip the account entirely — the in-app flag alone can never trade real money.
  if (live && !ALLOW_LIVE && !DRY_RUN) {
    log(`LIVE broker URL (${baseUrl}) but ALLOW_LIVE is not set — skipping for real-money safety. Set repo variable ALLOW_LIVE=true to permit live orders.`);
    return;
  }
  const client = createAlpacaClient({ baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });

  let account, positions, clock;
  try {
    account = await client.getAccount();
    positions = await client.getPositions();
    clock = await client.getClock();
  } catch (e) { log(`broker connect failed: ${e.message} — skipping`); return; }

  // Market-hours guard: never place real orders outside the regular session.
  // In dry-run we continue (so you can test any time) but flag it.
  if (!clock.isOpen) {
    if (!DRY_RUN) { log(`market closed (next open ${clock.nextOpen}) — skipping`); return; }
    log(`market closed (next open ${clock.nextOpen}) — dry-run continues for testing`);
  }

  const equity = account.equity;
  const dayRealizedPct = account.lastEquity > 0 ? ((account.equity - account.lastEquity) / account.lastEquity) * 100 : 0;

  // Account-level drawdown halt + equity snapshot for the curve. The peak (high-
  // water mark) persists in /users/{uid}/automation/state; a daily snapshot lands
  // in /users/{uid}/autoEquity/{date} so the app can plot the equity curve.
  const stateRef = db.collection('users').doc(uid).collection('automation').doc('state');
  const prevPeak = (await stateRef.get().then(s => s.exists ? s.data().peakEquity : 0).catch(() => 0)) || 0;
  const dd = drawdownHalted({ equity, peakEquity: prevPeak, maxDrawdownHaltPct: cfg.maxDrawdownHaltPct });
  await stateRef.set({ peakEquity: dd.peak, lastEquity: equity, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await db.collection('users').doc(uid).collection('autoEquity').doc(todayKey())
    .set({ date: todayKey(), equity, peak: dd.peak, drawdownPct: dd.drawdownPct, ts: admin.firestore.FieldValue.serverTimestamp() });
  if (dd.halted) log(`DRAWDOWN HALT: -${dd.drawdownPct.toFixed(1)}% from peak $${dd.peak.toFixed(0)} (>= ${cfg.maxDrawdownHaltPct}%) — no new entries`);
  let openCount = positions.length;
  const sectorCount = new Map();
  for (const p of positions) {
    const sec = SECTOR_BY_TICKER.get(p.symbol) || '?';
    sectorCount.set(sec, (sectorCount.get(sec) || 0) + 1);
  }
  const heldSymbols = new Set(positions.map(p => p.symbol));
  // Heat proxy: each open position carries ~riskPerTradePct of risk.
  let openHeatPct = openCount * (cfg.riskPerTradePct || 0);
  // Track remaining buying power so we never queue more than the account can fund.
  let availableBp = account.buyingPower;

  const modeLabel = live ? 'live' : 'paper';
  log(`mode=${modeLabel} equity=${equity.toFixed(0)} open=${openCount} dayP/L=${dayRealizedPct.toFixed(2)}% dryRun=${DRY_RUN}`);

  const markets = cfg.markets || ['US'];
  const now = new Date();

  // Recent LOSING exits, for the re-entry cooldown — the same guard the same-day
  // runner applies. Both paths write to the same journal and trade the same
  // account, so a cooldown enforced on only one of them is no cooldown at all:
  // the morning run would simply re-buy the name the afternoon run refused.
  // A failed read yields an empty list, disabling the cooldown rather than
  // blocking every entry.
  let recentLosses = [];
  if (REENTRY_COOLDOWN_DAYS > 0) {
    try {
      const since = new Date(now.getTime() - (REENTRY_COOLDOWN_DAYS + 1) * 86400_000);
      const snap = await db.collection('users').doc(uid).collection('autoOrders')
        .where('realizedWinLoss', '==', 'loss').get();
      recentLosses = snap.docs.map(d => {
        const o = d.data();
        const at = o.realizedAt?.toDate ? o.realizedAt.toDate() : (o.realizedAt ? new Date(o.realizedAt) : null);
        return at && at >= since ? { ticker: o.ticker, exitedAt: at } : null;
      }).filter(Boolean);
      if (recentLosses.length) log(`re-entry cooldown active for: ${recentLosses.map(l => l.ticker).join(', ')}`);
    } catch (e) { log(`cooldown lookup failed (${e.message}) — not applied`); }
  }
  // Enter only from the previous trading session's finalised bucket, and only
  // inside the morning window. Outside the window (e.g. the afternoon reconcile
  // run) we place nothing new but still reconcile below. Dry-run always evaluates
  // so it can be tested at any hour.
  const entryOpen = inEntryWindow(now);
  const bucket = await previousSessionDate(client, now);
  const canEnter = (entryOpen || DRY_RUN) && !!bucket;
  if (!bucket) log('no prior trading session in calendar — reconcile only');
  else if (!entryOpen && !DRY_RUN) log(`outside morning entry window (now ${marketClock(now).minutes} ET-min) — reconcile only`);
  else log(`entry session=${bucket} window=${entryOpen ? 'open' : 'closed'}`);

  const signals = canEnter ? await loadSignalsForBucket(db, bucket, markets) : [];
  const regimes = (canEnter && cfg.respectRegime !== false) ? await loadRegimes(db, bucket, markets) : {};
  // Best signals first so limited slots go to the highest-conviction names.
  const tierRank = { 'A+': 0, 'Tier 1': 1, 'Tier 2': 2 };
  signals.sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9));

  let placed = 0, skipped = 0;
  // When in a drawdown halt we open nothing new, but still fall through to the
  // reconciliation pass below so existing orders keep updating.
  for (const sig of (dd.halted ? [] : signals)) {
    const coid = clientOrderId(uid, sig.id);
    const journalRef = db.collection('users').doc(uid).collection('autoOrders').doc(coid);

    // Idempotency: already acted on this user+signal — but a prior DRY-RUN intent
    // must NOT block a real order, and neither should a prior ERROR (e.g. a price
    // the broker rejected): the next run inside the window retries it. Retrying is
    // double-submit-safe because the deterministic client order id collides at the
    // broker if the order actually went through. Only submitted/filled block.
    const existing = await journalRef.get();
    if (existing.exists && !['dryrun', 'error'].includes(existing.data().status)) { skipped++; continue; }

    // Never stack a second position on a symbol already held. The idempotency
    // check above is per-SIGNAL, so a fresh signal id on a name we already own
    // (a re-trigger, or the same ticker from another strategy) would otherwise
    // double the position — and double the risk the sizing math assumed.
    if (heldSymbols.has(sig.ticker)) { log(`skip ${sig.ticker}: already holding`); skipped++; continue; }

    const cool = inReentryCooldown(sig.ticker, recentLosses, now);
    if (cool.blocked) { log(`skip ${sig.ticker}: ${cool.reason}`); skipped++; continue; }

    const match = signalMatchesRules(sig, cfg);
    if (!match.ok) { log(`skip ${sig.ticker}: ${match.reasons[0] || 'rule filter'}`); skipped++; continue; }

    if (cfg.respectRegime !== false) {
      const reg = regimeAllowsEntry(regimes[sig.market || markets[0]], sig.side || 'buy');
      if (!reg.ok) { log(`skip ${sig.ticker}: ${reg.reason}`); skipped++; continue; }
    }

    // The stop we actually PLACE may be wider than the signal's natural stop
    // (see PLACED_STOP_PCT). Everything downstream — the entry guard, sizing,
    // the bracket leg and the journal — must use the SAME number, so derive it
    // once here and carry it on a shadow signal. The natural stop has already
    // done its job (it gated signal quality and set the target upstream).
    const placedSl = placedStopPrice(sig);
    const sigPlaced = { ...sig, slPrice: placedSl };

    // Prefer a live trade price for the slippage check; fall back to the cron's
    // last close if the data API is unavailable.
    const livePrice = (await client.getLatestPrice(sig.ticker)) ?? sig.currentPrice;
    if (!slippageOk(cfg, sig.entryPrice, livePrice, sig.side || 'buy', { pendingEntry: !!sig.pendingEntry })) {
      log(`skip ${sig.ticker}: slippage (live ${livePrice} vs entry ${sig.entryPrice} ± ${cfg.slippageBudgetPct}%)`); skipped++; continue;
    }
    if (!stopClearanceOk({ slPrice: placedSl, side: sig.side || 'buy', pendingEntry: !!sig.pendingEntry }, livePrice)) {
      log(`skip ${sig.ticker}: live ${livePrice} at/through SL ${placedSl} — bracket stop would fire on fill`); skipped++; continue;
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
      entry: sig.entryPrice, sl: placedSl,
    });
    if (size.shares < 1) { log(`skip ${sig.ticker}: size < 1 share (budget too small for price ${sig.entryPrice})`); skipped++; continue; }
    if (size.notional > availableBp + 1e-6) { log(`skip ${sig.ticker}: notional $${size.notional.toFixed(0)} > buying power $${availableBp.toFixed(0)}`); skipped++; continue; }

    const intent = buildBracketOrder({ signal: sigPlaced, shares: size.shares, clientOrderId: coid, slippageBudgetPct: cfg.slippageBudgetPct });
    const journal = {
      clientOrderId: coid, signalId: sig.id, ticker: sig.ticker, sector: sec,
      strategy: sig.strategy || null, strategyKey: sig.strategyKey || null, tier: sig.tier || null,
      side: intent.side, qty: size.shares, entry: sig.entryPrice, limitPrice: intent.limitPrice ?? null,
      // `sl` is the stop actually placed (the exit model replays against it too);
      // `naturalSl` keeps the signal's original stop for diagnostics.
      // `tp` is the target actually SENT to the broker — null for the trailing
      // strategies, which ship stop-only. `modelTp` keeps the signal's nominal
      // target for diagnostics so the two never get confused.
      tp: intent.takeProfit?.limitPrice ?? null,
      modelTp: sig.tpPrice ?? null,
      exitModel: intent.exitModel,
      sl: placedSl, naturalSl: sig.slPrice ?? null,
      // Session bucket this entry came from — the stale-entry sweep cancels an
      // unfilled entry once its session is no longer the current one.
      sessionDate: bucket,
      dollarRisk: size.dollarRisk, mode: modeLabel, live, dryRun: DRY_RUN,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (DRY_RUN) {
      journal.status = 'dryrun';
      await journalRef.set(journal);
      log(`DRYRUN would ${intent.side} ${size.shares} ${sig.ticker} limit ${intent.limitPrice} (entry ${sig.entryPrice}, ${exitLabel(intent)}/SL ${placedSl}, risk $${size.dollarRisk.toFixed(0)})`);
    } else {
      try {
        const order = await client.submitBracketOrder(intent);
        journal.status = 'submitted';
        journal.brokerOrderId = order?.id || null;
        await journalRef.set(journal);
        log(`PLACED ${intent.side} ${size.shares} ${sig.ticker} (order ${order?.id})`);
        await notify(db, uid, `🟢 <b>ENTRY</b> ${intent.side.toUpperCase()} ${size.shares} <b>${sig.ticker}</b> @ ${sig.entryPrice} · ${exitLabel(intent)} / SL ${placedSl} · ${modeLabel.toUpperCase()}`);
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
    heldSymbols.add(sig.ticker);
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
        if (!o?.status) continue;
        const filledQty = Number(o.filled_qty || 0);
        const terminal = ['filled', 'canceled', 'expired', 'rejected', 'done_for_day'].includes(o.status);
        // Strict one-session freshness: a GTC entry limit still unfilled after its
        // session has passed must not fill late — cancel it. (Only fully-unfilled
        // entries from an earlier session; a partial fill means we're in a position.)
        if (!terminal && filledQty === 0 && data.sessionDate && bucket && data.sessionDate !== bucket) {
          try {
            await client.cancelOrder(data.brokerOrderId);
            await d.ref.update({ status: 'expired', expiredAt: admin.firestore.FieldValue.serverTimestamp() });
            log(`EXPIRED stale unfilled entry ${data.ticker} (session ${data.sessionDate})`);
          } catch (e) { log(`cancel stale ${data.ticker} failed: ${e.message}`); }
          continue;
        }
        if (o.status !== 'new') {
          await d.ref.update({ status: o.status, filledQty, filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null, reconciledAt: admin.firestore.FieldValue.serverTimestamp() });
          if (o.status === 'filled') {
            await notify(db, uid, `🔵 <b>FILLED</b> ${data.ticker} ${data.qty} @ ${o.filled_avg_price || data.entry}`);
          }
        }
      } catch (e) { log(`reconcile ${data.ticker} failed: ${e.message}`); }
    }
  }

  // --- Exit management: apply the tracked exit model to REAL filled positions.
  // Shared with the same-day runner (scripts/lib/exit-pass.mjs) so both paths
  // apply exactly the same native / time-stop / trailing exits.
  await manageExits({
    db, admin, uid, client, log, dryRun: DRY_RUN,
    notify: (text) => notify(db, uid, text),
  });

  // --- Realized-outcome journaling: record each CLOSED trade's actual exit,
  // realized %, R, $ P&L, and win/loss onto its order doc — so the Auto Orders
  // page shows real broker results (not the settled-signal proxy) and never
  // depends on signal settlement. Backfills existing closed trades too, since
  // Alpaca retains the bracket order (with its filled leg) after the position
  // is gone. Skipped in dry-run (no real fills to read).
  if (!DRY_RUN) {
    try { await realizeOutcomes(db, uid, client, log); }
    catch (e) { log(`realize outcomes failed: ${e.message}`); }
  }

  log(`done: placed=${placed} skipped=${skipped} of ${signals.length} signals`);
  return { placed, skipped };
}

// For every closed order lacking a realized outcome, recover the exit price and
// compute realized %, R, $ P&L, and win/loss. Exit source: the model-exit price
// when the exit model fired (already journaled), else the filled bracket leg
// (TP=win / SL=loss) fetched from the retained parent order. Long-only.
async function realizeOutcomes(db, uid, client, log) {
  const snap = await db.collection('users').doc(uid).collection('autoOrders')
    .where('status', 'in', ['position_closed', 'exit_submitted']).get();
  for (const d of snap.docs) {
    const o = d.data();
    if (o.realizedWinLoss) continue;                     // already realized
    if ((o.side || 'buy') !== 'buy') continue;           // long-only
    const entry = o.filledAvgPrice ?? o.entry;
    const qty = o.filledQty || o.qty;
    if (entry == null || !qty) continue;

    let exit = null, reason = o.exitReason || null;
    if (o.exitModelPrice != null) {
      exit = Number(o.exitModelPrice);                    // model/native/time/trail exit
    } else if (o.brokerOrderId) {
      try {
        const parent = await client.getOrder(o.brokerOrderId, { nested: true });
        const leg = (parent?.legs || []).find(l =>
          (l.side === 'sell') && l.status === 'filled' && l.filled_avg_price != null);
        if (leg) {
          exit = Number(leg.filled_avg_price);
          reason = /stop/i.test(leg.type || '') ? 'stop' : 'target';
        }
      } catch (e) { log(`realize ${o.ticker}: fetch failed ${e.message}`); continue; }
    }
    if (exit == null || !Number.isFinite(exit)) continue; // exit not recoverable (e.g. manual close) — retry next run

    const pct = ((exit - entry) / entry) * 100;
    const slPct = (o.sl != null && entry > o.sl) ? ((entry - o.sl) / entry) * 100 : null;
    await d.ref.update({
      realizedExit: exit,
      realizedPct: pct,
      realizedR: slPct ? pct / slPct : null,
      realizedPnl: qty * (exit - entry),
      realizedWinLoss: pct >= 0 ? 'win' : 'loss',
      realizedExitReason: reason,
      realizedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    log(`REALIZED ${o.ticker}: ${pct >= 0 ? 'win' : 'loss'} ${pct.toFixed(2)}%${slPct ? ` ${(pct / slPct).toFixed(2)}R` : ''} exit ${exit} (${reason || 'exit'})`);
  }
}

// Record this run to /cronRuns (job='auto-trade') so the app's Execution Status
// page can show it alongside the refresh job. Best-effort.
async function recordAutoRun(db, { startedAt, users, placed, skipped, errors, note, error }) {
  try {
    const finishedAt = Date.now();
    await db.collection('cronRuns').add({
      job: 'auto-trade',
      dryRun: DRY_RUN,
      startedAt: admin.firestore.Timestamp.fromMillis(startedAt),
      finishedAt: admin.firestore.Timestamp.fromMillis(finishedAt),
      durationMs: finishedAt - startedAt,
      ok: !error,
      trigger: process.env.GITHUB_EVENT_NAME || 'manual',
      users: users ?? null, placed: placed ?? 0, skipped: skipped ?? 0, errors: errors ?? 0,
      note: note ?? null,
      error: error ? String(error) : null,
      logs: RUN_LOG.slice(-90),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('[auto] recordAutoRun failed', e.message); }
}

async function main() {
  const db = initAdmin();
  const startedAt = Date.now();
  console.log(`[auto] start dryRun=${DRY_RUN}${ONLY_UID ? ` onlyUid=${ONLY_UID}` : ''}`);

  // Global kill switch — env (this run) or Firestore (persisted operator pause).
  if (ENV_KILL) { console.log('[auto] KILL_SWITCH env set — aborting, no orders.'); await recordAutoRun(db, { startedAt, users: 0, note: 'kill switch (env)' }); return; }
  if (await isGloballyPaused(db)) { console.log('[auto] globally paused (publicConfig/automation.paused) — aborting.'); await recordAutoRun(db, { startedAt, users: 0, note: 'globally paused' }); return; }

  const configs = await loadEnabledConfigs(db);
  console.log(`[auto] ${configs.length} user(s) with automation enabled`);
  let placed = 0, skipped = 0, errors = 0;
  for (const { uid, cfg } of configs) {
    try { const r = await processUser(db, uid, cfg); placed += r?.placed || 0; skipped += r?.skipped || 0; }
    catch (e) { errors++; console.error(`[auto][${uid.slice(0, 6)}] fatal: ${e.message}`); }
  }
  console.log('[auto] complete');
  await recordAutoRun(db, { startedAt, users: configs.length, placed, skipped, errors });
}

main().catch(e => { console.error('[auto] fatal', e); process.exit(1); });
