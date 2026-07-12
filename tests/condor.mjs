// Condor engine tests — synthetic chains (no network). Run: npm run test:condor
import assert from 'node:assert/strict';
import {
  parseOccSymbol, parseCboeChain, pickExpiry, isFirstFriday, daysBetween, addDays,
  buildCondor, condorTicketText, DEFAULT_CONDOR_CONFIG, MODE_DEFAULTS,
} from '../src/data/condor.js';

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

const cfg = (mode, over = {}, capital = 4000) => ({
  ...JSON.parse(JSON.stringify(DEFAULT_CONDOR_CONFIG)),
  mode, capital,
  modes: {
    ...JSON.parse(JSON.stringify(MODE_DEFAULTS)),
    [mode]: { ...MODE_DEFAULTS[mode], ...over },
  },
});

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
});

ok('date helpers', () => {
  assert.equal(daysBetween('2026-07-16', '2026-08-21'), 36);
  assert.equal(addDays('2026-08-21', -21), '2026-07-31');
  assert.equal(isFirstFriday('2026-08-07'), true);
  assert.equal(isFirstFriday('2026-08-14'), false);
  assert.equal(isFirstFriday('2026-08-06'), false);
});

ok('pickExpiry: 30-45dte mode snaps to DTE closest to target inside the range', () => {
  const exps = ['2026-07-17', '2026-08-14', '2026-08-21', '2026-08-28', '2026-09-18'];
  // From 2026-07-16: DTEs are 1, 29, 36, 43, 64 → in [30,45]: 36 & 43 → closest to 38 = 36.
  assert.equal(pickExpiry(exps, cfg('30-45dte'), '2026-07-16'), '2026-08-21');
  // Nothing in range → overall closest to target.
  assert.equal(pickExpiry(['2026-07-17', '2026-09-18'], cfg('30-45dte'), '2026-07-16'), '2026-09-18');
});

ok('pickExpiry: 1dte cadences', () => {
  const exps = ['2026-07-17', '2026-07-20', '2026-07-21', '2026-07-24']; // Fri, Mon, Tue, Fri
  assert.equal(pickExpiry(exps, cfg('1dte', { cadence: 'any-day' }), '2026-07-16'), '2026-07-17');
  assert.equal(pickExpiry(exps, cfg('1dte'), '2026-07-16'), '2026-07-17');
  assert.equal(pickExpiry(exps, cfg('1dte'), '2026-07-17'), '2026-07-24');
  assert.equal(pickExpiry(exps, cfg('1dte', { cadence: 'twice-weekly' }), '2026-07-20'), '2026-07-21');
});

// ---------------------------------------------------------------------------
// Synthetic chains, spot 680. NOW = Thu 2026-07-16 11:00 ET.
const NOW = new Date('2026-07-16T15:00:00Z');
const mk = (expiry, type, strike, mid, delta, spread = 0.04, oi = 1000) => ({
  root: 'XSP', expiry, type, strike,
  bid: Math.round((mid - spread / 2) * 100) / 100, ask: Math.round((mid + spread / 2) * 100) / 100,
  mid, delta, iv: 0.2, oi, volume: 50,
});

// ----- 1-DTE chain (Fri 2026-07-17) -----------------------------------------
const E1 = '2026-07-17';
const CHAIN_1DTE = { spot: 680, asOf: 'test', options: [
  mk(E1, 'C', 692, 0.55, 0.13), mk(E1, 'C', 694, 0.40, 0.105),
  mk(E1, 'C', 696, 0.30, 0.09),                       // ← short call
  mk(E1, 'C', 698, 0.22, 0.07), mk(E1, 'C', 700, 0.15, 0.055),
  mk(E1, 'C', 701, 0.10, 0.05),                       // ← wing (696 + 4.42 → 701)
  mk(E1, 'C', 705, 0.05, 0.03),
  mk(E1, 'P', 668, 0.55, -0.13), mk(E1, 'P', 666, 0.42, -0.105),
  mk(E1, 'P', 664, 0.30, -0.09),                      // ← short put
  mk(E1, 'P', 662, 0.22, -0.07), mk(E1, 'P', 660, 0.16, -0.055),
  mk(E1, 'P', 659, 0.11, -0.05),                      // ← wing (664 − 4.42 → 659)
  mk(E1, 'P', 655, 0.06, -0.03),
] };

ok('1dte: delta-band shorts, %-of-spot wings, per-side stops, 1%-sizing', () => {
  const c = buildCondor(CHAIN_1DTE, cfg('1dte'), NOW);
  assert.equal(c.mode, '1dte');
  assert.equal(c.expiry, E1);
  assert.equal(c.dte, 1);
  assert.equal(c.entryDayOK, true);                    // Thursday
  assert.equal(c.call.sell.strike, 696);
  assert.equal(c.call.buy.strike, 701);
  assert.equal(c.put.sell.strike, 664);
  assert.equal(c.put.buy.strike, 659);
  assert.equal(c.call.credit, 0.20);
  assert.equal(c.put.credit, 0.19);
  assert.equal(c.totalCredit, 0.39);
  assert.equal(c.call.stopMark, 0.80);                 // 4 × credit
  assert.equal(c.put.stopMark, 0.76);
  assert.equal(c.allocPerCondor, 3900);
  assert.equal(c.contracts, 1);
  assert.equal(c.breakevenUp, 696.39);
  assert.equal(c.breakevenDown, 663.61);
  assert.equal(c.warnings.some(w => w.includes('SKIP RULE')), false);
});

ok('1dte: skip-rule warning when credit below floor', () => {
  const thin = { ...CHAIN_1DTE, options: CHAIN_1DTE.options.map(o =>
    ({ ...o, mid: Math.round(o.mid / 3 * 100) / 100, bid: Math.max(0.01, Math.round(o.bid / 3 * 100) / 100), ask: Math.round(o.ask / 3 * 100) / 100 })) };
  const c = buildCondor(thin, cfg('1dte'), NOW);
  assert.equal(c.warnings.some(w => w.includes('SKIP RULE')), true);
});

ok('1dte: premium fallback when greeks missing', () => {
  const noDelta = { ...CHAIN_1DTE, options: CHAIN_1DTE.options.map(o => ({ ...o, delta: null })) };
  const c = buildCondor(noDelta, cfg('1dte'), NOW);
  assert.equal(c.call.sell.strike, 696);               // mid closest to 0.04% of spot
  assert.equal(c.put.sell.strike, 664);
});

// ----- 30-45 DTE chain (Fri 2026-08-21, 36 DTE) ------------------------------
const EM = '2026-08-21';
const CHAIN_M = { spot: 680, asOf: 'test', options: [
  mk(EM, 'C', 700, 4.50, 0.22, 0.10), mk(EM, 'C', 705, 3.60, 0.18, 0.10),  // ← short call (0.18 closest to 0.175)
  mk(EM, 'C', 710, 2.90, 0.15, 0.10), mk(EM, 'C', 715, 2.30, 0.12, 0.10),
  mk(EM, 'C', 720, 1.40, 0.09, 0.10),                                       // ← wing (705 + 10.2 → 720)
  mk(EM, 'C', 725, 1.00, 0.07, 0.10),
  mk(EM, 'P', 660, 4.60, -0.22, 0.10), mk(EM, 'P', 655, 3.70, -0.18, 0.10), // ← short put
  mk(EM, 'P', 650, 3.00, -0.15, 0.10), mk(EM, 'P', 645, 2.40, -0.12, 0.10),
  mk(EM, 'P', 640, 1.50, -0.09, 0.10),                                      // ← wing (655 − 10.2 → 640)
  // A second, out-of-range expiry the picker must ignore:
  mk(E1, 'C', 696, 0.30, 0.09), mk(E1, 'C', 701, 0.10, 0.05),
  mk(E1, 'P', 664, 0.30, -0.09), mk(E1, 'P', 659, 0.11, -0.05),
] };

ok('30-45dte: picks ~38-DTE expiry, 0.15-0.20Δ shorts, 1.5% wings', () => {
  const c = buildCondor(CHAIN_M, cfg('30-45dte', {}, 12000), NOW);
  assert.equal(c.mode, '30-45dte');
  assert.equal(c.expiry, EM);
  assert.equal(c.dte, 36);
  assert.equal(c.entryDayOK, true);                    // any day is fine in this mode
  assert.equal(c.call.sell.strike, 705);
  assert.equal(c.call.buy.strike, 720);
  assert.equal(c.put.sell.strike, 655);
  assert.equal(c.put.buy.strike, 640);
  assert.equal(c.call.credit, 2.20);
  assert.equal(c.put.credit, 2.20);
  assert.equal(c.totalCredit, 4.40);
  assert.equal(c.call.stopMark, null);                 // no per-side stop in managed mode
});

ok('30-45dte: playbook management marks (50% TP, 21-DTE time exit, 2× loss stop)', () => {
  const c = buildCondor(CHAIN_M, cfg('30-45dte', {}, 12000), NOW);
  assert.equal(c.profitTargetMark, 2.20);              // buy back at 50% of credit
  assert.equal(c.lossMark, 13.20);                     // credit × (1 + 2)
  assert.equal(c.timeExitDate, '2026-07-31');          // expiry − 21 days
  assert.equal(c.breakevenUp, 709.40);
  assert.equal(c.breakevenDown, 650.60);
  assert.equal(c.creditOfWidthPct, 29);                // 4.4 / 15
});

ok('30-45dte: risk-based sizing (defined risk ≤ riskPct% of capital)', () => {
  // Risk per condor = (15 − 4.4) × 100 = $1,060. 20% of 12k = $2,400 → 2 contracts.
  const c = buildCondor(CHAIN_M, cfg('30-45dte', {}, 12000), NOW);
  assert.equal(c.contracts, 2);
  assert.equal(c.maxProfitUsd, 880);
  assert.equal(c.definedRiskUsd, 2120);
  assert.equal(c.plannedLossUsd, 1760);                // 2× credit × 100 × 2
  // Small account: 20% of 4k = $800 < $1,060 → quote 1 with a sizing warning.
  const small = buildCondor(CHAIN_M, cfg('30-45dte'), NOW);
  assert.equal(small.sizedByCapital, 0);
  assert.equal(small.contracts, 1);
  assert.equal(small.warnings.some(w => w.includes('defined risk')), true);
});

ok('liquidity warnings: thin OI and wide markets are flagged', () => {
  const bad = { ...CHAIN_M, options: CHAIN_M.options.map(o =>
    o.strike === 720 && o.type === 'C' ? { ...o, oi: 40, bid: 0.9, ask: 1.9, mid: 1.40 } : o) };
  const c = buildCondor(bad, cfg('30-45dte', {}, 12000), NOW);
  assert.equal(c.warnings.some(w => w.includes('open interest is thin')), true);
  assert.equal(c.warnings.some(w => w.includes('market is wide')), true);
});

ok('ticket text: mode-specific management lines', () => {
  const cm = cfg('30-45dte', {}, 12000);
  const tm = condorTicketText(buildCondor(CHAIN_M, cm, NOW), cm);
  for (const s of ['36 DTE', 'TAKE PROFIT', '2.20', 'TIME EXIT', '2026-07-31', 'HARD STOP', '13.20', 'Breakevens']) {
    assert.ok(tm.includes(s), `missing "${s}" in managed ticket`);
  }
  const c1 = cfg('1dte');
  const t1 = condorTicketText(buildCondor(CHAIN_1DTE, c1, NOW), c1);
  for (const s of ['1 DTE', 'STOPS (per side)', '0.80', '0.76', '696 CALL', '659 PUT']) {
    assert.ok(t1.includes(s), `missing "${s}" in 1dte ticket`);
  }
});

console.log(`${passed} passed`);
