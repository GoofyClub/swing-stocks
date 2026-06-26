// =============================================================================
// Data fetch layer — pluggable sources with priority fallback.
//
// Refactored from /legacy/swing_terminal_4-1.html (lines 3235–3580). The original
// code read directly from a global `state` object. Here, each call accepts an
// explicit `ctx` so the same fetchers work in:
//   - the browser (state from in-app config)
//   - the Node cron worker (state from process.env via scripts/refresh-signals.mjs)
//
// ctx shape:
//   {
//     apiKeys:        { alphavantage, finnhub, fmp },
//     market:         'US' | 'INDIA',
//     enabledSources: Set<string>,   // names from DATA_SOURCE_ORDER
//     manualBars:     Map<ticker, bars> | null,
//     cache:          Map<ticker, bars> | null,
//     fetchImpl:      typeof fetch,   // injectable for Node (use undici / built-in fetch)
//   }
// =============================================================================

import { parseStooqCsv } from '../strategy/engine.js';
import { DATA_SOURCE_ORDER } from './markets.js';

export class DataFetchError extends Error {
  constructor(ticker, attempts, cause) {
    super(`Could not fetch data for ${ticker}: ${cause}`);
    this.name = 'DataFetchError';
    this.ticker = ticker;
    this.attempts = attempts;
    this.cause = cause;
  }
}

function classifyFetchError(e) {
  if (e instanceof TypeError) return 'network_or_cors';
  if (e.name === 'AbortError') return 'timeout';
  return 'other';
}

async function fetchWithTimeout(url, ctx, timeoutMs = 15000, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const f = ctx.fetchImpl || globalThis.fetch;
  try {
    return await f(url, { mode: 'cors', cache: 'no-store', signal: ctrl.signal, ...init });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Source: Alpaca Market Data (US equities, daily bars, key+secret) ----
// Reliable from datacenter IPs (unlike Yahoo/Stooq which block CI), so it's the
// preferred source for the GitHub Actions cron. US only; needs both key + secret
// (free IEX feed is fine for EOD daily bars). ctx.apiKeys.alpaca = {key, secret}.
async function fetchAlpaca(ticker, ctx) {
  const creds = ctx.apiKeys?.alpaca;
  const key = creds?.key, secret = creds?.secret;
  if (!key || !secret) throw new Error('no Alpaca key/secret configured');
  if (ctx.market === 'INDIA' || ticker.startsWith('^')) throw new Error('Alpaca data is US equities only');
  const start = new Date(Date.now() - 5 * 365 * 86400_000).toISOString().slice(0, 10);
  const base = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars?timeframe=1Day&start=${start}&limit=10000&adjustment=split&feed=iex`;
  const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  const bars = [];
  let pageToken = null;
  do {
    const url = pageToken ? `${base}&page_token=${encodeURIComponent(pageToken)}` : base;
    const resp = await fetchWithTimeout(url, ctx, 15000, { headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim());
    const j = await resp.json();
    for (const b of (j.bars || [])) {
      bars.push({ date: String(b.t).slice(0, 10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
    }
    pageToken = j.next_page_token || null;
  } while (pageToken);
  if (bars.length < 30) throw new Error(`only ${bars.length} bars`);
  return bars;
}

// ---- Source: Alpha Vantage (CSV daily, requires free API key, supports CORS) ----
async function fetchAlphaVantage(ticker, ctx) {
  const key = ctx.apiKeys?.alphavantage;
  if (!key) throw new Error('no API key configured');
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=full&datatype=csv&apikey=${encodeURIComponent(key)}`;
  const resp = await fetchWithTimeout(url, ctx);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim());
  const text = await resp.text();
  if (text.startsWith('{')) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.Note || j['Error Message'] || j.Information || text; } catch {}
    throw new Error(`Alpha Vantage: ${msg.slice(0, 200)}`);
  }
  if (text.length < 100 || !text.toLowerCase().startsWith('timestamp')) {
    throw new Error(`unexpected response (${text.length}b): ${text.slice(0, 100)}`);
  }
  const lines = text.trim().split('\n').slice(1);
  const bars = [];
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 6) continue;
    bars.push({ date: p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[5] });
  }
  bars.reverse();
  return bars;
}

// ---- Source: Finnhub (JSON daily candles, requires free API key, supports CORS) ----
async function fetchFinnhub(ticker, ctx) {
  const key = ctx.apiKeys?.finnhub;
  if (!key) throw new Error('no API key configured');
  const to = Math.floor(Date.now() / 1000);
  const from = to - 365 * 24 * 3600 * 5;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(key)}`;
  const resp = await fetchWithTimeout(url, ctx);
  if (!resp.ok) {
    let detail = '';
    try { const j = await resp.json(); detail = j.error || ''; } catch {}
    throw new Error(`HTTP ${resp.status}${detail ? ' — ' + detail : ''}`);
  }
  const j = await resp.json();
  if (j.s !== 'ok') {
    throw new Error(`finnhub status=${j.s}${j.error ? ' — ' + j.error : ''} (note: stock/candle endpoint may require paid plan)`);
  }
  const bars = [];
  for (let i = 0; i < j.t.length; i++) {
    bars.push({
      date: new Date(j.t[i] * 1000).toISOString().slice(0, 10),
      open: j.o[i], high: j.h[i], low: j.l[i], close: j.c[i], volume: j.v[i],
    });
  }
  return bars;
}

// ---- Source: Yahoo Finance (multiple endpoints) ----
function yahooSymbol(ticker, market) {
  if (market === 'INDIA' && !ticker.startsWith('^') && !ticker.includes('.')) {
    return ticker + '.NS';
  }
  return ticker;
}

async function fetchYahooFinanceViaUrl(url, ctx) {
  const resp = await fetchWithTimeout(url, ctx);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim());
  const j = await resp.json();
  const result = j?.chart?.result?.[0];
  if (!result) {
    const errMsg = j?.chart?.error?.description || 'no result in response';
    throw new Error(`Yahoo Finance: ${errMsg}`);
  }
  const timestamps = result.timestamp;
  if (!timestamps || timestamps.length === 0) throw new Error('Yahoo Finance: no timestamps');
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error('Yahoo Finance: missing quote indicators');
  const { open, high, low, close, volume } = quote;
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (close[i] == null || isNaN(close[i])) continue;
    const d = new Date(timestamps[i] * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    bars.push({
      date: dateStr,
      open: open[i] ?? close[i],
      high: high[i] ?? close[i],
      low:  low[i]  ?? close[i],
      close: close[i],
      volume: volume[i] ?? 0,
    });
  }
  if (bars.length < 30) throw new Error(`Yahoo Finance: only ${bars.length} bars returned`);
  return bars;
}

async function fetchYahooDirect(ticker, ctx) {
  const sym = encodeURIComponent(yahooSymbol(ticker, ctx.market));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y&includePrePost=false`;
  return fetchYahooFinanceViaUrl(url, ctx);
}
async function fetchYahooQuery2(ticker, ctx) {
  const sym = encodeURIComponent(yahooSymbol(ticker, ctx.market));
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y&includePrePost=false`;
  return fetchYahooFinanceViaUrl(url, ctx);
}
async function fetchYahooCorsproxy(ticker, ctx) {
  const sym = encodeURIComponent(yahooSymbol(ticker, ctx.market));
  const inner = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5y&includePrePost=false`;
  const url = `https://corsproxy.io/?url=${encodeURIComponent(inner)}`;
  return fetchYahooFinanceViaUrl(url, ctx);
}

async function fetchYahooV7Csv(ticker, ctx) {
  const sym = encodeURIComponent(yahooSymbol(ticker, ctx.market));
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const p1 = p2 - 5 * 365 * 86400;
  const url = `https://query1.finance.yahoo.com/v7/finance/download/${sym}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
  const resp = await fetchWithTimeout(url, ctx);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text || text.length < 50) throw new Error('empty response');
  if (text.startsWith('{')) {
    let msg = text;
    try { const j = JSON.parse(text); msg = j.chart?.error?.description || j.message || text; } catch {}
    throw new Error(`Yahoo v7: ${msg.slice(0, 200)}`);
  }
  const lines = text.trim().split('\n').slice(1);
  const bars = [];
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 6 || p[4] === 'null' || p[4] === '') continue;
    bars.push({
      date: p[0].trim(),
      open: +p[1], high: +p[2], low: +p[3],
      close: +p[4],
      volume: +p[6] || 0,
    });
  }
  if (bars.length < 30) throw new Error(`Yahoo v7 CSV: only ${bars.length} rows`);
  return bars;
}

async function fetchYahooV7Proxy(ticker, ctx) {
  const sym = encodeURIComponent(yahooSymbol(ticker, ctx.market));
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const p1 = p2 - 5 * 365 * 86400;
  const inner = `https://query1.finance.yahoo.com/v7/finance/download/${sym}?period1=${p1}&period2=${p2}&interval=1d&events=history`;
  const url = `https://corsproxy.io/?url=${encodeURIComponent(inner)}`;
  const resp = await fetchWithTimeout(url, ctx);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = await resp.text();
  if (!text || text.length < 50 || text.startsWith('{')) throw new Error('bad response via proxy');
  const lines = text.trim().split('\n').slice(1);
  const bars = [];
  for (const line of lines) {
    const p = line.split(',');
    if (p.length < 6 || p[4] === 'null' || p[4] === '') continue;
    bars.push({ date: p[0].trim(), open: +p[1], high: +p[2], low: +p[3], close: +p[4], volume: +p[6] || 0 });
  }
  if (bars.length < 30) throw new Error(`only ${bars.length} rows via proxy`);
  return bars;
}

// ---- Source: Stooq (CSV daily, no key, CORS depends on browser/network) ----
function stooqUrl(ticker, market) {
  let sym;
  if (ticker.startsWith('^')) sym = ticker.toLowerCase();
  else if (market === 'INDIA') sym = ticker.toLowerCase() + '.in';
  else sym = ticker.toLowerCase() + '.us';
  return `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
}
async function fetchStooqViaUrl(rawUrl, ctx) {
  const resp = await fetchWithTimeout(rawUrl, ctx);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText || ''}`.trim());
  const text = await resp.text();
  if (!text || text.length < 50) throw new Error(`empty body (${text.length}b)`);
  if (text.toLowerCase().includes('exceeded')) throw new Error('rate-limited (daily hits exceeded)');
  if (text.toLowerCase().includes('no data') && text.length < 200) throw new Error('symbol not recognised');
  return parseStooqCsv(text);
}
async function fetchStooqDirect(ticker, ctx) {
  return fetchStooqViaUrl(stooqUrl(ticker, ctx.market), ctx);
}
async function fetchStooqCorsproxy(ticker, ctx) {
  return fetchStooqViaUrl(`https://corsproxy.io/?url=${encodeURIComponent(stooqUrl(ticker, ctx.market))}`, ctx);
}
async function fetchStooqAllorigins(ticker, ctx) {
  return fetchStooqViaUrl(`https://api.allorigins.win/raw?url=${encodeURIComponent(stooqUrl(ticker, ctx.market))}`, ctx);
}
async function fetchStooqCodetabs(ticker, ctx) {
  return fetchStooqViaUrl(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(stooqUrl(ticker, ctx.market))}`, ctx);
}

export const DATA_SOURCES = {
  alpaca:            { label: 'Alpaca Market Data (US, key+secret)',   needsKey: 'alpaca',       fetch: fetchAlpaca },
  alphavantage:      { label: 'Alpha Vantage (CSV, key required)',     needsKey: 'alphavantage', fetch: fetchAlphaVantage },
  finnhub:           { label: 'Finnhub (JSON, key required)',          needsKey: 'finnhub',      fetch: fetchFinnhub },
  yahoo_v7_direct:   { label: 'Yahoo Finance v7 CSV (direct)',         needsKey: null,           fetch: fetchYahooV7Csv },
  yahoo_v7_proxy:    { label: 'Yahoo Finance v7 CSV via corsproxy.io', needsKey: null,           fetch: fetchYahooV7Proxy },
  yahoo_direct:      { label: 'Yahoo Finance v8 (direct)',             needsKey: null,           fetch: fetchYahooDirect },
  yahoo_query2:      { label: 'Yahoo Finance v8 query2 server',        needsKey: null,           fetch: fetchYahooQuery2 },
  yahoo_corsproxy:   { label: 'Yahoo Finance v8 via corsproxy.io',     needsKey: null,           fetch: fetchYahooCorsproxy },
  stooq_direct:      { label: 'stooq.com (direct)',                    needsKey: null,           fetch: fetchStooqDirect },
  stooq_corsproxy:   { label: 'stooq.com via corsproxy.io',            needsKey: null,           fetch: fetchStooqCorsproxy },
  stooq_allorigins:  { label: 'stooq.com via allorigins.win',          needsKey: null,           fetch: fetchStooqAllorigins },
  stooq_codetabs:    { label: 'stooq.com via codetabs.com',            needsKey: null,           fetch: fetchStooqCodetabs },
};

// ----- Main fetcher: tries each source in priority order until one succeeds -----
export async function fetchBars(ticker, ctx, opts = {}) {
  if (ctx.manualBars && ctx.manualBars.has(ticker)) {
    const bars = ctx.manualBars.get(ticker);
    if (!opts.silent) console.log(`[fetchBars] ${ticker}: using manual CSV upload (${bars.length} bars)`);
    return bars;
  }
  if (ctx.cache && !opts.bypassCache && ctx.cache.has(ticker)) return ctx.cache.get(ticker);

  const order = opts.order || DATA_SOURCE_ORDER;
  const enabled = ctx.enabledSources || new Set(order);
  const attempts = [];
  let bestPartial = null;

  for (const sourceName of order) {
    if (!enabled.has(sourceName)) continue;
    const src = DATA_SOURCES[sourceName];
    if (!src) continue;

    const attempt = { strategy: sourceName, label: src.label, status: null, bars: 0, error: null, ms: 0 };

    if (src.needsKey && !ctx.apiKeys?.[src.needsKey]) {
      attempt.error = `skipped — no ${src.needsKey} key set`;
      attempts.push(attempt);
      continue;
    }

    const t0 = performance.now();
    try {
      const bars = await src.fetch(ticker, ctx);
      attempt.ms = Math.round(performance.now() - t0);
      attempt.bars = bars.length;
      if (bars.length === 0) {
        attempt.error = 'parsed 0 bars';
        attempts.push(attempt);
        continue;
      }
      if (bars.length < 220) {
        attempt.error = `only ${bars.length} bars (need 220 for indicator warmup)`;
        attempts.push(attempt);
        if (!bestPartial || bars.length > bestPartial.bars.length) bestPartial = { bars, source: sourceName };
        continue;
      }
      attempts.push(attempt);
      if (ctx.cache) ctx.cache.set(ticker, bars);
      if (!opts.silent) console.log(`[fetchBars] ${ticker} via ${sourceName}: ${bars.length} bars in ${attempt.ms}ms`);
      return bars;
    } catch (e) {
      attempt.ms = Math.round(performance.now() - t0);
      const kind = classifyFetchError(e);
      if (kind === 'network_or_cors') attempt.error = `network/CORS blocked (TypeError: ${e.message})`;
      else if (kind === 'timeout') attempt.error = 'timed out after 15s';
      else attempt.error = e.message || String(e);
      attempts.push(attempt);
    }
  }

  const networkOnly = attempts.filter(a => a.error && (a.error.startsWith('network/CORS') || a.error.includes('timed out')));
  const skipped = attempts.filter(a => a.error && a.error.startsWith('skipped'));
  let cause;
  if (skipped.length === attempts.length) {
    cause = 'No data sources are configured. Open Settings → Data sources and paste a free Alpha Vantage or Finnhub API key, or upload a CSV.';
  } else if (networkOnly.length + skipped.length === attempts.length) {
    cause = 'Every reachable source was blocked by network/CORS or timed out. Likely cause: corporate firewall, ad-blocker/privacy extension, or all public proxies are down. Try: (1) disable any ad-blocker, (2) set a free Alpha Vantage or Finnhub API key in Settings — those endpoints support CORS natively.';
  } else if (bestPartial) {
    cause = `Sources reachable but only ${bestPartial.bars.length} historical bars available for ${ticker} (need 220 for full setup detection). Likely a recently-listed name. ${bestPartial.bars.length >= 30 ? 'Consider uploading a longer CSV manually.' : ''}`;
  } else {
    const errs = attempts.filter(a => a.error && !a.error.startsWith('skipped'));
    cause = `All sources returned errors. Last: ${errs.length ? errs[errs.length-1].error : 'unknown'}.`;
  }
  throw new DataFetchError(ticker, attempts, cause);
}

// fetch with simple concurrency limit + per-ticker error tolerance
export async function fetchMany(tickers, ctx, concurrency = 3, onProgress) {
  const results = {};
  let idx = 0, done = 0, errors = 0;
  async function worker() {
    while (idx < tickers.length) {
      const i = idx++;
      const t = tickers[i];
      try {
        results[t] = await fetchBars(t, ctx);
      } catch (e) {
        results[t] = {
          error: e.message,
          cause: e.cause || null,
          attempts: e.attempts || null,
          ticker: t,
        };
        errors++;
      }
      done++;
      if (onProgress) onProgress(done, tickers.length, errors);
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return results;
}
