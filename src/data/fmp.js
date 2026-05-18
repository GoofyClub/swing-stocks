// =============================================================================
// FMP (Financial Modeling Prep) data fetcher.
// Extracted from /legacy/swing_terminal_4-1.html lines 2228–2263.
// Refactored to take key + cache as parameters instead of touching `state`.
// =============================================================================

export function makeFmpCache() {
  return new Map();
}

export async function fetchFMPData(ticker, { apiKey, cache, fetchImpl, ttlMs = 3600_000 } = {}) {
  if (!apiKey) return null;

  const cached = cache && cache.get(ticker);
  if (cached && Date.now() - cached.ts < ttlMs) return cached;

  const f = fetchImpl || globalThis.fetch;
  const base = 'https://financialmodelingprep.com/api/v3';
  const k = `apikey=${encodeURIComponent(apiKey)}`;
  // For India stocks, swap .NS suffix to .NSE used by FMP
  const sym = ticker.endsWith('.NS') ? ticker.replace('.NS', '.NSE') : ticker;

  const safeFetch = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const r = await f(url, { signal: ctrl.signal });
      return r.ok ? r.json() : [];
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const [earnResp, insiderResp, upgradeResp] = await Promise.all([
      safeFetch(`${base}/earnings-surprises/${encodeURIComponent(sym)}?${k}`),
      safeFetch(`${base}/insider-trading?symbol=${encodeURIComponent(sym)}&limit=50&${k}`),
      safeFetch(`${base}/upgrades-downgrades?search=${encodeURIComponent(sym)}&${k}`),
    ]);
    const result = {
      earnings: Array.isArray(earnResp)   ? earnResp   : [],
      insider:  Array.isArray(insiderResp) ? insiderResp : [],
      upgrades: Array.isArray(upgradeResp) ? upgradeResp : [],
      ts: Date.now(),
    };
    if (cache) cache.set(ticker, result);
    return result;
  } catch (e) {
    return null;
  }
}
