// =============================================================================
// Round-trip reconstruction self-test.
//
// These numbers end up on a P&L dashboard used to judge whether a strategy is
// working, so the matcher has to be right about partial fills, scaling, shorts
// and reversals — the cases a naive "pair each buy with the next sell" would
// silently get wrong.
//
// Run with:  node tests/perf.mjs
// =============================================================================

import { buildRoundTrips, summarize, groupByPeriod, groupBySymbol, realizedDrawdown, normalizeFill } from '../src/perf/roundTrips.js';

let pass = 0, fail = 0;
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.error('  ✗', name, extra); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Alpaca sends strings; mimic that faithfully rather than pre-cleaned numbers.
const fill = (symbol, side, qty, price, day, id = null) => ({
  symbol, side, qty: String(qty), price: String(price),
  transaction_time: `2026-08-${String(day).padStart(2, '0')}T15:30:00Z`,
  id: id ?? `${symbol}-${side}-${day}-${qty}`,
});

console.log('--- normalizeFill ---');
{
  const f = normalizeFill(fill('AAPL', 'buy', '10', '100.5', 3));
  t('coerces string qty/price to numbers', f.qty === 10 && f.price === 100.5);
  t('parses transaction_time to a Date', f.time instanceof Date);
  t('uppercases the symbol', normalizeFill({ symbol: 'aapl', side: 'buy', qty: 1, price: 1, transaction_time: '2026-08-01' }).symbol === 'AAPL');
  t('sell_short maps to sell', normalizeFill({ symbol: 'X', side: 'sell_short', qty: 1, price: 1, transaction_time: '2026-08-01' }).side === 'sell');
  t('buy_to_cover maps to buy', normalizeFill({ symbol: 'X', side: 'buy_to_cover', qty: 1, price: 1, transaction_time: '2026-08-01' }).side === 'buy');
}

console.log('\n--- simple long round trip ---');
{
  const { trades, open } = buildRoundTrips([fill('AAPL', 'buy', 10, 100, 1), fill('AAPL', 'sell', 10, 110, 5)]);
  t('produces exactly one closed trade', trades.length === 1);
  t('P&L = (110-100) x 10 = 100', near(trades[0].pnl, 100), `got ${trades[0]?.pnl}`);
  t('return = +10%', near(trades[0].pnlPct, 10));
  t('hold = 4 days', near(trades[0].holdDays, 4));
  t('classified win', trades[0].winLoss === 'win');
  t('nothing left open', open.length === 0);
}

console.log('\n--- losing trade ---');
{
  const { trades } = buildRoundTrips([fill('X', 'buy', 5, 100, 1), fill('X', 'sell', 5, 95, 2)]);
  t('P&L = -25', near(trades[0].pnl, -25));
  t('return = -5%', near(trades[0].pnlPct, -5));
  t('classified loss', trades[0].winLoss === 'loss');
}

console.log('\n--- PARTIAL FILLS: one order filling in pieces ---');
{
  // Buy 10 in two prints, sell 10 in three prints.
  const { trades, open } = buildRoundTrips([
    fill('P', 'buy', 6, 100, 1, 'b1'), fill('P', 'buy', 4, 102, 1, 'b2'),
    fill('P', 'sell', 3, 110, 5, 's1'), fill('P', 'sell', 3, 111, 5, 's2'), fill('P', 'sell', 4, 112, 5, 's3'),
  ]);
  const net = trades.reduce((s, x) => s + x.pnl, 0);
  // FIFO: lots are 6@100 then 4@102, closed by 3@110, 3@111, 4@112.
  //   sell 3@110 -> 3 from lot1: (110-100)*3 = 30   [lot1 has 3 left]
  //   sell 3@111 -> 3 from lot1: (111-100)*3 = 33   [lot1 exhausted]
  //   sell 4@112 -> 4 from lot2: (112-102)*4 = 40
  t('net P&L = 103 (FIFO across partials)', near(net, 103), `got ${net}`);
  t('nothing left open', open.length === 0);
  t('all qty accounted for', near(trades.reduce((s, x) => s + x.qty, 0), 10));
  // INVARIANT: for a fully closed book, net P&L must equal proceeds - cost no
  // matter how lots were matched. This is lot-matching-independent, so it
  // catches an arithmetic slip in the expectation above as well as in the code.
  const cost = 6 * 100 + 4 * 102, proceeds = 3 * 110 + 3 * 111 + 4 * 112;
  t('net P&L == proceeds - cost (matching-independent)', near(net, proceeds - cost), `${net} vs ${proceeds - cost}`);
}

console.log('\n--- SCALING OUT: partial close leaves the rest open ---');
{
  const { trades, open } = buildRoundTrips([fill('S', 'buy', 10, 100, 1), fill('S', 'sell', 4, 110, 3)]);
  t('one closed trade for the 4 sold', trades.length === 1 && trades[0].qty === 4);
  t('closed P&L = 40', near(trades[0].pnl, 40));
  t('6 shares still open', open.length === 1 && near(open[0].qty, 6));
  t('open lot keeps its original entry price', near(open[0].entryPrice, 100));
  t('open position is NOT counted as a win', summarize(trades).trades === 1);
}

console.log('\n--- SHORT round trip (P&L sign must invert) ---');
{
  const { trades } = buildRoundTrips([fill('SH', 'sell', 10, 100, 1), fill('SH', 'buy', 10, 90, 4)]);
  t('one closed trade', trades.length === 1);
  t('marked short', trades[0].side === 'short');
  t('short profit when price FALLS: +100', near(trades[0].pnl, 100), `got ${trades[0]?.pnl}`);
}
{
  const { trades } = buildRoundTrips([fill('SH2', 'sell', 10, 100, 1), fill('SH2', 'buy', 10, 105, 4)]);
  t('short loses when price rises: -50', near(trades[0].pnl, -50), `got ${trades[0]?.pnl}`);
}

console.log('\n--- REVERSAL: long -> short in a single fill ---');
{
  // Long 10, then sell 15: closes the 10 long and opens a 5 short.
  const { trades, open } = buildRoundTrips([fill('R', 'buy', 10, 100, 1), fill('R', 'sell', 15, 110, 3)]);
  t('closes the long for +100', trades.length === 1 && near(trades[0].pnl, 100));
  t('opens a 5-share short with the remainder', open.length === 1 && near(open[0].qty, 5) && open[0].side === 'short');
  t('short lot entry is the reversing fill price', near(open[0].entryPrice, 110));
}

console.log('\n--- ORDERING: out-of-order fills are sorted before matching ---');
{
  const late = fill('O', 'sell', 10, 110, 9);
  const early = fill('O', 'buy', 10, 100, 2);
  const a = buildRoundTrips([late, early]).trades;   // reversed input
  const b = buildRoundTrips([early, late]).trades;
  t('same result regardless of input order', near(a[0].pnl, b[0].pnl) && near(a[0].pnl, 100));
  t('entry is the earlier fill', a[0].entryPrice === 100 && a[0].exitPrice === 110);
}

console.log('\n--- MULTI-SYMBOL isolation ---');
{
  const { trades } = buildRoundTrips([
    fill('A', 'buy', 10, 100, 1), fill('B', 'buy', 5, 50, 1),
    fill('B', 'sell', 5, 60, 2), fill('A', 'sell', 10, 90, 3),
  ]);
  t('two closed trades', trades.length === 2);
  const bySym = Object.fromEntries(trades.map(x => [x.symbol, x.pnl]));
  t('B +50 (does not borrow A lots)', near(bySym.B, 50));
  t('A -100', near(bySym.A, -100));
}

console.log('\n--- summarize ---');
{
  const { trades } = buildRoundTrips([
    fill('W', 'buy', 10, 100, 1), fill('W', 'sell', 10, 110, 2),   // +100
    fill('L', 'buy', 10, 100, 3), fill('L', 'sell', 10, 95, 4),    // -50
    fill('W2', 'buy', 10, 100, 5), fill('W2', 'sell', 10, 105, 6), // +50
  ]);
  const s = summarize(trades);
  t('3 trades, 2 wins, 1 loss', s.trades === 3 && s.wins === 2 && s.losses === 1);
  t('win rate 66.7%', near(s.winRate, 2 / 3));
  t('net P&L +100', near(s.netPnl, 100));
  t('gross win 150 / gross loss 50', near(s.grossWin, 150) && near(s.grossLoss, 50));
  t('profit factor 3.0', near(s.profitFactor, 3));
  t('expectancy 33.33/trade', near(s.expectancy, 100 / 3));
  t('avg win 75 / avg loss -50', near(s.avgWin, 75) && near(s.avgLoss, -50));
  t('best/worst identified', s.best.symbol === 'W' && s.worst.symbol === 'L');
  t('empty input does not divide by zero', summarize([]).winRate === null);
  const allWins = summarize(buildRoundTrips([fill('Z', 'buy', 1, 10, 1), fill('Z', 'sell', 1, 20, 2)]).trades);
  t('profit factor is Infinity with no losses (not NaN)', allWins.profitFactor === Infinity);
}

console.log('\n--- groupByPeriod ---');
{
  const { trades } = buildRoundTrips([
    fill('A', 'buy', 10, 100, 1), fill('A', 'sell', 10, 110, 3),   // closes Aug 3
    fill('B', 'buy', 10, 100, 2), fill('B', 'sell', 10, 90, 3),    // closes Aug 3
    fill('C', 'buy', 10, 100, 4), fill('C', 'sell', 10, 105, 20),  // closes Aug 20
  ]);
  const days = groupByPeriod(trades, 'day');
  t('two distinct close-days', days.length === 2);
  t('newest day first', days[0].key > days[1].key);
  const aug3 = days.find(d => d.key.endsWith('-03'));
  t('Aug 3 nets 0 (+100 and -100 same day)', near(aug3.pnl, 0), `got ${aug3?.pnl}`);
  t('Aug 3 counts 2 trades', aug3.trades === 2);
  const months = groupByPeriod(trades, 'month');
  t('all in one month bucket', months.length === 1 && near(months[0].pnl, 50));
  const weeks = groupByPeriod(trades, 'week');
  t('week keys look like YYYY-Www', /^\d{4}-W\d{2}$/.test(weeks[0].key));
  t('cumulative present on every row', days.every(d => typeof d.cumulative === 'number'));
}

console.log('\n--- groupBySymbol + realizedDrawdown ---');
{
  const { trades } = buildRoundTrips([
    fill('A', 'buy', 10, 100, 1), fill('A', 'sell', 10, 120, 2),   // +200
    fill('A', 'buy', 10, 100, 3), fill('A', 'sell', 10, 70, 4),    // -300
    fill('B', 'buy', 10, 100, 5), fill('B', 'sell', 10, 110, 6),   // +100
  ]);
  const sym = groupBySymbol(trades);
  t('B ranked above A (more profitable)', sym[0].symbol === 'B');
  t('A nets -100 over 2 trades', near(sym.find(s => s.symbol === 'A').pnl, -100));
  const dd = realizedDrawdown(trades);
  t('realized drawdown = 300 (peak 200 -> -100)', near(dd.maxDrawdown, 300), `got ${dd.maxDrawdown}`);
}

console.log('\n--- robustness against messy broker data ---');
{
  const { trades } = buildRoundTrips([
    { symbol: 'X', side: 'buy', qty: '0', price: '100', transaction_time: '2026-08-01T00:00:00Z' },
    { symbol: '', side: 'buy', qty: '5', price: '100', transaction_time: '2026-08-01T00:00:00Z' },
    { symbol: 'X', side: 'buy', qty: '5', price: 'not-a-number', transaction_time: '2026-08-01T00:00:00Z' },
    { symbol: 'X', side: 'buy', qty: '5', price: '100' }, // no timestamp
  ]);
  t('zero-qty / blank symbol / NaN price / no time are all dropped', trades.length === 0);
  t('null input does not throw', buildRoundTrips(null).trades.length === 0);
  t('a sell with no prior buy opens a short, not a phantom win',
    buildRoundTrips([fill('N', 'sell', 5, 100, 1)]).trades.length === 0);
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
