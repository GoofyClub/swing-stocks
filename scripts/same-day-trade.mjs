#!/usr/bin/env node
// =============================================================================
// same-day-trade.mjs — "trade the close" execution worker.
//
// WHY THIS EXISTS
//   The scheduled path (auto-trade.mjs) enters from the PREVIOUS session's
//   finalised signals, so a signal fired on Monday's close is bought Tuesday
//   morning. Strategies modelled on the closing price lose part of their edge to
//   that gap: Connors RSI2 buys the oversold CLOSE, and by the next open the
//   bounce has frequently already started (you pay up) or the name gapped down
//   (you buy into a knife). This runner scans and enters the SAME afternoon,
//   minutes before the bell, which is the entry the strategy actually assumes.
//
// HOW IT DIFFERS FROM auto-trade.mjs
//   • Scans in-process from live bars instead of reading a finalised Firestore
//     signal bucket. That also means ZERO signal reads/writes — this path costs
//     no Firestore signal quota at all.
//   • Entries are MARKET orders (still bracketed). Minutes before the close a
//     market order fills at ~the closing price, and unlike a market-on-close
//     order it can still carry its TP/SL bracket. A limit risks not filling,
//     which for a trade-the-close entry means missing the trade entirely.
//   • Runs only inside the close window (15:35-15:50 ET) — see inCloseWindow.
//
// WHAT IT REUSES (deliberately — no second copy of the risk logic)
//   The identical strategy scan, rule filter, regime gate, portfolio guards,
//   placed-stop override and position sizing as the morning worker. Only the
//   signal SOURCE and the order type differ.
//
// IMPORTANT: the signal is computed on a near-final price, not the settled
// close, so a late-session reversal can invalidate it. That is inherent to any
// trade-the-close system (Connors' own rule has the same practical issue), not
// a defect of this implementation.
//
// SAFETY
//   • DRY_RUN defaults to TRUE — logs intended orders without submitting.
//   • Live orders still require ALLOW_LIVE=true, same hard gate as the morning
//     worker. A live broker URL alone can never place real-money orders.
//   • Idempotent per user+ticker+session via a deterministic client order id, so
//     re-running inside the window cannot double-submit.
//   • Refuses to run outside the close window unless FORCE_WINDOW=true.
//
// USAGE (intended: a cron/systemd timer on a machine you control — GitHub
// Actions cron is routinely 2-3 h late and cannot hit a 15-minute window)
//   DRY_RUN=false node scripts/same-day-trade.mjs
//
// Required env: FIREBASE_PROJECT_ID. Credentials are optional — with none set it
//               falls back to Application Default Credentials, which on a GCE VM
//               is the attached service account (no key file needed, and the only
//               option when the org blocks service-account key creation). To use
//               an explicit key instead, set FIREBASE_SERVICE_ACCOUNT_FILE (path)
//               or FIREBASE_SERVICE_ACCOUNT_JSON (raw JSON — what CI uses).
// Bar data env: ALPACA_KEY/ALPACA_SECRET (preferred), ALPHAVANTAGE_KEY, ...
// Optional env: DRY_RUN, ONLY_UID, KILL_SWITCH, ALLOW_LIVE, FORCE_WINDOW,
//               STRATEGIES (comma list; default: every strategy the user allows)
// =============================================================================

import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  clientOrderId, sizePosition, signalMatchesRules, passesPortfolioGuards,
  isTradeDayAllowed, buildBracketOrder, regimeAllowsEntry, drawdownHalted,
  marketClock, inCloseWindow, placedStopPrice, stopClearanceOk, inReentryCooldown, REENTRY_COOLDOWN_DAYS,
} from '../src/auto/engine.js';
import { STRATEGIES, tierReasons, advUsdFor } from '../src/strategy/normalize.js';
import { createAlpacaClient, resolveAlpacaBaseUrl, isLiveBaseUrl } from '../src/broker/alpaca.js';
import { STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA, watchlistFor, DATA_SOURCE_ORDER, LARGE_CAP_TICKERS, NIFTY50_TICKERS, MARKET_CONFIGS } from '../src/data/markets.js';
import { regimeCheck } from '../src/strategy/engine.js';
import { fetchBars } from '../src/data/fetchers.js';
import { sendTelegram } from '../src/data/telegram.js';

const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const ONLY_UID = process.env.ONLY_UID || null;
const ENV_KILL = String(process.env.KILL_SWITCH ?? 'false').toLowerCase() === 'true';
const ALLOW_LIVE = String(process.env.ALLOW_LIVE ?? 'false').toLowerCase() === 'true';
const FORCE_WINDOW = String(process.env.FORCE_WINDOW ?? 'false').toLowerCase() === 'true';
const ONLY_STRATEGIES = (process.env.STRATEGIES || '').split(',').map(s => s.trim()).filter(Boolean);
// Last minute (ET) at which an entry may still be submitted. Past this a market
// order no longer approximates the close, so we stop rather than trade badly.
const ORDER_DEADLINE_ET_MIN = 15 * 60 + 58;

const RUN_LOG = [];
{
  const _log = console.log.bind(console), _warn = console.warn.bind(console), _err = console.error.bind(console);
  const push = (s) => { RUN_LOG.push(s); if (RUN_LOG.length > 150) RUN_LOG.shift(); };
  console.log = (...a) => { push(a.map(String).join(' ')); _log(...a); };
  console.warn = (...a) => { push('WARN ' + a.map(String).join(' ')); _warn(...a); };
  console.error = (...a) => { push('ERROR ' + a.map(String).join(' ')); _err(...a); };
}

function initAdmin() {
  if (admin.apps.length) return admin.firestore();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID must be set.');

  // Credentials, in order of preference:
  //
  //   1. FIREBASE_SERVICE_ACCOUNT_FILE — a path to the key JSON. Preferred over
  //      pasting the key inline: systemd's EnvironmentFile is not a shell and
  //      mishandles the quotes in the blob, which fails at parse time on a
  //      trading afternoon rather than at setup.
  //   2. FIREBASE_SERVICE_ACCOUNT_JSON — raw JSON. What CI uses (GitHub Secrets).
  //   3. Application Default Credentials — nothing configured. On a GCE VM this
  //      is the attached service account, fetched from the metadata server. It
  //      needs no key on disk at all, which is why many orgs now BLOCK key
  //      creation outright (iam.disableServiceAccountKeyCreation). It is also
  //      simply better: nothing to leak, rotate, or protect.
  //
  // For (3) the VM's service account needs Firestore access (roles/datastore.user)
  // ON THE FIREBASE PROJECT — which may not be the project the VM lives in — and
  // the VM needs the cloud-platform scope.
  const saFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const saJson = saFile ? readFileSync(saFile, 'utf8') : process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (saJson) {
    let creds;
    try { creds = JSON.parse(saJson); }
    catch (e) { throw new Error(`service account key is not valid JSON (${saFile ? `file ${saFile}` : 'FIREBASE_SERVICE_ACCOUNT_JSON'}): ${e.message}`); }
    admin.initializeApp({ credential: admin.credential.cert(creds), projectId });
  } else {
    console.log('[sameday] no service-account key configured — using Application Default Credentials (GCE attached service account)');
    admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId });
  }
  return admin.firestore();
}

// US 'broad' means the full S&P universe (~1500 names), NOT the 113-name broad
// watchlist — that is what refresh-signals scans, so matching it here is what
// makes the two entry paths see the same stocks. Getting this wrong silently
// shrinks the same-day universe by ~13x.
const __dir = path.dirname(fileURLToPath(import.meta.url));
const __universe = (() => {
  try { return JSON.parse(readFileSync(path.join(__dir, '../src/data/universe.json'), 'utf8')); }
  catch { return null; }
})();
const UNIVERSE_LIST_US = __universe
  ? Object.entries(__universe).map(([t, v]) => ({ t, s: v.sector, name: v.name }))
  : null;
// ticker -> sp500 | sp400 | sp600. Without this every US signal is tagged
// index:null, which an index allow-list then rejects wholesale — only the 51
// curated large-caps (tagged via largeCap) would survive.
const UNIVERSE_INDEX = new Map(
  __universe ? Object.entries(__universe).map(([t, v]) => [t, v.index]) : [],
);

const SECTOR_BY_TICKER = (() => {
  const m = new Map();
  for (const it of [...STARTER_WATCHLIST, ...STARTER_WATCHLIST_INDIA]) m.set(it.t, it.s);
  return m;
})();

function buildCtx(market) {
  return {
    apiKeys: {
      alphavantage: process.env.ALPHAVANTAGE_KEY || '',
      finnhub:      process.env.FINNHUB_KEY     || '',
      fmp:          process.env.FMP_KEY         || '',
      ...(process.env.ALPACA_KEY && process.env.ALPACA_SECRET
        ? { alpaca: { key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET } }
        : {}),
    },
    market,
    enabledSources: new Set(DATA_SOURCE_ORDER),
    manualBars: null,
    cache: new Map(),
    fetchImpl: globalThis.fetch,
  };
}

async function isGloballyPaused(db) {
  try {
    const snap = await db.collection('publicConfig').doc('automation').get();
    return snap.exists && snap.data()?.paused === true;
  } catch { return false; }
}

async function loadEnabledConfigs(db) {
  let snap;
  try {
    snap = await db.collectionGroup('automation').where('enabled', '==', true).get();
  } catch (e) {
    if (e.code === 9 || /index/i.test(e.message || '')) {
      console.warn(`[sameday] automation.enabled index missing — scanning all automation docs. (${e.message})`);
      snap = await db.collectionGroup('automation').get();
    } else { throw e; }
  }
  const out = [];
  snap.forEach(doc => {
    if (doc.id !== 'config') return;
    const cfg = doc.data();
    if (cfg.enabled !== true) return;
    const uid = doc.ref.parent.parent?.id;
    if (!uid) return;
    if (ONLY_UID && uid !== ONLY_UID) return;
    out.push({ uid, cfg });
  });
  return out;
}

async function notify(db, uid, text) {
  try {
    const snap = await db.collection('users').doc(uid).collection('notifications').doc('config').get();
    const n = snap.exists ? snap.data() : null;
    if (n?.telegramEnabled && n.telegramBotToken && n.telegramChatId) {
      await sendTelegram(n.telegramBotToken, n.telegramChatId, text);
    }
  } catch (e) { console.warn(`[sameday][${uid.slice(0, 6)}] telegram failed: ${e.message}`); }
}

// Scan one market's watchlist in-process and return signal-shaped rows matching
// what the Firestore path produces, so every downstream filter behaves identically.
// `sessionDate` is today (ET) — this IS the session being traded.
async function scanForSignals(market, cfg, sessionDate, log) {
  const ctx = buildCtx(market);
  const watchlistSet = process.env.WATCHLIST_SET || 'core';
  // Mirror refresh-signals: US 'broad' = the full S&P universe file.
  const watchlist = (market === 'US' && watchlistSet === 'broad' && UNIVERSE_LIST_US?.length)
    ? UNIVERSE_LIST_US
    : watchlistFor(market, watchlistSet);
  // Only scan strategies this user could actually trade — a strategy they've
  // filtered out can never produce an order, so fetching bars for it is waste.
  const allowed = new Set(
    ONLY_STRATEGIES.length ? ONLY_STRATEGIES
      : (cfg.strategies?.length ? cfg.strategies : Object.keys(STRATEGIES)),
  );
  // Surface the universe actually being scanned: if this is much smaller than
  // what the morning worker covers, the two paths are not seeing the same names.
  log(`scanning ${market} watchlist=${watchlist.length} (set=${watchlistSet}) strategies=[${[...allowed].join(',')}]`);
  const out = [];
  // Individual bar-fetch failures are expected (recent listings, thin names) and
  // are not fatal — but a scan silently losing a third of its universe to
  // rate-limiting looks identical to a quiet day, so count them and report.
  let fetchFailed = 0, fetchOk = 0;
  for (const item of watchlist) {
    let bars;
    try { bars = await fetchBars(item.t, ctx); }
    catch (e) { fetchFailed++; if (fetchFailed <= 5) log(`bars unavailable for ${item.t}: ${e.message}`); continue; }
    if (!bars?.length) { fetchFailed++; continue; }
    fetchOk++;
    const idx = bars.length - 1; // today's (still-forming) bar — the close proxy
    for (const key of allowed) {
      const def = STRATEGIES[key];
      if (!def || def.needsFmp) continue; // FMP-driven strategies need data we don't pull here
      let res;
      try { res = def.evaluate(bars, { ...ctx, index: idx }); }
      catch (e) { log(`${item.t} ${key} threw: ${e.message}`); continue; }
      const env = res?.envelope;
      if (!env) continue;
      // Tier is DERIVED from the strategy's raw output, not returned by evaluate()
      // — same call refresh-signals makes. Reading a non-existent res.tier left
      // every signal at null, which the tier filter then rejected wholesale.
      const { tier, reasons: tierWhy } = tierReasons(key, res.raw);
      out.push({
        id: `${item.t}_${key}_${sessionDate}`,
        ticker: item.t,
        market,
        sector: item.s,
        strategy: def.short || key,
        strategyKey: key,
        tier,
        tierReasons: tierWhy,
        side: env.side || 'buy',
        entryPrice: env.entry,
        tpPrice: env.tp,
        slPrice: env.sl,
        slPct: env.slPct ?? null,
        expectedR: env.expectedR ?? null,
        pendingEntry: !!env.pendingEntry,
        currentPrice: bars[idx].close,
        index: market === 'INDIA'
          ? (NIFTY50_TICKERS.has(item.t) ? 'nifty50' : null)
          : (UNIVERSE_INDEX.get(item.t) || null),
        largeCap: LARGE_CAP_TICKERS.has(item.t),
        // 20-day average dollar volume — the liquidity floor (cfg.minAdvUsd) is
        // only applied when this is present, so omitting it silently disabled
        // the user's setting.
        advUsd: advUsdFor(bars),
        status: 'open',
      });
    }
  }
  if (fetchFailed) {
    const pct = Math.round((fetchFailed / watchlist.length) * 100);
    const warn = pct >= 20
      ? ' — HIGH. Likely rate-limiting on the keyless endpoints; set ALPACA_KEY + ALPACA_SECRET.'
      : '';
    log(`${market} bars: ${fetchOk} ok, ${fetchFailed} failed (${pct}%)${warn}${fetchFailed > 5 ? ' [first 5 logged]' : ''}`);
  }
  return out;
}

// Live regime snapshot, computed in-process from index + VIX bars.
//
// The morning path reads a finalised regime doc written by refresh-signals; no
// such doc exists intraday. Rather than skip a guard the user switched ON — the
// same-day runner may be the ONLY entry path, so skipping it would silently
// disable risk-off protection entirely — compute it here from the same inputs
// refresh-signals uses. Returns null when the index bars can't be fetched, and
// regimeAllowsEntry() treats null as "no opinion" (allow), matching the
// morning path's behaviour when its regime doc is missing.
async function liveRegime(market, ctx, log) {
  const mcfg = MARKET_CONFIGS[market];
  if (!mcfg?.indexTicker) return null;
  try {
    const indexBars = await fetchBars(mcfg.indexTicker, ctx);
    let vixBars = null;
    if (mcfg.vixTicker) {
      try { vixBars = await fetchBars(mcfg.vixTicker, ctx); }
      catch { /* VIX is optional — regimeCheck handles its absence */ }
    }
    const r = regimeCheck(indexBars, vixBars, null, {
      vixThreshold: mcfg.vixThreshold, vixPanic: mcfg.vixPanic, indexLabel: mcfg.indexLabel,
    });
    log(`${market} regime: ${r.go_to_cash ? '⛔ RISK-OFF (go to cash)' : '✅ ok'}${r.details?.vix != null ? ` · VIX ${r.details.vix.toFixed(1)}` : ''}`);
    return r;
  } catch (e) {
    log(`${market} regime unavailable (${e.message}) — gate not applied`);
    return null;
  }
}

async function processUser(db, uid, cfg, now) {
  const log = (msg) => console.log(`[sameday][${uid.slice(0, 6)}] ${msg}`);

  if (cfg.broker !== 'alpaca') { log(`broker '${cfg.broker}' not supported — skipping`); return; }
  if (!isTradeDayAllowed(cfg)) { log('not an allowed trade day — skipping'); return; }
  if (!cfg.apiKey || !cfg.apiSecret) { log('no broker API credentials — skipping'); return; }

  const baseUrl = resolveAlpacaBaseUrl(cfg);
  const live = isLiveBaseUrl(baseUrl);
  if (live && !ALLOW_LIVE && !DRY_RUN) {
    log(`LIVE broker URL (${baseUrl}) but ALLOW_LIVE is not set — skipping for real-money safety.`);
    return;
  }
  const client = createAlpacaClient({ baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });

  let account, positions, clock;
  try {
    account = await client.getAccount();
    positions = await client.getPositions();
    clock = await client.getClock();
  } catch (e) { log(`broker connect failed: ${e.message} — skipping`); return; }

  if (!clock.isOpen) {
    if (!DRY_RUN) { log(`market closed (next open ${clock.nextOpen}) — skipping`); return; }
    log('market closed — dry-run continues for testing');
  }

  const equity = account.equity;
  const dayRealizedPct = account.lastEquity > 0 ? ((account.equity - account.lastEquity) / account.lastEquity) * 100 : 0;

  const stateRef = db.collection('users').doc(uid).collection('automation').doc('state');
  const prevPeak = (await stateRef.get().then(s => s.exists ? s.data().peakEquity : 0).catch(() => 0)) || 0;
  const dd = drawdownHalted({ equity, peakEquity: prevPeak, maxDrawdownHaltPct: cfg.maxDrawdownHaltPct });
  if (dd.halted) { log(`DRAWDOWN HALT: -${dd.drawdownPct.toFixed(1)}% from peak — no new entries`); return; }

  let openCount = positions.length;
  const sectorCount = new Map();
  for (const p of positions) {
    const sec = SECTOR_BY_TICKER.get(p.symbol) || '?';
    sectorCount.set(sec, (sectorCount.get(sec) || 0) + 1);
  }
  const heldSymbols = new Set(positions.map(p => p.symbol));

  // Recent LOSING exits, for the re-entry cooldown. Read from the order journal's
  // realized outcomes; a missing/failed read yields an empty list, which disables
  // the cooldown rather than blocking every entry.
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
  let openHeatPct = openCount * (cfg.riskPerTradePct || 0);
  let availableBp = account.buyingPower;

  const modeLabel = live ? 'live' : 'paper';
  const sessionDate = marketClock(now).date;
  log(`mode=${modeLabel} equity=${equity.toFixed(0)} open=${openCount} session=${sessionDate} dryRun=${DRY_RUN}`);

  const markets = cfg.markets || ['US'];
  const scanStarted = Date.now();
  // Regime is evaluated per market BEFORE scanning: when it says risk-off there
  // is no point fetching 1500 tickers we cannot act on.
  const regimes = {};
  if (cfg.respectRegime !== false) {
    for (const m of markets) regimes[m] = await liveRegime(m, buildCtx(m), log);
  }
  let signals = [];
  for (const m of markets) signals = signals.concat(await scanForSignals(m, cfg, sessionDate, log));
  const tierRank = { 'A+': 0, 'Tier 1': 1, 'Tier 2': 2 };
  signals.sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9));
  const scanSecs = Math.round((Date.now() - scanStarted) / 1000);
  log(`scanned ${signals.length} candidate signal(s) in ${scanSecs}s (ET now ${marketClock(new Date()).minutes} min)`);

  let placed = 0, skipped = 0;
  for (const sig of signals) {
    // HARD DEADLINE. The window is checked once at startup, but the scan fetches
    // bars for the whole watchlist and takes real time — on a broad watchlist it
    // can run for many minutes. Without this, a slow scan would keep firing
    // entries after the bell, when a market order no longer gets anything like
    // the closing price (and may just be rejected). Re-check the clock before
    // EVERY order and stop dead once we're too close to the close.
    if (!FORCE_WINDOW && marketClock(new Date()).minutes >= ORDER_DEADLINE_ET_MIN) {
      log(`DEADLINE: past ${Math.floor(ORDER_DEADLINE_ET_MIN / 60)}:${String(ORDER_DEADLINE_ET_MIN % 60).padStart(2, '0')} ET — stopping, ${signals.length - placed - skipped} candidate(s) not placed. Start the timer earlier or use a smaller watchlist.`);
      break;
    }
    // Every skip below is LOGGED with its reason. A silent `skipped++` makes a
    // run that places nothing indistinguishable from a run that was misconfigured
    // — the whole point of the dry-run rehearsal is seeing which rule bit.
    //
    // A buy-stop setup needs price to trade UP through entry — that cannot be
    // resolved in the final minutes, so those strategies stay on the morning path.
    if (sig.pendingEntry) { log(`skip ${sig.ticker} (${sig.strategyKey}): buy-stop entry — morning path only`); skipped++; continue; }

    const coid = clientOrderId(uid, sig.id);
    const journalRef = db.collection('users').doc(uid).collection('autoOrders').doc(coid);
    const existing = await journalRef.get();
    if (existing.exists && !['dryrun', 'error'].includes(existing.data().status)) {
      log(`skip ${sig.ticker} (${sig.strategyKey}): already acted on this session (status ${existing.data().status})`); skipped++; continue;
    }

    const match = signalMatchesRules(sig, cfg);
    if (!match.ok) { log(`skip ${sig.ticker} (${sig.strategyKey}): ${match.reasons[0] || 'rule filter'}`); skipped++; continue; }

    // Never stack a second position on a symbol already held — the morning path
    // may already own it, and Alpaca positions are per-symbol so the exit model
    // could not tell the two apart.
    if (heldSymbols.has(sig.ticker)) { log(`skip ${sig.ticker}: already holding`); skipped++; continue; }

    // Don't immediately re-take a name that just stopped out — a still-falling
    // stock keeps re-qualifying for a mean-reversion setup (ARWR: 3 losses in 3
    // sessions).
    const cool = inReentryCooldown(sig.ticker, recentLosses, now);
    if (cool.blocked) { log(`skip ${sig.ticker}: ${cool.reason}`); skipped++; continue; }

    if (cfg.respectRegime !== false) {
      const reg = regimeAllowsEntry(regimes[sig.market || markets[0]], sig.side || 'buy');
      if (!reg.ok) { log(`skip ${sig.ticker}: ${reg.reason}`); skipped++; continue; }
    }

    const placedSl = placedStopPrice(sig);
    const livePrice = (await client.getLatestPrice(sig.ticker)) ?? sig.currentPrice;
    // Entry is a market order at ~the close, so slippage-vs-signal-price is not
    // meaningful here; what still matters is not buying into our own stop.
    if (!stopClearanceOk({ slPrice: placedSl, side: sig.side || 'buy', pendingEntry: false }, livePrice)) {
      log(`skip ${sig.ticker}: live ${livePrice} at/through SL ${placedSl}`); skipped++; continue;
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
      entry: livePrice, sl: placedSl,
    });
    if (size.shares < 1) {
      log(`skip ${sig.ticker}: size < 1 share (risk budget too small for price ${livePrice}, stop ${placedSl})`); skipped++; continue;
    }
    if (size.notional > availableBp + 1e-6) {
      log(`skip ${sig.ticker}: notional $${size.notional.toFixed(0)} > buying power $${availableBp.toFixed(0)}`); skipped++; continue;
    }

    const intent = buildBracketOrder({
      signal: { ...sig, slPrice: placedSl }, shares: size.shares,
      clientOrderId: coid, entryType: 'market',
    });
    const journal = {
      clientOrderId: coid, signalId: sig.id, ticker: sig.ticker, sector: sec,
      strategy: sig.strategy || null, strategyKey: sig.strategyKey || null, tier: sig.tier || null,
      side: intent.side, qty: size.shares, entry: livePrice, limitPrice: null,
      tp: sig.tpPrice, sl: placedSl, naturalSl: sig.slPrice ?? null,
      sessionDate, entryPath: 'same_day_close',
      dollarRisk: size.dollarRisk, mode: modeLabel, live, dryRun: DRY_RUN,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (DRY_RUN) {
      journal.status = 'dryrun';
      await journalRef.set(journal);
      log(`DRYRUN would ${intent.side} ${size.shares} ${sig.ticker} @ market ~${livePrice} (TP ${sig.tpPrice} / SL ${placedSl}, risk $${size.dollarRisk.toFixed(0)})`);
    } else {
      try {
        const order = await client.submitBracketOrder(intent);
        journal.status = 'submitted';
        journal.brokerOrderId = order?.id || null;
        await journalRef.set(journal);
        log(`PLACED ${intent.side} ${size.shares} ${sig.ticker} @ market (order ${order?.id})`);
        await notify(db, uid, `🟢 <b>SAME-DAY ENTRY</b> ${intent.side.toUpperCase()} ${size.shares} <b>${sig.ticker}</b> @ ~${livePrice} · TP ${sig.tpPrice} / SL ${placedSl} · ${modeLabel.toUpperCase()}`);
      } catch (e) {
        journal.status = 'error';
        journal.error = e.message;
        await journalRef.set(journal);
        log(`ERROR placing ${sig.ticker}: ${e.message}`);
        skipped++; continue;
      }
    }

    placed++; openCount++; openHeatPct += cfg.riskPerTradePct || 0;
    availableBp -= size.notional;
    heldSymbols.add(sig.ticker);
    sectorCount.set(sec, (sectorCount.get(sec) || 0) + 1);
  }

  log(`done: placed=${placed} skipped=${skipped} of ${signals.length} candidates`);
  return { placed, skipped };
}

async function recordRun(db, { startedAt, users, placed, skipped, errors, note, error }) {
  try {
    const finishedAt = Date.now();
    await db.collection('cronRuns').add({
      job: 'same-day-trade',
      dryRun: DRY_RUN,
      startedAt: admin.firestore.Timestamp.fromMillis(startedAt),
      finishedAt: admin.firestore.Timestamp.fromMillis(finishedAt),
      durationMs: finishedAt - startedAt,
      ok: !error,
      trigger: process.env.GITHUB_EVENT_NAME || 'cron',
      users: users ?? null, placed: placed ?? 0, skipped: skipped ?? 0, errors: errors ?? 0,
      note: note ?? null,
      error: error ? String(error) : null,
      logs: RUN_LOG.slice(-90),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('[sameday] recordRun failed', e.message); }
}

async function main() {
  const db = initAdmin();
  const startedAt = Date.now();
  const now = new Date();
  const { minutes, date } = marketClock(now);
  console.log(`[sameday] start dryRun=${DRY_RUN} etDate=${date} etMinutes=${minutes}`);

  if (ENV_KILL) { console.log('[sameday] KILL_SWITCH set — aborting.'); await recordRun(db, { startedAt, users: 0, note: 'kill switch' }); return; }
  if (await isGloballyPaused(db)) { console.log('[sameday] globally paused — aborting.'); await recordRun(db, { startedAt, users: 0, note: 'globally paused' }); return; }
  if (!inCloseWindow(now) && !FORCE_WINDOW) {
    console.log('[sameday] outside the 15:35-15:50 ET close window — nothing to do. Set FORCE_WINDOW=true to override.');
    await recordRun(db, { startedAt, users: 0, note: 'outside close window' });
    return;
  }

  const configs = await loadEnabledConfigs(db);
  console.log(`[sameday] ${configs.length} user(s) with automation enabled`);
  let placed = 0, skipped = 0, errors = 0;
  for (const { uid, cfg } of configs) {
    try { const r = await processUser(db, uid, cfg, now); placed += r?.placed || 0; skipped += r?.skipped || 0; }
    catch (e) { errors++; console.error(`[sameday][${uid.slice(0, 6)}] fatal: ${e.message}`); }
  }
  console.log('[sameday] complete');
  await recordRun(db, { startedAt, users: configs.length, placed, skipped, errors });
}

main().catch(e => { console.error('[sameday] fatal', e); process.exit(1); });
