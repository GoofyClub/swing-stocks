// My Trades — read /users/{uid}/enteredTrades.

import { state } from '../core/state.js';
import { initFirebase } from '../data/firebase.js';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderMyTrades(root) {
  root.innerHTML = `
    <div class="view">
      <h1>My Trades</h1>
      <p class="subtitle">Signals you have entered. Synced across devices.</p>
      <div class="card" id="totals">
        <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
          <div><span class="badge">window</span> last 30 days</div>
          <div id="agg" style="color:var(--text-dim);font-family:var(--font-mono);font-size:11px">—</div>
        </div>
      </div>
      <div class="card"><div id="trades-table"><div class="empty">Loading…</div></div></div>
    </div>
  `;

  if (!state.user) {
    document.getElementById('trades-table').innerHTML = `<div class="empty">Sign in to see your trades.</div>`;
    return;
  }
  const { db, ok } = initFirebase();
  if (!ok) {
    document.getElementById('trades-table').innerHTML = `<div class="empty">Firebase not configured. See SETUP.md.</div>`;
    return;
  }
  let trades = [];
  try {
    const ref = collection(db, 'users', state.user.uid, 'enteredTrades');
    const snap = await getDocs(query(ref, orderBy('enteredAt', 'desc'), limit(500)));
    trades = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[mytrades] empty collection or error:', e.message);
  }

  // Aggregate over 30d window
  const cutoff = Date.now() - 30 * 86400_000;
  const recent = trades.filter(t => {
    const ts = t.enteredAt?.toMillis ? t.enteredAt.toMillis() : new Date(t.enteredAt || 0).getTime();
    return ts >= cutoff;
  });
  const winCount  = recent.filter(t => t.winLoss === 'win').length;
  const lossCount = recent.filter(t => t.winLoss === 'loss').length;
  const closed    = winCount + lossCount;
  const totalPL   = recent.reduce((s, t) => s + (t.realizedPct ?? t.unrealizedPct ?? 0), 0);
  document.getElementById('agg').innerHTML = recent.length
    ? `<b style="color:var(--text)">${recent.length}</b> trades · win rate <b style="color:var(--text)">${closed ? Math.round((winCount/closed)*100) : 0}%</b> · total P/L <b style="color:${totalPL >= 0 ? 'var(--green)' : 'var(--red)'}">${totalPL >= 0 ? '+' : ''}${totalPL.toFixed(2)}%</b>`
    : 'no trades in the last 30 days';

  if (!trades.length) {
    document.getElementById('trades-table').innerHTML = `<div class="empty">You haven't entered any signals yet. Open Signal History and click the ★ on any row to track it here.</div>`;
    return;
  }
  document.getElementById('trades-table').innerHTML = `
    <table class="data">
      <thead><tr>
        <th>ENTERED</th><th>NAME</th><th>TICKER</th><th>STRATEGY</th>
        <th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th>
        <th class="num">P/L</th><th>STATUS</th><th>NOTES</th>
      </tr></thead>
      <tbody>
        ${trades.map(t => {
          const pl = t.realizedPct ?? t.unrealizedPct ?? null;
          const status = t.status === 'closed'
            ? (t.winLoss === 'win' ? '<span class="badge win">WIN</span>' : '<span class="badge loss">LOSS</span>')
            : '<span class="badge open">open</span>';
          return `<tr>
            <td>${escapeHtml((t.enteredAt?.toDate?.()?.toISOString?.() || t.enteredAt || '').slice(0,10))}</td>
            <td>${escapeHtml(t.name || '—')}</td>
            <td>${escapeHtml(t.ticker || '')}</td>
            <td>${escapeHtml(t.strategy || '—')}</td>
            <td class="num">${(t.overrideEntryPrice ?? t.entryPrice ?? 0).toFixed(2)}</td>
            <td class="num">${(t.tpPrice ?? 0).toFixed(2)}</td>
            <td class="num">${(t.slPrice ?? 0).toFixed(2)}</td>
            <td class="num" style="color:${pl == null ? 'var(--text-dim)' : pl >= 0 ? 'var(--green)' : 'var(--red)'}">${pl == null ? '—' : (pl >= 0 ? '+' : '') + pl.toFixed(2) + '%'}</td>
            <td>${status}</td>
            <td>${escapeHtml((t.notes || '').slice(0, 60))}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}
