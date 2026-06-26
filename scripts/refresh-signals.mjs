#!/usr/bin/env node
// =============================================================================
// refresh-signals.mjs — GitHub Actions cron worker.
//
// Runs on the schedule defined in .github/workflows/refresh-signals.yml.
// For each market (US, INDIA):
//   1. Fetch SPY/NIFTY + sector ETFs + every ticker in the starter watchlist.
//   2. For each ticker, run every pure strategy from /src/strategy/normalize.js.
//   3. Normalize each detected signal to { entry, tp, sl } and write to
//      /marketData/{YYYY-MM-DD}/signals/{id} via Firebase Admin SDK.
//   4. Re-settle any signals from the last 90 days using the freshly-fetched
//      bars (mark win/loss/open based on whether TP or SL was touched).
//   5. Prune /marketData docs older than 90 days (3-month retention).
//
// Required env vars (set in repo Secrets):
//   FIREBASE_SERVICE_ACCOUNT_JSON   — JSON string of a service account key
//   FIREBASE_PROJECT_ID             — the project ID
//   ALPHAVANTAGE_KEY                — optional but recommended
//   FINNHUB_KEY                     — optional
//   FMP_KEY                         — optional; enables PEAD/Insider/Analyst
// =============================================================================

import admin from 'firebase-admin';
import { fetchBars } from '../src/data/fetchers.js';
import { fetchFMPData, makeFmpCache } from '../src/data/fmp.js';
import { STRATEGIES, settleSignal, tierReasons, SETTLEMENT_VERSION } from '../src/strategy/normalize.js';
import { regimeCheck, sectorRank } from '../src/strategy/engine.js';
import { MARKET_CONFIGS, STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA, DATA_SOURCE_ORDER, companyName } from '../src/data/markets.js';
import { sendTelegram } from '../src/data/telegram.js';

// Signals are retained (and re-gradable) for this many days. Drives both the
// prune cutoff and the re-settle window, so it must cover the longest timeframe
// the History view offers (2Y chip) with a margin. Extending this only affects
// data captured from here on — anything already pruned is gone for good.
const RETENTION_DAYS = 800;
const MARKETS_TO_RUN = (process.env.MARKETS || 'US,INDIA').split(',').map(s => s.trim());
// Public site URL. Used as the click-through target in push notifications so
// tapping the alert opens the deployed app at My Trades.
const APP_URL = process.env.APP_URL || 'https://goofyclub.github.io/swing-stocks/';

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}
function daysAgo(n, now = new Date()) {
  return new Date(now.getTime() - n * 86400_000).toISOString().slice(0, 10);
}

function initAdmin() {
  if (admin.apps.length) return admin.firestore();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saJson    = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) {
    throw new Error('FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be set.');
  }
  const sa = JSON.parse(saJson);
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId,
  });
  return admin.firestore();
}

function buildCtx(market) {
  return {
    apiKeys: {
      alphavantage: process.env.ALPHAVANTAGE_KEY || '',
      finnhub:      process.env.FINNHUB_KEY     || '',
      fmp:          process.env.FMP_KEY         || '',
    },
    market,
    enabledSources: new Set(DATA_SOURCE_ORDER),
    manualBars: null,
    cache: new Map(),
    fetchImpl: globalThis.fetch, // Node 18+ has native fetch
  };
}

function strategyKeyToShort(key) {
  return STRATEGIES[key]?.short || key;
}

async function scanMarket(db, market, ctxIn) {
  const cfg = MARKET_CONFIGS[market];
  const ctx = ctxIn || buildCtx(market);
  const watchlist = market === 'INDIA' ? STARTER_WATCHLIST_INDIA : STARTER_WATCHLIST;
  console.log(`\n[scan] market=${market} watchlist=${watchlist.length}`);

  // 1. Pull the index for relative-strength regime check.
  let spyBars = null;
  try { spyBars = await fetchBars(cfg.indexTicker, ctx); }
  catch (e) { console.warn(`[scan] could not fetch index ${cfg.indexTicker}: ${e.message}`); }

  // VIX for regime
  let vixBars = null;
  if (cfg.vixTicker) {
    try { vixBars = await fetchBars(cfg.vixTicker, ctx); }
    catch (e) { console.warn(`[scan] could not fetch VIX ${cfg.vixTicker}: ${e.message}`); }
  }

  // Sector ETFs for sector ranks
  const sectorBars = {};
  for (const etf of cfg.sectorEtfs || []) {
    try { sectorBars[etf] = await fetchBars(etf, ctx); }
    catch (e) { console.warn(`[scan] could not fetch sector ${etf}: ${e.message}`); }
  }

  const fmpCache = makeFmpCache();
  const dateBucket = todayKey();
  const docRef = db.collection('marketData').doc(dateBucket);
  await docRef.set({
    market,
    refreshedAt: admin.firestore.FieldValue.serverTimestamp(),
    refreshedBy: 'github-actions-cron',
    sourcesUsed: DATA_SOURCE_ORDER.filter(s => ctx.enabledSources.has(s)),
  }, { merge: true });

  const sigCol = docRef.collection('signals');
  let writes = 0, errors = 0;

  // Aggregates collected during the scan so we can write a per-market summary at the end.
  const agg = {
    market,
    buyCount: 0,
    sellCount: 0,
    totalCount: 0,
    byStrategy: {}, // strategyShort -> count
    bySector:   {}, // sectorCode    -> count
  };

  for (const item of watchlist) {
    const ticker = item.t;
    let bars;
    try {
      bars = await fetchBars(ticker, ctx);
    } catch (e) {
      errors++;
      console.warn(`[scan] ${ticker}: ${e.message}`);
      continue;
    }

    // FMP-dependent strategies — fetch once per ticker, cached for 1h.
    let fmpData = null;
    if (ctx.apiKeys.fmp) {
      try {
        fmpData = await fetchFMPData(ticker, { apiKey: ctx.apiKeys.fmp, cache: fmpCache, fetchImpl: ctx.fetchImpl });
      } catch (e) { console.warn(`[scan] ${ticker} FMP: ${e.message}`); }
    }

    for (const [stratKey, def] of Object.entries(STRATEGIES)) {
      if (def.needsFmp && !fmpData) continue;
      let result;
      try {
        result = def.evaluate(bars, { spyBars, fmpData, marketCfg: cfg });
      } catch (e) {
        console.warn(`[scan] ${ticker} ${stratKey} threw: ${e.message}`);
        continue;
      }
      if (!result) continue;

      const env = result.envelope;
      const { tier, reasons: tierWhy } = tierReasons(stratKey, result.raw);
      const id = `${ticker}_${stratKey}_${dateBucket}`;
      const docBody = {
        ticker,
        name:         companyName(item),
        sector:       item.s,
        market,
        strategy:     def.short,
        strategyKey:  stratKey,
        tier,
        // Confluence factors that earned this tier — surfaced on the A+ badge.
        tierReasons:  tierWhy,
        side:         env.side,
        entryPrice:   env.entry,
        tpPrice:      env.tp,
        slPrice:      env.sl,
        // Buy-stop strategies fill only when price trades through entryPrice;
        // settlement waits for that trigger before counting W/L.
        pendingEntry: env.pendingEntry ?? false,
        // Trade quality metadata — used by the UI to flag low-R signals
        // and to compute entry-status (active / missed / invalidated).
        expectedR:    env.expectedR ?? null,
        slPct:        env.slPct ?? null,
        targetPct:    env.targetPct ?? null,
        signalTs:     new Date().toISOString(),
        currentPrice: bars[bars.length - 1].close,
        currentPriceTs: new Date().toISOString(),
        pctChange:    ((bars[bars.length - 1].close - env.entry) / env.entry) * 100,
        status:       'open',
        winLoss:      null,
        rawReason:    result.raw?.reason || result.raw?.reasons?.[result.raw.reasons.length - 1] || '',
      };
      await sigCol.doc(id).set(docBody, { merge: true });
      writes++;

      // Update aggregates
      agg.totalCount++;
      if (env.side === 'buy')  agg.buyCount++;
      if (env.side === 'sell') agg.sellCount++;
      agg.byStrategy[def.short] = (agg.byStrategy[def.short] || 0) + 1;
      agg.bySector[item.s]      = (agg.bySector[item.s] || 0) + 1;
    }
  }

  // Daily aggregates — stored under `summaries.{market}` so US + INDIA coexist on
  // the same date bucket without overwriting one another.
  await docRef.set({
    [`summaries.${market}`]: {
      ...agg,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
  }, { merge: true });

  // Per-market regime snapshot for dashboard banner.
  try {
    const regime = regimeCheck(spyBars, vixBars, null, {
      vixThreshold: cfg.vixThreshold,
      vixPanic:     cfg.vixPanic,
      indexLabel:   cfg.indexLabel,
    });
    const sectorMap = {};
    for (const [etf, bars] of Object.entries(sectorBars)) {
      if (!bars || !Array.isArray(bars)) continue;
      sectorMap[etf] = bars;
    }
    const ranks = sectorRank(sectorMap).map(r => ({
      etf: r.etf,
      name: cfg.sectorNames?.[r.etf] || r.etf,
      ret_20d: r.ret_20d,
      rank: r.rank,
    }));
    await docRef.collection('regime').doc(market).set({
      market,
      tradeable:  regime.tradeable,
      go_to_cash: regime.go_to_cash,
      indexLabel: cfg.indexLabel,
      vixLabel:   cfg.vixLabel,
      details:    regime.details,
      checks:     regime.checks,
      sectorRanks: ranks,
      computedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: false });
  } catch (e) {
    console.warn(`[scan] regime write failed for ${market}: ${e.message}`);
  }

  console.log(`[scan] market=${market} wrote=${writes} errors=${errors} buys=${agg.buyCount} sells=${agg.sellCount}`);
  return { writes, errors, ...agg };
}

// Re-evaluate W/L for signals in the last 90 days based on current bars.
//
// Processes every recent signal that is still OPEN *or* was settled under an
// older SETTLEMENT_VERSION. The latter is a one-time backfill: when the
// settlement model changes, previously-closed signals are re-graded once so the
// History win-rates reflect the current model. A signal already closed at the
// current version is skipped (decided once per model — no re-checking).
async function resettleRecentSignals(db, market, ctxIn) {
  const cfg = MARKET_CONFIGS[market];
  const ctx = ctxIn || buildCtx(market);
  const cutoff = daysAgo(RETENTION_DAYS);
  console.log(`[resettle] market=${market} cutoff=${cutoff} settlementVersion=${SETTLEMENT_VERSION}`);

  // No status filter — we may need to re-grade closed signals too. Uses the
  // existing (market, signalTs) collection-group index. (A `settlementVersion`
  // inequality can't be queried server-side because legacy docs lack the field,
  // so we filter client-side.)
  const cg = await db.collectionGroup('signals')
    .where('market', '==', market)
    .where('signalTs', '>=', cutoff + 'T00:00:00Z')
    .get();

  const byTicker = new Map();
  cg.forEach(s => {
    const d = s.data();
    const needs = d.status === 'open' || d.settlementVersion !== SETTLEMENT_VERSION;
    if (!needs) return; // already settled at the current model version — leave it
    if (!byTicker.has(d.ticker)) byTicker.set(d.ticker, []);
    byTicker.get(d.ticker).push({ ref: s.ref, ...d });
  });

  let settled = 0, regraded = 0;
  for (const [ticker, signals] of byTicker) {
    let bars;
    try { bars = await fetchBars(ticker, ctx); }
    catch (e) { console.warn(`[resettle] ${ticker}: ${e.message}`); continue; }
    const dateMap = new Map();
    bars.forEach((b, i) => dateMap.set(b.date, i));
    const lastClose = bars[bars.length - 1].close;
    for (const sig of signals) {
      const sigDate = (sig.signalTs || '').slice(0, 10);
      const idx = dateMap.get(sigDate);
      if (idx == null) continue;
      const wasClosed = sig.status === 'closed';
      const postBars = bars.slice(idx + 1);
      const verdict = settleSignal(
        { entry: sig.entryPrice, tp: sig.tpPrice, sl: sig.slPrice, pendingEntry: sig.pendingEntry, strategyKey: sig.strategyKey },
        postBars,
        { bars, entryIdx: idx },
      );
      // For a closed signal the realized return is locked to the exit price
      // (verdict.hitPrice = the tp/sl/native/time-stop level the trade left at),
      // NOT the latest close — otherwise a settled loser keeps drifting with the
      // live price and overstates the loss. Open signals still track lastClose.
      const pctChange = verdict.status === 'closed'
        ? ((verdict.hitPrice - sig.entryPrice) / sig.entryPrice) * 100
        : ((lastClose - sig.entryPrice) / sig.entryPrice) * 100;
      if (verdict.status === 'closed') {
        await sig.ref.update({
          status:      'closed',
          winLoss:     verdict.winLoss,
          settledAt:   verdict.settledAt,
          hitPrice:    verdict.hitPrice,
          exitReason:  verdict.exitReason ?? null,
          settlementVersion: SETTLEMENT_VERSION,
          currentPrice: lastClose,
          pctChange,
        });
        if (wasClosed) regraded++; else settled++;
      } else {
        // Open under the current model. If it had been closed under the old model
        // (e.g. a buy-stop that never actually triggered), revert it to open and
        // clear the stale verdict so it stops counting as a loss.
        const update = {
          settlementVersion: SETTLEMENT_VERSION,
          currentPrice: lastClose,
          currentPriceTs: new Date().toISOString(),
          pctChange,
        };
        if (wasClosed) {
          Object.assign(update, { status: 'open', winLoss: null, settledAt: null, hitPrice: null, exitReason: null });
          regraded++;
        }
        await sig.ref.update(update);
      }
    }
  }
  console.log(`[resettle] market=${market} settled=${settled} regraded=${regraded}`);
}

// =============================================================================
// Notification dispatch (Firebase Cloud Messaging via Admin SDK).
//
// Called for each closed trade. Reads every FCM token registered for the user
// at /users/{uid}/fcmTokens/{token} and sends a single push per token.
// Stale tokens (returned-as-unregistered by FCM) are pruned automatically.
// =============================================================================
async function notifyTradeClosed(db, uid, trade, verdict) {
  if (!uid || !trade || !verdict) return;
  let tokensSnap;
  try {
    tokensSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
  } catch (e) {
    console.warn(`[notify] read tokens failed for ${uid}: ${e.message}`);
    return;
  }
  if (tokensSnap.empty) return;

  const isWin = verdict.winLoss === 'win';
  const symbol = trade.name || trade.ticker;
  const title = `${isWin ? 'TARGET HIT' : 'STOP HIT'} · ${trade.ticker}`;
  const pct = (verdict.realizedPct ?? ((verdict.hitPrice - trade.entryPrice) / trade.entryPrice) * 100).toFixed(2);
  const body  = `${symbol} ${isWin ? 'reached your TP' : 'broke your SL'} at ${verdict.hitPrice?.toFixed(2)} (${pct}%).`;

  // Telegram exit alert (best-effort) — independent of FCM tokens.
  try {
    const nSnap = await db.collection('users').doc(uid).collection('notifications').doc('config').get();
    const n = nSnap.exists ? nSnap.data() : null;
    if (n?.telegramEnabled && n.telegramBotToken && n.telegramChatId) {
      await sendTelegram(n.telegramBotToken, n.telegramChatId,
        `${isWin ? '🎯 <b>TARGET HIT</b>' : '🛑 <b>STOP HIT</b>'} <b>${trade.ticker}</b> exit ${verdict.hitPrice?.toFixed(2)} (${pct}%)`);
    }
  } catch (e) { console.warn(`[notify] telegram failed for ${uid}: ${e.message}`); }

  for (const tokDoc of tokensSnap.docs) {
    const token = tokDoc.id;
    try {
      await admin.messaging().send({
        token,
        notification: { title, body },
        data: { tradeId: trade.id || '', link: `${APP_URL}#/mytrades` },
        webpush: {
          fcmOptions: { link: `${APP_URL}#/mytrades` },
          notification: { icon: `${APP_URL}favicon.ico` },
        },
      });
    } catch (e) {
      // Prune dead tokens so we don't waste reads + writes on them next run.
      if (e.code === 'messaging/registration-token-not-registered' ||
          e.errorInfo?.code === 'messaging/registration-token-not-registered') {
        try { await tokDoc.ref.delete(); } catch {}
        console.log(`[notify] pruned stale token for ${uid}`);
      } else {
        console.warn(`[notify] send failed for ${uid}/${token.slice(0, 12)}…: ${e.message}`);
      }
    }
  }
}

// =============================================================================
// Per-user trade settlement.
//
// Walks all open trades across all users via a collection-group query, settles
// each against its OWN tp/sl (which may differ from the source signal's tp/sl
// when the user overrode the entry price), and writes back the verdict.
//
// We reuse settleSignal() from /src/strategy/normalize.js so the W/L math is
// identical to the client's preview computation.
// =============================================================================
async function settleUserTrades(db, market, ctxIn) {
  const ctx = ctxIn || buildCtx(market);
  console.log(`[settle-trades] market=${market} start`);

  // Collection-group query — Admin SDK bypasses Firestore Security Rules so we
  // can read across all /users/*/enteredTrades subcollections in one shot.
  // Single-field equality only — no composite index required.
  let snap;
  try {
    snap = await db.collectionGroup('enteredTrades').where('status', '==', 'open').get();
  } catch (e) {
    console.warn(`[settle-trades] collection-group query failed: ${e.message}`);
    return { settled: 0, refreshed: 0, errors: 1 };
  }

  // Filter to this market client-side and group by ticker so we fetch each
  // ticker's bars at most once even if multiple users have trades on it.
  const tradesByTicker = new Map();
  snap.forEach(s => {
    const d = s.data();
    if (d.market && d.market !== market) return;
    if (!d.ticker || !d.signalDate) return;
    if (!tradesByTicker.has(d.ticker)) tradesByTicker.set(d.ticker, []);
    tradesByTicker.get(d.ticker).push({ ref: s.ref, ...d });
  });

  let settled = 0, refreshed = 0, errors = 0;

  for (const [ticker, trades] of tradesByTicker) {
    let bars;
    try { bars = await fetchBars(ticker, ctx); }
    catch (e) {
      console.warn(`[settle-trades] ${ticker}: ${e.message}`);
      errors++;
      continue;
    }
    const dateMap = new Map();
    bars.forEach((b, i) => dateMap.set(b.date, i));
    const lastClose = bars[bars.length - 1]?.close;

    for (const t of trades) {
      const idx = dateMap.get(t.signalDate);
      if (idx == null) {
        // Refresh currentPrice even if we can't find the bar (rare).
        try {
          await t.ref.update({
            currentPrice: lastClose ?? null,
            currentPriceTs: new Date().toISOString(),
          });
          refreshed++;
        } catch {}
        continue;
      }
      // settleSignal() walks bars *after* the signal day and returns the first
      // touch of tp (win) or sl (loss). Identical math to the client's preview.
      const verdict = settleSignal(
        { entry: t.entryPrice, tp: t.tpPrice, sl: t.slPrice, pendingEntry: t.pendingEntry, strategyKey: t.strategyKey },
        bars.slice(idx + 1),
        { bars, entryIdx: idx },
      );
      const updates = {
        currentPrice:   lastClose ?? null,
        currentPriceTs: new Date().toISOString(),
      };
      if (verdict.status === 'closed') {
        updates.status      = 'closed';
        updates.winLoss     = verdict.winLoss;
        updates.settledAt   = verdict.settledAt;
        updates.hitPrice    = verdict.hitPrice;
        updates.exitReason  = verdict.exitReason ?? null;
        updates.realizedPct = ((verdict.hitPrice - t.entryPrice) / t.entryPrice) * 100;
      } else if (lastClose != null && t.entryPrice) {
        updates.unrealizedPct = ((lastClose - t.entryPrice) / t.entryPrice) * 100;
      }
      try {
        await t.ref.update(updates);
        if (verdict.status === 'closed') {
          settled++;
          // Extract uid from the trade's path: users/{uid}/enteredTrades/{id}
          const uid = t.ref.parent.parent?.id;
          await notifyTradeClosed(db, uid, t, {
            ...verdict,
            realizedPct: updates.realizedPct,
          });
        } else {
          refreshed++;
        }
      } catch (e) {
        console.warn(`[settle-trades] update failed for ${t.ref.path}: ${e.message}`);
        errors++;
      }
    }
  }

  console.log(`[settle-trades] market=${market} settled=${settled} refreshed=${refreshed} errors=${errors}`);
  return { settled, refreshed, errors };
}

// Delete /marketData/{date} docs older than 90 days.
async function pruneOldBuckets(db) {
  const cutoff = daysAgo(RETENTION_DAYS);
  const snap = await db.collection('marketData').get();
  let deleted = 0;
  for (const docSnap of snap.docs) {
    if (docSnap.id < cutoff) {
      // Delete subcollections first
      const subs = await docSnap.ref.collection('signals').listDocuments();
      for (const s of subs) await s.delete();
      await docSnap.ref.delete();
      deleted++;
    }
  }
  console.log(`[prune] deleted ${deleted} buckets older than ${cutoff}`);
}

// Record a run summary to /cronRuns so the app can show execution history
// (last run time, per-market signal counts, errors). Best-effort: a failure to
// write the record never fails the run.
async function recordRun(db, { startedAt, summary, error }) {
  try {
    const finishedAt = Date.now();
    const markets = summary.map(s => ({
      market: s.market,
      error: s.error || null,
      written: s.writes ?? null,
      errors: s.errors ?? null,
      buys: s.buyCount ?? null,
      sells: s.sellCount ?? null,
      settled: s.userTrades?.settled ?? null,
    }));
    const okCount = markets.filter(m => !m.error).length;
    await db.collection('cronRuns').add({
      startedAt: admin.firestore.Timestamp.fromMillis(startedAt),
      finishedAt: admin.firestore.Timestamp.fromMillis(finishedAt),
      durationMs: finishedAt - startedAt,
      ok: !error && okCount === markets.length && markets.length > 0,
      trigger: process.env.GITHUB_EVENT_NAME || 'manual',
      markets,
      error: error ? String(error) : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[main] recordRun failed', e.message);
  }
}

async function main() {
  const db = initAdmin();
  const startedAt = Date.now();
  const summary = [];
  let fatal = null;
  for (const m of MARKETS_TO_RUN) {
    if (!MARKET_CONFIGS[m]) { console.warn(`[main] unknown market ${m}, skip`); continue; }
    try {
      // Build the per-market context ONCE and pass it through every pass so we
      // benefit from the bar cache (Map populated during scanMarket — re-used by
      // resettleRecentSignals and settleUserTrades for free).
      const ctx = buildCtx(m);
      const r = await scanMarket(db, m, ctx);
      await resettleRecentSignals(db, m, ctx);
      const trades = await settleUserTrades(db, m, ctx);
      summary.push({ market: m, ...r, userTrades: trades });
    } catch (e) {
      console.error(`[main] ${m} failed:`, e);
      summary.push({ market: m, error: e.message });
    }
  }
  try { await pruneOldBuckets(db); } catch (e) { console.warn('[main] prune failed', e.message); }
  await recordRun(db, { startedAt, summary, error: fatal });
  console.log('\n[main] DONE', JSON.stringify(summary));
}

main().catch(e => { console.error(e); process.exit(1); });
