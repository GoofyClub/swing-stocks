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
  atr,
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
  rsi2:         { targetPct: 2,    minR: 0.7, maxR: 1.5, minSlPct: 0.5, maxSlPct: 3,  source: 'Connors RSI(2), 75-85% WR, +1-3% mean-reversion bounce' },
  pocket_pivot: { targetPct: 8,    minR: 1.5, maxR: 3.5, minSlPct: 0.7, maxSlPct: 5,  source: 'Kacher/Morales Pocket Pivot, 55-65% WR, +5-15%' },
  htf:          { targetPct: 100,  minR: 3.0, maxR: 12.0, minSlPct: 2.0, maxSlPct: 30, source: "O'Neil High Tight Flag, 65-75% WR, +50-300% — home-runs" },
  nr7:          { targetPct: 4,    minR: 1.2, maxR: 3.0, minSlPct: 0.5, maxSlPct: 3,  source: 'Crabel NR7, 55-65% WR, +3-8% vol-expansion' },
  fifty_two_wh: { targetPct: 10,   minR: 1.5, maxR: 4.0, minSlPct: 0.8, maxSlPct: 6,  source: 'Jegadeesh/Titman 52WH, 60-65% WR, +5-15% momentum drift' },
  peg:          { targetPct: 12,   minR: 2.0, maxR: 5.0, minSlPct: 1.0, maxSlPct: 6,  source: 'Minervini/Zanger PEG, 65-72% WR, +5-20%' },
  pead:         { targetPct: 12,   minR: 2.0, maxR: 5.0, minSlPct: 1.0, maxSlPct: 8,  source: 'Ball/Brown PEAD, 75-80% WR, +5-20% over 60d' },
  insider:      { targetPct: 15,   minR: 2.0, maxR: 6.0, minSlPct: 1.5, maxSlPct: 10, source: 'Lakonishok/Lee Insider Cluster, 65-75% WR, +8-25% over 30-90d' },
  analyst:      { targetPct: 10,   minR: 1.5, maxR: 4.0, minSlPct: 1.0, maxSlPct: 8,  source: 'Womack Analyst Upgrade, 60-70% WR, +5-15% over 20-60d' },
};

// Apply target % to entry but clamp the resulting R-multiple within [minR, maxR].
//
// REJECTS the signal (returns null) when:
//   - SL is too tight (entry-sl < minSlPct% of entry): real-world noise will stop out
//     before the strategy plays out. Was the CSCO 0.15% SL bug.
//   - SL is too wide (entry-sl > maxSlPct% of entry): the typical hold-period gain
//     of this strategy can't produce a workable R-multiple. Was the LLY 13.8% SL bug.
//
// Returns { entry, tp, sl, side, targetPct, expectedR, slPct } or null.
function applyTarget(strategyKey, entry, sl) {
  const t = STRATEGY_TARGETS[strategyKey];
  if (!t) {
    // Unknown strategy — fall back to 2R for safety, no SL bound check.
    const risk = entry - sl;
    if (risk <= 0) return null;
    return { entry, tp: entry + 2 * risk, sl, side: 'buy', targetPct: null, expectedR: 2, slPct: (risk / entry) * 100 };
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
  return { entry, tp, sl, side: 'buy', targetPct: t.targetPct, expectedR, slPct };
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
};

// Export the target table so tests + UI can introspect calibration.
export { STRATEGY_TARGETS };

// =============================================================================
// Signal settlement — given a signal envelope and the bars AFTER signal day,
// determine if/when TP or SL was hit and produce { status, winLoss, settledAt, hitPrice }.
//
// Tie-breaking rule for an intraday TP-and-SL touch on the same bar:
//   Assume PESSIMISTIC fill — SL hit first (i.e. loss). This is the standard
//   conservative back-test convention and matches the legacy backtest engine's
//   intrabar handling.
// =============================================================================

export function settleSignal(envelope, postSignalBars) {
  if (!envelope || !postSignalBars || postSignalBars.length === 0) {
    return { status: 'open', winLoss: null, settledAt: null, hitPrice: null };
  }
  const { tp, sl } = envelope;
  for (const bar of postSignalBars) {
    const hitTp = bar.high >= tp;
    const hitSl = bar.low  <= sl;
    if (hitTp && hitSl) {
      // Conservative: assume SL fills first within the bar.
      return { status: 'closed', winLoss: 'loss', settledAt: bar.date, hitPrice: sl };
    }
    if (hitTp) return { status: 'closed', winLoss: 'win',  settledAt: bar.date, hitPrice: tp };
    if (hitSl) return { status: 'closed', winLoss: 'loss', settledAt: bar.date, hitPrice: sl };
  }
  return { status: 'open', winLoss: null, settledAt: null, hitPrice: null };
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
export function computeTier(strategyKey, raw) {
  if (!raw) return 'Tier 1';
  switch (strategyKey) {
    case 'pullback': {
      const v   = raw.metrics?.volume_multiple ?? 0;
      const r   = raw.metrics?.ret_1m;
      const spy = raw.metrics?.spy_ret_1m;
      const rsExcess = (r != null && spy != null) ? (r - spy) : 0;
      if (raw.confirmation_bar && v >= 1.5 && rsExcess >= 0.04) return 'A+';
      if (raw.confirmation_bar) return 'Tier 1';
      return 'Tier 2';
    }
    case 'rsi2':
      if (raw.extreme && raw.three_day_decline) return 'A+';
      if (raw.extreme || raw.three_day_decline) return 'Tier 1';
      return 'Tier 1';
    case 'vcp':
      if (raw.volume_dry && (raw.pct_below_pivot ?? 99) < 3) return 'A+';
      if (raw.volume_dry) return 'Tier 1';
      return 'Tier 2';
    case 'pocket_pivot':
      if ((raw.vol_ratio ?? 0) > 2.0) return 'A+';
      return 'Tier 1';
    case 'htf':
      // HTF is rare by construction — tight flag + above-trend = A+, else Tier 1
      if ((raw.flag_depth_pct ?? 100) < 15) return 'A+';
      return 'Tier 1';
    case 'nr7':
      if (raw.above_50sma) return 'Tier 1';
      return 'Tier 2';
    case 'fifty_two_wh':
      if (raw.strong) return 'A+';
      return 'Tier 1';
    case 'peg':
      if ((raw.gap_pct ?? 0) >= 7 && (raw.gap_vol_ratio ?? 0) >= 3) return 'A+';
      return 'Tier 1';
    case 'pead':
      if (raw.strong && raw.fresh) return 'A+';
      if (raw.strong || raw.fresh) return 'Tier 1';
      return 'Tier 2';
    case 'insider':
      if (raw.strong) return 'A+';
      return 'Tier 1';
    case 'analyst':
      if (raw.strong) return 'A+';
      return 'Tier 1';
    case 'quality_dip':
      if (raw.volume_confirmed && (raw.trade_plan?.r_multiple ?? 0) > 2) return 'A+';
      if (raw.volume_confirmed) return 'Tier 1';
      return 'Tier 2';
    default:
      return 'Tier 1';
  }
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
        const tier = computeTier(key, result.raw);
        out.push({ strategy: key, strategyName: def.name, short: def.short, tier, ...result });
      }
    } catch (e) {
      // Strategy threw — skip with a console warning; do not break the scan.
      console.warn(`[scanAllStrategies] ${key} threw:`, e?.message || e);
    }
  }
  return out;
}
