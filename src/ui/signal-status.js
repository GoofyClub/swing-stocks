// =============================================================================
// Shared helpers for signal/trade row badges. Used by Signal History, Live
// Signals (cron mode), Dashboard, and My Trades so the UX is consistent.
//
// entryStatus — describes whether a signal is still actionable given today's
// price. Computed at render time from the latest currentPrice the cron wrote.
//
//   'tp_hit'      currentPrice >= TP                — trade target reached
//   'invalidated' currentPrice <= SL                — setup broke, don't enter
//   'missed'      currentPrice > entry × 1.02       — ran away from entry zone
//   'active'      else (within reasonable distance) — still tradeable
//   null          missing currentPrice              — no live update yet
//
// multiSignal — given a list of signals, return a Set of tickers that appear
// in more than one strategy. UI uses this to badge double-occurrence rows so
// users don't accidentally size two positions on the same name.
// =============================================================================

const MISS_ABOVE_ENTRY = 0.02;  // 2% above entry = too late to enter

export function computeEntryStatus(row) {
  const cur   = row.currentPrice ?? row.current ?? null;
  const entry = row.entryPrice   ?? row.entry   ?? null;
  const tp    = row.tpPrice      ?? row.tp      ?? null;
  const sl    = row.slPrice      ?? row.sl      ?? null;
  if (!Number.isFinite(cur) || !Number.isFinite(entry)) return null;
  if (Number.isFinite(tp) && cur >= tp) return 'tp_hit';
  if (Number.isFinite(sl) && cur <= sl) return 'invalidated';
  if (cur > entry * (1 + MISS_ABOVE_ENTRY)) return 'missed';
  return 'active';
}

export function entryStatusBadge(status) {
  switch (status) {
    case 'tp_hit':      return '<span class="badge win"  title="Price has reached the take-profit level — too late, trade already worked">TP HIT</span>';
    case 'invalidated': return '<span class="badge loss" title="Price broke the stop-loss level — setup invalidated, do not enter">INVALIDATED</span>';
    case 'missed':      return '<span class="badge"      style="color:var(--amber);border-color:var(--amber)" title="Price has moved more than 2% above the entry — entry zone passed">MISSED</span>';
    case 'active':      return '<span class="badge"      style="color:var(--cyan);border-color:var(--cyan)" title="Price is still in the entry zone — actionable now">ACTIVE</span>';
    default:            return '<span class="badge">—</span>';
  }
}

// R:R warning — a small badge next to TP for trades with marginal reward/risk.
// Used in addition to the rejection in applyTarget so users can SEE that the
// trade is right at the threshold even when it's not auto-rejected.
export function lowRBadge(expectedR) {
  if (!Number.isFinite(expectedR)) return '';
  if (expectedR < 1.5) return ' <span class="badge loss" title="Reward/risk below 1.5R — poor expectancy">LOW R</span>';
  if (expectedR < 2)   return ' <span class="badge"      style="color:var(--amber);border-color:var(--amber)" title="Reward/risk below 2R — marginal">${expectedR.toFixed(1)}R</span>';
  return '';
}

// Multi-signal helper. Returns:
//   { tickerCount: Map<ticker, count>, multiTickers: Set<ticker> }
// where multiTickers contains every ticker present in >= 2 distinct strategies.
export function indexMultiSignal(rows, tickerKey = 'ticker', stratKey = 'strategy') {
  const seen = new Map(); // ticker -> Set<strategy>
  for (const r of rows) {
    const tk = r[tickerKey];
    if (!tk) continue;
    if (!seen.has(tk)) seen.set(tk, new Set());
    seen.get(tk).add(r[stratKey] || '_');
  }
  const tickerCount = new Map();
  const multiTickers = new Set();
  for (const [tk, strats] of seen) {
    tickerCount.set(tk, strats.size);
    if (strats.size >= 2) multiTickers.add(tk);
  }
  return { tickerCount, multiTickers };
}

export function multiSignalBadge(ticker, multiTickers, tickerCount) {
  if (!multiTickers.has(ticker)) return '';
  const n = tickerCount.get(ticker) || 0;
  return ` <span class="badge" style="color:var(--violet);border-color:var(--violet)" title="${ticker} appears in ${n} strategies — do not double-size if you act on more than one">MULTI×${n}</span>`;
}
