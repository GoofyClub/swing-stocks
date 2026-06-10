// =============================================================================
// Settlement + tiering self-test.
//
// Pins the behaviour the app depends on for Signal History win/loss reporting:
//   1. settleSignal() decides WIN/LOSS on the FIRST bar that touches TP or SL,
//      with a pessimistic same-bar tie-break, and never revisits later bars
//      (so a decided verdict is stable as more price data accrues).
//   2. Buy-stop strategies (pendingEntry) don't count a W/L until price triggers
//      the entry — a name that rolls straight to the stop stays OPEN, not LOSS.
//   3. tierReasons() returns the same tier as the legacy computeTier() AND the
//      human-readable confluence factors that earned it (the "why A+" data).
//
// Run with:  node tests/settle.mjs
// =============================================================================

import { settleSignal, tierReasons, computeTier } from '../src/strategy/normalize.js';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}
const bar = (date, high, low) => ({ date, high, low });

console.log('\n--- settleSignal: first-touch W/L ---');
{
  const env = { entry: 100, tp: 110, sl: 95 };
  t('TP touched before SL -> win',
    settleSignal(env, [bar('d1', 111, 99), bar('d2', 96, 90)]).winLoss === 'win');
  t('SL touched before TP -> loss',
    settleSignal(env, [bar('d1', 101, 94), bar('d2', 111, 100)]).winLoss === 'loss');
  t('same-bar TP and SL -> loss (pessimistic tie-break)',
    settleSignal(env, [bar('d1', 111, 94)]).winLoss === 'loss');
  t('neither touched -> open',
    settleSignal(env, [bar('d1', 108, 97)]).status === 'open');
  t('empty post-signal bars -> open',
    settleSignal(env, []).status === 'open');
}

console.log('\n--- settleSignal: settles once, ignores later bars ---');
{
  const env = { entry: 100, tp: 110, sl: 95 };
  const v = settleSignal(env, [bar('d1', 105, 99), bar('d2', 111, 100), bar('d3', 90, 80)]);
  t('resolves on first deciding bar (d2), ignoring a later SL breach', v.winLoss === 'win' && v.settledAt === 'd2');

  // Idempotency: appending more future bars after a decision must not change it.
  const short = settleSignal(env, [bar('d1', 111, 99)]);
  const long  = settleSignal(env, [bar('d1', 111, 99), bar('d2', 80, 70), bar('d3', 200, 120)]);
  t('verdict stable as bars accrue (win stays win, same settledAt/hitPrice)',
    short.winLoss === 'win' && long.winLoss === 'win' &&
    short.settledAt === long.settledAt && short.hitPrice === long.hitPrice);
}

console.log('\n--- settleSignal: hitPrice is the level, not the bar extreme ---');
{
  const env = { entry: 100, tp: 110, sl: 95 };
  t('win hitPrice = tp (gap-through not modeled)', settleSignal(env, [bar('d1', 120, 100)]).hitPrice === 110);
  t('loss hitPrice = sl (gap-through not modeled)', settleSignal(env, [bar('d1', 101, 80)]).hitPrice === 95);
}

console.log('\n--- settleSignal: buy-stop entry trigger (pendingEntry) ---');
{
  // Entry is a buy-stop ABOVE current price; SL sits just below it.
  const env = { entry: 102, tp: 110, sl: 99, pendingEntry: true };

  t('rolls to SL without triggering entry -> OPEN, not loss',
    settleSignal(env, [bar('d1', 101, 98)]).status === 'open');

  t('triggers entry then reaches TP -> win',
    settleSignal(env, [bar('d1', 101, 100), bar('d2', 111, 103)]).winLoss === 'win');

  t('triggers entry then breaks SL -> loss',
    settleSignal(env, [bar('d1', 103, 100), bar('d2', 104, 98)]).winLoss === 'loss');

  // Same env WITHOUT the flag (market-at-close strategy): the dip to 98 is a loss.
  const market = { entry: 102, tp: 110, sl: 99 };
  t('market entry (no pendingEntry): dip to SL is a loss',
    settleSignal(market, [bar('d1', 101, 98)]).winLoss === 'loss');

  // Trigger and stop on the SAME bar -> pessimistic loss.
  t('entry + SL on the trigger bar -> loss',
    settleSignal(env, [bar('d1', 103, 98)]).winLoss === 'loss');
}

console.log('\n--- settleSignal: native exit (RSI2 close > 5-SMA) ---');
{
  // Closes fall into an oversold entry at 95, then bounce. The 5-SMA exit should
  // fire on the first up-bar and book the small win — NOT hold weeks for a +R TP.
  const closes = [100, 99, 98, 97, 96, 95, 97, 99, 101, 103];
  const series = closes.map((c, i) => ({ date: 'b' + i, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 }));
  const entryIdx = 5; // entry at close 95
  const env = { entry: 95, tp: 130, sl: 80, strategyKey: 'rsi2' };
  const v = settleSignal(env, series.slice(entryIdx + 1), { bars: series, entryIdx });
  t('RSI2 exits at first close > 5-SMA (native), booked as win', v.exitReason === 'native' && v.winLoss === 'win');
  t('native exit hitPrice = exit-bar close', v.hitPrice === series[6].close);

  // Without the full series (no opts), native exit can't run — falls back to TP/SL.
  const v2 = settleSignal(env, series.slice(entryIdx + 1));
  t('no opts -> native skipped, stays open (neither TP/SL hit)', v2.status === 'open');
}

console.log('\n--- settleSignal: time stop at strategy max hold ---');
{
  // nr7 maxHold = 7; price drifts up, never touching TP/SL. Exit at the 7th held
  // bar's close. (pendingEntry forced off so the trade is live from bar 0.)
  const up = Array.from({ length: 7 }, (_, i) => ({ date: 't' + i, open: 100, high: 101, low: 99.5, close: 100.2, volume: 1 }));
  const vWin = settleSignal({ entry: 100, tp: 130, sl: 80, strategyKey: 'nr7', pendingEntry: false }, up);
  t('time stop fires at maxHold (7), close > entry -> win', vWin.exitReason === 'time_stop' && vWin.winLoss === 'win' && vWin.settledAt === 't6');

  const down = Array.from({ length: 7 }, (_, i) => ({ date: 'u' + i, open: 100, high: 100.5, low: 99, close: 99.5, volume: 1 }));
  const vLoss = settleSignal({ entry: 100, tp: 130, sl: 80, strategyKey: 'nr7', pendingEntry: false }, down);
  t('time stop fires at maxHold (7), close < entry -> loss', vLoss.exitReason === 'time_stop' && vLoss.winLoss === 'loss');

  // Six bars only -> hold not reached -> still open.
  const vOpen = settleSignal({ entry: 100, tp: 130, sl: 80, strategyKey: 'nr7', pendingEntry: false }, up.slice(0, 6));
  t('below maxHold bars -> still open', vOpen.status === 'open');

  // No strategyKey -> no time stop (legacy contract preserved).
  const vLegacy = settleSignal({ entry: 100, tp: 130, sl: 80 }, up);
  t('no strategyKey -> no time stop, stays open', vLegacy.status === 'open');
}

console.log('\n--- tierReasons: tier parity + non-empty A+ explanation ---');
{
  const cases = [
    ['pullback', { confirmation_bar: true, metrics: { volume_multiple: 1.8, ret_1m: 0.10, spy_ret_1m: 0.04 } }, 'A+'],
    ['pullback', { confirmation_bar: true, metrics: { volume_multiple: 1.0, ret_1m: 0.05, spy_ret_1m: 0.04 } }, 'Tier 1'],
    ['rsi2',     { detected: true, extreme: true, three_day_decline: true }, 'A+'],
    ['vcp',      { detected: true, volume_dry: true, pct_below_pivot: 1.0 }, 'A+'],
    ['vcp',      { detected: true, volume_dry: false }, 'Tier 2'],
    ['peg',      { detected: true, gap_pct: 8, gap_vol_ratio: 3.2 }, 'A+'],
    ['pead',     { detected: true, strong: true, fresh: true, surprise_pct: 18, days_since: 3 }, 'A+'],
    ['fifty_two_wh', { detected: true, strong: true, vol_ratio: 2.1 }, 'A+'],
    ['insider',  { detected: true, strong: true, cluster_size: 4 }, 'A+'],
    ['nr7',      { detected: true, above_50sma: false }, 'Tier 2'],
    ['fvg',      { detected: true, bullish_reaction: true, zone_low: 90, zone_high: 95, current_close: 96 }, 'A+'],
    ['fvg',      { detected: true, bullish_reaction: true, zone_low: 90, zone_high: 95, current_close: 93 }, 'Tier 1'],
  ];
  for (const [key, raw, expectTier] of cases) {
    const { tier, reasons } = tierReasons(key, raw);
    t(`${key} -> ${expectTier}`, tier === expectTier);
    t(`${key} computeTier() agrees with tierReasons()`, computeTier(key, raw) === tier);
    if (expectTier === 'A+') {
      t(`${key} A+ exposes >=1 reason`, Array.isArray(reasons) && reasons.length >= 1);
    }
  }
  t('null raw -> Tier 1, no reasons', (() => { const r = tierReasons('pullback', null); return r.tier === 'Tier 1' && r.reasons.length === 0; })());
}

console.log('\n=============================================');
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log('=============================================');
if (fail > 0) process.exit(1);
