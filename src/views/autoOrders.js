// Auto Orders — read-only view of what the auto-trade worker did, from the
// per-user journal at /users/{uid}/autoOrders/{clientOrderId}.
//
// Each order references the signal it came from (signalId + sessionDate). We join
// to that settled signal (/marketData/{sessionDate}/signals/{signalId}) to show
// the trade's OUTCOME — win/loss, realized %, R multiple, and $ P&L — plus a
// timeframe filter and a performance summary, mirroring the Signal History tab.
// The bracket TP/SL exit price isn't in the journal, so the settled signal (same
// entry/TP/SL geometry, same settlement logic) is the source of truth for result.

import { collection, getDocs, doc, getDoc } from 'firebase/firestore';
import { initFirebase } from '../data/firebase.js';
import { sectorName } from '../data/markets.js';
import { mobileRowsHTML, isPhoneLayout } from '../ui/mobile-rows.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTs(ts) {
  if (!ts) return '—';
  try { return (ts.toDate ? ts.toDate() : new Date(ts)).toLocaleString(); } catch { return '—'; }
}
function orderMillis(o) {
  const c = o.createdAt;
  if (c?.toMillis) return c.toMillis();
  if (c) { const t = new Date(c).getTime(); if (Number.isFinite(t)) return t; }
  return 0;
}

// --- Realized-performance helpers (same math as Signal History) --------------
// A CLOSED trade's return is frozen at its EXIT price (signal.hitPrice); open
// trades use the live mark. Returns null when there isn't enough to compute.
function pctFor(s) {
  if (!s) return null;
  if (s.status === 'closed' && s.hitPrice != null && s.entryPrice) {
    return ((s.hitPrice - s.entryPrice) / s.entryPrice) * 100;
  }
  if (s.pctChange != null) return s.pctChange;
  if (s.currentPrice != null && s.entryPrice) return ((s.currentPrice - s.entryPrice) / s.entryPrice) * 100;
  return null;
}
// Stop distance as % of entry (the risk taken).
function slPctFor(s) {
  if (!s) return null;
  if (s.slPct != null && s.slPct > 0) return s.slPct;
  if (s.entryPrice && s.slPrice != null && s.entryPrice > s.slPrice) {
    return ((s.entryPrice - s.slPrice) / s.entryPrice) * 100;
  }
  return null;
}
// Outcome R once CLOSED (realized return ÷ risk taken). Null while open.
function resultRFor(s) {
  if (!s || s.status !== 'closed') return null;
  const p = pctFor(s), slp = slPctFor(s);
  if (p == null || slp == null) return null;
  return p / slp;
}
// The trade outcome for one order. Prefers the worker's broker-realized fields
// (actual exit fill → the true win/loss, %, R, $) recorded on the order doc;
// falls back to the settled signal it came from when realized data isn't there
// yet (e.g. still-open trade, or a run hasn't journaled it).
function outcomeFor(o) {
  // 1) Broker-realized outcome (authoritative, owned on the order).
  if (o.realizedWinLoss || o.realizedPct != null) {
    const pct = o.realizedPct ?? null;
    return {
      closed: true, pct,
      r: o.realizedR ?? null,
      winLoss: o.realizedWinLoss || (pct != null ? (pct >= 0 ? 'win' : 'loss') : null),
      pnl: o.realizedPnl ?? null,
      filled: true, source: 'broker',
    };
  }
  // 2) Settled-signal fallback (proxy — same entry/TP/SL geometry).
  const s = o._sig;
  if (!s) return null;
  const closed = s.status === 'closed';
  const pct = pctFor(s);
  const r = resultRFor(s);
  const winLoss = closed ? (s.winLoss || (pct != null ? (pct >= 0 ? 'win' : 'loss') : null)) : null;
  const entryPx = o.filledAvgPrice ?? o.entry ?? s.entryPrice ?? null;
  const qty = o.filledQty || o.qty || 0;
  // Real $ only for actually-filled (non-dry-run) trades; hypothetical otherwise.
  const filled = !o.dryRun && o.status !== 'dryrun' && qty > 0 && entryPx != null;
  const pnl = (closed && pct != null && filled) ? qty * entryPx * (pct / 100) : null;
  return { closed, pct, r, winLoss, pnl, filled, source: 'signal' };
}

async function loadAutoOrders() {
  const { db, ok } = initFirebase();
  if (!ok) return { orders: [], equity: [] };
  const auth = (await import('firebase/auth')).getAuth();
  const user = auth.currentUser;
  if (!user) return { orders: [], equity: [] };
  const [ordSnap, eqSnap] = await Promise.all([
    getDocs(collection(db, 'users', user.uid, 'autoOrders')),
    getDocs(collection(db, 'users', user.uid, 'autoEquity')),
  ]);
  const orders = ordSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  orders.sort((a, b) => orderMillis(b) - orderMillis(a));

  // Join each order to its settled signal for outcome data — but ONLY for orders
  // the worker hasn't already realized (those carry their own broker outcome, so
  // no read is needed). De-dupe by sessionDate/signalId so shared signals are read
  // once; failures are non-fatal (the row just shows no result). Skipping realized
  // orders keeps this light on the Firestore read quota.
  try {
    const needsSignal = (o) => !(o.realizedWinLoss || o.realizedPct != null);
    const keyOf = (o) => (needsSignal(o) && o.sessionDate && o.signalId) ? `${o.sessionDate}/${o.signalId}` : null;
    const uniq = [...new Set(orders.map(keyOf).filter(Boolean))];
    const sigMap = new Map();
    await Promise.all(uniq.map(async (k) => {
      const [bucket, ...rest] = k.split('/');
      const signalId = rest.join('/');
      try {
        const snap = await getDoc(doc(db, 'marketData', bucket, 'signals', signalId));
        if (snap.exists()) sigMap.set(k, snap.data());
      } catch { /* ignore per-signal read errors */ }
    }));
    for (const o of orders) { const k = keyOf(o); if (k && sigMap.has(k)) o._sig = sigMap.get(k); }
  } catch { /* leave orders unjoined on any bulk failure */ }

  const equity = eqSnap.docs.map(d => ({ date: d.id, ...d.data() }))
    .filter(e => Number.isFinite(e.equity))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { orders, equity };
}

// Minimal inline SVG line chart of the equity series (no chart lib).
function equitySparkline(series, { w = 640, h = 120 } = {}) {
  if (series.length < 2) return '<div class="empty" style="padding:8px 0">Need at least two daily snapshots to draw the curve.</div>';
  const vals = series.map(s => s.equity);
  const min = Math.min(...vals), max = Math.max(...vals);
  const pad = 6, span = (max - min) || 1;
  const x = (i) => pad + (i / (series.length - 1)) * (w - 2 * pad);
  const y = (v) => pad + (1 - (v - min) / span) * (h - 2 * pad);
  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.equity).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  const color = up ? 'var(--green)' : 'var(--red)';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="display:block">
    <polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}" />
  </svg>`;
}

function statusBadge(o) {
  if (o.dryRun || o.status === 'dryrun') return '<span class="badge">DRY-RUN</span>';
  const s = (o.status || '').toLowerCase();
  if (s === 'filled') return '<span class="badge win">FILLED</span>';
  if (s === 'submitted' || s === 'new' || s === 'accepted') return '<span class="badge open">SUBMITTED</span>';
  if (s === 'exit_submitted') return `<span class="badge open" title="Exit-model liquidation submitted (${escapeHtml(o.exitReason || '')})">EXITING</span>`;
  if (s === 'position_closed') return '<span class="badge" title="Position no longer open at the broker (bracket TP/SL or exit filled)">CLOSED</span>';
  if (s === 'error' || s === 'rejected' || s === 'canceled') return `<span class="badge loss">${escapeHtml((o.status || 'ERROR').toUpperCase())}</span>`;
  return `<span class="badge">${escapeHtml(o.status || '—')}</span>`;
}

// Outcome cells shared by the desktop table. Returns { result, pct, r, pnl } HTML.
function outcomeCells(o) {
  const oc = outcomeFor(o);
  const dash = '<span style="color:var(--text-dim)">—</span>';
  if (!oc) return { result: dash, pct: dash, r: dash, pnl: dash };
  let result = dash;
  if (oc.winLoss === 'win') result = '<span class="badge win">WIN</span>';
  else if (oc.winLoss === 'loss') result = '<span class="badge loss">LOSS</span>';
  else if (!oc.closed && oc.pct != null) result = '<span class="badge open">OPEN</span>';
  const pct = oc.pct == null ? dash
    : `<span style="color:${oc.pct >= 0 ? 'var(--green)' : 'var(--red)'}">${(oc.pct >= 0 ? '+' : '') + oc.pct.toFixed(2)}%</span>`;
  const r = oc.r == null ? dash
    : `<span style="color:${oc.r >= 0 ? 'var(--green)' : 'var(--red)'}">${(oc.r >= 0 ? '+' : '') + oc.r.toFixed(2)}R</span>`;
  const pnl = oc.pnl == null ? dash
    : `<span style="color:${oc.pnl >= 0 ? 'var(--green)' : 'var(--red)'}">${(oc.pnl >= 0 ? '+$' : '-$') + Math.abs(oc.pnl).toFixed(2)}</span>`;
  return { result, pct, r, pnl };
}

// Aggregate performance over a set of orders (scoped to the timeframe filter).
function summarize(rows) {
  let wins = 0, losses = 0, open = 0, sumR = 0, rCount = 0, sumPct = 0, pctCount = 0,
      grossWin = 0, grossLoss = 0, netPnl = 0, pnlCount = 0;
  for (const o of rows) {
    const oc = outcomeFor(o);
    if (!oc) continue;
    if (oc.closed) {
      if (oc.winLoss === 'win') wins++; else if (oc.winLoss === 'loss') losses++;
      if (oc.r != null) { sumR += oc.r; rCount++; }
      if (oc.pct != null) { sumPct += oc.pct; pctCount++; }
      if (oc.pnl != null) { netPnl += oc.pnl; pnlCount++; if (oc.pnl >= 0) grossWin += oc.pnl; else grossLoss += Math.abs(oc.pnl); }
    } else if (oc.pct != null) open++;
  }
  const closed = wins + losses;
  return {
    closed, wins, losses, open,
    winRate: closed ? wins / closed : null,
    avgR: rCount ? sumR / rCount : null,
    netR: rCount ? sumR : null,
    avgPct: pctCount ? sumPct / pctCount : null,
    netPnl: pnlCount ? netPnl : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
  };
}

const TIMEFRAMES = [
  { days: 7, label: '7D' }, { days: 30, label: '30D' },
  { days: 90, label: '90D' }, { days: 0, label: 'All' },
];
let activeDays = 90; // default window (mirrors Signal History)

export async function renderAutoOrders(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Auto Orders</h1>
      <p class="subtitle">How the automated account is performing, plus every decision the worker recorded — dry-run intents and real orders. Win/loss, %, R and P&L come from the settled signal each order was based on. Read-only; configure rules on the <a href="#/automation" style="color:var(--cyan)">Automation</a> page.</p>
      <div id="ao-equity"></div>
      <div class="card" id="ao-controls" style="display:none">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span style="color:var(--text-mute);font-size:0.8rem;text-transform:uppercase;letter-spacing:0.06em">Timeframe</span>
          <div id="ao-tf" style="display:flex;gap:6px;flex-wrap:wrap">
            ${TIMEFRAMES.map(tf => `<button class="btn-bare tf-chip${tf.days === activeDays ? ' active' : ''}" data-days="${tf.days}">${tf.label}</button>`).join('')}
          </div>
        </div>
      </div>
      <div id="ao-summary"></div>
      <div class="card"><h2>Order journal <span class="count" id="ao-count"></span></h2><div id="ao-table"><div class="empty">Loading…</div></div></div>
    </div>
  `;

  let rows = [], equity = [];
  try { ({ orders: rows, equity } = await loadAutoOrders()); }
  catch (e) {
    document.getElementById('ao-table').innerHTML = `<div class="empty" style="text-align:left"><b>Couldn't load auto orders.</b><br><span style="color:var(--red);font-family:var(--font-mono);font-size:0.9rem">${escapeHtml(e.message)}</span></div>`;
    return;
  }

  // ---- Equity / P&L summary (unchanged) ----
  const eqEl = document.getElementById('ao-equity');
  if (equity.length) {
    const start = equity[0].equity, cur = equity[equity.length - 1].equity;
    const peak = Math.max(...equity.map(e => e.equity));
    const chg = cur - start, chgPct = start > 0 ? (chg / start) * 100 : 0;
    const ddNow = peak > 0 ? ((peak - cur) / peak) * 100 : 0;
    const stat = (label, val, color) => `<div style="display:flex;flex-direction:column;gap:2px">
      <span style="color:var(--text-mute);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em">${label}</span>
      <span style="font-family:var(--font-mono);font-size:1.1rem;${color ? `color:${color}` : ''}">${val}</span></div>`;
    eqEl.innerHTML = `<div class="card">
      <h2>Account equity <span class="count">(${equity.length} day${equity.length === 1 ? '' : 's'})</span></h2>
      <div style="display:flex;gap:28px;flex-wrap:wrap;margin-bottom:12px">
        ${stat('Current', '$' + cur.toFixed(2))}
        ${stat('Change', (chg >= 0 ? '+$' : '-$') + Math.abs(chg).toFixed(2) + ` (${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)`, chg >= 0 ? 'var(--green)' : 'var(--red)')}
        ${stat('Peak', '$' + peak.toFixed(2))}
        ${stat('Drawdown from peak', '-' + ddNow.toFixed(2) + '%', ddNow > 0 ? 'var(--red)' : 'var(--text)')}
      </div>
      ${equitySparkline(equity)}
      <div style="color:var(--text-dim);font-size:0.8rem;font-family:var(--font-mono);margin-top:4px">${escapeHtml(equity[0].date)} → ${escapeHtml(equity[equity.length - 1].date)}</div>
    </div>`;
  }

  if (!rows.length) {
    document.getElementById('ao-summary').innerHTML = '';
    document.getElementById('ao-table').innerHTML = `<div class="empty">
      <b>No auto orders yet.</b><br><br>
      Orders appear here after the <b>Auto-trade (paper)</b> GitHub Action runs for an account with automation enabled.
      It starts in dry-run mode, so the first entries will be <b>DRY-RUN</b> intents — what it <i>would</i> have placed.
    </div>`;
    return;
  }

  document.getElementById('ao-controls').style.display = '';

  // Render summary + table for the active timeframe; re-runs on chip change.
  function apply() {
    const cutoff = activeDays > 0 ? Date.now() - activeDays * 86400_000 : 0;
    const filtered = activeDays > 0 ? rows.filter(o => orderMillis(o) >= cutoff) : rows;
    renderSummary(filtered);
    renderTable(filtered);
    document.getElementById('ao-count').textContent = `(${filtered.length}${filtered.length !== rows.length ? ` of ${rows.length}` : ''})`;
  }

  function renderSummary(filtered) {
    const s = summarize(filtered);
    const el = document.getElementById('ao-summary');
    if (!s.closed && !s.open) { el.innerHTML = ''; return; }
    const c = (v, up) => up == null ? '' : `color:${up ? 'var(--green)' : 'var(--red)'}`;
    const stat = (label, val, style = '') => `<div style="display:flex;flex-direction:column;gap:2px">
      <span style="color:var(--text-mute);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.06em">${label}</span>
      <span style="font-family:var(--font-mono);font-size:1.1rem;${style}">${val}</span></div>`;
    const wr = s.winRate == null ? '—' : Math.round(s.winRate * 100) + '%';
    const wrStyle = s.winRate == null ? '' : c(null, s.winRate >= 0.5) || `color:${s.winRate >= 0.55 ? 'var(--green)' : s.winRate <= 0.4 ? 'var(--red)' : 'var(--amber)'}`;
    const pf = s.profitFactor == null ? '—' : (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2));
    el.innerHTML = `<div class="card">
      <h2>Performance summary <span class="count">(${s.closed} closed · ${s.open} open)</span></h2>
      <div style="display:flex;gap:28px;flex-wrap:wrap">
        ${stat('Trades', String(s.closed))}
        ${stat('Win rate', wr, s.winRate == null ? '' : `color:${s.winRate >= 0.55 ? 'var(--green)' : s.winRate <= 0.4 ? 'var(--red)' : 'var(--amber)'}`)}
        ${stat('Wins / Losses', `${s.wins} / ${s.losses}`)}
        ${stat('Net R', s.netR == null ? '—' : (s.netR >= 0 ? '+' : '') + s.netR.toFixed(2) + 'R', c(null, s.netR == null ? null : s.netR >= 0))}
        ${stat('Avg R', s.avgR == null ? '—' : (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R', c(null, s.avgR == null ? null : s.avgR >= 0))}
        ${stat('Avg %', s.avgPct == null ? '—' : (s.avgPct >= 0 ? '+' : '') + s.avgPct.toFixed(2) + '%', c(null, s.avgPct == null ? null : s.avgPct >= 0))}
        ${stat('Realized P&L', s.netPnl == null ? '—' : (s.netPnl >= 0 ? '+$' : '-$') + Math.abs(s.netPnl).toFixed(2), c(null, s.netPnl == null ? null : s.netPnl >= 0))}
        ${stat('Profit factor', pf)}
      </div>
      <div style="color:var(--text-dim);font-size:0.8rem;margin-top:8px">Result, %, R and Realized P&L are from the settled signal each order was based on. Open trades are marked while unsettled and excluded from realized totals.</div>
    </div>`;
  }

  function renderTable(filtered) {
    const tableEl = document.getElementById('ao-table');
    if (!filtered.length) { tableEl.innerHTML = `<div class="empty">No auto orders in this window.</div>`; return; }

    if (isPhoneLayout()) {
      tableEl.innerHTML = `<div class="tbl-mobile-switch">${mobileRowsHTML(filtered.map(o => {
        const oc = outcomeFor(o);
        const nums = [
          { k: 'E', v: o.entry != null ? Number(o.entry).toFixed(2) : '—' },
          { k: 'TP', v: o.tp != null ? Number(o.tp).toFixed(2) : '—', color: 'var(--green)' },
          { k: 'SL', v: o.sl != null ? Number(o.sl).toFixed(2) : '—', color: 'var(--red)' },
          { k: 'Qty', v: String(o.qty ?? '—') },
        ];
        // Outcome badge shown ON the row (not hidden in the expander), so win/loss
        // reads at a glance on phones — matching the desktop RESULT column.
        const resultBadge = oc && oc.winLoss === 'win' ? '<span class="badge win">WIN</span>'
          : oc && oc.winLoss === 'loss' ? '<span class="badge loss">LOSS</span>'
          : oc && !oc.closed && oc.pct != null ? '<span class="badge open">OPEN</span>' : '';
        // Right-aligned figure on line 3: realized R when known, else %.
        const right = oc && oc.r != null
          ? { v: (oc.r >= 0 ? '+' : '') + oc.r.toFixed(2) + 'R', color: oc.r >= 0 ? 'var(--green)' : 'var(--red)' }
          : oc && oc.pct != null
            ? { v: (oc.pct >= 0 ? '+' : '') + oc.pct.toFixed(2) + '%', color: oc.pct >= 0 ? 'var(--green)' : 'var(--red)' }
            : null;
        const detail = [];
        if (oc && (oc.closed || oc.pct != null)) {
          if (oc.pct != null) detail.push({ k: '%', v: (oc.pct >= 0 ? '+' : '') + oc.pct.toFixed(2) + '%' });
          if (oc.r != null) detail.push({ k: 'R', v: (oc.r >= 0 ? '+' : '') + oc.r.toFixed(2) + 'R' });
          if (oc.pnl != null) detail.push({ k: 'P&L', v: (oc.pnl >= 0 ? '+$' : '-$') + Math.abs(oc.pnl).toFixed(2) });
        }
        detail.push({ k: 'Risk', v: o.dollarRisk != null ? '$' + Number(o.dollarRisk).toFixed(0) : '—' });
        detail.push({ k: 'Mode', v: escapeHtml(o.mode || '—') + (o.live ? ' <span class="badge loss">LIVE</span>' : '') });
        detail.push({ k: 'Tier', v: escapeHtml(o.tier || '—') });
        detail.push({ k: 'When', v: escapeHtml(fmtTs(o.createdAt)) });
        if (o.error) detail.push({ k: 'Error', v: escapeHtml(o.error), wide: true });
        return {
          ticker: escapeHtml(o.ticker || ''),
          name: escapeHtml(o.strategy || o.strategyKey || ''),
          badgesHtml: `<span class="badge ${o.side === 'sell' ? 'loss' : 'open'}">${escapeHtml(o.side || '—')}</span>` + resultBadge + statusBadge(o),
          meta: [escapeHtml(sectorName(o.sector) || ''), escapeHtml(fmtTs(o.createdAt))].filter(Boolean).join(' · '),
          nums,
          right,
          detail,
        };
      }))}</div>`;
      return;
    }

    tableEl.innerHTML = `
      <table class="data">
        <thead><tr>
          <th>WHEN</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th><th>TIER</th><th>SIDE</th>
          <th class="num">QTY</th><th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th>
          <th>RESULT</th><th class="num">%</th><th class="num">R</th><th class="num">P&L</th>
          <th class="num">RISK $</th><th>MODE</th><th>STATUS</th>
        </tr></thead>
        <tbody>
          ${filtered.map(o => {
            const oc = outcomeCells(o);
            return `<tr title="${o.error ? escapeHtml(o.error) : ''}">
            <td>${escapeHtml(fmtTs(o.createdAt))}</td>
            <td>${escapeHtml(o.ticker || '')}</td>
            <td title="${escapeHtml(o.sector || '')}">${escapeHtml(sectorName(o.sector) || '—')}</td>
            <td>${escapeHtml(o.strategy || o.strategyKey || '—')}</td>
            <td>${escapeHtml(o.tier || '—')}</td>
            <td>${escapeHtml(o.side || '')}</td>
            <td class="num">${o.qty ?? '—'}</td>
            <td class="num">${o.entry != null ? Number(o.entry).toFixed(2) : '—'}</td>
            <td class="num" style="color:var(--green)">${o.tp != null ? Number(o.tp).toFixed(2) : '—'}</td>
            <td class="num" style="color:var(--red)">${o.sl != null ? Number(o.sl).toFixed(2) : '—'}</td>
            <td>${oc.result}</td>
            <td class="num">${oc.pct}</td>
            <td class="num">${oc.r}</td>
            <td class="num">${oc.pnl}</td>
            <td class="num">${o.dollarRisk != null ? '$' + Number(o.dollarRisk).toFixed(0) : '—'}</td>
            <td>${escapeHtml(o.mode || '—')}${o.live ? ' <span class="badge loss">LIVE</span>' : ''}</td>
            <td>${statusBadge(o)}</td>
          </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  // Wire timeframe chips.
  const tf = document.getElementById('ao-tf');
  tf.addEventListener('click', (e) => {
    const btn = e.target.closest('.tf-chip');
    if (!btn) return;
    activeDays = Number(btn.dataset.days);
    tf.querySelectorAll('.tf-chip').forEach(b => b.classList.toggle('active', b === btn));
    apply();
  });

  apply();
}
