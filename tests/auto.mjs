// =============================================================================
// Auto-trade engine self-test. Pins the pure risk/sizing/guard/idempotency
// logic the execution worker relies on — so a refactor can't silently change
// how many shares get bought or which signals get filtered.
//
// Run with:  node tests/auto.mjs
// =============================================================================

import {
  clientOrderId, sizePosition, signalMatchesRules, passesPortfolioGuards,
  isTradeDayAllowed, slippageOk, stopClearanceOk, buildBracketOrder, brokerPrice, modelExitAction, regimeAllowsEntry, drawdownHalted,
  marketClock, inEntryWindow, entryLimitPrice,
} from '../src/auto/engine.js';
import { resolveAlpacaBaseUrl, isLiveBaseUrl } from '../src/broker/alpaca.js';
import { INDEX_OPTIONS, indexOptionsForMarket, indexOptionsForMarkets } from '../src/data/indexes.js';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

const baseCfg = {
  markets: ['US'], tiers: ['A+', 'Tier 1'], sides: ['buy'], strategies: [],
  excludeTickers: ['TSLA'], minPrice: 20, maxPrice: 1500, minAdvUsd: 20_000_000,
  riskPerTradePct: 0.5, maxConcurrentPositions: 8, maxPositionsPerSector: 2,
  maxPortfolioHeatPct: 4, dailyLossHaltPct: 3, slippageBudgetPct: 0.3,
  tradeDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
};
const sig = (over = {}) => ({
  ticker: 'AAPL', market: 'US', tier: 'A+', side: 'buy', strategyKey: 'rsi2',
  entryPrice: 100, tpPrice: 110, slPrice: 95, advUsd: 50_000_000, ...over,
});

console.log('\n--- clientOrderId: deterministic + sanitized ---');
{
  const a = clientOrderId('user123', 'AAPL_rsi2_2026-06-17');
  t('stable for same inputs', a === clientOrderId('user123', 'AAPL_rsi2_2026-06-17'));
  t('differs by signal', a !== clientOrderId('user123', 'MSFT_rsi2_2026-06-17'));
  t('only safe chars', /^[A-Za-z0-9._-]+$/.test(a));
}

console.log('\n--- sizePosition: fixed-fractional risk ---');
{
  // equity 100k, risk 0.5% = $500 risk; entry-sl = 5 → 100 shares.
  const s = sizePosition({ equity: 100_000, riskPerTradePct: 0.5, entry: 100, sl: 95 });
  t('shares = floor(dollarRisk / riskPerShare)', s.shares === 100);
  t('dollarRisk computed', s.dollarRisk === 500);
  t('notional = shares*entry', s.notional === 10_000);
  t('zero stop distance -> 0 shares', sizePosition({ equity: 100_000, riskPerTradePct: 0.5, entry: 100, sl: 100 }).shares === 0);
  t('no equity -> 0 shares', sizePosition({ equity: 0, riskPerTradePct: 0.5, entry: 100, sl: 95 }).shares === 0);
  t('rounds DOWN (never over-risk)', sizePosition({ equity: 100_000, riskPerTradePct: 0.5, entry: 100, sl: 97 }).shares === 166);
}

console.log('\n--- sizePosition: fixed $ mode + per-position cap (small capital) ---');
{
  // Fixed $ budget ignores equity/stop; shares = floor(budget / entry).
  t('fixed: $200 budget at $50 = 4 shares', sizePosition({ sizingMode: 'fixed', fixedNotional: 200, entry: 50, sl: 47 }).shares === 4);
  t('fixed: budget below 1 share price = 0', sizePosition({ sizingMode: 'fixed', fixedNotional: 100, entry: 223, sl: 218 }).shares === 0);
  t('fixed: notional = shares*entry', sizePosition({ sizingMode: 'fixed', fixedNotional: 200, entry: 50, sl: 47 }).notional === 200);
  t('fixed still tracks dollarRisk from stop', sizePosition({ sizingMode: 'fixed', fixedNotional: 200, entry: 50, sl: 47 }).dollarRisk === 12);
  // maxPositionNotional caps BOTH modes.
  t('risk mode capped by max $ per position',
    sizePosition({ equity: 100_000, riskPerTradePct: 0.5, entry: 100, sl: 95, maxPositionNotional: 1000 }).shares === 10);
  t('fixed mode under cap unaffected',
    sizePosition({ sizingMode: 'fixed', fixedNotional: 300, entry: 50, sl: 47, maxPositionNotional: 1000 }).shares === 6);
  t('default mode is risk (back-compat)', sizePosition({ equity: 100_000, riskPerTradePct: 0.5, entry: 100, sl: 95 }).shares === 100);
}

console.log('\n--- signalMatchesRules ---');
{
  t('clean signal passes', signalMatchesRules(sig(), baseCfg).ok);
  t('wrong market fails', !signalMatchesRules(sig({ market: 'INDIA' }), baseCfg).ok);
  t('tier not selected fails', !signalMatchesRules(sig({ tier: 'Tier 2' }), baseCfg).ok);
  t('side not selected fails', !signalMatchesRules(sig({ side: 'sell' }), baseCfg).ok);
  t('excluded ticker fails', !signalMatchesRules(sig({ ticker: 'TSLA' }), baseCfg).ok);
  t('below min price fails', !signalMatchesRules(sig({ entryPrice: 10 }), baseCfg).ok);
  t('above max price fails', !signalMatchesRules(sig({ entryPrice: 2000 }), baseCfg).ok);
  t('thin liquidity fails', !signalMatchesRules(sig({ advUsd: 1_000_000 }), baseCfg).ok);
  t('index not selected fails', !signalMatchesRules(sig({ index: 'sp600' }), { ...baseCfg, indexes: ['sp500'] }).ok);
  t('index selected passes', signalMatchesRules(sig({ index: 'sp500' }), { ...baseCfg, indexes: ['sp500'] }).ok);
  t('empty index allow-list = all allowed', signalMatchesRules(sig({ index: 'sp600' }), baseCfg).ok);
  // Per-strategy index override takes precedence over the global list.
  t('per-strategy override: rsi2 allowed on sp500',
    signalMatchesRules(sig({ strategyKey: 'rsi2', index: 'sp500' }), { ...baseCfg, strategyIndexes: { rsi2: ['sp500'] } }).ok);
  t('per-strategy override: rsi2 blocked on sp600',
    !signalMatchesRules(sig({ strategyKey: 'rsi2', index: 'sp600' }), { ...baseCfg, strategyIndexes: { rsi2: ['sp500'] } }).ok);
  t('per-strategy override falls back to global when strategy has no entry',
    signalMatchesRules(sig({ strategyKey: 'vcp', index: 'sp600' }), { ...baseCfg, strategyIndexes: { rsi2: ['sp500'] } }).ok);
  // Large-cap is a separate membership dimension that overlaps sp500.
  t('largecap filter matches large-cap sp500 name',
    signalMatchesRules(sig({ index: 'sp500', largeCap: true }), { ...baseCfg, indexes: ['largecap'] }).ok);
  t('largecap filter matches large-cap name with no S&P index',
    signalMatchesRules(sig({ index: null, largeCap: true }), { ...baseCfg, indexes: ['largecap'] }).ok);
  t('sp500 filter still matches a large-cap sp500 name (OR membership)',
    signalMatchesRules(sig({ index: 'sp500', largeCap: true }), { ...baseCfg, indexes: ['sp500'] }).ok);
  t('largecap filter blocks a non-large-cap name',
    !signalMatchesRules(sig({ index: 'sp600', largeCap: false }), { ...baseCfg, indexes: ['largecap'] }).ok);
  t('per-strategy largecap override blocks non-large-cap rsi2',
    !signalMatchesRules(sig({ strategyKey: 'rsi2', index: 'sp600', largeCap: false }), { ...baseCfg, strategyIndexes: { rsi2: ['largecap'] } }).ok);
  // The Automation page's chips/table read each INDEX_OPTIONS entry's value the
  // same way this line does. If that field ever drifts from what the option
  // objects actually expose, every saved index resolves to the string
  // 'undefined' and the engine rejects EVERY signal on the index filter (the
  // "last auto trade was on the 17th" bug). Assert the chip value the UI would
  // persist is a real membership the engine honors, not undefined.
  for (const opt of INDEX_OPTIONS) {
    const chipValue = opt.value ?? opt.v; // mirrors src/views/automation.js chips()
    t(`index option '${opt.label}' exposes a real chip value (not undefined)`,
      typeof chipValue === 'string' && chipValue.length > 0);
    const member = chipValue === 'largecap' ? { largeCap: true } : { index: chipValue };
    t(`selecting index '${chipValue}' matches its own members`,
      signalMatchesRules(sig({ ...member }), { ...baseCfg, indexes: [chipValue] }).ok);
  }
  // India index filter — India signals are Nifty-tagged (index:'nifty50'), never
  // S&P. The filter options are market-aware so India users can't pick an S&P
  // bucket that would silently match nothing.
  t('india nifty50 signal matches nifty50 filter',
    signalMatchesRules(sig({ market: 'INDIA', index: 'nifty50', largeCap: false }), { ...baseCfg, markets: ['INDIA'], indexes: ['nifty50'] }).ok);
  t('india nifty50 signal blocked by an S&P filter',
    !signalMatchesRules(sig({ market: 'INDIA', index: 'nifty50', largeCap: false }), { ...baseCfg, markets: ['INDIA'], indexes: ['sp500'] }).ok);
  t('india nifty50 signal passes when index filter empty',
    signalMatchesRules(sig({ market: 'INDIA', index: 'nifty50', largeCap: false }), { ...baseCfg, markets: ['INDIA'] }).ok);
  t('US index options are the S&P buckets', indexOptionsForMarket('US').map(o => o.value).join(',') === 'largecap,sp500,sp400,sp600');
  t('India index options are Nifty-based (nifty50)', indexOptionsForMarket('INDIA').map(o => o.value).join(',') === 'nifty50');
  t('unknown market falls back to US options', indexOptionsForMarket('MARS').map(o => o.value).join(',') === 'largecap,sp500,sp400,sp600');
  t('multi-market options union US+India (nifty50 last, no dupes)',
    indexOptionsForMarkets(['US', 'INDIA']).map(o => o.value).join(',') === 'largecap,sp500,sp400,sp600,nifty50');
  t('empty markets defaults to US options', indexOptionsForMarkets([]).map(o => o.value).join(',') === 'largecap,sp500,sp400,sp600');
  t('empty strategy allow-list = all allowed', signalMatchesRules(sig({ strategyKey: 'vcp' }), baseCfg).ok);
  t('strategy allow-list excludes others', !signalMatchesRules(sig({ strategyKey: 'vcp' }), { ...baseCfg, strategies: ['rsi2'] }).ok);
  t('reasons listed on failure', signalMatchesRules(sig({ tier: 'Tier 2', ticker: 'TSLA' }), baseCfg).reasons.length === 2);
}

console.log('\n--- passesPortfolioGuards ---');
{
  const ctx = { cfg: baseCfg, openCount: 3, sectorCount: 1, openHeatPct: 1.5, addedHeatPct: 0.5, dayRealizedPct: -1 };
  t('within all limits passes', passesPortfolioGuards(ctx).ok);
  t('max concurrent blocks', !passesPortfolioGuards({ ...ctx, openCount: 8 }).ok);
  t('max per sector blocks', !passesPortfolioGuards({ ...ctx, sectorCount: 2 }).ok);
  t('portfolio heat cap blocks', !passesPortfolioGuards({ ...ctx, openHeatPct: 3.8, addedHeatPct: 0.5 }).ok);
  t('daily loss halt blocks', !passesPortfolioGuards({ ...ctx, dayRealizedPct: -3 }).ok);
  t('heat exactly at cap passes', passesPortfolioGuards({ ...ctx, openHeatPct: 3.5, addedHeatPct: 0.5 }).ok);
}

console.log('\n--- isTradeDayAllowed ---');
{
  t('Monday allowed', isTradeDayAllowed(baseCfg, new Date('2026-06-15T14:00:00Z'))); // Mon
  t('Saturday blocked', !isTradeDayAllowed(baseCfg, new Date('2026-06-13T14:00:00Z'))); // Sat
  t('empty tradeDays = always allowed', isTradeDayAllowed({ ...baseCfg, tradeDays: [] }, new Date('2026-06-13T14:00:00Z')));
}

console.log('\n--- slippageOk ---');
{
  t('buy at entry ok', slippageOk(baseCfg, 100, 100, 'buy'));
  t('buy within budget ok', slippageOk(baseCfg, 100, 100.2, 'buy'));
  t('buy past budget skipped', !slippageOk(baseCfg, 100, 100.5, 'buy'));
  t('sell gapped down skipped', !slippageOk(baseCfg, 100, 99.5, 'sell'));
  // Two-sided: a buy that gapped DOWN past the budget is a stale signal whose
  // bracket SL may sit at/above the fill (the CSCO/ARWR instant stop-outs).
  t('buy gapped down within budget ok', slippageOk(baseCfg, 100, 99.8, 'buy'));
  t('buy gapped down past budget skipped', !slippageOk(baseCfg, 100, 99.5, 'buy'));
  t('buy-stop below trigger still ok (pendingEntry)', slippageOk(baseCfg, 100, 97, 'buy', { pendingEntry: true }));
  t('buy-stop still capped on run-away', !slippageOk(baseCfg, 100, 100.5, 'buy', { pendingEntry: true }));
  t('sell gapped up past budget skipped', !slippageOk(baseCfg, 100, 100.5, 'sell'));
  t('sell-stop above trigger still ok (pendingEntry)', slippageOk(baseCfg, 100, 103, 'sell', { pendingEntry: true }));
  t('no budget = always ok', slippageOk({ ...baseCfg, slippageBudgetPct: null }, 100, 90, 'buy'));
}

console.log('\n--- stopClearanceOk ---');
{
  t('live above SL ok', stopClearanceOk({ slPrice: 98.5, side: 'buy' }, 100));
  t('live at SL skipped', !stopClearanceOk({ slPrice: 98.5, side: 'buy' }, 98.5));
  t('live through SL skipped', !stopClearanceOk({ slPrice: 109.13, side: 'buy' }, 108.64)); // the CSCO Jul-16 fill
  t('pendingEntry exempt', stopClearanceOk({ slPrice: 98.5, side: 'buy', pendingEntry: true }, 97));
  t('no SL = ok', stopClearanceOk({ slPrice: null, side: 'buy' }, 100));
  t('no live price fails open', stopClearanceOk({ slPrice: 98.5, side: 'buy' }, null));
  t('short: live below SL ok', stopClearanceOk({ slPrice: 105, side: 'sell' }, 100));
  t('short: live at/above SL skipped', !stopClearanceOk({ slPrice: 105, side: 'sell' }, 105));
}

console.log('\n--- drawdownHalted ---');
{
  t('within drawdown limit not halted', !drawdownHalted({ equity: 9500, peakEquity: 10000, maxDrawdownHaltPct: 20 }).halted);
  t('beyond limit halts', drawdownHalted({ equity: 7900, peakEquity: 10000, maxDrawdownHaltPct: 20 }).halted);
  t('reports drawdown %', Math.abs(drawdownHalted({ equity: 8000, peakEquity: 10000, maxDrawdownHaltPct: 20 }).drawdownPct - 20) < 1e-9);
  t('new high resets peak, 0 drawdown', drawdownHalted({ equity: 11000, peakEquity: 10000, maxDrawdownHaltPct: 20 }).peak === 11000);
  t('disabled when pct 0', !drawdownHalted({ equity: 5000, peakEquity: 10000, maxDrawdownHaltPct: 0 }).halted);
}

console.log('\n--- regimeAllowsEntry ---');
{
  t('risk-off blocks new longs', !regimeAllowsEntry({ go_to_cash: true }, 'buy').ok);
  t('risk-on allows longs', regimeAllowsEntry({ go_to_cash: false }, 'buy').ok);
  t('missing regime fails open', regimeAllowsEntry(null, 'buy').ok);
  t('risk-off does not block sells', regimeAllowsEntry({ go_to_cash: true }, 'sell').ok);
}

console.log('\n--- paper/live URL resolution (real-money safety) ---');
{
  t('blank base -> paper host', resolveAlpacaBaseUrl({}) === 'https://paper-api.alpaca.markets');
  t('configured url is used', resolveAlpacaBaseUrl({ restApiBase: 'https://api.alpaca.markets' }) === 'https://api.alpaca.markets');
  t('paper host is NOT live', isLiveBaseUrl('https://paper-api.alpaca.markets') === false);
  t('live host IS live', isLiveBaseUrl('https://api.alpaca.markets') === true);
  t('blank resolves to paper (not live)', isLiveBaseUrl(resolveAlpacaBaseUrl({})) === false);
  t('unknown url treated as live (fails safe)', isLiveBaseUrl('https://example.com') === true);
}

console.log('\n--- buildBracketOrder ---');
{
  const mkt = buildBracketOrder({ signal: sig(), shares: 100, clientOrderId: 'x' });
  t('limit entry when not pendingEntry', mkt.type === 'limit' && mkt.stopPrice === null);
  t('limit = entry when no slippage budget', mkt.limitPrice === 100);
  t('attaches TP + SL bracket', mkt.takeProfit.limitPrice === 110 && mkt.stopLoss.stopPrice === 95);
  const bounded = buildBracketOrder({ signal: sig(), shares: 100, clientOrderId: 'x', slippageBudgetPct: 0.3 });
  t('buy limit bounded up by slippage budget', bounded.limitPrice === 100.3);
  const stop = buildBracketOrder({ signal: sig({ pendingEntry: true }), shares: 100, clientOrderId: 'x', slippageBudgetPct: 0.3 });
  t('stop-entry when pendingEntry (no limit)', stop.type === 'stop' && stop.stopPrice === 100 && stop.limitPrice === null);
  // Regression: strategy math yields raw floats (45.06 × 1.02 = 45.961200000000005)
  // and Alpaca rejects sub-penny prices — every price must round to the penny.
  const subPenny = buildBracketOrder({
    signal: sig({ entryPrice: 45.06, tpPrice: 45.06 * 1.02, slPrice: 45.06 * 0.98, pendingEntry: true }),
    shares: 10, clientOrderId: 'x',
  });
  t('TP rounds sub-penny float to penny', subPenny.takeProfit.limitPrice === 45.96);
  t('SL rounds sub-penny float to penny', subPenny.stopLoss.stopPrice === 44.16);
  t('pending stop entry rounds to penny', subPenny.stopPrice === 45.06);
  t('sub-dollar prices keep 4 decimals', brokerPrice(0.12345) === 0.1235 && brokerPrice(0.1234) === 0.1234);
  t('at/above $1 rounds to pennies', brokerPrice(1.005) === 1.01 || brokerPrice(1.005) === 1.0); // fp-safe: must be a penny increment
}

console.log('\n--- modelExitAction (broker exit management) ---');
{
  const closed = (exitReason) => ({ status: 'closed', winLoss: 'win', exitReason });
  t('native exit acts', modelExitAction(closed('native')) === true);
  t('time stop acts', modelExitAction(closed('time_stop')) === true);
  t('trailing stop acts', modelExitAction(closed('trail')) === true);
  t('tp is the bracket\'s job', modelExitAction(closed('tp')) === false);
  t('sl is the bracket\'s job', modelExitAction(closed('sl')) === false);
  t('open position does not act', modelExitAction({ status: 'open', exitReason: null }) === false);
  t('null verdict does not act', modelExitAction(null) === false);
}

console.log('\n--- entryLimitPrice ---');
{
  t('null entry -> null', entryLimitPrice(null, 'buy', 0.3) === null);
  t('no budget -> entry rounded', entryLimitPrice(100, 'buy') === 100);
  t('buy pays up to +budget', entryLimitPrice(100, 'buy', 0.3) === 100.3);
  t('sell accepts down to -budget', entryLimitPrice(100, 'sell', 0.3) === 99.7);
}

console.log('\n--- marketClock / inEntryWindow (DST-aware ET) ---');
{
  // 2026-07-03 13:40 UTC = 09:40 EDT (summer, UTC-4) → in the morning window.
  const edtMorning = new Date('2026-07-03T13:40:00Z');
  t('EDT morning maps to 09:40 ET', marketClock(edtMorning).minutes === 9 * 60 + 40);
  t('EDT date is the ET calendar day', marketClock(edtMorning).date === '2026-07-03');
  t('09:40 ET is inside entry window', inEntryWindow(edtMorning) === true);
  // 16:30 UTC = 12:30 EDT — where GitHub's delayed cron actually lands; must be
  // inside the (widened) window so late runs can still place entries.
  t('12:30 ET is inside entry window', inEntryWindow(new Date('2026-07-03T16:30:00Z')) === true);
  // 17:30 UTC = 13:30 EDT → past the 13:00 ET cutoff, outside the window.
  t('13:30 ET is outside entry window', inEntryWindow(new Date('2026-07-03T17:30:00Z')) === false);
  // 19:45 UTC = 15:45 EDT → afternoon, outside the window.
  t('15:45 ET is outside entry window', inEntryWindow(new Date('2026-07-03T19:45:00Z')) === false);
  // 2026-01-05 14:40 UTC = 09:40 EST (winter, UTC-5) → in window.
  t('EST morning maps to 09:40 ET', marketClock(new Date('2026-01-05T14:40:00Z')).minutes === 9 * 60 + 40);
  t('EST 09:40 ET is inside entry window', inEntryWindow(new Date('2026-01-05T14:40:00Z')) === true);
  // 13:40 UTC in winter = 08:40 EST → before the open, outside window.
  t('EST pre-open (08:40 ET) is outside window', inEntryWindow(new Date('2026-01-05T13:40:00Z')) === false);
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
