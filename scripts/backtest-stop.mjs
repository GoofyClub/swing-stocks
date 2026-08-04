#!/usr/bin/env node
// =============================================================================
// backtest-stop.mjs — what-if harness for the PLACED stop distance.
//
// READ-ONLY. Reads retained signal history from Firestore, re-settles each
// signal under several candidate stop-loss distances using the SAME settlement
// engine the app uses (settleSignal), and prints a side-by-side comparison.
//
// WHY THIS EXISTS
//   RSI2's live results diverged sharply from its settled history (43% live WR
//   vs 75% settled; every live loss was a stop fill). The hypothesis: the tight
//   0.5-3% bracket stop fires during the normal post-entry dip — which for a
//   mean-reversion setup IS the entry condition — converting would-be winners
//   into realized losses. Connors' original rule uses no stop and exits on
//   close > 5-SMA. This measures that tradeoff on real data instead of guessing.
//
// WHAT IT ISOLATES
//   Only the stop actually PLACED at the broker is varied. The signal
//   population and the target are left exactly as recorded, so the comparison
//   isn't contaminated by (a) admitting new, more volatile signals that the
//   0.5-3% slPct quality filter currently rejects, or (b) the applyTarget R-clamp
//   silently inflating the TP when the stop widens (an 8% stop pushes the +2%
//   target to +5.6%, which is no longer the same strategy).
//
//   The natural (recorded) stop still governs which signals exist — that filter
//   ran at scan time. This asks only: given those same entries, what if the
//   protective stop had been placed further away?
//
// READING THE OUTPUT
//   Net R is the headline. Under risk-based sizing every trade risks the same
//   dollar amount, so net R is proportional to total P&L and is comparable
//   across variants despite their different position sizes. Net % is NOT
//   sizing-adjusted — it's shown for reference only. The 'none' variant has no
//   defined risk, so its R column is blank by construction.
//
//   Exit-reason mix is the diagnostic: if widening the stop mostly converts
//   'sl' exits into 'native' exits, the hypothesis holds. If it converts them
//   into 'time_stop' exits at large negative returns, the stop was doing real
//   work and widening it is buying tail risk.
//
// USAGE
//   node scripts/backtest-stop.mjs                          # rsi2, US, 180d
//   node scripts/backtest-stop.mjs --strategy=rsi2 --days=400
//   node scripts/backtest-stop.mjs --stops=natural,3,5,8,10,none
//
// FLAGS
//   --strategy=<key>   strategy to test            (default rsi2)
//   --market=<US|INDIA>                            (default US)
//   --days=<n>         lookback window             (default 180)
//   --stops=<list>     stop variants as % of entry (default natural,3,5,8,none)
//                      'natural' = the recorded stop; 'none' = no stop at all
//   --limit=<n>        max signals to read         (default 3000)
//
// Required env: FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT_JSON
// Bar data env: same keys as refresh-signals (ALPACA_KEY/SECRET, ALPHAVANTAGE_KEY, ...)
//
// NOTE ON QUOTA: this reads signal docs and fetches daily bars per ticker. The
// project has hit the Firestore free-tier daily read cap before, so the default
// window is deliberately modest — widen with --days only when you need it.
// =============================================================================

import admin from 'firebase-admin';
import { fetchBars } from '../src/data/fetchers.js';
import { settleSignal, entryIndexFor } from '../src/strategy/normalize.js';
import { DATA_SOURCE_ORDER } from '../src/data/markets.js';

// ---- args -------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true']; }),
);
const STRATEGY = args.strategy || 'rsi2';
const MARKET   = args.market || 'US';
const DAYS     = Number(args.days || 180);
const LIMIT    = Number(args.limit || 3000);
const STOPS    = (args.stops || 'natural,3,5,8,none').split(',').map(s => s.trim()).filter(Boolean);

function initAdmin() {
  if (admin.apps.length) return admin.firestore();
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!projectId || !saJson) throw new Error('FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_JSON must be set.');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)), projectId });
  return admin.firestore();
}

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

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

// Signals for one strategy inside the lookback window. Prefers a server-side
// strategyKey filter; falls back to an unfiltered window scan when the composite
// index isn't deployed (same defensive pattern the workers use).
async function loadSignals(db) {
  const cutoff = daysAgo(DAYS) + 'T00:00:00Z';
  const base = db.collectionGroup('signals').where('signalTs', '>=', cutoff);
  let snap;
  try {
    snap = await base.where('strategyKey', '==', STRATEGY).limit(LIMIT).get();
  } catch (e) {
    console.warn(`[backtest] filtered query unavailable (${e.message}) — scanning the window and filtering in memory.`);
    snap = await base.orderBy('signalTs', 'desc').limit(LIMIT).get();
  }
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(r => r.strategyKey === STRATEGY)
    .filter(r => !r.market || r.market === MARKET)
    .filter(r => r.entryPrice > 0 && r.tpPrice != null && r.slPrice != null);
}

// The stop price a variant would have placed for a given signal.
// Returns null when the variant places no stop at all.
function stopPriceFor(variant, sig) {
  if (variant === 'natural') return sig.slPrice;
  if (variant === 'none') return null;
  const pct = Number(variant);
  if (!Number.isFinite(pct) || pct <= 0) throw new Error(`bad stop variant '${variant}'`);
  return sig.entryPrice * (1 - pct / 100);
}

function blankStats() {
  return {
    closed: 0, open: 0, wins: 0, losses: 0,
    sumPct: 0, sumR: 0, rCount: 0,
    grossWinPct: 0, grossLossPct: 0,
    worstPct: 0, bestPct: 0,
    reasons: {},
  };
}

function accumulate(st, verdict, sig, stopPx) {
  if (!verdict || verdict.status !== 'closed') { st.open++; return; }
  st.closed++;
  const pct = ((verdict.hitPrice - sig.entryPrice) / sig.entryPrice) * 100;
  st.sumPct += pct;
  if (pct >= 0) { st.wins++; st.grossWinPct += pct; } else { st.losses++; st.grossLossPct += Math.abs(pct); }
  if (pct < st.worstPct) st.worstPct = pct;
  if (pct > st.bestPct) st.bestPct = pct;
  // R is measured against the risk actually taken (the placed stop) — that's the
  // denominator position sizing uses, so net R tracks realized P&L.
  if (stopPx != null && sig.entryPrice > stopPx) {
    const slPct = ((sig.entryPrice - stopPx) / sig.entryPrice) * 100;
    if (slPct > 0) { st.sumR += pct / slPct; st.rCount++; }
  }
  const k = verdict.exitReason || '?';
  st.reasons[k] = (st.reasons[k] || 0) + 1;
}

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}

async function main() {
  const db = initAdmin();
  console.log(`[backtest] strategy=${STRATEGY} market=${MARKET} window=${DAYS}d stops=[${STOPS.join(', ')}]`);
  console.log('[backtest] READ-ONLY — no Firestore writes, no orders.\n');

  const signals = await loadSignals(db);
  if (!signals.length) { console.log('No signals matched. Try a longer --days window.'); return; }

  // Group by ticker so bars are fetched once per symbol, not once per signal.
  const byTicker = new Map();
  for (const s of signals) {
    if (!byTicker.has(s.ticker)) byTicker.set(s.ticker, []);
    byTicker.get(s.ticker).push(s);
  }
  console.log(`[backtest] ${signals.length} ${STRATEGY} signal(s) across ${byTicker.size} ticker(s)\n`);

  const ctx = buildCtx(MARKET);
  const stats = Object.fromEntries(STOPS.map(v => [v, blankStats()]));
  let evaluated = 0, skipped = 0;

  for (const [ticker, sigs] of byTicker) {
    let bars;
    try { bars = await fetchBars(ticker, ctx); }
    catch (e) { console.warn(`[backtest] ${ticker}: bars unavailable (${e.message}) — skipping ${sigs.length} signal(s)`); skipped += sigs.length; continue; }
    if (!bars?.length) { skipped += sigs.length; continue; }

    const dateMap = new Map();
    bars.forEach((b, i) => dateMap.set(b.date, i));

    for (const sig of sigs) {
      const sigDate = (sig.signalTs || '').slice(0, 10);
      const entryIdx = entryIndexFor(bars, dateMap, sigDate);
      if (entryIdx < 0) { skipped++; continue; }
      const postBars = bars.slice(entryIdx + 1);
      if (!postBars.length) { skipped++; continue; }
      evaluated++;

      for (const variant of STOPS) {
        const stopPx = stopPriceFor(variant, sig);
        // No stop → a price the series can never reach, so only TP / native /
        // time-stop can close the trade.
        const slForEngine = stopPx == null ? sig.entryPrice * 1e-6 : stopPx;
        const verdict = settleSignal(
          { entry: sig.entryPrice, tp: sig.tpPrice, sl: slForEngine, pendingEntry: !!sig.pendingEntry, strategyKey: sig.strategyKey },
          postBars,
          { bars, entryIdx },
        );
        accumulate(stats[variant], verdict, sig, stopPx);
      }
    }
  }

  console.log(`[backtest] evaluated ${evaluated} signal(s)${skipped ? `, skipped ${skipped} (no bars / no post-entry data)` : ''}\n`);

  // ---- comparison table ----
  const head = [
    pad('STOP', 9), pad('CLOSED', 7, true), pad('OPEN', 5, true), pad('WR', 7, true),
    pad('NET R', 9, true), pad('AVG R', 8, true), pad('NET %', 9, true), pad('AVG %', 8, true),
    pad('AVG W', 8, true), pad('AVG L', 8, true), pad('WORST', 8, true), pad('PF', 6, true),
  ].join(' ');
  console.log(head);
  console.log('-'.repeat(head.length));

  for (const v of STOPS) {
    const s = stats[v];
    const wr = s.closed ? (s.wins / s.closed) * 100 : null;
    const avgW = s.wins ? s.grossWinPct / s.wins : null;
    const avgL = s.losses ? -(s.grossLossPct / s.losses) : null;
    const pf = s.grossLossPct > 0 ? s.grossWinPct / s.grossLossPct : (s.grossWinPct > 0 ? Infinity : null);
    const f = (x, d = 2, suffix = '') => x == null ? '—' : (x >= 0 ? '' : '') + x.toFixed(d) + suffix;
    console.log([
      pad(v === 'none' ? 'none' : v === 'natural' ? 'natural' : v + '%', 9),
      pad(s.closed, 7, true), pad(s.open, 5, true),
      pad(wr == null ? '—' : wr.toFixed(1) + '%', 7, true),
      pad(s.rCount ? f(s.sumR) + 'R' : '—', 9, true),
      pad(s.rCount ? f(s.sumR / s.rCount) + 'R' : '—', 8, true),
      pad(f(s.sumPct) + '%', 9, true),
      pad(s.closed ? f(s.sumPct / s.closed) + '%' : '—', 8, true),
      pad(f(avgW) + '%', 8, true),
      pad(f(avgL) + '%', 8, true),
      pad(f(s.worstPct) + '%', 8, true),
      pad(pf == null ? '—' : (pf === Infinity ? 'inf' : pf.toFixed(2)), 6, true),
    ].join(' '));
  }

  console.log('\nEXIT REASON MIX (closed trades)');
  console.log(`${pad('STOP', 9)} ${pad('tp', 8, true)} ${pad('sl', 8, true)} ${pad('native', 8, true)} ${pad('time_stop', 10, true)}`);
  console.log('-'.repeat(48));
  for (const v of STOPS) {
    const r = stats[v].reasons;
    console.log([
      pad(v === 'none' ? 'none' : v === 'natural' ? 'natural' : v + '%', 9),
      pad(r.tp || 0, 8, true), pad(r.sl || 0, 8, true),
      pad(r.native || 0, 8, true), pad(r.time_stop || 0, 10, true),
    ].join(' '));
  }

  console.log(`
INTERPRETATION
  NET R is the headline: with risk-based sizing each trade risks the same dollar
  amount, so net R is proportional to total P&L and IS comparable across rows.
  NET % is not sizing-adjusted — reference only. 'none' has no defined risk, so
  its R columns are blank.

  Watch where 'sl' exits go as the stop widens. Moving into 'native' (the
  close > 5-SMA bounce) supports widening. Moving into 'time_stop' at large
  negative returns means the stop was doing real work — check WORST before
  changing anything live.

  CAVEATS: signals still OPEN are excluded from every stat, so recent entries are
  under-represented. Settlement is on daily bars — it cannot see the intraday
  path, so a stop and a target touched on the SAME day resolve pessimistically
  (loss). Real fills also carry slippage this model does not charge.`);
}

main().catch(e => { console.error('[backtest] fatal', e); process.exit(1); });
