// =============================================================================
// In-memory app state. Holds the current user, market, fetch context, etc.
// Persisted user preferences live in Firestore (/users/{uid}/prefs); this is
// just runtime cache.
// =============================================================================

import { MARKET_CONFIGS, DATA_SOURCE_ORDER, STARTER_WATCHLIST } from '../data/markets.js';

// Restore last-selected market from localStorage on module load. Defaults to US.
let _bootMarket = 'US';
try {
  const stored = localStorage.getItem('swing.market');
  if (stored && MARKET_CONFIGS[stored]) _bootMarket = stored;
} catch {}

export const state = {
  user: null,                       // Firebase User or null
  market: _bootMarket,              // 'US' | 'INDIA'
  marketCfg: MARKET_CONFIGS[_bootMarket],
  prefs: {
    theme:    'dark',
    fontSize: 'M',
    market:   'US',
    dataSourceOpen: false,
    collapsedPanels: {},
  },
  // Data fetch context — shared by both interactive scans and any client-side refresh.
  fetchCtx: {
    apiKeys: { alphavantage: '', finnhub: '', fmp: '' },
    market: _bootMarket,
    enabledSources: new Set(DATA_SOURCE_ORDER),
    manualBars: new Map(),
    cache: new Map(),
  },
  // Lightweight in-memory copies of Firestore docs we just read, to avoid double-fetching.
  signalCache: new Map(),
  tradeCache:  new Map(),
  watchlist:   STARTER_WATCHLIST.map(x => ({ ...x })),
};

const subscribers = new Set();

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function notify(reason = 'state') {
  for (const fn of subscribers) {
    try { fn(reason, state); } catch (e) { console.error('[state subscriber]', e); }
  }
}

export function setMarket(market) {
  if (!MARKET_CONFIGS[market]) return;
  state.market = market;
  state.marketCfg = MARKET_CONFIGS[market];
  state.fetchCtx.market = market;
  state.fetchCtx.cache.clear();
  notify('market');
}

export function setUser(user) {
  state.user = user;
  notify('user');
}
