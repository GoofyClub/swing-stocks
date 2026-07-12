// Condor engine tests — synthetic chains (no network). Run: npm run test:condor
import assert from 'node:assert/strict';
import {
  parseOccSymbol, parseCboeChain, pickExpiry, isFirstFriday, daysBetween, addDays,
  buildCondor, condorTicketText, DEFAULT_CONDOR_CONFIG, MODE_DEFAULTS,
  fetchAlpacaChain, fetchChainSmart, formatExitPlan,
} from '../src/data/condor.js';
import { saveChainCache, loadChainCache, clearChainCache } from '../src/data/condorChainCache.js';

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
  // From 2026-07-16: DTEs are 1, 29, 36, 43, 64 → in [30,45]: 36 & 43 → closest to 40 = 43.
  assert.equal(pickExpiry(exps, cfg('30-45dte'), '2026-07-16'), '2026-08-28');
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

ok('30-45dte: 0.15Δ shorts (band 0.12-0.18), 0.75%-of-spot wings (≈$5 SPY-scale)', () => {
  const c = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW);
  assert.equal(c.mode, '30-45dte');
  assert.equal(c.expiry, EM);                          // only in-range expiry in this chain
  assert.equal(c.dte, 36);
  assert.equal(c.entryDayOK, true);                    // any day is fine in this mode
  assert.equal(c.call.sell.strike, 710);               // δ 0.15 = band midpoint
  assert.equal(c.call.buy.strike, 720);                // 710 + 5.1 → next listed = 720
  assert.equal(c.put.sell.strike, 650);
  assert.equal(c.put.buy.strike, 640);
  assert.equal(c.call.credit, 1.50);                   // 2.90 − 1.40
  assert.equal(c.put.credit, 1.50);                    // 3.00 − 1.50
  assert.equal(c.totalCredit, 3.00);
  assert.equal(c.call.stopMark, null);                 // no per-side stop in managed mode
  assert.equal(c.popPct, 70);                          // 1 − (0.15 + 0.15)
});

ok('30-45dte: management marks (50% TP, 21-DTE time exit, 2× loss stop) + width floor', () => {
  const c = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW);
  assert.equal(c.profitTargetMark, 1.50);              // buy back at 50% of credit
  assert.equal(c.lossMark, 9.00);                      // credit × (1 + 2)
  assert.equal(c.timeExitDate, '2026-07-31');          // expiry − 21 days
  assert.equal(c.breakevenUp, 713.00);
  assert.equal(c.breakevenDown, 647.00);
  assert.equal(c.creditOfWidthPct, 30);                // 3.0 / 10 → ≥ 20% floor, no warning
  assert.equal(c.warnings.some(w => w.includes('SKIP RULE')), false);
  // Thin premium → credit falls under 20% of width → skip warning.
  const thin = { ...CHAIN_M, options: CHAIN_M.options.map(o =>
    ({ ...o, mid: Math.round(o.mid / 3 * 100) / 100, bid: Math.round(o.bid / 3 * 100) / 100, ask: Math.round(o.ask / 3 * 100) / 100 })) };
  const ct = buildCondor(thin, cfg('30-45dte', {}, 30000), NOW);
  assert.equal(ct.warnings.some(w => w.includes('SKIP RULE') && w.includes('% of wing width')), true);
});

ok('30-45dte: risk-based sizing (defined risk ≤ riskPct% of capital, blueprint 2-5%)', () => {
  // Risk per condor = (10 − 3) × 100 = $700. 5% of 30k = $1,500 → 2 contracts.
  const c = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW);
  assert.equal(c.contracts, 2);
  assert.equal(c.maxProfitUsd, 600);
  assert.equal(c.definedRiskUsd, 1400);
  assert.equal(c.plannedLossUsd, 1200);                // 2× credit × 100 × 2
  // $10k account: 5% = $500 < $700 → quote 1 with a sizing warning.
  const small = buildCondor(CHAIN_M, cfg('30-45dte', {}, 10000), NOW);
  assert.equal(small.sizedByCapital, 0);
  assert.equal(small.contracts, 1);
  assert.equal(small.warnings.some(w => w.includes('defined risk')), true);
});

ok('30-45dte: VIX entry filter warns only below the floor', () => {
  const low = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW, { vix: 11.2 });
  assert.equal(low.vix, 11.2);
  assert.equal(low.warnings.some(w => w.includes('VIX is 11.2')), true);
  const okVix = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW, { vix: 18.4 });
  assert.equal(okVix.warnings.some(w => w.includes('VIX is')), false);
});

ok('high-VIX headline-regime warning fires in both modes at their own levels', () => {
  // Managed mode: default caution level 27.
  const panic = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW, { vix: 34.6 });
  assert.equal(panic.warnings.some(w => w.includes('headline regime') && w.includes('34.6')), true);
  const calm = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW, { vix: 22.0 });
  assert.equal(calm.warnings.some(w => w.includes('headline regime')), false);
  // 1-DTE mode is gap-sensitive: fires earlier (default 25).
  const w1 = buildCondor(CHAIN_1DTE, cfg('1dte'), NOW, { vix: 25.5 });
  assert.equal(w1.warnings.some(w => w.includes('headline regime')), true);
  const q1 = buildCondor(CHAIN_1DTE, cfg('1dte'), NOW, { vix: 20.0 });
  assert.equal(q1.warnings.some(w => w.includes('headline regime')), false);
});

ok('missing OI normalizes to null and skips the thin-OI check (Alpaca-style rows)', () => {
  const json = { data: { current_price: 680, options: [
    { option: 'SPY260821C00710000', bid: 2.85, ask: 2.95, delta: 0.15 },   // no open_interest field
  ] } };
  const chain = parseCboeChain(json, 'SPY');
  assert.equal(chain.options[0].oi, null);
  const nullOi = { ...CHAIN_M, options: CHAIN_M.options.map(o => ({ ...o, oi: null })) };
  const c = buildCondor(nullOi, cfg('30-45dte', {}, 30000), NOW);
  assert.equal(c.warnings.some(w => w.includes('open interest is thin')), false);
});

ok('weekend compute adds a PREVIEW note (quotes are Friday close)', () => {
  const SAT = new Date('2026-07-18T15:00:00Z'); // Saturday, 11:00 ET
  const c = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), SAT);
  assert.equal(c.warnings.some(w => w.includes('PREVIEW') && w.includes('Sat')), true);
  const thu = buildCondor(CHAIN_M, cfg('30-45dte', {}, 30000), NOW);
  assert.equal(thu.warnings.some(w => w.includes('PREVIEW')), false);
});

ok('liquidity warnings: thin OI and wide markets are flagged', () => {
  const bad = { ...CHAIN_M, options: CHAIN_M.options.map(o =>
    o.strike === 720 && o.type === 'C' ? { ...o, oi: 40, bid: 0.9, ask: 1.9, mid: 1.40 } : o) };
  const c = buildCondor(bad, cfg('30-45dte', {}, 12000), NOW);
  assert.equal(c.warnings.some(w => w.includes('open interest is thin')), true);
  assert.equal(c.warnings.some(w => w.includes('market is wide')), true);
});

// ---------------------------------------------------------------------------
// Chain cache (localStorage-backed; a tiny in-memory fake stands in for it —
// Node has no localStorage — via the injectable `storage` param).
function fakeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
  };
}
const SOME_CHAIN = { spot: 680, options: CHAIN_M.options, source: 'cboe', fetchedAt: '2026-07-16T14:00:00.000Z' }; // Thu 10:00 ET

ok('chain cache: save then load same ET day returns the chain + vix', () => {
  const s = fakeStorage();
  saveChainCache('SPY', '30-45dte', SOME_CHAIN, 16.2, s);
  const hit = loadChainCache('SPY', '30-45dte', new Date('2026-07-16T19:30:00.000Z'), s); // same Thu, 15:30 ET
  assert.ok(hit);
  assert.equal(hit.chain.spot, 680);
  assert.equal(hit.vix, 16.2);
});

ok('chain cache: a different ET calendar day is a miss (never silently stale)', () => {
  const s = fakeStorage();
  saveChainCache('SPY', '30-45dte', SOME_CHAIN, 16.2, s);
  const nextDay = loadChainCache('SPY', '30-45dte', new Date('2026-07-17T14:00:00.000Z'), s); // Fri
  assert.equal(nextDay, null);
});

ok('chain cache: keyed per underlying+mode — no cross-leak', () => {
  const s = fakeStorage();
  saveChainCache('SPY', '30-45dte', SOME_CHAIN, 16.2, s);
  assert.equal(loadChainCache('XSP', '30-45dte', new Date('2026-07-16T19:00:00.000Z'), s), null);
  assert.equal(loadChainCache('SPY', '1dte', new Date('2026-07-16T19:00:00.000Z'), s), null);
});

ok('chain cache: empty, corrupt, or optionless entries all miss cleanly', () => {
  const s = fakeStorage();
  assert.equal(loadChainCache('SPY', '30-45dte', NOW, s), null); // nothing saved
  s.setItem('swing.condorChain.v1.SPY.30-45dte', '{not json');
  assert.equal(loadChainCache('SPY', '30-45dte', NOW, s), null); // corrupt JSON
  saveChainCache('SPY', '30-45dte', { ...SOME_CHAIN, options: [] }, 16.2, s);
  assert.equal(loadChainCache('SPY', '30-45dte', new Date('2026-07-16T19:00:00.000Z'), s), null); // no options
});

ok('chain cache: clearChainCache removes the entry', () => {
  const s = fakeStorage();
  saveChainCache('SPY', '30-45dte', SOME_CHAIN, 16.2, s);
  clearChainCache('SPY', '30-45dte', s);
  assert.equal(loadChainCache('SPY', '30-45dte', new Date('2026-07-16T19:00:00.000Z'), s), null);
});

ok('chain cache: a null VIX (fetch failed) round-trips as null, not NaN/undefined', () => {
  const s = fakeStorage();
  saveChainCache('SPY', '30-45dte', SOME_CHAIN, null, s);
  const hit = loadChainCache('SPY', '30-45dte', new Date('2026-07-16T19:00:00.000Z'), s);
  assert.equal(hit.vix, null);
});

// formatExitPlan is what a journal row shows once a trade is logged —
// answers "when do I close this, and at what?" without recomputing anything.
ok('formatExitPlan: managed-mode row shows TP / time-exit date / hard stop', () => {
  const t = { mode: '30-45dte', exitPlan: { profitTargetMark: 1.50, timeExitDate: '2026-07-31', lossMark: 9.00 } };
  assert.equal(formatExitPlan(t), 'TP≤1.50 · by 2026-07-31 · SL≥9.00');
});

ok('formatExitPlan: 1-DTE row shows the per-side stop marks', () => {
  const t = { mode: '1dte', exitPlan: { callStopMark: 0.80, putStopMark: 0.76 } };
  assert.equal(formatExitPlan(t), 'stop C≥0.80 · P≥0.76');
});

ok('formatExitPlan: missing or malformed exit plan degrades gracefully, never throws', () => {
  assert.equal(formatExitPlan({ mode: '30-45dte' }), '—');           // no exitPlan at all
  assert.equal(formatExitPlan({}), '—');
  assert.equal(formatExitPlan(null), '—');
  assert.equal(formatExitPlan({ mode: '30-45dte', exitPlan: {} }), 'TP≤— · by — · SL≥—'); // partial data
});

ok('ticket text: mode-specific management lines', () => {
  const cm = cfg('30-45dte', {}, 30000);
  const tm = condorTicketText(buildCondor(CHAIN_M, cm, NOW, { vix: 17.3 }), cm);
  for (const s of ['36 DTE', 'TAKE PROFIT', '1.50', 'TIME EXIT', '2026-07-31', 'DEFEND', '~0.30',
                   'HARD STOP', '9.00', 'Breakevens', 'Est. probability of profit ≈ 70%', 'VIX 17.3']) {
    assert.ok(tm.includes(s), `missing "${s}" in managed ticket`);
  }
  const c1 = cfg('1dte');
  const t1 = condorTicketText(buildCondor(CHAIN_1DTE, c1, NOW), c1);
  for (const s of ['1 DTE', 'STOPS (per side)', '0.80', '0.76', '696 CALL', '659 PUT']) {
    assert.ok(t1.includes(s), `missing "${s}" in 1dte ticket`);
  }
});

// ---------------------------------------------------------------------------
// Data-source orchestration (async tests)
const jsonRes = obj => ({ ok: true, json: async () => obj });

const ALPACA_SNAPSHOT_PAGE = {
  snapshots: {
    'SPY260821C00710000': { latestQuote: { bp: 2.85, ap: 2.95 }, greeks: { delta: 0.15 }, impliedVolatility: 0.19, dailyBar: { v: 1200 } },
    'SPY260821P00650000': { latestQuote: { bp: 2.95, ap: 3.05 }, greeks: { delta: -0.15 }, impliedVolatility: 0.20 },
    'SPY260821C00990000': { latestQuote: { bp: 0, ap: 0 } },   // quote-less → dropped
  },
  next_page_token: null,
};

await (async () => {
  try {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/stocks/SPY/trades/latest')) return jsonRes({ trade: { p: 680.25 } });
      if (String(url).includes('/options/snapshots/SPY')) return jsonRes(ALPACA_SNAPSHOT_PAGE);
      throw new Error(`unexpected url ${url}`);
    };
    const chain = await fetchAlpacaChain('SPY', { apiKey: 'k', apiSecret: 's' },
      cfg('30-45dte'), fetchImpl, '2026-07-16');
    assert.equal(chain.source, 'alpaca');
    assert.equal(chain.spot, 680.25);
    assert.equal(chain.options.length, 2);            // quote-less contract dropped
    const call = chain.options.find(o => o.type === 'C');
    assert.equal(call.strike, 710);
    assert.equal(call.mid, 2.90);
    assert.equal(call.delta, 0.15);
    assert.equal(call.oi, null);                       // snapshots carry no OI
    assert.ok(calls.some(u => u.includes('expiration_date_gte=2026-08-13')), 'DTE window lower bound');
    assert.ok(calls.some(u => u.includes('expiration_date_lte=2026-09-01')), 'DTE window upper bound');
    passed++; console.log('  ✓ fetchAlpacaChain: parses snapshots, drops quote-less, windows by DTE');
  } catch (e) { console.error(`  ✗ fetchAlpacaChain\n    ${e.message}`); process.exitCode = 1; }

  try {
    // No creds → Alpaca skipped; CBOE direct fails; proxy succeeds.
    const cboeJson = { timestamp: 'x', data: { current_price: 680, options: [
      { option: 'SPY260821C00710000', bid: 2.85, ask: 2.95, delta: 0.15 },
    ] } };
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.startsWith('https://cdn.cboe.com')) throw new TypeError('Failed to fetch'); // CORS-style failure
      if (u.includes('allorigins')) return jsonRes(cboeJson);
      throw new Error(`unexpected url ${u}`);
    };
    const before = Date.now();
    const chain = await fetchChainSmart(cfg('30-45dte'), {}, fetchImpl);
    assert.equal(chain.source, 'cboe-proxy');
    assert.equal(chain.options.length, 1);
    assert.ok(chain.fetchedAt, 'fetchedAt should be stamped for caching');
    const fetchedMs = new Date(chain.fetchedAt).getTime();
    assert.ok(fetchedMs >= before && fetchedMs <= Date.now() + 1, 'fetchedAt should be ~now, not the source\'s own asOf');
    passed++; console.log('  ✓ fetchChainSmart: falls back direct→proxy, reports the source, stamps fetchedAt');
  } catch (e) { console.error(`  ✗ fetchChainSmart fallback\n    ${e.message}`); process.exitCode = 1; }

  try {
    const fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(
      () => fetchChainSmart(cfg('30-45dte'), { apiKey: 'k', apiSecret: 's' }, fetchImpl),
      /All chain sources failed.*Alpaca.*CBOE direct.*CBOE via proxy/s,
    );
    passed++; console.log('  ✓ fetchChainSmart: aggregate error names every failed source');
  } catch (e) { console.error(`  ✗ fetchChainSmart aggregate error\n    ${e.message}`); process.exitCode = 1; }
})();

console.log(`${passed} passed`);
