// Auto Orders — read-only view of what the auto-trade worker did, from the
// per-user journal at /users/{uid}/autoOrders/{clientOrderId}.

import { collection, getDocs } from 'firebase/firestore';
import { initFirebase } from '../data/firebase.js';
import { sectorName } from '../data/markets.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTs(ts) {
  if (!ts) return '—';
  try { return (ts.toDate ? ts.toDate() : new Date(ts)).toLocaleString(); } catch { return '—'; }
}

async function loadAutoOrders() {
  const { db, ok } = initFirebase();
  if (!ok) return [];
  const auth = (await import('firebase/auth')).getAuth();
  const user = auth.currentUser;
  if (!user) return [];
  const snap = await getDocs(collection(db, 'users', user.uid, 'autoOrders'));
  const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  rows.sort((a, b) => {
    const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : 0;
    const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : 0;
    return bt - at;
  });
  return rows;
}

function statusBadge(o) {
  if (o.dryRun || o.status === 'dryrun') return '<span class="badge">DRY-RUN</span>';
  const s = (o.status || '').toLowerCase();
  if (s === 'filled') return '<span class="badge win">FILLED</span>';
  if (s === 'submitted' || s === 'new' || s === 'accepted') return '<span class="badge open">SUBMITTED</span>';
  if (s === 'error' || s === 'rejected' || s === 'canceled') return `<span class="badge loss">${escapeHtml((o.status || 'ERROR').toUpperCase())}</span>`;
  return `<span class="badge">${escapeHtml(o.status || '—')}</span>`;
}

export async function renderAutoOrders(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Auto Orders</h1>
      <p class="subtitle">Every decision the auto-trade worker recorded — dry-run intents and real orders. Read-only; configure rules on the <a href="#/automation" style="color:var(--cyan)">Automation</a> page.</p>
      <div class="card"><div id="ao-table"><div class="empty">Loading…</div></div></div>
    </div>
  `;

  let rows = [];
  try { rows = await loadAutoOrders(); }
  catch (e) {
    document.getElementById('ao-table').innerHTML = `<div class="empty" style="text-align:left"><b>Couldn't load auto orders.</b><br><span style="color:var(--red);font-family:var(--font-mono);font-size:0.9rem">${escapeHtml(e.message)}</span></div>`;
    return;
  }

  if (!rows.length) {
    document.getElementById('ao-table').innerHTML = `<div class="empty">
      <b>No auto orders yet.</b><br><br>
      Orders appear here after the <b>Auto-trade (paper)</b> GitHub Action runs for an account with automation enabled.
      It starts in dry-run mode, so the first entries will be <b>DRY-RUN</b> intents — what it <i>would</i> have placed.
    </div>`;
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
