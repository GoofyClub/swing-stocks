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

export function createAlpacaClient({ baseUrl, apiKey, apiSecret, fetchImpl = globalThis.fetch }) {
  if (!baseUrl || !apiKey || !apiSecret) {
    throw new Error('Alpaca client needs baseUrl, apiKey, apiSecret');
  }
  const root = baseUrl.replace(/\/$/, '');
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
  };
}

// Force the paper endpoint whenever mode !== 'live', so a misconfigured base URL
// can never accidentally route a "paper" run to the live account.
export function resolveAlpacaBaseUrl(cfg) {
  if (cfg.mode === 'live') return cfg.restApiBase || 'https://api.alpaca.markets';
  return 'https://paper-api.alpaca.markets';
}
