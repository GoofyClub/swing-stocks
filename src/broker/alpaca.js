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

    // Submit a bracket order from the engine's broker-agnostic intent.
    async submitBracketOrder(intent) {
      const body = {
        symbol: intent.symbol,
        qty: String(intent.qty),
        side: intent.side,
        type: intent.type === 'stop' ? 'stop' : 'market',
        time_in_force: intent.timeInForce || 'gtc',
        client_order_id: intent.clientOrderId,
        order_class: 'bracket',
      };
      if (intent.type === 'stop' && intent.stopPrice != null) body.stop_price = String(intent.stopPrice);
      if (intent.takeProfit?.limitPrice != null) body.take_profit = { limit_price: String(intent.takeProfit.limitPrice) };
      if (intent.stopLoss?.stopPrice != null) body.stop_loss = { stop_price: String(intent.stopLoss.stopPrice) };
      return req('POST', '/v2/orders', body);
    },

    // Order status by Alpaca order id (reconciliation).
    async getOrder(orderId) {
      return req('GET', `/v2/orders/${encodeURIComponent(orderId)}`);
    },

    // Market clock — is the (US) market open right now, and when does it next
    // open/close. Used to avoid placing orders outside regular session.
    async getClock() {
      const c = await req('GET', '/v2/clock');
      return { isOpen: !!c.is_open, nextOpen: c.next_open, nextClose: c.next_close, timestamp: c.timestamp };
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
