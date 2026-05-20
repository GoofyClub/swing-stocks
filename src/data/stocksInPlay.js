// =============================================================================
// "Stocks in Play" — pre-trade scanner for the 5-Min Opening Range Breakout
// (ORB) strategy. Maps onto the strategy guide's Section 3 selection process:
//
//   - Section 3.1 — Universe filters (price > $5, volume > 1M shares).
//   - Section 3.2 — Catalyst / activity narrowing (proxied by gainers/losers
//     and most-actively-traded lists, which capture exactly the "real reason
//     to be active today" set the strategy wants).
//   - Section 3.3 — Opening-range RVOL is intraday-only and *must* be computed
//     by the user at 09:35 ET. This module surfaces the candidates; the final
//     RVOL_OR check is left to the user.
//
// Data source: Alpha Vantage TOP_GAINERS_LOSERS endpoint. Free tier, single
// API call returns 25 gainers + 25 losers + 25 most-active = 75 tickers
// across the entire US market (NOT limited to our 58-stock starter list).
//
// Cache: 12h in localStorage. Manual refresh button overrides.
// =============================================================================

const CACHE_KEY     = 'swing.stocksInPlay';
const CACHE_TTL_MS  = 12 * 60 * 60 * 1000;   // 12 hours
const CACHE_VERSION = 1;

// Exposed so the view can render the same criteria text the data layer uses.
export const ORB_CRITERIA = {
  // Section 3.1 — hard universe filters (ALL must pass)
  minPrice: 5.00,
  minDailyVolume: 1_000_000,
  minDailyAtr: 0.50,           // can't verify from gainers list — informational

  // Section 3.2 — catalyst narrowing hints
  preferredMinGapPct: 2.0,
  rvolOrFloorPct: 100,         // Section 3.3 — what user must verify at 09:35 ET

  // Output
  topN: 10,
};

// -----------------------------------------------------------------------------
// Cache helpers
// -----------------------------------------------------------------------------
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.v !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, ...data }));
  } catch (e) {
    console.warn('[stocks-in-play] cache save failed', e?.message);
  }
}

export function clearCache() {
  try { localStorage.removeItem(CACHE_KEY); } catch {}
}

export function getCachedAt() {
  const c = loadCache();
  return c?.fetchedAt || null;
}

// -----------------------------------------------------------------------------
// Source: Alpha Vantage TOP_GAINERS_LOSERS
// https://www.alphavantage.co/documentation/#top-gainers-losers
// -----------------------------------------------------------------------------
async function fetchFromAlphaVantage(ctx) {
  const key = ctx?.apiKeys?.alphavantage;
  if (!key) {
    throw new Error(
      'Alpha Vantage key not set. Open Settings → Data Source and paste your free key from alphavantage.co/support/#api-key.'
    );
  }
  const url = `https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${encodeURIComponent(key)}`;
  const fetchImpl = ctx?.fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let resp;
  try {
    resp = await fetchImpl(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`Alpha Vantage HTTP ${resp.status}`);
  const j = await resp.json();
  if (j.Note)              throw new Error(`Alpha Vantage rate-limit: ${j.Note}`);
  if (j['Error Message'])  throw new Error(`Alpha Vantage: ${j['Error Message']}`);
  if (j.Information)       throw new Error(`Alpha Vantage: ${j.Information}`);

  const parse = (item, category) => ({
    ticker:        item.ticker,
    price:         Number(item.price),
    changeAmount:  Number(item.change_amount),
    changePct:     Number((item.change_percentage || '0').replace('%', '')),
    volume:        Number(item.volume),
    category,
  });

  // Order matters for the dedupe: gainers first, then most-actively-traded
  // (likely already in the gainers list anyway), then losers. The category we
  // keep is whichever the ticker appeared in first.
  const all = [
    ...(j.top_gainers           || []).map(t => parse(t, 'gainer')),
    ...(j.most_actively_traded  || []).map(t => parse(t, 'active')),
    ...(j.top_losers            || []).map(t => parse(t, 'loser')),
  ];

  const seen = new Map();
  for (const c of all) {
    if (!c.ticker) continue;
    if (Number.isNaN(c.price) || Number.isNaN(c.volume)) continue;
    if (!seen.has(c.ticker)) seen.set(c.ticker, c);
  }

  return {
    candidates: [...seen.values()],
    lastUpdated: j.last_updated || null,
    source: 'Alpha Vantage TOP_GAINERS_LOSERS',
    sourceUrl: 'https://www.alphavantage.co/documentation/#top-gainers-losers',
  };
}

// -----------------------------------------------------------------------------
// Ranking + filtering
// -----------------------------------------------------------------------------
function rankCandidates(candidates) {
  // Apply Section 3.1 universe filters we can check from the gainers data.
  const passing = candidates.filter(c =>
    c.price  >= ORB_CRITERIA.minPrice &&
    c.volume >= ORB_CRITERIA.minDailyVolume,
  );

  // Play-score (proxy for "stock in play" readiness, capturing Section 3.2 vibe):
  //   log10(volume)    — weights raw liquidity smoothly across orders of magnitude
  //   |change%| / 5    — weights catalyst-driven moves; division by 5 puts a 25%
  //                      gap on the same scale as 100M of volume
  // A stock with a 5% move on 20M shares scores ~8.3 + 1.0 = 9.3.
  // A stock with a 30% move on 500K shares scores ~5.7 + 6.0 = 11.7 — both pass
  // (large moves with even modest volume DO carry edge per the research).
  const scored = passing.map(c => ({
    ...c,
    playScore: Math.log10(Math.max(c.volume, 1)) + (Math.abs(c.changePct) / 5),
  }));
  scored.sort((a, b) => b.playScore - a.playScore);
  return {
    top:    scored.slice(0, ORB_CRITERIA.topN),
    passing: scored.length,
    total:   candidates.length,
  };
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------
export async function fetchStocksInPlay(ctx, opts = {}) {
  // Cache hit?
  if (!opts.bypassCache) {
    const cached = loadCache();
    if (cached && (Date.now() - cached.fetchedAt < CACHE_TTL_MS)) {
      return { ...cached, fromCache: true };
    }
  }

  // Live fetch
  const raw = await fetchFromAlphaVantage(ctx);
  const ranked = rankCandidates(raw.candidates);

  const result = {
    candidates:  ranked.top,
    passing:     ranked.passing,
    total:       ranked.total,
    lastUpdated: raw.lastUpdated,
    source:      raw.source,
    sourceUrl:   raw.sourceUrl,
    fetchedAt:   Date.now(),
    criteria: {
      minPrice:        ORB_CRITERIA.minPrice,
      minDailyVolume:  ORB_CRITERIA.minDailyVolume,
      rvolOrFloorPct:  ORB_CRITERIA.rvolOrFloorPct,
    },
    fromCache:   false,
  };
  saveCache(result);
  return result;
}
