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

// ---- Per-strategy normalizers ---------------------------------------------------

// L1+L3 pullback continuation. Engine emits trade_plan with all 3 values.
function normalizePullback(raw, bars, idx) {
  if (!raw.confirmation_bar || !raw.trade_plan) return null;
  return {
    entry: raw.trade_plan.entry_trigger,
    tp:    raw.trade_plan.first_target_estimate,
    sl:    raw.trade_plan.initial_stop_estimate,
    side:  'buy',
  };
}

// Quality Dip — engine emits trade_plan with entry/stop/target.
function normalizeQualityDip(raw) {
  if (!raw.detected || !raw.trade_plan) return null;
  return {
    entry: raw.trade_plan.entry,
    tp:    raw.trade_plan.target,
    sl:    raw.trade_plan.stop,
    side:  'buy',
  };
}

// VCP — engine emits a pivot. Entry just above, SL = pivot − 1.5×ATR(14), TP at 2R.
function normalizeVCP(raw, bars, idx) {
  if (!raw.detected) return null;
  const a14 = atr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14)[idx];
  if (!a14) return null;
  const entry = raw.pivot * 1.001;
  const sl    = raw.pivot - 1.5 * a14;
  const tp    = entry + 2 * (entry - sl);
  return { entry, tp, sl, side: 'buy' };
}

// RSI(2) mean-reversion — engine emits stop. TP = +1.5×ATR target (mean-reversion bounce).
function normalizeRSI2(raw, bars, idx) {
  if (!raw.detected) return null;
  const close = bars[idx].close;
  const a14 = raw.atr14;
  if (!a14) return null;
  return {
    entry: close,
    tp:    close + 1.5 * a14,
    sl:    raw.stop,
    side:  'buy',
  };
}

// Pocket Pivot — engine emits stop. TP = +2R.
function normalizePocketPivot(raw, bars, idx) {
  if (!raw.detected) return null;
  const entry = bars[idx].close;
  const sl = raw.stop;
  const risk = entry - sl;
  if (risk <= 0) return null;
  return { entry, tp: entry + 2 * risk, sl, side: 'buy' };
}

// High Tight Flag — engine emits stop + target directly.
function normalizeHTF(raw) {
  if (!raw.detected) return null;
  const entry = raw.peak * 1.001;
  return { entry, tp: raw.target, sl: raw.stop, side: 'buy' };
}

// NR7 — entry on buy-stop above today's high. SL = today's low. TP = entry + 2R.
function normalizeNR7(raw) {
  if (!raw.detected) return null;
  const entry = raw.buy_stop;
  const sl = raw.sell_stop;
  const risk = entry - sl;
  if (risk <= 0) return null;
  return { entry, tp: entry + 2 * risk, sl, side: 'buy' };
}

// 52WH Breakout — engine emits stop. TP = +2R (momentum target, slim 1:2).
function normalize52WH(raw, bars, idx) {
  if (!raw.detected) return null;
  const entry = bars[idx].close;
  const risk = entry - raw.stop;
  if (risk <= 0) return null;
  return { entry, tp: entry + 2 * risk, sl: raw.stop, side: 'buy' };
}

// PEG — engine emits stop. TP = +2R.
function normalizePEG(raw, bars, idx) {
  if (!raw.detected) return null;
  const entry = bars[idx].close;
  const risk = entry - raw.stop;
  if (risk <= 0) return null;
  return { entry, tp: entry + 2 * risk, sl: raw.stop, side: 'buy' };
}

// FMP-driven strategies (PEAD / Insider / Analyst) — no native price levels,
// derive from ATR(14) at signal time. SL = entry − 1.5×ATR; TP = entry + 3×ATR (3:1).
function normalizeFmpStrategy(raw, bars, idx) {
  if (!raw.detected) return null;
  const a14 = atr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14)[idx];
  const entry = bars[idx].close;
  if (!a14) return null;
  return {
    entry,
    tp: entry + 3 * a14,
    sl: entry - 1.5 * a14,
    side: 'buy',
  };
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
      const env = normalizePullback(raw, bars, i);
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
    name: 'Power Earnings Gap',
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
      const env = normalizeFmpStrategy(raw, bars, i);
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
      const env = normalizeFmpStrategy(raw, bars, i);
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
      const env = normalizeFmpStrategy(raw, bars, i);
      return env ? { raw, envelope: env, idx: i } : null;
    },
  },
};

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

// Convenience: run all applicable strategies on a single ticker.
export function scanAllStrategies(bars, ctx = {}) {
  const out = [];
  for (const [key, def] of Object.entries(STRATEGIES)) {
    if (def.needsFmp && !ctx.fmpData) continue;
    try {
      const result = def.evaluate(bars, ctx);
      if (result) out.push({ strategy: key, name: def.name, short: def.short, ...result });
    } catch (e) {
      // Strategy threw — skip with a console warning; do not break the scan.
      console.warn(`[scanAllStrategies] ${key} threw:`, e?.message || e);
    }
  }
  return out;
}
