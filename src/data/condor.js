// =============================================================================
// Iron Condor engine — chain fetch + mechanical leg selection.
//
// Two DTE modes, each a complete rulebook:
//   '30-45dte' (DEFAULT) — the classic managed condor (daystoexpiry.com
//        playbook): enter ~35-40 DTE, 0.15-0.20Δ shorts, wide wings, take
//        profit at 50% of credit, exit at 21 DTE, stop at 2× credit loss.
//        Managed win rate historically ~78-82%.
//   '1dte' — the weekly source strategy (Sharique's "1%" system): enter the
//        morning before expiry, 0.06-0.12Δ shorts, hold to expiry, per-SIDE
//        stop at 3× that side's credit. ≈ +1% win weeks / −1% stop weeks.
//
// Data source: CBOE's public delayed-quotes JSON (no API key, CORS-enabled,
// ~15-min delayed). Index symbols are prefixed with "_" (_XSP, _SPX); equities
// are plain (SPY). Strikes chosen by delta barely move in 15 minutes; the user
// confirms the final credit at the broker.
//
// Selection logic is pure and DOM-free so tests/condor.mjs runs it in Node.
// =============================================================================

export const UNDERLYINGS = {
  SPY: {
    key: 'SPY', cboe: 'SPY', roots: ['SPY'], label: 'SPY · ETF (most liquid, default)',
    style: 'american', note: 'Deepest option market on earth; penny-wide spreads. American-style — never hold short legs into expiry; the managed rules exit by 21 DTE anyway.',
  },
  XSP: {
    key: 'XSP', cboe: '_XSP', roots: ['XSP'], label: 'XSP · Mini-SPX (cash-settled)',
    style: 'european', note: 'Cash-settled, European — no assignment risk, 60/40 tax treatment. Slightly wider markets than SPY.',
  },
  SPX: {
    key: 'SPX', cboe: '_SPX', roots: ['SPXW', 'SPX'], label: 'SPX · full-size (cash-settled)',
    style: 'european', note: 'Cash-settled, European, 60/40 tax — 10× XSP size; best fee economics for large accounts.',
  },
};

// Per-mode rule parameters. Each mode is a self-contained playbook; switching
// modes in the UI swaps the whole parameter set (both are saved).
export const MODE_DEFAULTS = {
  '30-45dte': {
    targetDte: 40, dteMin: 30, dteMax: 45,
    deltaMin: 0.12, deltaMax: 0.18,   // target ~0.15Δ shorts → est. POP ≈ 70-75%
    wingPct: 0.75,                    // % of spot beyond the short strike (≈ $5 on SPY)
    minCreditWidthPct: 20,            // total credit floor as % of wing width (≈ $1.00 on $5 wings)
    profitTargetPct: 50,              // close all legs at 50% of max profit (standing GTC order)
    timeExitDte: 21,                  // or close/roll at 21 DTE, whichever first
    lossMult: 2,                      // hard exit when total loss = 2× total credit
    riskPct: 5,                       // sizing: defined risk per trade ≤ this % of capital
    minVix: 13,                       // warn when VIX below this — premium too thin to sell
  },
  '1dte': {
    cadence: 'thu-fri',               // 'thu-fri' | 'any-day' | 'twice-weekly'
    deltaMin: 0.06, deltaMax: 0.12,
    wingPct: 0.65,
    minCreditPct: 0.025,
    stopMult: 3,                      // per-side stop: loss = 3× that side's credit
  },
};

export const MODE_INFO = {
  '30-45dte': {
    label: '30–45 DTE · managed (enter ~40 DTE)',
    pros: 'What successful systematic condor traders run: ~0.15Δ shorts (est. POP 70–75%), managed win rate ~78–82%, slow gamma — mistakes are survivable and adjustments have time to work. Check once a day, not once an hour. Best mode to learn on.',
    cons: 'Capital is committed for 2–4 weeks per cycle, weeks of overnight/event exposure (CPI, NFP, often FOMC land inside the window — normal for this style, the management rules handle it), and annualized return per dollar is lower than faster cycles.',
  },
  '1dte': {
    label: '1 DTE · weekly (the source "1%" strategy)',
    pros: 'Fastest theta capture, in-and-out weekly (≈ +1% win weeks / −1% stop weeks), no multi-week exposure, small capital per condor.',
    cons: 'High gamma — moves near your strike hurt fast and stops MUST be honored instantly; overnight gap through the stop is uncapped down to the wings; requires a disciplined fixed morning routine.',
  },
};

export const DEFAULT_CONDOR_CONFIG = {
  underlying: 'SPY',
  mode: '30-45dte',
  capital: 10000,
  modes: JSON.parse(JSON.stringify(MODE_DEFAULTS)),
};

export function activeParams(cfg) {
  const base = MODE_DEFAULTS[cfg.mode] || MODE_DEFAULTS['30-45dte'];
  return { ...base, ...(cfg.modes?.[cfg.mode] || {}) };
}

// ---------------------------------------------------------------------------
// Chain fetch + parse
// ---------------------------------------------------------------------------

// OCC option symbol, spaces stripped: ROOT + YYMMDD + C/P + strike*1000 (8 digits)
const OCC_RE = /^([A-Z]+?)(\d{6})([CP])(\d{8})$/;

export function parseOccSymbol(sym) {
  const m = OCC_RE.exec(String(sym || '').replace(/\s+/g, ''));
  if (!m) return null;
  const [, root, ymd, cp, strikeRaw] = m;
  return {
    root,
    expiry: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`,
    type: cp,
    strike: Number(strikeRaw) / 1000,
  };
}

function normalizeRow(row) {
  const id = parseOccSymbol(row.option);
  if (!id) return null;
  const bid = Number(row.bid);
  const ask = Number(row.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= 0) return null;
  const mid = bid > 0 ? (bid + ask) / 2 : Number(row.last_trade_price) || ask / 2;
  return {
    ...id,
    bid, ask,
    mid: Math.round(mid * 100) / 100,
    delta: Number.isFinite(Number(row.delta)) ? Number(row.delta) : null,
    iv: Number(row.iv) || null,
    oi: Number(row.open_interest) || 0,
    volume: Number(row.volume) || 0,
  };
}

export function parseCboeChain(json, underlyingKey) {
  const u = UNDERLYINGS[underlyingKey];
  const d = json?.data || {};
  const spot = [d.current_price, d.close, d.last, d.price]
    .map(Number).find(Number.isFinite);
  if (!Number.isFinite(spot)) throw new Error('CBOE payload missing spot price');
  const rows = Array.isArray(d.options) ? d.options : [];
  const options = [];
  for (const row of rows) {
    const o = normalizeRow(row);
    if (o && u.roots.includes(o.root)) options.push(o);
  }
  if (!options.length) throw new Error('CBOE payload contained no usable options');
  return { spot, options, asOf: json?.timestamp || null };
}

// CBOE's CDN blocks many networks (Akamai bot protection) and does not always
// send CORS headers, so every CBOE call supports a public read-proxy fallback.
const CORS_PROXY = url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;

async function fetchJson(url, fetchImpl, viaProxy = false) {
  const res = await fetchImpl(viaProxy ? CORS_PROXY(url) : url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchCboeChain(underlyingKey, fetchImpl = globalThis.fetch, viaProxy = false) {
  const u = UNDERLYINGS[underlyingKey];
  if (!u) throw new Error(`Unknown underlying ${underlyingKey}`);
  const json = await fetchJson(`https://cdn.cboe.com/api/global/delayed_quotes/options/${u.cboe}.json`, fetchImpl, viaProxy);
  const chain = parseCboeChain(json, underlyingKey);
  chain.source = viaProxy ? 'cboe-proxy' : 'cboe';
  return chain;
}

// VIX spot from the CBOE feed (with the same proxy fallback). Informational
// only — callers should treat null (both attempts failed) as "unknown".
export async function fetchVixSpot(fetchImpl = globalThis.fetch) {
  const url = 'https://cdn.cboe.com/api/global/delayed_quotes/options/_VIX.json';
  let json;
  try { json = await fetchJson(url, fetchImpl); }
  catch { json = await fetchJson(url, fetchImpl, true); }
  const v = [json?.data?.current_price, json?.data?.close].map(Number).find(Number.isFinite);
  if (!Number.isFinite(v)) throw new Error('CBOE VIX payload missing price');
  return v;
}

// ---------------------------------------------------------------------------
// Alpaca option-chain source (SPY only — Alpaca has no index options).
// Uses the user's existing Alpaca keys (Automation tab); the market-data API
// accepts the same key pair, serves a free real-time *indicative* options feed
// including greeks, and sends CORS headers — far more reliable in-browser
// than CBOE's CDN.
// ---------------------------------------------------------------------------

const ALPACA_DATA = 'https://data.alpaca.markets';

export async function fetchAlpacaChain(underlyingKey, creds, cfg, fetchImpl = globalThis.fetch, todayISO = etNow().iso) {
  if (underlyingKey !== 'SPY') throw new Error('Alpaca source supports SPY only');
  if (!creds?.apiKey || !creds?.apiSecret) throw new Error('No Alpaca keys configured');
  const headers = {
    'APCA-API-KEY-ID': creds.apiKey,
    'APCA-API-SECRET-KEY': creds.apiSecret,
    Accept: 'application/json',
  };
  const get = async (url) => {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`Alpaca ${res.status}`);
    return res.json();
  };

  // Spot from the free IEX feed.
  const trade = await get(`${ALPACA_DATA}/v2/stocks/SPY/trades/latest?feed=iex`);
  const spot = Number(trade?.trade?.p);
  if (!Number.isFinite(spot)) throw new Error('Alpaca spot price unavailable');

  // Snapshot window sized to the active mode so we never page the whole chain.
  const p = activeParams(cfg);
  const [gte, lte] = cfg.mode === '30-45dte'
    ? [addDays(todayISO, Math.max(1, (p.dteMin ?? 30) - 2)), addDays(todayISO, (p.dteMax ?? 45) + 2)]
    : [addDays(todayISO, 1), addDays(todayISO, 8)];

  const options = [];
  let pageToken = null;
  for (let page = 0; page < 6; page++) {
    const q = new URLSearchParams({
      feed: 'indicative', limit: '1000',
      expiration_date_gte: gte, expiration_date_lte: lte,
    });
    if (pageToken) q.set('page_token', pageToken);
    const j = await get(`${ALPACA_DATA}/v1beta1/options/snapshots/SPY?${q}`);
    const snaps = j?.snapshots || {};
    for (const [sym, s] of Object.entries(snaps)) {
      const id = parseOccSymbol(sym);
      if (!id) continue;
      const quote = s.latestQuote || s.latest_quote || {};
      const bid = Number(quote.bp), ask = Number(quote.ap);
      if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask <= 0) continue;
      const delta = Number(s.greeks?.delta);
      options.push({
        ...id,
        bid, ask,
        mid: Math.round((bid > 0 ? (bid + ask) / 2 : ask / 2) * 100) / 100,
        delta: Number.isFinite(delta) ? delta : null,
        iv: Number(s.impliedVolatility ?? s.implied_volatility) || null,
        oi: null,                                   // snapshots don't carry OI
        volume: Number(s.dailyBar?.v ?? s.daily_bar?.v) || 0,
      });
    }
    pageToken = j?.next_page_token || null;
    if (!pageToken) break;
  }
  if (!options.length) throw new Error('Alpaca returned no option snapshots in the DTE window');
  return { spot, options, asOf: null, source: 'alpaca' };
}

// Source orchestration: Alpaca (if keys + SPY) → CBOE direct → CBOE via proxy.
// Throws with a per-source breakdown only when everything failed.
export async function fetchChainSmart(cfg, creds, fetchImpl = globalThis.fetch) {
  const failures = [];
  if (cfg.underlying === 'SPY' && creds?.apiKey && creds?.apiSecret) {
    try { return await fetchAlpacaChain(cfg.underlying, creds, cfg, fetchImpl); }
    catch (e) { failures.push(`Alpaca: ${e.message}`); }
  }
  try { return await fetchCboeChain(cfg.underlying, fetchImpl); }
  catch (e) { failures.push(`CBOE direct: ${e.message || 'blocked (CORS)'}`); }
  try { return await fetchCboeChain(cfg.underlying, fetchImpl, true); }
  catch (e) { failures.push(`CBOE via proxy: ${e.message}`); }
  throw new Error(`All chain sources failed — ${failures.join(' · ')}`);
}

export const CHAIN_SOURCE_LABEL = {
  alpaca: 'Alpaca (real-time indicative feed)',
  cboe: 'CBOE (≈15-min delayed)',
  'cboe-proxy': 'CBOE via proxy (≈15-min delayed)',
};

// ---------------------------------------------------------------------------
// Dates (US-Eastern; a pre-market check from any timezone must agree with NY)
// ---------------------------------------------------------------------------

export function etNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return {
    iso: `${p.year}-${p.month}-${p.day}`,
    weekday: p.weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function weekdayOfISO(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short' });
}

export function daysBetween(fromISO, toISO) {
  return Math.round((new Date(`${toISO}T12:00:00Z`) - new Date(`${fromISO}T12:00:00Z`)) / 86400000);
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isFirstFriday(iso) {
  return weekdayOfISO(iso) === 'Fri' && Number(iso.slice(8, 10)) <= 7;
}

// Choose the target expiry from the chain's listed expiries.
//   30-45dte → DTE closest to targetDte inside [dteMin, dteMax]
//              (fallback: closest DTE overall, flagged by the caller via dte)
//   1dte     → by cadence: thu-fri = next Friday; any-day = next expiry;
//              twice-weekly = next Tue or Fri
export function pickExpiry(expiries, cfg, todayISO) {
  const future = [...new Set(expiries)].sort().filter(e => e > todayISO);
  if (!future.length) return null;
  if (cfg.mode === '30-45dte') {
    const p = activeParams(cfg);
    const scored = future.map(e => ({ e, dte: daysBetween(todayISO, e) }));
    const inRange = scored.filter(x => x.dte >= p.dteMin && x.dte <= p.dteMax);
    const pool = inRange.length ? inRange : scored;
    return pool.sort((a, b) => Math.abs(a.dte - p.targetDte) - Math.abs(b.dte - p.targetDte))[0].e;
  }
  const cad = activeParams(cfg).cadence || 'thu-fri';
  if (cad === 'any-day') return future[0];
  const wanted = cad === 'twice-weekly' ? ['Tue', 'Fri'] : ['Fri'];
  return future.find(e => wanted.includes(weekdayOfISO(e))) || future[0];
}

// ---------------------------------------------------------------------------
// Leg selection
// ---------------------------------------------------------------------------

const r2 = x => Math.round(x * 100) / 100;

// Short strike: |delta| inside the band, closest to the band midpoint
// (ties → further OTM). Fallback without greeks: premium-target — the band
// midpoint delta's typical premium expressed as % of spot per mode.
function pickShort(cands, spot, p, side, premTargetPct) {
  const otm = cands.filter(o => (side === 'C' ? o.strike > spot : o.strike < spot));
  const withDelta = otm.filter(o => o.delta !== null && Math.abs(o.delta) > 0.005);
  const target = (p.deltaMin + p.deltaMax) / 2;
  const inBand = withDelta.filter(o => {
    const d = Math.abs(o.delta);
    return d >= p.deltaMin && d <= p.deltaMax;
  });
  if (inBand.length) {
    return inBand.sort((a, b) => {
      const da = Math.abs(Math.abs(a.delta) - target);
      const db = Math.abs(Math.abs(b.delta) - target);
      if (da !== db) return da - db;
      return side === 'C' ? b.strike - a.strike : a.strike - b.strike;
    })[0];
  }
  const premTarget = spot * premTargetPct / 100;
  const usable = (withDelta.length ? withDelta : otm).filter(o => o.mid > 0);
  if (!usable.length) return null;
  return usable.sort((a, b) => Math.abs(a.mid - premTarget) - Math.abs(b.mid - premTarget))[0];
}

// Wing = nearest listed strike at least wingPct-of-spot beyond the short.
function pickWing(cands, shortStrike, spot, p, side) {
  const dist = spot * (p.wingPct / 100);
  const beyond = cands.filter(o => (side === 'C'
    ? o.strike >= shortStrike + dist
    : o.strike <= shortStrike - dist));
  if (beyond.length) {
    return beyond.sort((a, b) => (side === 'C' ? a.strike - b.strike : b.strike - a.strike))[0];
  }
  const any = cands.filter(o => (side === 'C' ? o.strike > shortStrike : o.strike < shortStrike));
  if (!any.length) return null;
  return any.sort((a, b) => (side === 'C' ? b.strike - a.strike : a.strike - b.strike))[0];
}

function buildSide(options, spot, expiry, cfg, side) {
  const p = activeParams(cfg);
  const premTargetPct = cfg.mode === '30-45dte' ? 0.5 : 0.04; // fallback only
  const cands = options.filter(o => o.expiry === expiry && o.type === side);
  const short = pickShort(cands, spot, p, side, premTargetPct);
  if (!short) return null;
  const wing = pickWing(cands, short.strike, spot, p, side);
  if (!wing) return null;
  const credit = r2(short.mid - wing.mid);              // mid-based (target fill)
  const naturalCredit = r2(short.bid - wing.ask);       // worst-case immediate fill
  return {
    side,
    sell: short,
    buy: wing,
    width: r2(Math.abs(wing.strike - short.strike)),
    credit,
    naturalCredit,
    creditPct: r2(credit / spot * 10000) / 100,
    // 1-DTE mode manages per side; stopMark only meaningful there.
    stopMark: cfg.mode === '1dte' ? r2(credit * (1 + p.stopMult)) : null,
  };
}

// Liquidity screen a trader would do by eye: thin OI or wide markets on a leg.
// (oi === null means the source doesn't report OI — skip that check.)
function liquidityWarnings(legs) {
  const out = [];
  for (const [name, o] of legs) {
    if (o.oi !== null && o.oi < 100) out.push(`${name} (${o.strike}${o.type}) open interest is thin (${o.oi}) — expect worse fills; consider one strike over.`);
    const spread = r2(o.ask - o.bid);
    if (o.mid >= 0.10 && spread / o.mid > 0.4) {
      out.push(`${name} (${o.strike}${o.type}) market is wide (${o.bid.toFixed(2)}/${o.ask.toFixed(2)}) — work the order at mid, never take the natural price.`);
    }
  }
  return out;
}

// Main entry: chain (+config) → the trade card model.
// extras: { vix } — optional context the view fetched alongside the chain.
export function buildCondor(chain, cfg, now = new Date(), extras = {}) {
  const p = activeParams(cfg);
  const t = etNow(now);
  const expiries = chain.options.map(o => o.expiry);
  const expiry = pickExpiry(expiries, cfg, t.iso);
  if (!expiry) throw new Error('No future expiry found in chain');
  const dte = daysBetween(t.iso, expiry);

  const call = buildSide(chain.options, chain.spot, expiry, cfg, 'C');
  const put  = buildSide(chain.options, chain.spot, expiry, cfg, 'P');
  if (!call || !put) throw new Error('Could not find quotable strikes for both sides');

  const totalCredit = r2(call.credit + put.credit);
  const naturalCredit = r2(call.naturalCredit + put.naturalCredit);
  const maxWidth = Math.max(call.width, put.width);
  const creditOfWidthPct = maxWidth > 0 ? Math.round(totalCredit / maxWidth * 100) : 0;

  const warnings = [];
  let contracts, allocPerCondor = null, sizedByCapital;
  if (cfg.mode === '1dte') {
    // Source-strategy sizing: total credit ≈ 1% of the allocation per condor.
    allocPerCondor = Math.round(totalCredit * 100 * 100);
    sizedByCapital = allocPerCondor > 0 ? Math.floor(cfg.capital / allocPerCondor) : 0;
    if (sizedByCapital === 0) {
      warnings.push(`Capital ($${cfg.capital.toLocaleString()}) is below one condor's allocation ($${(allocPerCondor || 0).toLocaleString()}). Quoting 1 contract, but weekly swings will exceed ±1% of your capital.`);
    }
  } else {
    // Managed-condor sizing: defined risk per trade ≤ riskPct% of capital.
    const riskPer = (maxWidth - totalCredit) * 100;
    sizedByCapital = riskPer > 0 ? Math.floor((cfg.capital * (p.riskPct / 100)) / riskPer) : 0;
    if (sizedByCapital === 0) {
      warnings.push(`One condor's defined risk ($${Math.round(riskPer).toLocaleString()}) exceeds ${p.riskPct}% of your capital ($${Math.round(cfg.capital * p.riskPct / 100).toLocaleString()}). Quoting 1 contract — understand you're over the sizing rule, or use narrower wings.`);
    }
  }
  contracts = Math.max(1, sizedByCapital);

  if (cfg.mode === '30-45dte') {
    // Managed mode thinks in credit-vs-width (the blueprint's $1.00+ on $5 wings ≈ 20%).
    if (creditOfWidthPct < p.minCreditWidthPct) {
      warnings.push(`SKIP RULE: total credit is ${creditOfWidthPct}% of wing width — below the ${p.minCreditWidthPct}% floor `
        + `(≈ $${(maxWidth * p.minCreditWidthPct / 100 * 100).toFixed(0)} per condor). Premium is too thin to pay for the risk — `
        + 'wait for higher IV rather than moving strikes closer.');
    }
    if (Number.isFinite(extras.vix) && extras.vix < p.minVix) {
      warnings.push(`VIX is ${extras.vix.toFixed(1)} — below your ${p.minVix} floor. Premium sellers get paid for volatility; `
        + 'with IV this low the blueprint says wait for a pullback or pre-event IV bump instead of forcing an entry.');
    }
  } else {
    const minCredit = r2(chain.spot * p.minCreditPct / 100);
    if (call.credit < minCredit || put.credit < minCredit) {
      warnings.push(`SKIP RULE: a side's net credit is below the floor of ${minCredit.toFixed(2)} `
        + `(${p.minCreditPct}% of spot). Premium is too thin to pay for the risk — do NOT move strikes closer to force it.`);
    }
  }
  const big = Math.max(call.credit, put.credit), small = Math.min(call.credit, put.credit);
  if (big > 0 && (big - small) / big > 0.25) {
    warnings.push('Sides are imbalanced (>25% credit difference) — acceptable, but the richer side carries the market\'s feared direction.');
  }
  if (cfg.mode === '1dte' && isFirstFriday(expiry)) {
    warnings.push('Expiry is the first Friday of the month — likely NFP at 8:30 AM ET that day. Base rule: skip, or use the Mon→Tue cycle this week.');
  }
  if (cfg.mode === '30-45dte' && (dte < p.dteMin || dte > p.dteMax)) {
    warnings.push(`No listed expiry inside ${p.dteMin}–${p.dteMax} DTE — using the closest (${dte} DTE). Fine occasionally; don't drift below ~${p.dteMin} DTE at entry.`);
  }
  warnings.push(...liquidityWarnings([
    ['Short call', call.sell], ['Call wing', call.buy],
    ['Short put', put.sell], ['Put wing', put.buy],
  ]));

  const entryDayOK = (() => {
    if (cfg.mode !== '1dte') return true;             // managed mode: any day works
    const cad = p.cadence || 'thu-fri';
    if (cad === 'any-day') return true;
    return cad === 'thu-fri' ? t.weekday === 'Thu' : (t.weekday === 'Mon' || t.weekday === 'Thu');
  })();

  // Estimated probability the index finishes between the short strikes at
  // expiry ≈ 1 − (short call Δ + |short put Δ|). ~0.15Δ shorts → ~70-75%.
  const popPct = (call.sell.delta !== null && put.sell.delta !== null)
    ? Math.round((1 - (Math.abs(call.sell.delta) + Math.abs(put.sell.delta))) * 100)
    : null;

  const c = {
    mode: cfg.mode,
    underlying: cfg.underlying,
    spot: chain.spot,
    asOf: chain.asOf,
    vix: Number.isFinite(extras.vix) ? extras.vix : null,
    popPct,
    expiry,
    expiryWeekday: weekdayOfISO(expiry),
    dte,
    call, put,
    totalCredit,
    naturalCredit,
    totalCreditPct: r2(totalCredit / chain.spot * 10000) / 100,
    creditOfWidthPct,
    maxWidth,
    breakevenUp: r2(call.sell.strike + totalCredit),
    breakevenDown: r2(put.sell.strike - totalCredit),
    contracts,
    sizedByCapital,
    allocPerCondor,
    maxProfitUsd: Math.round(totalCredit * 100 * contracts),
    definedRiskUsd: Math.round((maxWidth - totalCredit) * 100 * contracts),
    warnings,
    entryDayOK,
    etToday: t,
  };
  if (cfg.mode === '30-45dte') {
    c.profitTargetMark = r2(totalCredit * (1 - p.profitTargetPct / 100)); // buy back at ≤ this
    c.lossMark = r2(totalCredit * (1 + p.lossMult));                      // hard exit at ≥ this
    c.plannedLossUsd = Math.round(totalCredit * p.lossMult * 100 * contracts);
    c.timeExitDate = addDays(expiry, -p.timeExitDte);
    c.profitTargetUsd = Math.round(totalCredit * (p.profitTargetPct / 100) * 100 * contracts);
  } else {
    c.stopLossUsd = Math.round((call.credit * p.stopMult) * 100 * contracts);
  }
  return c;
}

// Plain-text order ticket — pasteable, and what the Telegram button sends.
export function condorTicketText(c, cfg) {
  const p = activeParams(cfg);
  const u = UNDERLYINGS[c.underlying];
  const L = (act, o) => `${act}  ${c.contracts}x ${c.underlying} ${c.expiry.slice(5)} ${o.strike} ${o.type === 'C' ? 'CALL' : 'PUT'}  @ ~${o.mid.toFixed(2)} mid`;
  const lines = [
    `IRON CONDOR — ${c.underlying} exp ${c.expiry} (${c.expiryWeekday}, ${c.dte} DTE) · spot ${c.spot.toFixed(2)}`,
    L('SELL to open', c.call.sell),
    L('BUY  to open', c.call.buy),
    L('SELL to open', c.put.sell),
    L('BUY  to open', c.put.buy),
    `Net credit: limit ≈ ${c.totalCredit.toFixed(2)} mid (natural ${c.naturalCredit.toFixed(2)}) — start at mid, accept ≥ ${(Math.max(c.naturalCredit, c.totalCredit * 0.9)).toFixed(2)}`,
    `Breakevens at expiry: ${c.breakevenDown.toFixed(2)} / ${c.breakevenUp.toFixed(2)} · credit = ${c.creditOfWidthPct}% of wing width`,
  ];
  if (c.mode === '30-45dte') {
    lines.push(
      `TAKE PROFIT: buy back all 4 legs when condor mark ≤ ${c.profitTargetMark.toFixed(2)}  [${p.profitTargetPct}% of credit ≈ +$${c.profitTargetUsd}] — place this GTC order right after the fill`,
      `TIME EXIT: if target not hit, close by ${c.timeExitDate}  [${p.timeExitDte} DTE]`,
      `DEFEND (optional): if a SHORT strike's delta reaches ~0.30, roll the UNTESTED side — buy its spread back cheap and re-sell at the new ~0.15Δ for extra credit`,
      `HARD STOP: close everything if condor mark ≥ ${c.lossMark.toFixed(2)}  [loss = ${p.lossMult}× credit ≈ −$${c.plannedLossUsd}]`,
    );
    if (c.popPct !== null) lines.splice(1, 0, `Est. probability of profit ≈ ${c.popPct}%${c.vix !== null ? ` · VIX ${c.vix.toFixed(1)}` : ''}`);
  } else {
    lines.push(
      `STOPS (per side): close CALL side if its spread mark ≥ ${c.call.stopMark.toFixed(2)}; PUT side if ≥ ${c.put.stopMark.toFixed(2)}  [${1 + p.stopMult}× credit]`,
    );
  }
  lines.push(`Max profit ≈ $${c.maxProfitUsd} · defined risk ≈ $${c.definedRiskUsd} · ${c.contracts} contract(s)`);
  lines.push(u.style === 'american'
    ? '⚠ SPY: American-style — close ALL legs before expiry day\'s close; never let them expire.'
    : (c.mode === '1dte'
        ? 'Cash-settled: if both shorts are safely OTM at 3:30 PM ET expiry day, let them expire.'
        : 'Cash-settled — but in this mode you exit by the profit target / 21-DTE rule, not at expiry.'));
  return lines.join('\n');
}
