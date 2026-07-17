// =============================================================================
// Signal normalizer — maps each raw strategy result into a uniform "trade envelope"
// of { entry, tp, sl } so downstream code (Firestore, Win/Loss tracking, My Trades)
// can treat all strategies identically.
//
// IMPORTANT: this module does NOT modify any strategy logic. It reads the
// outputs of /src/strategy/engine.js as-is and applies documented per-strategy
// conventions to derive a price level for take-profit and stop when one is not
// already present.
//
// Win/Loss accounting (matches user spec):
//   - WIN  if intraday HIGH >= tp on any bar at or after signal date
//   - LOSS if intraday LOW  <= sl on any bar at or after signal date
//          (and the WIN condition was not met first on the same bar — see
//           settleSignal() for the tie-breaking rule)
//   - OPEN otherwise
//
// All `result` objects must include the strategy's raw output for traceability.
// =============================================================================

import {
  evaluateSetup,
  evaluateQualityDip,
  evaluateVCP,
  evaluateRSI2MeanReversion,
  evaluatePocketPivot,
  evaluateHTF,
  evaluateNR7,
  evaluate52WH,
  evaluatePEG,
  evaluatePEAD,
  evaluateInsiderCluster,
  evaluateAnalystUpgrade,
  evaluateFVGRetest,
  atr,
  sma,
} from './engine.js';

// =============================================================================
// Per-strategy target gains — calibrated to documented historical performance
// (see User Guide → Strategy win-rate reference for sources). Each strategy's
// TP is set so price movement of the documented mid-range counts as a "win".
//
// Floor/ceiling protect against pathological ATR-only stops: if entry-SL is
// tiny, we don't want the TP to be silly close; if entry-SL is huge, we don't
// want a 20% target on a stock that just needs a 4% move.
//
// FORMAT: targetPct = midpoint of documented gain range, used as `tp = entry × (1 + targetPct/100)`.
//         minR/maxR  = guardrails on the resulting reward:risk ratio.
// =============================================================================
// `minSlPct` / `maxSlPct` bound the SL distance as a % of entry. These prevent:
//   - SL too tight (intraday noise stops out immediately) — e.g. CSCO PEG with 0.15% SL
//   - SL too wide (mathematically can't hit target_pct with reasonable R) — e.g. LLY PEG
//     with 13.8% SL on a strategy that targets +12%, R would be < 1
// Signals failing either bound are rejected by applyTarget().
const STRATEGY_TARGETS = {
  pullback:     { targetPct: 5,    minR: 1.5, maxR: 3.5, minSlPct: 0.7, maxSlPct: 5,  source: '20-EMA pullback continuation, 42-48% WR, 2:1 R:R typical' },
  quality_dip:  { targetPct: 10,   minR: 1.5, maxR: 4.0, minSlPct: 0.8, maxSlPct: 8,  source: 'Quality Dip (mean-reversion on quality), 60-70% WR, +5-15%' },
  vcp:          { targetPct: 18,   minR: 2.0, maxR: 8.0, minSlPct: 1.0, maxSlPct: 7,  source: 'Minervini VCP, 55-68% WR, +10-30% target' },
  // OPEN QUESTION (Jul 2026 paper run): the 0.5-3% stop here conflicts with
  // Connors' published results, which use NO stop — exit only on close>5-SMA
  // (his testing showed stops materially lower RSI(2)'s win rate, since the
  // stop fires at peak oversoldness, i.e. the entry condition). In the Jul 9-16
  // paper account every loss was a stop fill (12/12) while wins were TP/native
  // exits; live WR came in at 43% vs the settled 75%. Candidate change: widen
  // rsi2 maxSlPct toward a disaster stop (~8-10%) and lean on the native exit.
  rsi2:         { targetPct: 2,    minR: 0.7, maxR: 1.5, minSlPct: 0.5, maxSlPct: 3,  source: 'Connors RSI(2), 75-85% WR, +1-3% mean-reversion bounce' },
  pocket_pivot: { targetPct: 8,    minR: 1.5, maxR: 3.5, minSlPct: 0.7, maxSlPct: 5,  source: 'Kacher/Morales Pocket Pivot, 55-65% WR, +5-15%' },
  htf:          { targetPct: 100,  minR: 3.0, maxR: 12.0, minSlPct: 2.0, maxSlPct: 30, source: "O'Neil High Tight Flag, 65-75% WR, +50-300% — home-runs" },
  nr7:          { targetPct: 4,    minR: 1.2, maxR: 3.0, minSlPct: 0.5, maxSlPct: 3,  source: 'Crabel NR7, 55-65% WR, +3-8% vol-expansion' },
  fifty_two_wh: { targetPct: 10,   minR: 1.5, maxR: 4.0, minSlPct: 0.8, maxSlPct: 6,  source: 'Jegadeesh/Titman 52WH, 60-65% WR, +5-15% momentum drift' },
  peg:          { targetPct: 12,   minR: 2.0, maxR: 5.0, minSlPct: 1.0, maxSlPct: 6,  source: 'Minervini/Zanger PEG, 65-72% WR, +5-20%' },
  pead:         { targetPct: 12,   minR: 2.0, maxR: 5.0, minSlPct: 1.0, maxSlPct: 8,  source: 'Ball/Brown PEAD, 75-80% WR, +5-20% over 60d' },
  insider:      { targetPct: 15,   minR: 2.0, maxR: 6.0, minSlPct: 1.5, maxSlPct: 10, source: 'Lakonishok/Lee Insider Cluster, 65-75% WR, +8-25% over 30-90d' },
  analyst:      { targetPct: 10,   minR: 1.5, maxR: 4.0, minSlPct: 1.0, maxSlPct: 8,  source: 'Womack Analyst Upgrade, 60-70% WR, +5-15% over 20-60d' },
  fvg:          { targetPct: 15,   minR: 1.5, maxR: 6.0, minSlPct: 1.5, maxSlPct: 12, source: 'Monthly bullish FVG retest in monthly uptrend, reversal off the gap — higher-timeframe swing' },
};

// Strategies whose `entry` is a BUY-STOP placed ABOVE the signal bar (price must
// trade up through `entry` for the order to fill). For these, settlement must not
// count a TP/SL touch until the entry actually triggers — otherwise a name that
// rolls straight over to the stop is booked as a loss for a trade that never
// existed. Market-at-close strategies (entry = signal-day close) fill immediately
// and are NOT in this set.
const STOP_ENTRY_STRATEGIES = new Set(['pullback', 'nr7', 'vcp', 'htf']);

// Apply target % to entry but clamp the resulting R-multiple within [minR, maxR].
//
// REJECTS the signal (returns null) when:
//   - SL is too tight (entry-sl < minSlPct% of entry): real-world noise will stop out
//     before the strategy plays out. Was the CSCO 0.15% SL bug.
//   - SL is too wide (entry-sl > maxSlPct% of entry): the typical hold-period gain
//     of this strategy can't produce a workable R-multiple. Was the LLY 13.8% SL bug.
//
// Returns { entry, tp, sl, side, targetPct, expectedR, slPct, pendingEntry } or null.
function applyTarget(strategyKey, entry, sl) {
  const pendingEntry = STOP_ENTRY_STRATEGIES.has(strategyKey);
  const t = STRATEGY_TARGETS[strategyKey];
  if (!t) {
    // Unknown strategy — fall back to 2R for safety, no SL bound check.
    const risk = entry - sl;
    if (risk <= 0) return null;
    return { entry, tp: entry + 2 * risk, sl, side: 'buy', targetPct: null, expectedR: 2, slPct: (risk / entry) * 100, pendingEntry };
  }
  const risk = entry - sl;
  if (risk <= 0) return null;
  const slPct = (risk / entry) * 100;

  // Quality guards on SL distance. Either out-of-range and the signal is unfit
  // for live trading — reject silently (engine still produces the raw detection
  // for diagnostics; we just stop emitting an envelope).
  if (slPct < t.minSlPct) return null;
  if (slPct > t.maxSlPct) return null;

  // Primary: target = entry × (1 + targetPct/100)
  let tp = entry * (1 + t.targetPct / 100);
  // Clamp to R-multiple guardrails.
  const rImplied = (tp - entry) / risk;
  if (rImplied < t.minR) tp = entry + t.minR * risk;
  if (rImplied > t.maxR) tp = entry + t.maxR * risk;
  const expectedR = (tp - entry) / risk;
  return { entry, tp, sl, side: 'buy', targetPct: t.targetPct, expectedR, slPct, pendingEntry };
}

// ---- Per-strategy normalizers ---------------------------------------------------
//
// Each normalizer extracts {entry, sl} from the strategy's native output, then
// delegates to applyTarget() so TP calibration is centralised + tested in one place.

// L1+L3 pullback continuation. Engine emits trade_plan with entry_trigger + initial_stop.
function normalizePullback(raw) {
  if (!raw.confirmation_bar || !raw.trade_plan) return null;
  const entry = raw.trade_plan.entry_trigger;
  const sl    = raw.trade_plan.initial_stop_estimate;
  return applyTarget('pullback', entry, sl);
}

// Quality Dip — engine emits trade_plan with entry/stop/target. Engine's target
// is "recover 97% of 52w high" which is a meaningful price level for this strategy,
// so we honour it but still clamp to the R guardrails via applyTarget shaping.
function normalizeQualityDip(raw) {
  if (!raw.detected || !raw.trade_plan) return null;
  const out = applyTarget('quality_dip', raw.trade_plan.entry, raw.trade_plan.stop);
  if (!out) return null;
  // If engine's "recover 52w high" target is tighter than our calibrated target,
  // honour it (it's a real meaningful resistance level).
  const engineTp = raw.trade_plan.target;
  if (Number.isFinite(engineTp) && engineTp > out.entry && engineTp < out.tp) {
    out.tp = engineTp;
    out.expectedR = (engineTp - out.entry) / (out.entry - out.sl);
  }
  return out;
}

// VCP — engine emits pivot. SL = pivot − 1.5×ATR(14).
function normalizeVCP(raw, bars, idx) {
  if (!raw.detected) return null;
  const a14 = atr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14)[idx];
  if (!a14) return null;
  const entry = raw.pivot * 1.001;
  const sl    = raw.pivot - 1.5 * a14;
  return applyTarget('vcp', entry, sl);
}

// RSI(2) mean-reversion — engine emits stop. Entry at today's close.
function normalizeRSI2(raw, bars, idx) {
  if (!raw.detected) return null;
  const close = bars[idx].close;
  return applyTarget('rsi2', close, raw.stop);
}

// Pocket Pivot — engine emits stop. Entry at today's close.
function normalizePocketPivot(raw, bars, idx) {
  if (!raw.detected) return null;
  return applyTarget('pocket_pivot', bars[idx].close, raw.stop);
}

// High Tight Flag — engine emits its own target (peak * 1.5 = +50%). Use as floor,
// but extend toward the calibrated mid-range (+100%) if the calibrated target
// produces a sane R-multiple.
function normalizeHTF(raw) {
  if (!raw.detected) return null;
  const entry = raw.peak * 1.001;
  const out = applyTarget('htf', entry, raw.stop);
  if (!out) return null;
  // Engine emits peak * 1.5 as the minimum target — keep it if it's larger than
  // our calibrated TP (rare but possible on very wide stops).
  if (Number.isFinite(raw.target) && raw.target > out.tp) {
    out.tp = raw.target;
    out.expectedR = (raw.target - entry) / (entry - raw.stop);
  }
  return out;
}

// NR7 — entry on buy-stop above today's high, SL at today's low.
function normalizeNR7(raw) {
  if (!raw.detected) return null;
  return applyTarget('nr7', raw.buy_stop, raw.sell_stop);
}

// 52WH Breakout — engine emits stop. Entry at today's close.
//
// EXTRA GUARDS (added after the WMT bug where a single bad bar from a CORS
// proxy caused a fake breakout signal):
//   1. Require today's high to be at least 0.5% above the prior 52w high. A
//      bare-margin breakout (e.g. $135.15 vs $134.69 = 0.34%) is usually a
//      data artifact, not a real institutional buy.
//   2. Require today's CLOSE to also be above the prior 52w high. A high
//      that didn't hold to the close is a fake-out, not a breakout.
function normalize52WH(raw, bars, idx) {
  if (!raw.detected) return null;
  const todayHigh  = bars[idx].high;
  const todayClose = bars[idx].close;
  if (Number.isFinite(raw.high_52w) && raw.high_52w > 0) {
    if (todayHigh  < raw.high_52w * 1.005) return null;   // need real-margin breakout
    if (todayClose < raw.high_52w)          return null;  // close must hold above
  }
  return applyTarget('fifty_two_wh', todayClose, raw.stop);
}

// PEG — engine emits stop (gap_open × 0.98). Entry at today's close.
function normalizePEG(raw, bars, idx) {
  if (!raw.detected) return null;
  return applyTarget('peg', bars[idx].close, raw.stop);
}

// FMP-driven strategies (PEAD / Insider / Analyst). No native price levels;
// derive SL from ATR(14) then apply the per-strategy calibrated target.
function normalizeFmpStrategy(strategyKey, raw, bars, idx) {
  if (!raw.detected) return null;
  const a14 = atr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14)[idx];
  const entry = bars[idx].close;
  if (!a14) return null;
  const sl = entry - 1.5 * a14;
  return applyTarget(strategyKey, entry, sl);
}

// Monthly bullish FVG retest. The engine confirms: monthly uptrend (close > 12mo
// MA), an unfilled bullish FVG below price, the current month dipping into that
// zone, AND a bullish reaction (monthly close back above the zone mid). We only
// emit a tradeable envelope once that reversal is showing — entry at the current
// close, stop just below the reversal low / gap (whichever is tighter, since the
// gap is the structural support that must hold), target a higher-timeframe move.
function normalizeFVG(raw, bars, idx) {
  if (!raw || !raw.detected || !raw.bullish_reaction) return null;
  const entry = bars[idx].close;
  // Tighter of: just below the gap floor, or just below the reversal-month low.
  const stopAnchor = Math.max(raw.zone_low ?? -Infinity, raw.current_low ?? -Infinity);
  if (!Number.isFinite(stopAnchor)) return null;
  const sl = stopAnchor * 0.99;
  return applyTarget('fvg', entry, sl);
}

// ---- Strategy registry ----------------------------------------------------------
// `evaluate(bars, ctx)` returns { raw, envelope } or null.
// `ctx` shape: { spyBars, fmpData, marketCfg, idx? }  (idx defaults to last bar)

export const STRATEGIES = {
  pullback: {
    name: 'Swing Pullback 20-EMA Continuation',
    short: 'Pullback',
    evaluate(bars, { spyBars, marketCfg, idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateSetup(bars, spyBars, i, marketCfg || {});
      const env = normalizePullback(raw);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  quality_dip: {
    name: 'Quality Dip',
    short: 'QualityDip',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateQualityDip(bars, i);
      const env = normalizeQualityDip(raw);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  vcp: {
    name: 'Volatility Contraction Pattern (Minervini)',
    short: 'VCP',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateVCP(bars, i);
      const env = normalizeVCP(raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  rsi2: {
    name: 'RSI(2) Mean Reversion (Connors)',
    short: 'RSI2',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateRSI2MeanReversion(bars, i);
      const env = normalizeRSI2(raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  pocket_pivot: {
    name: 'Pocket Pivot (Kacher/Morales)',
    short: 'PocketPivot',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluatePocketPivot(bars, i);
      const env = normalizePocketPivot(raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  htf: {
    name: "High Tight Flag (O'Neil)",
    short: 'HTF',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateHTF(bars, i);
      const env = normalizeHTF(raw);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  nr7: {
    name: 'NR7 + Inside Day (Crabel)',
    short: 'NR7',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateNR7(bars, i);
      const env = normalizeNR7(raw);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  fifty_two_wh: {
    name: '52-Week High Breakout',
    short: '52WH',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluate52WH(bars, i);
      const env = normalize52WH(raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  peg: {
    // Gap-and-Go is the trader-vernacular name; Power Earnings Gap (PEG) is the
    // academic acronym. Same strategy. We surface both so the User Guide and
    // table labels reconcile cleanly.
    name: 'Gap-and-Go (Power Earnings Gap)',
    short: 'PEG',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluatePEG(bars, i);
      const env = normalizePEG(raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  pead: {
    name: 'Post-Earnings Announcement Drift',
    short: 'PEAD',
    needsFmp: true,
    evaluate(bars, { fmpData, idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluatePEAD(fmpData, bars, i);
      const env = normalizeFmpStrategy('pead', raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  insider: {
    name: 'Insider Cluster Buy',
    short: 'Insider',
    needsFmp: true,
    evaluate(bars, { fmpData, idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateInsiderCluster(fmpData, bars, i);
      const env = normalizeFmpStrategy('insider', raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  analyst: {
    name: 'Analyst Upgrade Momentum',
    short: 'Analyst',
    needsFmp: true,
    evaluate(bars, { fmpData, idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateAnalystUpgrade(fmpData, bars, i);
      const env = normalizeFmpStrategy('analyst', raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
  fvg: {
    // Higher-timeframe swing: a stock in a monthly uptrend that corrected into a
    // monthly bullish Fair Value Gap and is now reversing off it. evaluateFVGRetest
    // always assesses the most-recent month, so it's a "latest bar" signal.
    name: 'Monthly FVG Retest (Bullish)',
    short: 'FVG',
    evaluate(bars, { idx } = {}) {
      const i = idx ?? bars.length - 1;
      const raw = evaluateFVGRetest(bars);
      const env = normalizeFVG(raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
};

// Export the target table so tests + UI can introspect calibration.
export { STRATEGY_TARGETS };

// =============================================================================
// Signal settlement — given a signal envelope and the bars AFTER signal day,
// determine the trade outcome and produce
//   { status, winLoss, settledAt, hitPrice, exitReason }.
//
// These strategies are NOT buy-and-hold-until-TP-or-SL trades — each has a
// documented hold window and (for mean-reversion) an indicator exit. Settling on
// a fixed bracket held forever systematically understates win-rate (a quick
// bounce that the strategy would have banked at +1% is held for weeks until it
// eventually nicks the stop). So settlement applies, in priority order per bar:
//
//   1. ENTRY TRIGGER (buy-stop strategies): when `pendingEntry` is set, the trade
//      stays dormant until price trades up through `entry`. A name that rolls to
//      the stop without ever triggering stays OPEN, not LOSS.
//   2. SL / TP touch — first touch wins; same-bar TP+SL is a PESSIMISTIC loss
//      (assume the stop filled first, matching the backtest engine).
//   3. NATIVE EXIT — the strategy's documented discretionary exit (RSI(2): first
//      close back above the 5-SMA). Exits at that bar's close: win if green.
//      Requires the full bar series via opts; skipped if unavailable.
//   4. TIME STOP — at the strategy's max hold (STRATEGY_HOLD), exit at the bar's
//      close: win if green, else loss.
//
// `opts = { bars, entryIdx }` supplies the full price series and the signal's
// index within it so native exits can recompute indicators. Without it (e.g. unit
// tests passing only { entry, tp, sl }), only the TP/SL/entry-trigger rules
// apply — preserving the original simple contract.
//
// Determinism: every rule is a function of the bars up to the deciding bar, and
// settlement returns on the FIRST bar that resolves the trade, so re-running as
// more bars accrue yields an identical verdict — a decided W/L never changes.
// =============================================================================

// Bump whenever the settlement model changes in a way that should re-grade
// already-closed signals. The cron stamps each settled signal with this and
// re-settles any signal carrying an older version exactly once, so historical
// win/loss reflects the current model without re-checking on every run.
//   1 — original: fixed TP/SL, first touch, held indefinitely.
//   2 — entry-trigger gating + RSI(2) native exit + per-strategy time stop.
//   3 — closed-signal pctChange frozen at exit (hitPrice), not latest close.
//   4 — trend/breakout strategies settle on a trailing stop (breakeven at +1R,
//       trail 2R below the high, no fixed TP); mean-reversion keeps fixed targets.
export const SETTLEMENT_VERSION = 4;

// Documented max hold per strategy, in trading bars. After this many held bars
// with no TP/SL/native exit, settle at that bar's close.
const STRATEGY_HOLD = {
  rsi2: 7, nr7: 7, pocket_pivot: 15, peg: 20, pullback: 15, vcp: 25,
  htf: 40, fifty_two_wh: 30, quality_dip: 30, pead: 60, insider: 60,
  analyst: 45, fvg: 60,
};

// Build a native (indicator-based) exit predicate `(fullSeriesIdx) => boolean`
// for strategies whose documented exit changes the WIN/LOSS verdict. Only RSI(2)
// qualifies: its bounce is captured by close>5-SMA well before a fixed +R target.
// Trend strategies book their win at the first target (= tp) and otherwise fall
// through to the time stop, so they need no native rule here.
function buildNativeExit(strategyKey, bars) {
  if (strategyKey === 'rsi2') {
    const closes = bars.map(b => b.close);
    const s5 = sma(closes, 5);
    return (i) => Number.isFinite(s5[i]) && closes[i] > s5[i];
  }
  return null;
}

// Trend/breakout strategies are managed with a TRAILING stop in real life, not a
// fixed far take-profit. Settling them on "hit a distant TP or time-stop at the
// close" systematically gives back open profit and books winners as losses — so
// these use settleTrailing() instead. Mean-reversion / level strategies (rsi2,
// quality_dip, fvg, the FMP drifts) keep the fixed-target model.
const TRAILING_STRATEGIES = new Set(['pullback', 'vcp', 'peg', 'pocket_pivot', 'htf', 'nr7', 'fifty_two_wh']);
// Trail the stop this many R below the highest high reached; breakeven at +1R.
const TRAIL_GIVEBACK_R = 2;

// Trailing-stop settlement. No fixed TP — let winners run; exit on the trailing
// stop or the time stop. Rules per bar (evaluated pessimistically: the stop set
// from PRIOR bars is checked against this bar's low BEFORE this bar's high raises
// it, so a bar can't protect against its own low):
//   • initial stop = sl
//   • once the high is +1R above entry → move stop up to breakeven (entry)
//   • stop also trails to (highestHigh − TRAIL_GIVEBACK_R × R)
//   • exit when low ≤ current stop; else time-stop at the max-hold bar's close
function settleTrailing(envelope, postSignalBars, opts = {}) {
  const { sl, entry, pendingEntry, strategyKey } = envelope;
  const R = entry - sl;
  const maxHold = STRATEGY_HOLD[strategyKey];
  const done = (winLoss, date, price, reason) =>
    ({ status: 'closed', winLoss, settledAt: date, hitPrice: price, exitReason: reason });
  if (!(R > 0)) return { status: 'open', winLoss: null, settledAt: null, hitPrice: null, exitReason: null };

  let triggered = !(pendingEntry && Number.isFinite(entry));
  let held = 0;
  let stop = sl;
  let maxHigh = -Infinity;

  for (let k = 0; k < postSignalBars.length; k++) {
    const bar = postSignalBars[k];
    if (!triggered) {
      if (bar.high >= entry) triggered = true;
      else continue;
    }
    held++;

    // Exit check against the stop carried in from prior bars.
    if (bar.low <= stop) {
      const win = stop > entry; // breakeven (stop === entry) books as a non-win
      return done(win ? 'win' : 'loss', bar.date, stop, stop > sl ? 'trail' : 'sl');
    }

    // Raise the stop using this bar's high (applies to subsequent bars).
    maxHigh = Math.max(maxHigh, bar.high);
    if (maxHigh - entry >= R) stop = Math.max(stop, entry);          // breakeven at +1R
    stop = Math.max(stop, maxHigh - TRAIL_GIVEBACK_R * R);            // trail

    if (maxHold && held >= maxHold && Number.isFinite(bar.close)) {
      return done(bar.close > entry ? 'win' : 'loss', bar.date, bar.close, 'time_stop');
    }
  }
  return { status: 'open', winLoss: null, settledAt: null, hitPrice: null, exitReason: null };
}

export function settleSignal(envelope, postSignalBars, opts = {}) {
  if (!envelope || !postSignalBars || postSignalBars.length === 0) {
    return { status: 'open', winLoss: null, settledAt: null, hitPrice: null, exitReason: null };
  }
  const { tp, sl, entry, pendingEntry, strategyKey } = envelope;
  if (TRAILING_STRATEGIES.has(strategyKey)) return settleTrailing(envelope, postSignalBars, opts);
  const maxHold = STRATEGY_HOLD[strategyKey]; // undefined => no time stop
  const fullBars = opts.bars || null;
  const entryIdx = opts.entryIdx;
  const nativeExit = (fullBars && Number.isFinite(entryIdx))
    ? buildNativeExit(strategyKey, fullBars) : null;

  const done = (winLoss, date, price, reason) =>
    ({ status: 'closed', winLoss, settledAt: date, hitPrice: price, exitReason: reason });

  // For buy-stop entries, the trade is dormant until price trades through `entry`.
  let triggered = !(pendingEntry && Number.isFinite(entry));
  let held = 0; // bars elapsed since the entry filled

  for (let k = 0; k < postSignalBars.length; k++) {
    const bar = postSignalBars[k];
    if (!triggered) {
      if (bar.high >= entry) triggered = true; // fills this bar — evaluate it below
      else continue;                           // not yet filled — nothing applies
    }
    held++;

    const hitTp = bar.high >= tp;
    const hitSl = bar.low  <= sl;
    if (hitTp && hitSl) return done('loss', bar.date, sl, 'sl'); // pessimistic tie
    if (hitTp) return done('win',  bar.date, tp, 'tp');
    if (hitSl) return done('loss', bar.date, sl, 'sl');

    // Native discretionary exit — exit at this bar's close.
    if (nativeExit && Number.isFinite(bar.close)) {
      const fullIdx = entryIdx + 1 + k; // this bar's index in the full series
      if (nativeExit(fullIdx)) {
        return done(bar.close > entry ? 'win' : 'loss', bar.date, bar.close, 'native');
      }
    }

    // Time stop — exit at the close of the max-hold bar.
    if (maxHold && held >= maxHold && Number.isFinite(bar.close)) {
      return done(bar.close > entry ? 'win' : 'loss', bar.date, bar.close, 'time_stop');
    }
  }
  return { status: 'open', winLoss: null, settledAt: null, hitPrice: null, exitReason: null };
}

// Index of the bar a signal/trade was based on: the last bar ON OR BEFORE the
// signal date. A signal's stored date is the cron's wall-clock run time, which
// can fall on a weekend or market holiday (e.g. Juneteenth) that has NO bar of
// its own. Requiring an exact date→bar match and skipping when it fails leaves
// such signals permanently "open", never checking TP/SL. Bars are ascending by
// date, so we return the last bar whose date <= sigDate (-1 if none).
export function entryIndexFor(bars, dateMap, sigDate) {
  if (!sigDate || !bars?.length) return -1;
  const exact = dateMap?.get(sigDate);
  if (exact != null) return exact;
  let idx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date <= sigDate) idx = i; else break;
  }
  return idx;
}

// =============================================================================
// Quality tier — A+ / Tier 1 / Tier 2
//
// Every strategy emits its own auxiliary "strength" signals (volume confluence,
// regime alignment, freshness, ...). This function reads those raw flags and
// collapses them into a single bucket the UI can filter on. Used by both the
// Live Signals scanner and the cron worker (which persists it to Firestore so
// Signal History can filter retroactively).
//
//   A+      — multiple top-shelf confluence factors all present
//   Tier 1  — strategy fires cleanly; standard-quality signal
//   Tier 2  — strategy fires but with caveats (e.g. armed without confirmation,
//             missing volume dry-up, weak trend backdrop)
// =============================================================================
// tierReasons() is the single source of truth for tiering. It returns BOTH the
// tier bucket AND the human-readable confluence factors that drove it, so the UI
// can answer "why is this A+?" on hover. `computeTier()` is a thin wrapper that
// keeps the old string-only contract for callers that don't need the reasons.
//
// The tier boundaries here are character-for-character the same conditions the
// previous computeTier() used — only the explanatory strings are new.
export function tierReasons(strategyKey, raw) {
  if (!raw) return { tier: 'Tier 1', reasons: [] };
  switch (strategyKey) {
    case 'pullback': {
      const v   = raw.metrics?.volume_multiple ?? 0;
      const r   = raw.metrics?.ret_1m;
      const spy = raw.metrics?.spy_ret_1m;
      const rsExcess = (r != null && spy != null) ? (r - spy) : 0;
      if (raw.confirmation_bar && v >= 1.5 && rsExcess >= 0.04) {
        return { tier: 'A+', reasons: [
          'Confirmation bar printed',
          `Volume ${v.toFixed(1)}× ≥ 1.5× avg`,
          `RS vs SPY +${(rsExcess * 100).toFixed(1)}% ≥ 4%`,
        ] };
      }
      if (raw.confirmation_bar) return { tier: 'Tier 1', reasons: ['Confirmation bar printed'] };
      return { tier: 'Tier 2', reasons: ['Setup armed without confirmation'] };
    }
    case 'rsi2':
      if (raw.extreme && raw.three_day_decline) {
        return { tier: 'A+', reasons: ['RSI(2) extreme (< 5)', '3-day decline streak'] };
      }
      if (raw.extreme)            return { tier: 'Tier 1', reasons: ['RSI(2) extreme (< 5)'] };
      if (raw.three_day_decline)  return { tier: 'Tier 1', reasons: ['3-day decline streak'] };
      return { tier: 'Tier 1', reasons: ['RSI(2) < 10 above 200-SMA'] };
    case 'vcp':
      if (raw.volume_dry && (raw.pct_below_pivot ?? 99) < 3) {
        return { tier: 'A+', reasons: ['Volume dry-up confirmed', `Within ${(raw.pct_below_pivot ?? 0).toFixed(1)}% of pivot (< 3%)`] };
      }
      if (raw.volume_dry) return { tier: 'Tier 1', reasons: ['Volume dry-up confirmed'] };
      return { tier: 'Tier 2', reasons: ['Contractions formed; volume not yet dry'] };
    case 'pocket_pivot':
      if ((raw.vol_ratio ?? 0) > 2.0) {
        return { tier: 'A+', reasons: [`Up-volume ${(raw.vol_ratio ?? 0).toFixed(1)}× max down-vol (> 2×)`] };
      }
      return { tier: 'Tier 1', reasons: ['Pocket pivot up-volume confirmed'] };
    case 'htf':
      // HTF is rare by construction — tight flag = A+, else Tier 1.
      if ((raw.flag_depth_pct ?? 100) < 15) {
        return { tier: 'A+', reasons: [`Tight flag ${(raw.flag_depth_pct ?? 0).toFixed(0)}% deep (< 15%)`] };
      }
      return { tier: 'Tier 1', reasons: ['High tight flag formed'] };
    case 'nr7':
      if (raw.above_50sma) return { tier: 'Tier 1', reasons: ['NR7 inside day above 50-SMA'] };
      return { tier: 'Tier 2', reasons: ['NR7 inside day below 50-SMA'] };
    case 'fifty_two_wh':
      if (raw.strong) return { tier: 'A+', reasons: [`Breakout volume ${(raw.vol_ratio ?? 0).toFixed(1)}× avg (> 1.5×)`] };
      return { tier: 'Tier 1', reasons: ['New 52-week high on above-avg volume'] };
    case 'peg':
      if ((raw.gap_pct ?? 0) >= 7 && (raw.gap_vol_ratio ?? 0) >= 3) {
        return { tier: 'A+', reasons: [`Gap +${(raw.gap_pct ?? 0).toFixed(1)}% ≥ 7%`, `Gap volume ${(raw.gap_vol_ratio ?? 0).toFixed(1)}× ≥ 3×`] };
      }
      return { tier: 'Tier 1', reasons: ['Power earnings gap held'] };
    case 'pead':
      if (raw.strong && raw.fresh) {
        return { tier: 'A+', reasons: [`Strong beat +${(raw.surprise_pct ?? 0).toFixed(1)}% (> 15%)`, `Fresh (${raw.days_since ?? '?'}d ago, ≤ 10d)`] };
      }
      if (raw.strong) return { tier: 'Tier 1', reasons: [`Strong beat +${(raw.surprise_pct ?? 0).toFixed(1)}%`] };
      if (raw.fresh)  return { tier: 'Tier 1', reasons: [`Fresh earnings (${raw.days_since ?? '?'}d ago)`] };
      return { tier: 'Tier 2', reasons: ['Earnings beat, not strong or fresh'] };
    case 'insider':
      if (raw.strong) return { tier: 'A+', reasons: [`Cluster of ${raw.cluster_size ?? '3+'} insiders (≥ 3)`] };
      return { tier: 'Tier 1', reasons: ['Insider cluster buy (≥ 2)'] };
    case 'analyst':
      if (raw.strong) return { tier: 'A+', reasons: [`${raw.total_bullish ?? '2+'} bullish actions, multi-firm (≥ 2)`] };
      return { tier: 'Tier 1', reasons: ['Analyst upgrade/initiation'] };
    case 'quality_dip':
      if (raw.volume_confirmed && (raw.trade_plan?.r_multiple ?? 0) > 2) {
        return { tier: 'A+', reasons: ['Volume confirmed', `R-multiple ${(raw.trade_plan?.r_multiple ?? 0).toFixed(1)}R (> 2R)`] };
      }
      if (raw.volume_confirmed) return { tier: 'Tier 1', reasons: ['Volume confirmed'] };
      return { tier: 'Tier 2', reasons: ['Dip stabilized; volume weak'] };
    case 'fvg':
      // Full reclaim of the gap (close back above the zone top) is the strongest
      // reversal; a close above the gap mid is a standard bullish reaction.
      if (Number.isFinite(raw.zone_high) && Number.isFinite(raw.current_close) && raw.current_close >= raw.zone_high) {
        return { tier: 'A+', reasons: ['Monthly uptrend intact', 'Reclaimed full FVG zone (close ≥ zone high)'] };
      }
      return { tier: 'Tier 1', reasons: ['Monthly uptrend intact', 'Bullish reaction off FVG (close > zone mid)'] };
    default:
      return { tier: 'Tier 1', reasons: [] };
  }
}

export function computeTier(strategyKey, raw) {
  return tierReasons(strategyKey, raw).tier;
}

// Convenience: run all applicable strategies on a single ticker.
//
// IMPORTANT: each result object uses `strategyName` for the strategy's full
// human label (e.g. "Swing Pullback 20-EMA Continuation"), NOT `name`. Callers
// often spread this object alongside a `name` field that means "company name"
// (e.g. "Apple Inc"). Keeping these in different namespaces prevents accidental
// clobber via `{ name: companyName, ...h }`.
export function scanAllStrategies(bars, ctx = {}) {
  const out = [];
  for (const [key, def] of Object.entries(STRATEGIES)) {
    if (def.needsFmp && !ctx.fmpData) continue;
    try {
      const result = def.evaluate(bars, ctx);
      if (result) {
        const { tier, reasons } = tierReasons(key, result.raw);
        out.push({ strategy: key, strategyName: def.name, short: def.short, tier, tierReasons: reasons, ...result });
      }
    } catch (e) {
      // Strategy threw — skip with a console warning; do not break the scan.
      console.warn(`[scanAllStrategies] ${key} threw:`, e?.message || e);
    }
  }
  return out;
}
