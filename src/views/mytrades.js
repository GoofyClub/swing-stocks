// My Trades — read /users/{uid}/enteredTrades, enriched with live status from
// the source shared signal. Each row has a Remove button.

import { state } from '../core/state.js';
import { initFirebase } from '../data/firebase.js';
import { loadMyTrades, removeTrade } from '../data/trades.js';
import { openModal } from '../ui/modal.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderMyTrades(root) {
  root.innerHTML = `
    <div class="view">
      <h1>My Trades</h1>
      <p class="subtitle">Signals you have entered. Status &amp; current price are live from the shared signal feed.</p>
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
  const { ok } = initFirebase();
  if (!ok) {
    document.getElementById('trades-table').innerHTML = `<div class="empty">Firebase not configured. See SETUP.md.</div>`;
    return;
  }

  let trades = [];
  try {
    trades = await loadMyTrades();
  } catch (e) {
    console.error('[mytrades]', e);
    document.getElementById('trades-table').innerHTML = `<div class="empty">Couldn't load trades: ${escapeHtml(e.message)}</div>`;
    return;
  }

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
    document.getElementById('trades-table').innerHTML = `<div class="empty">You haven't entered any signals yet. Open Signal History and click ☆ on any row to track it here.</div>`;
    return;
  }

  document.getElementById('trades-table').innerHTML = `
    <table class="data">
      <thead><tr>
        <th>ENTERED</th><th>NAME</th><th>TICKER</th><th>STRATEGY</th>
        <th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th>
        <th class="num">CURRENT</th><th class="num">P/L</th><th>STATUS</th><th>NOTES</th><th></th>
      </tr></thead>
      <tbody>
        ${trades.map(t => {
          const pl = t.realizedPct ?? t.unrealizedPct ?? null;
          const status = t.status === 'closed'
            ? (t.winLoss === 'win' ? '<span class="badge win">WIN</span>' : '<span class="badge loss">LOSS</span>')
            : '<span class="badge open">open</span>';
          const enteredDate = (t.enteredAt?.toDate?.()?.toISOString?.() || t.signalDate || '').slice(0, 10);
          const override = t.overrideEntryPrice != null;
          return `<tr data-trade-id="${escapeHtml(t.id)}">
            <td>${escapeHtml(enteredDate)}</td>
            <td>${escapeHtml(t.name || '—')}</td>
            <td>${escapeHtml(t.ticker || '')}</td>
            <td>${escapeHtml(t.strategy || '—')}</td>
            <td class="num" title="${override ? 'overridden by you' : 'from signal'}">${(t.entryPrice ?? 0).toFixed(2)}${override ? ' *' : ''}</td>
            <td class="num">${(t.tpPrice ?? 0).toFixed(2)}</td>
            <td class="num">${(t.slPrice ?? 0).toFixed(2)}</td>
            <td class="num">${t.currentPrice != null ? t.currentPrice.toFixed(2) : '—'}</td>
            <td class="num" style="color:${pl == null ? 'var(--text-dim)' : pl >= 0 ? 'var(--green)' : 'var(--red)'}">${pl == null ? '—' : (pl >= 0 ? '+' : '') + pl.toFixed(2) + '%'}</td>
            <td>${status}</td>
            <td title="${escapeHtml(t.notes || '')}">${escapeHtml((t.notes || '').slice(0, 60))}</td>
            <td><button class="btn-bare remove-btn" data-trade-id="${escapeHtml(t.id)}" data-ticker="${escapeHtml(t.ticker)}" title="Remove">✕</button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
    <p style="color:var(--text-mute);font-size:11px;margin-top:10px">
      * = entry price was overridden by you at trade-entry time.
    </p>
  `;

  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tradeId;
      const ticker = btn.dataset.ticker;
      openModal({
        title: 'Remove trade',
        bodyHtml: `<div>Remove <b>${escapeHtml(ticker)}</b> from My Trades? This does not affect the shared signal — only your tracked entry.</div>`,
        primaryLabel: 'Remove',
        onPrimary: async () => {
          await removeTrade(id);
          // Re-render the view so totals + table reflect the deletion.
          renderMyTrades(root);
        },
      });
    });
  });
}
