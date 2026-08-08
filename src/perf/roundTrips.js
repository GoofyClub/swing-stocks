// =============================================================================
// roundTrips.js — reconstruct REAL closed trades from broker fills.
//
// Alpaca has no "closed trade P&L" endpoint — that is exactly why its UI can't
// show you win/loss per trade. What it does expose is every individual FILL
// (/v2/account/activities/FILL). A round trip is derived by matching closing
// fills against opening fills.
//
// Everything here is derived from BROKER FILLS ONLY. No signal data, no assumed
// entry price, no modelled exit. If the broker filled it, it is in here; if it
// didn't, it isn't. That is the whole point — the settled-signal numbers and the
// real account had already diverged, and only fills settle that argument.
//
// MATCHING RULE: FIFO. The oldest open lot closes first, which is the US tax
// default and the convention every broker statement uses, so these numbers
// reconcile against a 1099. Average-cost would produce different per-trade
// figures for the same account.
//
// Handles, because real fill streams contain all of them:
//   • partial fills            (one order filling across several prints)
//   • scaling in and out       (many opens, many partial closes)
//   • shorts                   (sell opens, buy closes; P&L sign inverted)
//   • position reversal in one fill (close the long, open a short with the rest)
//   • still-open positions     (reported separately, never as a fake win)
// =============================================================================

// Normalise one Alpaca FILL activity into the shape the matcher wants.
// Alpaca sends numbers as strings and uses `transaction_time`.
export function normalizeFill(a) {
  const qty = Math.abs(Number(a.qty ?? a.quantity ?? 0));
  const price = Number(a.price ?? 0);
  const rawSide = String(a.side ?? '').toLowerCase();
  // 'sell_short' and 'buy_to_cover' appear on some accounts; both reduce to a
  // direction. Anything containing 'buy' is a buy.
  const side = rawSide.includes('buy') ? 'buy' : 'sell';
  const time = a.transaction_time ?? a.transactionTime ?? a.time ?? null;
  return {
    symbol: String(a.symbol ?? '').toUpperCase(),
    side, qty, price,
    time: time ? new Date(time) : null,
    orderId: a.order_id ?? a.orderId ?? null,
    id: a.id ?? null,
  };
}

// Build closed round trips + remaining open lots from a list of fills.
//
// Returns { trades, open, skipped } where `trades` are CLOSED round trips
// sorted by exit time, and `open` is what is still held per symbol.
export function buildRoundTrips(rawFills) {
  const fills = (rawFills || [])
    .map(normalizeFill)
    .filter(f => f.symbol && f.qty > 0 && Number.isFinite(f.price) && f.time)
    // Chronological — FIFO is meaningless without a stable time order. Ties are
    // broken by id so the result is deterministic across runs.
    .sort((a, b) => (a.time - b.time) || String(a.id).localeCompare(String(b.id)));

  const lots = new Map();   // symbol -> [{ qty, price, time, dir }]  dir: +1 long, -1 short
  const trades = [];
  let skipped = 0;

  for (const f of fills) {
    const dir = f.side === 'buy' ? 1 : -1;
    if (!lots.has(f.symbol)) lots.set(f.symbol, []);
    const queue = lots.get(f.symbol);
    let remaining = f.qty;

    // Close against opposing lots first (FIFO), then open with any remainder.
    while (remaining > 0 && queue.length && queue[0].dir === -dir) {
      const lot = queue[0];
      const matched = Math.min(remaining, lot.qty);
      // Long: profit when exit > entry. Short: inverted.
      const entryPrice = lot.dir === 1 ? lot.price : f.price;
      const exitPrice  = lot.dir === 1 ? f.price  : lot.price;
      const pnl = (exitPrice - entryPrice) * matched;
      const cost = lot.price * matched;

      trades.push({
        symbol: f.symbol,
        side: lot.dir === 1 ? 'long' : 'short',
        qty: matched,
        entryPrice: lot.price,
        exitPrice: f.price,
        entryTime: lot.time,
        exitTime: f.time,
        pnl,
        pnlPct: cost > 0 ? (pnl / cost) * 100 : null,
        holdDays: (f.time - lot.time) / 86400_000,
        winLoss: pnl >= 0 ? 'win' : 'loss',
      });

      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= 1e-9) queue.shift();
    }

    // Anything left opens a new lot — this is also how a reversal works: the
    // closing part above flattened the old side, the remainder opens the new one.
    if (remaining > 1e-9) queue.push({ qty: remaining, price: f.price, time: f.time, dir });
  }

  const open = [];
  for (const [symbol, queue] of lots) {
    for (const lot of queue) {
      if (lot.qty > 1e-9) {
        open.push({ symbol, qty: lot.qty, entryPrice: lot.price, entryTime: lot.time, side: lot.dir === 1 ? 'long' : 'short' });
      }
    }
  }

  trades.sort((a, b) => a.exitTime - b.exitTime);
  return { trades, open, skipped };
}

// ---- Aggregation -----------------------------------------------------------

// Headline stats over a set of closed round trips.
export function summarize(trades) {
  const n = trades.length;
  if (!n) {
    return { trades: 0, wins: 0, losses: 0, winRate: null, netPnl: 0, grossWin: 0, grossLoss: 0,
             avgWin: null, avgLoss: null, profitFactor: null, expectancy: null, best: null, worst: null,
             avgHoldDays: null };
  }
  let wins = 0, losses = 0, grossWin = 0, grossLoss = 0, hold = 0;
  let best = trades[0], worst = trades[0];
  for (const t of trades) {
    if (t.pnl >= 0) { wins++; grossWin += t.pnl; } else { losses++; grossLoss += -t.pnl; }
    hold += t.holdDays || 0;
    if (t.pnl > best.pnl) best = t;
    if (t.pnl < worst.pnl) worst = t;
  }
  const netPnl = grossWin - grossLoss;
  return {
    trades: n, wins, losses,
    winRate: wins / n,
    netPnl, grossWin, grossLoss,
    avgWin: wins ? grossWin / wins : null,
    avgLoss: losses ? -(grossLoss / losses) : null,
    // Infinity when there are wins and no losses at all — displayed as ∞, not a
    // divide-by-zero crash.
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    expectancy: netPnl / n,
    best, worst,
    avgHoldDays: hold / n,
  };
}

// Local-time bucket key. Realized P&L is grouped by the day the trade CLOSED,
// which is when the money actually moved.
function bucketKey(date, period) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  if (period === 'month') return `${y}-${m}`;
  if (period === 'week') {
    // ISO week, so weeks line up with how brokers and calendars report them.
    const t = new Date(Date.UTC(y, date.getMonth(), date.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((t - yearStart) / 86400_000) + 1) / 7);
    return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return `${y}-${m}-${d}`;
}

// Realized P&L grouped by day / week / month, newest first, with a running total.
export function groupByPeriod(trades, period = 'day') {
  const map = new Map();
  for (const t of trades) {
    if (!t.exitTime) continue;
    const key = bucketKey(t.exitTime, period);
    if (!map.has(key)) map.set(key, { key, trades: 0, wins: 0, losses: 0, pnl: 0 });
    const b = map.get(key);
    b.trades++; b.pnl += t.pnl;
    if (t.pnl >= 0) b.wins++; else b.losses++;
  }
  const rows = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  let running = 0;
  for (const r of rows) { running += r.pnl; r.cumulative = running; r.winRate = r.trades ? r.wins / r.trades : null; }
  return rows.reverse();
}

// Per-symbol breakdown — which names actually make or lose the money.
export function groupBySymbol(trades) {
  const map = new Map();
  for (const t of trades) {
    if (!map.has(t.symbol)) map.set(t.symbol, { symbol: t.symbol, trades: 0, wins: 0, pnl: 0 });
    const b = map.get(t.symbol);
    b.trades++; b.pnl += t.pnl;
    if (t.pnl >= 0) b.wins++;
  }
  return [...map.values()]
    .map(b => ({ ...b, winRate: b.trades ? b.wins / b.trades : null }))
    .sort((a, b) => b.pnl - a.pnl);
}

// Peak-to-trough drawdown of the REALIZED equity curve (closed trades only).
// Not the same as account drawdown, which also moves with open positions.
export function realizedDrawdown(trades) {
  let peak = 0, equity = 0, maxDd = 0, maxDdPct = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) { maxDd = dd; maxDdPct = peak > 0 ? (dd / peak) * 100 : 0; }
  }
  return { maxDrawdown: maxDd, maxDrawdownPct: maxDdPct };
}
