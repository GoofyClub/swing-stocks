// =============================================================================
// Auto-trade engine — PURE decision logic, no I/O. The worker
// (scripts/auto-trade.mjs) composes these with a broker adapter + Firestore.
//
// Keeping this side-effect-free means every risk/sizing/guard decision is unit-
// tested (tests/auto.mjs) without touching a broker or the network — the only
// safe way to build something that places real orders.
// =============================================================================

import { indexMemberships, indexAllowed } from '../data/indexes.js';

// Deterministic client order id → idempotency key. Re-running the worker for the
// same user+signal yields the same id, so the broker (and our journal) dedupe a
// double-submit. Sanitized to the charset brokers accept for client_order_id.
export function clientOrderId(uid, signalId) {
  return `at.${uid}.${signalId}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 120);
}

// =============================================================================
// PLACED stop override — the stop actually sent to the broker, per strategy.
//
// Three different stops were previously the same number, which conflated three
// jobs: (1) the quality filter that decides which signals are tradeable at all
// (applyTarget's minSlPct/maxSlPct), (2) the geometry the target is derived
// from, and (3) the protective stop actually placed. This overrides ONLY (3).
//
// EMPTY BY DEFAULT — and rsi2 is deliberately NOT here.
//
//   A first backtest suggested widening rsi2's stop to 5%: the natural stop
//   appeared to net -44.58R against +20.33R for 5%. That comparison was WRONG.
//   It let each variant use its own set of closed trades, and a wider stop keeps
//   trades alive longer, so the wide rows quietly excluded ~80 unresolved
//   (disproportionately underwater) trades that the tight stop had already
//   booked as losses.
//
//   Re-run over the SAME 320 trades closed under every variant, the ordering
//   inverts — net R falls monotonically as the stop widens:
//
//     stop      WR     net R   avg R    PF    worst
//     natural  57.2%  +52.67R  +0.16R  1.37  -2.99%
//     3%       69.1%  +34.33R  +0.11R  1.36  -3.00%
//     5%       77.5%  +30.27R  +0.09R  1.54  -5.00%
//     8%       80.6%  +24.26R  +0.08R  1.76  -8.00%
//     none     82.8%       —        —  2.08 -30.43%
//
//   Wider stops do buy a higher win rate, profit factor and raw % return — but
//   under risk-based sizing every trade risks the same dollars, so net R is what
//   tracks P&L, and by that measure the natural stop wins. It also has the
//   smallest worst case. So there is no evidence for an override, and adding one
//   would have made things worse.
//
// The MECHANISM stays because it is sound and separately useful: it decouples
// the stop actually placed from the two other jobs the same number does (the
// applyTarget quality filter, and the geometry the target is derived from), so a
// future evidence-backed value can be set here without disturbing either. With
// the map empty every strategy simply keeps its natural stop.
//
// Do not add an entry here without a COMMON-SUBSET backtest supporting it:
//   node scripts/backtest-stop.mjs --strategy=<key> --stops=natural,3,5,8,none
// =============================================================================
export const PLACED_STOP_PCT = {};

// The stop price to actually place for a signal. Falls back to the signal's own
// stop when the strategy has no override. Long-only: a short's stop sits ABOVE
// entry, and widening that correctly is a different calculation than this one,
// so shorts are passed through untouched.
export function placedStopPrice(signal) {
  const natural = signal?.slPrice ?? null;
  const pct = PLACED_STOP_PCT[signal?.strategyKey];
  if (pct == null) return natural;
  if (!(signal?.entryPrice > 0)) return natural;
  if ((signal.side || 'buy') !== 'buy') return natural;
  const wide = signal.entryPrice * (1 - pct / 100);
  // Only ever LOOSEN. If a signal already carries a stop further from entry than
  // the override, keep it — this must never tighten a stop.
  return natural == null ? wide : Math.min(wide, natural);
}

// =============================================================================
// Re-entry cooldown — how many days after a LOSING exit a ticker is untradeable.
//
// A mean-reversion setup keeps firing on a name that is still falling: the stop
// takes you out, the stock is now even more oversold, so the scan flags it again
// tomorrow. ARWR was entered and stopped out THREE times in three sessions
// (Jul 13/14/15), each a fresh loss, because nothing remembered the previous
// one. That is the same trade re-taken, not three independent edges.
//
// Only LOSING exits start a cooldown. A winner that sets up again is a working
// strategy and should be allowed straight back in.
//
// 0 disables it. Default 3 sessions ≈ half rsi2's 7-bar hold: long enough that a
// stopped-out name must actually base before re-entry, short enough not to miss
// the next genuine setup.
// =============================================================================
export const REENTRY_COOLDOWN_DAYS = 3;

// Is `ticker` still cooling off? `recentLosses` is [{ ticker, exitedAt }] where
// exitedAt is a Date/ms/ISO of the losing exit.
export function inReentryCooldown(ticker, recentLosses, now = new Date(), cooldownDays = REENTRY_COOLDOWN_DAYS) {
  if (!cooldownDays || !ticker || !Array.isArray(recentLosses)) return { blocked: false };
  const cutoffMs = now.getTime() - cooldownDays * 86400_000;
  for (const l of recentLosses) {
    if (!l || l.ticker !== ticker) continue;
    const t = l.exitedAt instanceof Date ? l.exitedAt.getTime()
      : typeof l.exitedAt === 'number' ? l.exitedAt
      : l.exitedAt ? Date.parse(l.exitedAt) : NaN;
    if (!Number.isFinite(t)) continue;
    if (t >= cutoffMs) {
      const daysAgo = Math.max(0, (now.getTime() - t) / 86400_000);
      return {
        blocked: true,
        reason: `re-entry cooldown: stopped out ${daysAgo.toFixed(1)}d ago (${cooldownDays}d cooldown)`,
      };
    }
  }
  return { blocked: false };
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
  // Index filter: a per-strategy override (cfg.strategyIndexes[key]) takes
  // precedence; otherwise the global cfg.indexes applies. Empty = all indices.
  // Membership is OR — a large-cap S&P-500 name matches either 'largecap' or
  // 'sp500' in the allow-list.
  const perStrat = cfg.strategyIndexes?.[signal.strategyKey];
  const idxAllow = (Array.isArray(perStrat) && perStrat.length) ? perStrat : (cfg.indexes || []);
  if (!indexAllowed(signal, idxAllow)) reasons.push(`index ${indexMemberships(signal).join('/') || 'none'} not allowed for ${signal.strategyKey}`);
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

// Account-level circuit breaker. Halts NEW entries when equity has fallen
// maxDrawdownHaltPct from its peak (high-water mark) — a multi-day backstop that
// complements the intraday daily-loss halt. 0/undefined disables it. Also returns
// the (possibly updated) peak so the caller can persist the new high-water mark.
export function drawdownHalted({ equity, peakEquity, maxDrawdownHaltPct }) {
  const peak = Math.max(peakEquity || 0, equity || 0);
  const drawdownPct = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
  const halted = maxDrawdownHaltPct > 0 && drawdownPct >= maxDrawdownHaltPct;
  return { halted, drawdownPct, peak };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Is `date` an allowed trade day per the config? Uses UTC weekday; the worker
// runs near market hours so UTC day == trading day for both US and India.
export function isTradeDayAllowed(cfg, date = new Date()) {
  if (!cfg.tradeDays?.length) return true;
  return cfg.tradeDays.includes(DAY_NAMES[date.getUTCDay()]);
}

// US-market wall clock (DST-aware, no dependency). Returns the ET calendar date
// and minutes-since-midnight ET for `now`. Used to (a) find the previous trading
// session's signal bucket and (b) gate new entries to the morning window, so the
// worker never depends on GitHub Actions' UTC cron landing at an exact ET time.
export function marketClock(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// Regular US session opens 09:30 ET (570 min). New entries are only placed inside
// [open, open + windowMinutes] ET. Price-drift protection comes from the limit
// order at the signal entry price plus the slippageOk gate — NOT from a tight
// window — so the window can be generous: it only needs to shut off entries by
// the late afternoon. It is 210 min (09:30-13:00 ET) because GitHub Actions cron
// on this repo routinely fires 2-3 hours late; a 90-min window meant every
// scheduled run landed after it closed and no entries were ever placed.
// Reconciliation runs regardless of the window.
export const MARKET_OPEN_ET_MIN = 9 * 60 + 30;
export const MARKET_CLOSE_ET_MIN = 16 * 60;

// Same-day "trade the close" window (default 15:35-15:50 ET).
//
// The morning path enters from the PREVIOUS session's signals, so a signal fired
// on Monday's close is bought Tuesday morning — by which time a mean-reversion
// bounce has often already happened. Strategies modelled on the closing price
// (Connors RSI2 buys the oversold close) lose part of their edge to that gap.
// This window is for a runner that scans and enters the SAME afternoon.
//
// It ends before 15:50 ET because that is Alpaca's market-on-close cutoff — the
// latest point an order can still be guaranteed the official close. Note the
// signal is necessarily computed on a near-final price rather than the settled
// close, so a late-session reversal can change it; that is inherent to any
// trade-the-close system, not a defect of this one.
export function inCloseWindow(now = new Date(), { startMinuteET = 15 * 60 + 35, endMinuteET = 15 * 60 + 50 } = {}) {
  const { minutes } = marketClock(now);
  return minutes >= startMinuteET && minutes <= endMinuteET;
}
export function inEntryWindow(now = new Date(), { openMinuteET = MARKET_OPEN_ET_MIN, windowMinutes = 210 } = {}) {
  const { minutes } = marketClock(now);
  return minutes >= openMinuteET && minutes <= openMinuteET + windowMinutes;
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

// Skip if the live price has moved past the entry beyond the slippage budget —
// in EITHER direction. The run-away direction (buy: gapped up) means chasing a
// worse fill. The opposite direction (buy: gapped down) is just as bad for a
// different reason: the signal's price levels are stale — the bracket SL was
// computed off the signal bar, so a fill 2-4% below it lands at or through its
// own stop and the position is stopped out seconds after entry.
// Buy-stop strategies (pendingEntry) skip the gap-down check: price sitting
// below the entry trigger is their normal waiting state, and their trigger
// sits above the SL by construction so a fill implies stop clearance.
export function slippageOk(cfg, entry, livePrice, side = 'buy', { pendingEntry = false } = {}) {
  if (cfg.slippageBudgetPct == null || livePrice == null || entry == null || entry <= 0) return true;
  const budget = cfg.slippageBudgetPct / 100;
  const lo = entry * (1 - budget), hi = entry * (1 + budget);
  if (side === 'sell') return livePrice >= lo && (pendingEntry || livePrice <= hi);
  return livePrice <= hi && (pendingEntry || livePrice >= lo);
}

// Hard backstop for the same failure mode independent of the slippage budget
// (which is user-configurable and may be generous or unset): never open a
// position whose bracket stop-loss would trigger the moment the entry fills.
// For a buy that means the live price must be ABOVE the stop; for a short,
// below it. Fails open when either price is unknown, like slippageOk.
export function stopClearanceOk({ slPrice, side = 'buy', pendingEntry = false }, livePrice) {
  if (pendingEntry || slPrice == null || livePrice == null) return true;
  return side === 'sell' ? livePrice < slPrice : livePrice > slPrice;
}

// Entry limit price, bounded by the slippage budget so a fill can never be worse
// than entry ± budget%. A buy tolerates paying up to entry*(1+budget); a sell
// accepts down to entry*(1-budget). With no budget it's just the signal price.
const round2 = (x) => Math.round(x * 100) / 100;
export function entryLimitPrice(entry, side = 'buy', slippageBudgetPct = null) {
  if (entry == null || entry <= 0) return null;
  if (slippageBudgetPct == null) return round2(entry);
  const b = slippageBudgetPct / 100;
  return round2((side === 'sell') ? entry * (1 - b) : entry * (1 + b));
}

// Should an OPEN broker position be closed by the tracked exit model? The GTC
// bracket already owns the TP and SL legs, so a tp/sl verdict is the bracket's
// business (it fills at the broker on its own) — this pass acts only on the
// exits a bracket can't express: RSI2's close>5-SMA native exit, per-strategy
// time stops, and the trailing-stop model for trend strategies.
const BROKER_MANAGED_EXITS = new Set(['native', 'time_stop', 'trail']);
export function modelExitAction(verdict) {
  return !!(verdict && verdict.status === 'closed' && BROKER_MANAGED_EXITS.has(verdict.exitReason));
}

// Round to a broker-valid price increment. Strategy math produces raw floats
// (e.g. entry × 1.02 = 45.961200000000005) and Alpaca rejects sub-penny prices
// on stocks ≥ $1 ("sub-penny increment does not fulfill minimum pricing
// criteria"); under $1 it accepts up to 4 decimals.
export function brokerPrice(x) {
  if (x == null || !Number.isFinite(x)) return null;
  return x >= 1 ? Math.round(x * 100) / 100 : Math.round(x * 10000) / 10000;
}

// Broker-agnostic bracket-order intent. The adapter translates this to its own
// API shape. We always attach the stop + target so a fill is protected.
//
// Entries are LIMIT orders bounded by the slippage budget (not market) so a run
// that fires late — after GitHub Actions lag — can't chase a moved price: it
// either fills near the signal price or doesn't fill. Buy-stop strategies keep
// their stop-entry trigger. Every price is passed through brokerPrice so no
// raw float ever reaches the API.
// `entryType: 'market'` skips the limit and takes whatever the book gives. Only
// the same-day close runner uses it: fired minutes before the bell it fills at
// ~the closing price, which is the price the strategy is actually modelled on,
// and unlike a market-on-close order it can still carry its bracket. A limit
// there would risk not filling at all, which for a trade-the-close entry means
// missing the trade rather than getting a better price.
export function buildBracketOrder({ signal, shares, clientOrderId, slippageBudgetPct = null, entryType = null }) {
  const isBuy = (signal.side || 'buy') === 'buy';
  const pending = !!signal.pendingEntry;
  const market = entryType === 'market';
  const limitPrice = (pending || market) ? null : entryLimitPrice(signal.entryPrice, signal.side, slippageBudgetPct);
  return {
    clientOrderId,
    symbol: signal.ticker,
    side: isBuy ? 'buy' : 'sell',
    qty: shares,
    type: market ? 'market' : pending ? 'stop' : 'limit',
    stopPrice: (!market && pending) ? brokerPrice(signal.entryPrice) : null,
    limitPrice: brokerPrice(limitPrice),
    timeInForce: 'gtc',
    takeProfit: signal.tpPrice != null ? { limitPrice: brokerPrice(signal.tpPrice) } : null,
    stopLoss: signal.slPrice != null ? { stopPrice: brokerPrice(signal.slPrice) } : null,
  };
}
