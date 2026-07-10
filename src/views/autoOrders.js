// Auto Orders — read-only view of what the auto-trade worker did, from the
// per-user journal at /users/{uid}/autoOrders/{clientOrderId}.

import { collection, getDocs } from 'firebase/firestore';
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
  orders.sort((a, b) => {
    const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return bt - at;
  });
  // Equity snapshots are keyed by date (doc id = YYYY-MM-DD) — sort ascending.
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

export async function renderAutoOrders(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Auto Orders</h1>
      <p class="subtitle">How the automated account is performing, plus every decision the worker recorded — dry-run intents and real orders. Read-only; configure rules on the <a href="#/automation" style="color:var(--cyan)">Automation</a> page.</p>
      <div id="ao-equity"></div>
      <div class="card"><h2>Order journal</h2><div id="ao-table"><div class="empty">Loading…</div></div></div>
    </div>
  `;

  let rows = [], equity = [];
  try { ({ orders: rows, equity } = await loadAutoOrders()); }
  catch (e) {
    document.getElementById('ao-table').innerHTML = `<div class="empty" style="text-align:left"><b>Couldn't load auto orders.</b><br><span style="color:var(--red);font-family:var(--font-mono);font-size:0.9rem">${escapeHtml(e.message)}</span></div>`;
    return;
  }

  // ---- Equity / P&L summary ----
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
    document.getElementById('ao-table').innerHTML = `<div class="empty">
      <b>No auto orders yet.</b><br><br>
      Orders appear here after the <b>Auto-trade (paper)</b> GitHub Action runs for an account with automation enabled.
      It starts in dry-run mode, so the first entries will be <b>DRY-RUN</b> intents — what it <i>would</i> have placed.
    </div>`;
    return;
  }

  // Compact 3-line rows for phones (≤640px); table only on desktop.
  if (isPhoneLayout()) {
    document.getElementById('ao-table').innerHTML = `<div class="tbl-mobile-switch">${mobileRowsHTML(rows.map(o => {
      const nums = [
        { k: 'E', v: o.entry != null ? Number(o.entry).toFixed(2) : '—' },
        { k: 'TP', v: o.tp != null ? Number(o.tp).toFixed(2) : '—', color: 'var(--green)' },
        { k: 'SL', v: o.sl != null ? Number(o.sl).toFixed(2) : '—', color: 'var(--red)' },
        { k: 'Qty', v: String(o.qty ?? '—') },
      ];
      const detail = [
        { k: 'Risk', v: o.dollarRisk != null ? '$' + Number(o.dollarRisk).toFixed(0) : '—' },
        { k: 'Mode', v: escapeHtml(o.mode || '—') + (o.live ? ' <span class="badge loss">LIVE</span>' : '') },
        { k: 'Tier', v: escapeHtml(o.tier || '—') },
        { k: 'When', v: escapeHtml(fmtTs(o.createdAt)) },
      ];
      if (o.error) detail.push({ k: 'Error', v: escapeHtml(o.error), wide: true });
      return {
        ticker: escapeHtml(o.ticker || ''),
        name: escapeHtml(o.strategy || o.strategyKey || ''),
        badgesHtml: `<span class="badge ${o.side === 'sell' ? 'loss' : 'open'}">${escapeHtml(o.side || '—')}</span>` + statusBadge(o),
        meta: [escapeHtml(sectorName(o.sector) || ''), escapeHtml(fmtTs(o.createdAt))].filter(Boolean).join(' · '),
        nums,
        detail,
      };
    }))}</div>`;
    return;
  }

  document.getElementById('ao-table').innerHTML = `
    <table class="data">
      <thead><tr>
        <th>WHEN</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th><th>TIER</th><th>SIDE</th>
        <th class="num">QTY</th><th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th>
        <th class="num">RISK $</th><th>MODE</th><th>STATUS</th>
      </tr></thead>
      <tbody>
        ${rows.map(o => `<tr title="${o.error ? escapeHtml(o.error) : ''}">
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
          <td class="num">${o.dollarRisk != null ? '$' + Number(o.dollarRisk).toFixed(0) : '—'}</td>
          <td>${escapeHtml(o.mode || '—')}${o.live ? ' <span class="badge loss">LIVE</span>' : ''}</td>
          <td>${statusBadge(o)}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
}
