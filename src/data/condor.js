// =============================================================================
// Iron Condor engine — chain fetch + mechanical leg selection.
//
// Data source: CBOE's public delayed-quotes JSON (no API key, CORS-enabled,
// ~15-min delayed). Index symbols are prefixed with "_" (_XSP, _SPX); equities
// are plain (SPY). Delay caveat: short strikes chosen by delta barely move in
// 15 minutes; the user confirms the final credit at their broker anyway.
//
// The selection logic is pure and DOM-free so tests/condor.mjs can exercise it
// in Node with a synthetic chain.
// =============================================================================

export const UNDERLYINGS = {
  XSP: {
    key: 'XSP', cboe: '_XSP', roots: ['XSP'], label: 'XSP · Mini-SPX (cash-settled)',
    style: 'european', note: 'Cash-settled, European — no assignment risk; OK to let expire OTM.',
  },
  SPX: {
    key: 'SPX', cboe: '_SPX', roots: ['SPXW', 'SPX'], label: 'SPX · full-size (cash-settled)',
    style: 'european', note: 'Cash-settled, European — no assignment risk; OK to let expire OTM.',
  },
  SPY: {
    key: 'SPY', cboe: 'SPY', roots: ['SPY'], label: 'SPY · ETF (American style)',
    style: 'american', note: 'American-style with assignment risk — ALWAYS close all legs by 3:30 PM ET on expiry day.',
  },
};

// Base rules from the source strategy, translated to % of spot (see the Condor
// Guide tab for the full derivation from the Nifty original).
export const DEFAULT_CONDOR_CONFIG = {
  underlying: 'XSP',
  cadence: 'thu-fri',      // 'thu-fri' | 'any-day' | 'twice-weekly'
  deltaMin: 0.06,          // short-strike |delta| band (≈ "level it won't reach")
  deltaMax: 0.12,
  wingPct: 0.65,           // wing distance beyond the short strike, % of spot
  minCreditPct: 0.025,     // per-side net credit floor, % of spot (else SKIP week)
  stopMult: 3,             // close a side when its loss = stopMult × its credit
  capital: 4000,           // account capital used for sizing ($)
};

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

// Normalize one CBOE option row → engine shape (null when unusable).
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

export async function fetchCboeChain(underlyingKey, fetchImpl = globalThis.fetch) {
  const u = UNDERLYINGS[underlyingKey];
  if (!u) throw new Error(`Unknown underlying ${underlyingKey}`);
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${u.cboe}.json`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`CBOE chain fetch failed: ${res.status}`);
  const json = await res.json();
  return parseCboeChain(json, underlyingKey);
}

// ---------------------------------------------------------------------------
// Dates (all reasoning in US-Eastern so a pre-market check from any timezone
// picks the same expiry the floor sees)
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
    weekday: p.weekday,                       // 'Mon' … 'Sun'
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

function weekdayOfISO(iso) {
  // Noon UTC avoids TZ date-shift; weekday of a calendar date is TZ-free.
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short' });
}

export function isFirstFriday(iso) {
  return weekdayOfISO(iso) === 'Fri' && Number(iso.slice(8, 10)) <= 7;
}

// Choose the target expiry from the chain's actual listed expiries.
//   thu-fri       → the next Friday-dated expiry after today
//   any-day       → the first listed expiry after today (≈ tomorrow, 1 DTE)
//   twice-weekly  → the next Tue- or Fri-dated expiry after today
export function pickExpiry(expiries, cadence, todayISO) {
  const future = [...new Set(expiries)].sort().filter(e => e > todayISO);
  if (!future.length) return null;
  if (cadence === 'any-day') return future[0];
  const wanted = cadence === 'twice-weekly' ? ['Tue', 'Fri'] : ['Fri'];
  return future.find(e => wanted.includes(weekdayOfISO(e))) || future[0];
}

// ---------------------------------------------------------------------------
// Leg selection
// ---------------------------------------------------------------------------

const r2 = x => Math.round(x * 100) / 100;

// Pick the short strike for one side: |delta| inside [deltaMin, deltaMax],
// closest to the band midpoint (ties → further OTM). Fallback when the feed
// has no greeks: premium closest to 0.04% of spot among OTM strikes.
function pickShort(cands, spot, cfg, side) {
  const otm = cands.filter(o => (side === 'C' ? o.strike > spot : o.strike < spot));
  const withDelta = otm.filter(o => o.delta !== null && Math.abs(o.delta) > 0.005);
  const target = (cfg.deltaMin + cfg.deltaMax) / 2;
  const inBand = withDelta.filter(o => {
    const d = Math.abs(o.delta);
    return d >= cfg.deltaMin && d <= cfg.deltaMax;
  });
  if (inBand.length) {
    return inBand.sort((a, b) => {
      const da = Math.abs(Math.abs(a.delta) - target);
      const db = Math.abs(Math.abs(b.delta) - target);
      if (da !== db) return da - db;
      return side === 'C' ? b.strike - a.strike : a.strike - b.strike; // further OTM wins ties
    })[0];
  }
  // No greeks (or nothing in band): premium-target fallback.
  const premTarget = spot * 0.0004;
  const usable = (withDelta.length ? withDelta : otm).filter(o => o.mid > 0);
  if (!usable.length) return null;
  return usable.sort((a, b) => Math.abs(a.mid - premTarget) - Math.abs(b.mid - premTarget))[0];
}

// Wing = nearest listed strike at least wingPct-of-spot beyond the short.
function pickWing(cands, shortStrike, spot, cfg, side) {
  const dist = spot * (cfg.wingPct / 100);
  const beyond = cands.filter(o => (side === 'C'
    ? o.strike >= shortStrike + dist
    : o.strike <= shortStrike - dist));
  if (beyond.length) {
    return beyond.sort((a, b) => (side === 'C' ? a.strike - b.strike : b.strike - a.strike))[0];
  }
  // Grid runs out before full width — take the furthest available beyond short.
  const any = cands.filter(o => (side === 'C' ? o.strike > shortStrike : o.strike < shortStrike));
  if (!any.length) return null;
  return any.sort((a, b) => (side === 'C' ? b.strike - a.strike : a.strike - b.strike))[0];
}

function buildSide(options, spot, expiry, cfg, side) {
  const cands = options.filter(o => o.expiry === expiry && o.type === side);
  const short = pickShort(cands, spot, cfg, side);
  if (!short) return null;
  const wing = pickWing(cands, short.strike, spot, cfg, side);
  if (!wing) return null;
  // Sell at the short's mid, pay the wing's mid — the realistic combined fill.
  const credit = r2(short.mid - wing.mid);
  return {
    side,
    sell: short,
    buy: wing,
    width: r2(Math.abs(wing.strike - short.strike)),
    credit,
    creditPct: r2(credit / spot * 10000) / 100,      // % of spot, 2dp
    stopMark: r2(credit * (1 + cfg.stopMult)),        // close side if spread mark ≥ this
  };
}

// Main entry: chain (+config) → the trade card model.
export function buildCondor(chain, cfg, now = new Date()) {
  const t = etNow(now);
  const expiries = chain.options.map(o => o.expiry);
  const expiry = pickExpiry(expiries, cfg.cadence, t.iso);
  if (!expiry) throw new Error('No future expiry found in chain');

  const call = buildSide(chain.options, chain.spot, expiry, cfg, 'C');
  const put  = buildSide(chain.options, chain.spot, expiry, cfg, 'P');
  if (!call || !put) throw new Error('Could not find quotable strikes for both sides');

  const totalCredit = r2(call.credit + put.credit);
  const maxWidth = Math.max(call.width, put.width);
  // Sizing preserves the source strategy's math: total credit ≈ 1% of the
  // capital allocated to one condor → allocation = credit × 100 (shares) × 100.
  const allocPerCondor = Math.round(totalCredit * 100 * 100);
  const contracts = allocPerCondor > 0 ? Math.max(0, Math.floor(cfg.capital / allocPerCondor)) : 0;
  const qty = Math.max(1, contracts);

  const warnings = [];
  const minCredit = r2(chain.spot * cfg.minCreditPct / 100);
  if (call.credit < minCredit || put.credit < minCredit) {
    warnings.push(`SKIP-WEEK RULE: a side's net credit is below the floor of ${minCredit.toFixed(2)} `
      + `(${cfg.minCreditPct}% of spot). Volatility is too low — do NOT move strikes closer to force it.`);
  }
  const big = Math.max(call.credit, put.credit), small = Math.min(call.credit, put.credit);
  if (big > 0 && (big - small) / big > 0.25) {
    warnings.push('Sides are imbalanced (>25% credit difference) — acceptable, but the richer side carries the market\'s feared direction.');
  }
  if (isFirstFriday(expiry)) {
    warnings.push('Expiry is the first Friday of the month — likely NFP release at 8:30 AM ET that day. Base rule: skip, or use the Mon→Tue cycle this week.');
  }
  if (contracts === 0) {
    warnings.push(`Capital ($${cfg.capital.toLocaleString()}) is below one condor's allocation ($${allocPerCondor.toLocaleString()}). `
      + 'Quoting 1 contract, but weekly swings will exceed ±1% of your capital.');
  }
  const entryDayOK = (() => {
    if (cfg.cadence === 'any-day') return true;
    const wd = t.weekday;
    return cfg.cadence === 'thu-fri' ? wd === 'Thu' : (wd === 'Mon' || wd === 'Thu');
  })();

  return {
    underlying: cfg.underlying,
    spot: chain.spot,
    asOf: chain.asOf,
    expiry,
    expiryWeekday: weekdayOfISO(expiry),
    call, put,
    totalCredit,
    totalCreditPct: r2(totalCredit / chain.spot * 10000) / 100,
    maxWidth,
    contracts: qty,
    sizedByCapital: contracts,
    allocPerCondor,
    maxProfitUsd: Math.round(totalCredit * 100 * qty),
    definedRiskUsd: Math.round((maxWidth - totalCredit) * 100 * qty),
    stopLossUsd: Math.round((call.credit * cfg.stopMult) * 100 * qty), // one side stopping
    warnings,
    entryDayOK,
    etToday: t,
  };
}

// Plain-text order ticket — pasteable, and what the Telegram button sends.
export function condorTicketText(c, cfg) {
  const u = UNDERLYINGS[c.underlying];
  const exp = `${c.expiry} (${c.expiryWeekday})`;
  const L = (act, o) => `${act}  ${c.contracts}x ${c.underlying} ${c.expiry.slice(5)} ${o.strike} ${o.type === 'C' ? 'CALL' : 'PUT'}  @ ~${o.mid.toFixed(2)} mid`;
  const lines = [
    `IRON CONDOR — ${c.underlying} exp ${exp} · spot ${c.spot.toFixed(2)}`,
    L('SELL to open', c.call.sell),
    L('BUY  to open', c.call.buy),
    L('SELL to open', c.put.sell),
    L('BUY  to open', c.put.buy),
    `Net credit target ≈ ${c.totalCredit.toFixed(2)}  (call ${c.call.credit.toFixed(2)} + put ${c.put.credit.toFixed(2)}) — reject fills below ~90% of this`,
    `STOPS: close CALL side if its spread mark ≥ ${c.call.stopMark.toFixed(2)}; PUT side if ≥ ${c.put.stopMark.toFixed(2)}  [${1 + cfg.stopMult}× credit]`,
    `Max profit ≈ $${c.maxProfitUsd} · defined risk ≈ $${c.definedRiskUsd} · ${c.contracts} contract(s)`,
    u.style === 'american' ? '⚠ SPY: close ALL legs by 3:30 PM ET on expiry day — never let them expire.' : 'Cash-settled: if both shorts are safely OTM at 3:30 PM ET expiry day, let them expire.',
  ];
  return lines.join('\n');
}
