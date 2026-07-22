// =============================================================================
// Index-membership metadata shared across the app.
//
// Every signal is tagged with a single S&P `index` value (sp500 | sp400 | sp600
// | null) from the universe, PLUS a boolean `largeCap` flag when the ticker is
// in the curated large-cap watchlist (STARTER_WATCHLIST). Large-cap membership
// overlaps sp500, so it can't live in the single `index` field — it's a separate
// dimension. This module is the one source of truth for:
//   • the filter options shown on Live Signals / History / Automation,
//   • how a signal's memberships are computed (for OR-style multi-select filters
//     and the automation index allow-list), and
//   • the badge label shown in the INDEX column (largecap preferred over sp500).
//
// Node-safe (no DOM / browser deps) so scripts/*.mjs and src/auto/engine.js can
// import it too.
// =============================================================================

// Filter dropdown / chip options, per market. US uses the S&P partitions (Large
// Cap first, as the "premium" curated set); India uses Nifty-based indices — its
// stocks are never tagged with an S&P bucket, so showing S&P options for India
// would silently match nothing. Callers with a market context should use
// indexOptionsForMarket(); INDEX_OPTIONS stays as the US set for back-compat.
export const INDEX_OPTIONS_BY_MARKET = {
  US: [
    { value: 'largecap', label: 'Large Cap' },
    { value: 'sp500',    label: 'S&P 500' },
    { value: 'sp400',    label: 'MidCap 400' },
    { value: 'sp600',    label: 'SmallCap 600' },
  ],
  INDIA: [
    { value: 'nifty50',  label: 'NIFTY 50' },
  ],
};

// Back-compat: the default (US) option set for callers without a market context.
export const INDEX_OPTIONS = INDEX_OPTIONS_BY_MARKET.US;

// Index filter options for a single market (falls back to US for unknowns).
export function indexOptionsForMarket(market) {
  return INDEX_OPTIONS_BY_MARKET[market] || INDEX_OPTIONS_BY_MARKET.US;
}

// Union of index options across several markets, de-duped by value — used by the
// Automation page whose `markets` setting can span US + India at once. Empty =
// default to US.
export function indexOptionsForMarkets(markets) {
  const seen = new Set();
  const out = [];
  for (const m of (markets && markets.length ? markets : ['US'])) {
    for (const o of indexOptionsForMarket(m)) {
      if (!seen.has(o.value)) { seen.add(o.value); out.push(o); }
    }
  }
  return out;
}

// Tier options for the (now multi-select) tier filter. `label` is the compact
// chip text; `value` is the value stored on each signal's `tier` field.
export const TIER_OPTIONS = [
  { value: 'A+',     label: 'A+' },
  { value: 'Tier 1', label: 'T1' },
  { value: 'Tier 2', label: 'T2' },
];

// Short labels for the INDEX-column badge.
const INDEX_BADGE = { largecap: 'Large Cap', sp500: 'S&P 500', sp400: 'Mid 400', sp600: 'Small 600', nifty50: 'NIFTY 50' };

// Every index bucket a signal belongs to. A large-cap S&P-500 name returns
// ['largecap', 'sp500'] so it matches EITHER filter. Used by the multi-select
// filters (OR semantics) and the automation index allow-list.
export function indexMemberships(sig) {
  const out = [];
  if (sig?.largeCap) out.push('largecap');
  if (sig?.index) out.push(sig.index);
  return out;
}

// The single badge label to display for a signal — large-cap is preferred over
// the raw S&P-500 tag when a name is in both. Returns null when unclassified.
export function indexBadgeLabel(sig) {
  if (sig?.largeCap) return INDEX_BADGE.largecap;
  return INDEX_BADGE[sig?.index] || null;
}

// True when the signal passes an index allow-list (empty list = no restriction).
export function indexAllowed(sig, allow) {
  if (!allow || !allow.length) return true;
  return indexMemberships(sig).some(m => allow.includes(m));
}
