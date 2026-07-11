// Condor engine tests — synthetic chain (no network). Run: npm run test:condor
import assert from 'node:assert/strict';
import {
  parseOccSymbol, parseCboeChain, pickExpiry, isFirstFriday, buildCondor,
  condorTicketText, DEFAULT_CONDOR_CONFIG,
} from '../src/data/condor.js';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('condor engine');

// ---------------------------------------------------------------------------
ok('parseOccSymbol handles padded CBOE symbols', () => {
  const p = parseOccSymbol('XSP   260717C00695000');
  assert.deepEqual(p, { root: 'XSP', expiry: '2026-07-17', type: 'C', strike: 695 });
  assert.equal(parseOccSymbol('SPXW260717P06100000').root, 'SPXW');
  assert.equal(parseOccSymbol('garbage'), null);
});

ok('parseCboeChain reads spot, filters roots and quote-less rows', () => {
  const json = { timestamp: 'x', data: {
    current_price: 680.12,
    options: [
      { option: 'XSP260717C00695000', bid: 0.2, ask: 0.3, delta: 0.09 },
      { option: 'SPY260717C00695000', bid: 0.2, ask: 0.3, delta: 0.09 },  // wrong root
      { option: 'XSP260717C00700000', bid: 0, ask: 0 },                    // no quotes
    ],
  } };
  const chain = parseCboeChain(json, 'XSP');
  assert.equal(chain.spot, 680.12);
  assert.equal(chain.options.length, 1);
  assert.equal(chain.options[0].strike, 695);
});

ok('pickExpiry respects cadence', () => {
  const exps = ['2026-07-17', '2026-07-20', '2026-07-21', '2026-07-24']; // Fri, Mon, Tue, Fri
  assert.equal(pickExpiry(exps, 'any-day', '2026-07-16'), '2026-07-17');
  assert.equal(pickExpiry(exps, 'thu-fri', '2026-07-16'), '2026-07-17');
  assert.equal(pickExpiry(exps, 'thu-fri', '2026-07-17'), '2026-07-24'); // Friday → next Friday
  assert.equal(pickExpiry(exps, 'twice-weekly', '2026-07-20'), '2026-07-21'); // Monday → Tuesday
});

ok('isFirstFriday flags NFP-day expiries', () => {
  assert.equal(isFirstFriday('2026-08-07'), true);   // first Friday of Aug 2026
  assert.equal(isFirstFriday('2026-08-14'), false);
  assert.equal(isFirstFriday('2026-08-06'), false);  // Thursday
});

// ---------------------------------------------------------------------------
// Synthetic 1-DTE XSP chain: spot 680, expiry Fri 2026-07-17.
const EXP = '2026-07-17';
const mk = (type, strike, mid, delta) => ({
  root: 'XSP', expiry: EXP, type, strike,
  bid: Math.round((mid - 0.02) * 100) / 100, ask: Math.round((mid + 0.02) * 100) / 100,
  mid, delta, iv: 0.2, oi: 1000, volume: 50,
});
const CHAIN = { spot: 680, asOf: 'test', options: [
  mk('C', 692, 0.55, 0.13),
  mk('C', 694, 0.40, 0.105),
  mk('C', 696, 0.30, 0.09),    // ← expected short call (delta closest to 0.09)
  mk('C', 698, 0.22, 0.07),
  mk('C', 700, 0.15, 0.055),
  mk('C', 701, 0.10, 0.05),    // ← expected wing (first strike ≥ 696 + 0.65% of 680 = 700.42)
  mk('C', 705, 0.05, 0.03),
  mk('P', 668, 0.55, -0.13),
  mk('P', 666, 0.42, -0.105),
  mk('P', 664, 0.30, -0.09),   // ← expected short put
  mk('P', 662, 0.22, -0.07),
  mk('P', 660, 0.16, -0.055),
  mk('P', 659, 0.11, -0.05),   // ← expected wing (largest strike ≤ 664 − 4.42 = 659.58)
  mk('P', 655, 0.06, -0.03),
] };
// Thu 2026-07-16 11:00 ET (15:00 UTC in July, EDT).
const NOW = new Date('2026-07-16T15:00:00Z');

ok('buildCondor picks delta-band shorts and %-of-spot wings', () => {
  const c = buildCondor(CHAIN, { ...DEFAULT_CONDOR_CONFIG, capital: 4000 }, NOW);
  assert.equal(c.expiry, EXP);
  assert.equal(c.entryDayOK, true);
  assert.equal(c.call.sell.strike, 696);
  assert.equal(c.call.buy.strike, 701);
  assert.equal(c.put.sell.strike, 664);
  assert.equal(c.put.buy.strike, 659);
});

ok('buildCondor credit, stops and sizing follow the base math', () => {
  const c = buildCondor(CHAIN, { ...DEFAULT_CONDOR_CONFIG, capital: 4000 }, NOW);
  assert.equal(c.call.credit, 0.20);                 // 0.30 − 0.10
  assert.equal(c.put.credit, 0.19);                  // 0.30 − 0.11
  assert.equal(c.totalCredit, 0.39);
  assert.equal(c.call.stopMark, 0.80);               // 4 × credit
  assert.equal(c.put.stopMark, 0.76);
  assert.equal(c.allocPerCondor, 3900);              // credit ≈ 1% of allocation
  assert.equal(c.contracts, 1);
  assert.equal(c.maxProfitUsd, 39);
  assert.equal(c.definedRiskUsd, 461);               // (5 − 0.39) × 100
  // Credits ≥ 0.025% of spot (0.17) → no skip-week warning.
  assert.equal(c.warnings.some(w => w.includes('SKIP-WEEK')), false);
});

ok('buildCondor warns when credit is below the floor (skip-week rule)', () => {
  const thin = { ...CHAIN, options: CHAIN.options.map(o =>
    ({ ...o, mid: o.mid / 3, bid: Math.max(0.01, o.bid / 3), ask: o.ask / 3 })) };
  const c = buildCondor(thin, { ...DEFAULT_CONDOR_CONFIG, capital: 4000 }, NOW);
  assert.equal(c.warnings.some(w => w.includes('SKIP-WEEK')), true);
});

ok('buildCondor warns when capital is below one allocation', () => {
  const c = buildCondor(CHAIN, { ...DEFAULT_CONDOR_CONFIG, capital: 1000 }, NOW);
  assert.equal(c.sizedByCapital, 0);
  assert.equal(c.contracts, 1); // still quotes one for reference
  assert.equal(c.warnings.some(w => w.includes('below one condor')), true);
});

ok('buildCondor falls back to premium targeting when greeks missing', () => {
  const noDelta = { ...CHAIN, options: CHAIN.options.map(o => ({ ...o, delta: null })) };
  const c = buildCondor(noDelta, { ...DEFAULT_CONDOR_CONFIG, capital: 4000 }, NOW);
  // 0.04% of 680 = 0.272 → call mid closest is 0.30 (strike 696); put 0.30 (664).
  assert.equal(c.call.sell.strike, 696);
  assert.equal(c.put.sell.strike, 664);
});

ok('condorTicketText contains all four legs and both stops', () => {
  const cfg = { ...DEFAULT_CONDOR_CONFIG, capital: 4000 };
  const txt = condorTicketText(buildCondor(CHAIN, cfg, NOW), cfg);
  for (const s of ['696 CALL', '701 CALL', '664 PUT', '659 PUT', '0.80', '0.76', 'SELL to open', 'BUY  to open']) {
    assert.ok(txt.includes(s), `missing "${s}" in ticket`);
  }
});

console.log(`${passed} passed`);
