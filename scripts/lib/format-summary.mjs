// =============================================================================
// The end-of-day summary message.
//
// One message after the close that answers, in order: did the account move, what
// opened and closed today, what is still held overnight, and is anything wrong.
//
// It states what DIDN'T happen as well as what did. A quiet day and a broken day
// look identical from silence, and this system has already demonstrated that
// failure mode — the entry runner died on quota for three consecutive sessions
// and the only symptom was the absence of messages nobody was expecting.
// =============================================================================

import { esc, b, i, fit } from './tg.mjs';

const usd = (n) => (n == null || !Number.isFinite(n)) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
const pct = (n) => (n == null || !Number.isFinite(n)) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const mark = (n) => !Number.isFinite(n) ? '·' : n >= 0 ? '🟢' : '🔴';

// `closed` rows: { ticker, realizedPct, realizedR, realizedPnl, realizedWinLoss, realizedExitReason }
// `opened` rows: { ticker, qty, entry }
// `held`   rows: { symbol, qty, unrealizedPl, avgEntry }
export function formatDailySummary({
  label = 'Swing',
  date,
  equity,
  dayPl,
  dayPlPct,
  opened = [],
  closed = [],
  held = [],
  skipped = 0,
  scanned = null,
  drawdownPct = null,
  halted = false,
  problems = [],
  dryRun = false,
} = {}) {
  const out = [];

  out.push(`${mark(dayPl)} ${b(`${label} — ${date || 'today'}`)}`);
  out.push(`equity ${b(usd(equity))} · today ${usd(dayPl)} (${pct(dayPlPct)})${dryRun ? `  ${i('DRY RUN')}` : ''}`);

  // Problems first. A summary that buries a failure under trade counts is how a
  // broken system reads as a slow one.
  if (problems.length) {
    out.push('');
    for (const p of problems) out.push(`⚠️ ${esc(p)}`);
  }
  if (halted) {
    out.push('');
    out.push(`⛔ ${b('DRAWDOWN HALT ACTIVE')} — no new entries${drawdownPct != null ? ` (${drawdownPct.toFixed(1)}% from peak)` : ''}`);
  }

  // ---- closed today --------------------------------------------------------
  if (closed.length) {
    const net = closed.reduce((s, t) => s + (Number(t.realizedPnl) || 0), 0);
    const wins = closed.filter(t => t.realizedWinLoss === 'win').length;
    out.push('');
    out.push(`${b(`Closed (${closed.length})`)} ${i(`${wins}W / ${closed.length - wins}L · net ${usd(net)}`)}`);
    for (const t of closed) {
      out.push(`${mark(Number(t.realizedPnl))} <b>${esc(t.ticker)}</b> ${pct(Number(t.realizedPct))}`
        + `${Number.isFinite(Number(t.realizedR)) ? ` · ${Number(t.realizedR).toFixed(2)}R` : ''}`
        + ` · ${usd(Number(t.realizedPnl))}`
        + `${t.realizedExitReason ? ` ${i(`(${t.realizedExitReason})`)}` : ''}`);
    }
  }

  // ---- opened today --------------------------------------------------------
  out.push('');
  if (opened.length) {
    out.push(b(`Opened (${opened.length})`));
    for (const o of opened) {
      out.push(`🟦 <b>${esc(o.ticker)}</b> ×${esc(o.qty)} @ ${Number(o.entry).toFixed(2)}`);
    }
  } else {
    // Say WHY nothing opened. "No entries" is ambiguous between a working system
    // with no qualifying signals and a system that never ran.
    out.push(`${b('Opened')} — none`
      + (scanned != null ? ` ${i(`(${scanned} candidate${scanned === 1 ? '' : 's'} scanned, ${skipped} filtered out)`)}` : ''));
  }

  // ---- still held ----------------------------------------------------------
  out.push('');
  if (held.length) {
    const openPl = held.reduce((s, p) => s + (Number(p.unrealizedPl) || 0), 0);
    out.push(`${b(`Held overnight (${held.length})`)} ${i(`unrealized ${usd(openPl)}`)}`);
    for (const p of held) {
      out.push(`${mark(Number(p.unrealizedPl))} <b>${esc(p.symbol)}</b> ×${esc(p.qty)} · ${usd(Number(p.unrealizedPl))}`);
    }
  } else {
    out.push(`${b('Held overnight')} — flat`);
  }

  return fit(out.join('\n'));
}
