// =============================================================================
// Alpaca broker adapter (server-side). Wraps the Alpaca Trading REST API behind
// a small interface the worker uses. Node 18+ native fetch; no SDK dependency.
//
// Paper base:  https://paper-api.alpaca.markets
// Live  base:  https://api.alpaca.markets
//
// Auth is via APCA-API-KEY-ID / APCA-API-SECRET-KEY headers. We never log the
// secret. The worker decides paper vs live; this adapter just talks to baseUrl.
// =============================================================================

export function createAlpacaClient({ baseUrl, apiKey, apiSecret, dataBaseUrl = 'https://data.alpaca.markets', fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !apiKey || !apiSecret) {
    throw new Error('Alpaca client needs baseUrl, apiKey, apiSecret');
  }
  const root = baseUrl.replace(/\/$/, '');
  const dataRoot = dataBaseUrl.replace(/\/$/, '');
  const headers = {
    'APCA-API-KEY-ID': apiKey,
    'APCA-API-SECRET-KEY': apiSecret,
    'Content-Type': 'application/json',
  };

  async function req(method, path, body) {
    const res = await fetchImpl(`${root}${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = json?.message || text || `${res.status} ${res.statusText}`;
      const err = new Error(`Alpaca ${method} ${path} failed: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  return {
    // Account equity + buying power, used for position sizing and the daily halt.
    async getAccount() {
      const a = await req('GET', '/v2/account');
      return {
        equity: Number(a.equity),
        lastEquity: Number(a.last_equity),
        buyingPower: Number(a.buying_power),
        cash: Number(a.cash),
        status: a.status,
        raw: a,
      };
    },

    // Open positions → used for concurrent/sector caps and reconciliation.
    async getPositions() {
      const list = await req('GET', '/v2/positions');
      return (list || []).map(p => ({
        symbol: p.symbol,
        qty: Number(p.qty),
        avgEntry: Number(p.avg_entry_price),
        marketValue: Number(p.market_value),
        unrealizedPl: Number(p.unrealized_pl),
      }));
    },

    // Look up an order we previously submitted by our deterministic client id.
    // Returns null if it doesn't exist (the idempotency check).
    async getOrderByClientId(clientOrderId) {
      try {
        return await req('GET', `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`);
      } catch (e) {
        if (e.status === 404) return null;
        throw e;
      }
    },

    // Submit a protected entry from the engine's broker-agnostic intent. The
    // entry leg is a limit (bounded by the slippage budget) unless it's a buy-stop
    // strategy; the protective legs stay GTC so they cover the position across
    // days. An unfilled entry limit is cancelled later by the stale-entry sweep.
    //
    // order_class is derived from which legs the intent actually carries, because
    // Alpaca validates them: `bracket` REQUIRES both take_profit and stop_loss
    // and rejects the order if either is missing, while `oto` takes exactly one.
    // Trend strategies exit on a trailing stop and so ship without a target (see
    // buildBracketOrder) — those must go out as OTO or the broker refuses them.
    async submitBracketOrder(intent) {
      const type = intent.type === 'stop' ? 'stop' : intent.type === 'limit' ? 'limit' : 'market';
      const tp = intent.takeProfit?.limitPrice != null ? { limit_price: String(intent.takeProfit.limitPrice) } : null;
      const sl = intent.stopLoss?.stopPrice   != null ? { stop_price:  String(intent.stopLoss.stopPrice)   } : null;
      const body = {
        symbol: intent.symbol,
        qty: String(intent.qty),
        side: intent.side,
        type,
        time_in_force: intent.timeInForce || 'gtc',
        client_order_id: intent.clientOrderId,
      };
      if (tp && sl) body.order_class = 'bracket';
      else if (tp || sl) body.order_class = 'oto';
      // else: a naked entry — no order_class, no protective leg. Should not
      // happen (every signal carries a stop), but sending order_class with no
      // legs is a guaranteed rejection, so degrade to a plain order instead.
      if (type === 'stop'  && intent.stopPrice  != null) body.stop_price  = String(intent.stopPrice);
      if (type === 'limit' && intent.limitPrice != null) body.limit_price = String(intent.limitPrice);
      if (tp) body.take_profit = tp;
      if (sl) body.stop_loss = sl;
      return req('POST', '/v2/orders', body);
    },

    // Order status by Alpaca order id (reconciliation).
    // With { nested: true } the bracket parent comes back with its child legs
    // (TP limit + SL stop) in `legs[]`, each carrying its own status and
    // filled_avg_price — that's how we recover the actual exit fill of a
    // bracket-closed position for realized-P&L journaling.
    async getOrder(orderId, { nested = false } = {}) {
      const q = nested ? '?nested=true' : '';
      return req('GET', `/v2/orders/${encodeURIComponent(orderId)}${q}`);
    },

    // Cancel an order by Alpaca id. Used by the stale-entry sweep to kill a
    // prior session's unfilled entry limit so it can't fill late (strict
    // one-session freshness). Returns 204 no-content on success.
    async cancelOrder(orderId) {
      return req('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`);
    },

    // Every FILL on the account — the ground truth for realized performance.
    //
    // Alpaca has no closed-trade endpoint, so per-trade P&L is reconstructed
    // from these by matching closes against opens (see src/perf/roundTrips.js).
    //
    // The endpoint pages with `page_token`, and a busy account easily exceeds one
    // page — silently taking only the first would understate every total, so we
    // follow the cursor to exhaustion. `maxPages` is a runaway guard, not a
    // preference: hitting it means the caller asked for too wide a window.
    async getActivities({ after = null, until = null, pageSize = 100, maxPages = 50 } = {}) {
      const out = [];
      let pageToken = null;
      for (let page = 0; page < maxPages; page++) {
        const qs = new URLSearchParams({ activity_types: 'FILL', page_size: String(pageSize), direction: 'asc' });
        if (after) qs.set('after', after);
        if (until) qs.set('until', until);
        if (pageToken) qs.set('page_token', pageToken);
        const batch = await req('GET', `/v2/account/activities?${qs}`);
        if (!Array.isArray(batch) || !batch.length) break;
        out.push(...batch);
        if (batch.length < pageSize) break;      // last page
        pageToken = batch[batch.length - 1]?.id;
        if (!pageToken) break;
      }
      return out;
    },

    // Account equity / P&L time series — Alpaca's own numbers, so the dashboard
    // headline agrees with the broker rather than re-deriving it from fills.
    // period: 1D|1W|1M|3M|1A|all   timeframe: 1Min|5Min|15Min|1H|1D
    async getPortfolioHistory({ period = '1M', timeframe = '1D', extendedHours = false } = {}) {
      const qs = new URLSearchParams({ period, timeframe, extended_hours: String(extendedHours) });
      const h = await req('GET', `/v2/account/portfolio/history?${qs}`);
      const ts = h?.timestamp || [];
      return {
        baseValue: Number(h?.base_value ?? 0),
        points: ts.map((t, i) => ({
          date: new Date(t * 1000),
          equity: Number(h.equity?.[i] ?? 0),
          profitLoss: Number(h.profit_loss?.[i] ?? 0),
          profitLossPct: Number(h.profit_loss_pct?.[i] ?? 0) * 100,
        })).filter(p => Number.isFinite(p.equity) && p.equity > 0),
      };
    },

    // Trading calendar between two ET dates (inclusive). Each row is
    // { date:'YYYY-MM-DD', open:'HH:MM', close:'HH:MM' } and only real sessions
    // appear — so the previous-session lookup skips weekends AND holidays.
    async getCalendar(start, end) {
      const c = await req('GET', `/v2/calendar?start=${start}&end=${end}`);
      return Array.isArray(c) ? c : [];
    },

    // Market clock — is the (US) market open right now, and when does it next
    // open/close. Used to avoid placing orders outside regular session.
    async getClock() {
      const c = await req('GET', '/v2/clock');
      return { isOpen: !!c.is_open, nextOpen: c.next_open, nextClose: c.next_close, timestamp: c.timestamp };
    },

    // Daily bars from the market-data API, ascending, shaped like the strategy
    // engine's bars ({date, open, high, low, close, volume}) so settleSignal can
    // run directly on them. Used by the exit-management pass. split-adjusted so
    // indicator math (5-SMA etc.) stays continuous across splits.
    async getDailyBars(symbol, { start, end = null, limit = 300 } = {}) {
      const q = new URLSearchParams({ timeframe: '1Day', adjustment: 'split', limit: String(limit) });
      if (start) q.set('start', `${start}T00:00:00Z`);
      if (end)   q.set('end', `${end}T23:59:59Z`);
      const res = await fetchImpl(`${dataRoot}/v2/stocks/${encodeURIComponent(symbol)}/bars?${q}`, { headers });
      if (!res.ok) throw new Error(`Alpaca bars ${symbol} failed: ${res.status} ${await res.text().catch(() => '')}`);
      const j = await res.json().catch(() => null);
      return (j?.bars || []).map(b => ({
        date: String(b.t).slice(0, 10),
        open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c),
        volume: Number(b.v),
      }));
    },

    // Liquidate a position (market order). cancelOrders=true also cancels the
    // symbol's open orders (the resting bracket legs) — required, since Alpaca
    // rejects a close while the bracket still holds the shares.
    async closePosition(symbol, { cancelOrders = true } = {}) {
      return req('DELETE', `/v2/positions/${encodeURIComponent(symbol)}?cancel_orders=${cancelOrders ? 'true' : 'false'}`);
    },

    // Latest trade price from the market-data API (separate host). Used for the
    // pre-trade slippage check so we compare against a live price, not a stale
    // EOD close. Returns null on any failure so the caller can fall back.
    async getLatestPrice(symbol) {
      try {
        const res = await fetchImpl(`${dataRoot}/v2/stocks/${encodeURIComponent(symbol)}/trades/latest`, { headers });
        if (!res.ok) return null;
        const j = await res.json().catch(() => null);
        const p = j?.trade?.p;
        return Number.isFinite(p) ? p : null;
      } catch { return null; }
    },
  };
}

// The base URL the user configured IS the paper-vs-live switch (paper-api... for
// paper, api.alpaca.markets for real money). Blank defaults to the paper host so
// an unconfigured account can never touch live.
export function resolveAlpacaBaseUrl(cfg) {
  const url = (cfg.restApiBase || '').trim();
  return url || 'https://paper-api.alpaca.markets';
}

// True unless the resolved base URL is the Alpaca PAPER host. The live host —
// OR any unrecognized URL — is treated as live, so the worker can gate it behind
// ALLOW_LIVE and a misconfigured URL fails safe (blocked, not silently live).
export function isLiveBaseUrl(url) {
  return !/paper-api\.alpaca\.markets/i.test(String(url || ''));
}
