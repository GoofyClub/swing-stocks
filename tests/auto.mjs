// =============================================================================
// Auto-trade engine self-test. Pins the pure risk/sizing/guard/idempotency
// logic the execution worker relies on — so a refactor can't silently change
// how many shares get bought or which signals get filtered.
//
// Run with:  node tests/auto.mjs
// =============================================================================

import {
  clientOrderId, sizePosition, signalMatchesRules, passesPortfolioGuards,
  isTradeDayAllowed, slippageOk, buildBracketOrder, regimeAllowsEntry,
} from '../src/auto/engine.js';

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
}

console.log('\n--- regimeAllowsEntry ---');
{
  t('risk-off blocks new longs', !regimeAllowsEntry({ go_to_cash: true }, 'buy').ok);
  t('risk-on allows longs', regimeAllowsEntry({ go_to_cash: false }, 'buy').ok);
  t('missing regime fails open', regimeAllowsEntry(null, 'buy').ok);
  t('risk-off does not block sells', regimeAllowsEntry({ go_to_cash: true }, 'sell').ok);
}

console.log('\n--- buildBracketOrder ---');
{
  const mkt = buildBracketOrder({ signal: sig(), shares: 100, clientOrderId: 'x' });
  t('market entry when not pendingEntry', mkt.type === 'market' && mkt.stopPrice === null);
  t('attaches TP + SL bracket', mkt.takeProfit.limitPrice === 110 && mkt.stopLoss.stopPrice === 95);
  const stop = buildBracketOrder({ signal: sig({ pendingEntry: true }), shares: 100, clientOrderId: 'x' });
  t('stop-entry when pendingEntry', stop.type === 'stop' && stop.stopPrice === 100);
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
