// =============================================================================
// Auto-trade engine — PURE decision logic, no I/O. The worker
// (scripts/auto-trade.mjs) composes these with a broker adapter + Firestore.
//
// Keeping this side-effect-free means every risk/sizing/guard decision is unit-
// tested (tests/auto.mjs) without touching a broker or the network — the only
// safe way to build something that places real orders.
// =============================================================================

// Deterministic client order id → idempotency key. Re-running the worker for the
// same user+signal yields the same id, so the broker (and our journal) dedupe a
// double-submit. Sanitized to the charset brokers accept for client_order_id.
export function clientOrderId(uid, signalId) {
  return `at.${uid}.${signalId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
}

// Position size. Two modes:
//   • 'risk'  (default) — fixed-fractional risk: shares = (equity × risk%) ÷
//                         |entry − stop|. Capital deployed varies with stop width.
//   • 'fixed' — a fixed dollar budget per trade: shares = fixedNotional ÷ entry.
//                Best for small accounts that want a known, small spend per name.
// `maxPositionNotional` (when > 0) hard-caps the dollars in any single position
// in BOTH modes. Whole shares only (Alpaca bracket orders don't allow fractional),
// so a budget below one share's price yields 0 shares → the caller skips.
export function sizePosition({ equity, sizingMode = 'risk', riskPerTradePct, fixedNotional, maxPositionNotional, entry, sl }) {
  const riskPerShare = (entry != null && sl != null) ? Math.abs(entry - sl) : 0;
  const zero = { shares: 0, riskPerShare, dollarRisk: 0, notional: 0 };
  if (!(entry > 0)) return zero;

  let rawShares;
  if (sizingMode === 'fixed') {
    if (!(fixedNotional > 0)) return zero;
    rawShares = fixedNotional / entry;
  } else {
    const dollarRisk = (equity > 0 && riskPerTradePct > 0) ? equity * (riskPerTradePct / 100) : 0;
    if (riskPerShare <= 0 || dollarRisk <= 0) return zero;
    rawShares = dollarRisk / riskPerShare;
  }
  // Hard cap on capital per position (applies to both modes).
  if (maxPositionNotional > 0) rawShares = Math.min(rawShares, maxPositionNotional / entry);

  const shares = Math.floor(rawShares);
  if (shares < 1) return { ...zero, riskPerShare };
  return { shares, riskPerShare, dollarRisk: riskPerShare > 0 ? shares * riskPerShare : 0, notional: shares * entry };
}

// Does a signal pass the user's selection rules? Returns every failed reason so
// the worker can log exactly why a signal was skipped.
export function signalMatchesRules(signal, cfg) {
  const reasons = [];
  const entry = signal.entryPrice;
  const ticker = (signal.ticker || '').toUpperCase();

  if (cfg.markets?.length && signal.market && !cfg.markets.includes(signal.market)) reasons.push(`market ${signal.market} not selected`);
  if (cfg.tiers?.length && !cfg.tiers.includes(signal.tier)) reasons.push(`tier ${signal.tier} not selected`);
  if (cfg.sides?.length && !cfg.sides.includes(signal.side || 'buy')) reasons.push(`side ${signal.side} not selected`);
  if (cfg.strategies?.length && !cfg.strategies.includes(signal.strategyKey)) reasons.push(`strategy ${signal.strategyKey} not in allow-list`);
  if (Array.isArray(cfg.excludeTickers) && cfg.excludeTickers.includes(ticker)) reasons.push(`${ticker} on exclusion list`);
  if (entry != null) {
    if (cfg.minPrice != null && entry < cfg.minPrice) reasons.push(`price ${entry} < min ${cfg.minPrice}`);
    if (cfg.maxPrice != null && entry > cfg.maxPrice) reasons.push(`price ${entry} > max ${cfg.maxPrice}`);
  }
  if (cfg.minAdvUsd != null && signal.advUsd != null && signal.advUsd < cfg.minAdvUsd) {
    reasons.push(`ADV ${Math.round(signal.advUsd / 1e6)}M < min ${Math.round(cfg.minAdvUsd / 1e6)}M`);
  }
  return { ok: reasons.length === 0, reasons };
}

// Portfolio-level guardrails evaluated at the moment of considering a new entry.
// `addedHeatPct` is the risk this new position would add (= riskPerTradePct).
export function passesPortfolioGuards({ cfg, openCount, sectorCount, openHeatPct, addedHeatPct, dayRealizedPct }) {
  if (cfg.maxConcurrentPositions != null && openCount >= cfg.maxConcurrentPositions) {
    return { ok: false, reason: `max concurrent positions (${cfg.maxConcurrentPositions}) reached` };
  }
  if (cfg.maxPositionsPerSector != null && sectorCount >= cfg.maxPositionsPerSector) {
    return { ok: false, reason: `max positions per sector (${cfg.maxPositionsPerSector}) reached` };
  }
  if (cfg.maxPortfolioHeatPct != null && (openHeatPct + addedHeatPct) > cfg.maxPortfolioHeatPct + 1e-9) {
    return { ok: false, reason: `portfolio heat ${(openHeatPct + addedHeatPct).toFixed(2)}% > cap ${cfg.maxPortfolioHeatPct}%` };
  }
  if (cfg.dailyLossHaltPct != null && dayRealizedPct != null && dayRealizedPct <= -Math.abs(cfg.dailyLossHaltPct)) {
    return { ok: false, reason: `daily loss halt: ${dayRealizedPct.toFixed(2)}% <= -${cfg.dailyLossHaltPct}%` };
  }
  return { ok: true, reason: null };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Is `date` an allowed trade day per the config? Uses UTC weekday; the worker
// runs near market hours so UTC day == trading day for both US and India.
export function isTradeDayAllowed(cfg, date = new Date()) {
  if (!cfg.tradeDays?.length) return true;
  return cfg.tradeDays.includes(DAY_NAMES[date.getUTCDay()]);
}

// Market-regime gate. When the latest regime snapshot says "go to cash" (index
// broke its 200-DMA / volatility spike), block NEW long entries. Fails OPEN when
// no regime data is available, so a missing snapshot doesn't halt everything.
export function regimeAllowsEntry(regime, side = 'buy') {
  if (!regime) return { ok: true, reason: null };
  if ((side || 'buy') === 'buy' && regime.go_to_cash) {
    return { ok: false, reason: 'market regime: go-to-cash (risk-off) — new longs blocked' };
  }
  return { ok: true, reason: null };
}

// Skip if the live price has already run past the entry beyond the slippage
// budget (for a buy: price gapped up; for a sell: price gapped down).
export function slippageOk(cfg, entry, livePrice, side = 'buy') {
  if (cfg.slippageBudgetPct == null || livePrice == null || entry == null || entry <= 0) return true;
  const budget = cfg.slippageBudgetPct / 100;
  if (side === 'sell') return livePrice >= entry * (1 - budget);
  return livePrice <= entry * (1 + budget);
}

// Broker-agnostic bracket-order intent. The adapter translates this to its own
// API shape. We always attach the stop + target so a fill is protected.
export function buildBracketOrder({ signal, shares, clientOrderId }) {
  const isBuy = (signal.side || 'buy') === 'buy';
  return {
    clientOrderId,
    symbol: signal.ticker,
    side: isBuy ? 'buy' : 'sell',
    qty: shares,
    // Buy-stop strategies trigger on a stop-entry; others enter at market open.
    type: signal.pendingEntry ? 'stop' : 'market',
    stopPrice: signal.pendingEntry ? signal.entryPrice : null,
    timeInForce: 'gtc',
    takeProfit: signal.tpPrice != null ? { limitPrice: signal.tpPrice } : null,
    stopLoss: signal.slPrice != null ? { stopPrice: signal.slPrice } : null,
  };
}
