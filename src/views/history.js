// Signal History — read-only view of the shared /marketData/{date}/signals/* collection.
// Each row has a ★ button to add it to /users/{uid}/enteredTrades.

import { state } from '../core/state.js';
import { initFirebase } from '../data/firebase.js';
import { collection, query, orderBy, limit, getDocs, collectionGroup } from 'firebase/firestore';
import { enterTrade, removeTrade, loadEnteredTradeIds, tradeIdFor } from '../data/trades.js';
import { openModal } from '../ui/modal.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function parseHashParams() {
  const h = window.location.hash || '';
  const q = h.includes('?') ? h.split('?')[1] : '';
  const out = {};
  for (const part of q.split('&')) {
    if (!part) continue;
    const [k, v] = part.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return out;
}

async function loadHistory({ days = 90 } = {}) {
  const { db, ok } = initFirebase();
  if (!ok) return { rows: [], err: 'Firebase not configured (see SETUP.md)' };
  try {
    const q1 = query(collectionGroup(db, 'signals'), orderBy('signalTs', 'desc'), limit(500));
    const snap = await getDocs(q1);
    const cutoff = Date.now() - days * 86400_000;
    const rows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => {
        if (!r.signalTs) return true;
        return new Date(r.signalTs).getTime() >= cutoff;
      });
    return { rows };
  } catch (e) {
    console.error('[history] loadHistory failed', e);
    return { rows: [], err: e.message };
  }
}

function applyFilters(rows, f) {
  return rows.filter(r => {
    if (f.side && r.side !== f.side) return false;
    if (f.strategy && r.strategy !== f.strategy) return false;
    if (f.sector && r.sector !== f.sector) return false;
    if (f.winLoss) {
      if (f.winLoss === 'open' && r.status !== 'open') return false;
      if (f.winLoss === 'win'  && r.winLoss !== 'win')  return false;
      if (f.winLoss === 'loss' && r.winLoss !== 'loss') return false;
    }
    if (f.q) {
      const needle = f.q.toLowerCase();
      const hay = `${r.ticker || ''} ${r.name || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

export async function renderHistory(root) {
  const params = parseHashParams();
  root.innerHTML = `
    <div class="view">
      <h1>Signal History</h1>
      <p class="subtitle">All signals from the last 3 months. Click <span style="color:var(--amber)">★</span> on any row to track it on My Trades.</p>

      <div class="card">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <select id="f-side" class="btn-bare"><option value="">All sides</option><option value="buy">Buys</option><option value="sell">Sells</option></select>
          <select id="f-winloss" class="btn-bare"><option value="">All W/L</option><option value="open">Open</option><option value="win">Wins</option><option value="loss">Losses</option></select>
          <select id="f-strategy" class="btn-bare"><option value="">All strategies</option></select>
          <select id="f-sector"   class="btn-bare"><option value="">All sectors</option></select>
          <input  id="f-q"   class="search" type="search" placeholder="ticker / name" style="max-width:240px">
          <button id="btn-csv" class="btn-bare" type="button">CSV ↓</button>
          <span id="row-count" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem"></span>
        </div>
      </div>

      <div class="card">
        <div id="history-table"><div class="empty">Loading…</div></div>
      </div>
    </div>
  `;

  const [{ rows, err }, enteredIds] = await Promise.all([
    loadHistory(),
    loadEnteredTradeIds(),
  ]);
  // Mutable set so we can toggle in-place after enter/remove.
  const entered = new Set(enteredIds);

  const root$ = (id) => document.getElementById(id);

  if (err) {
    root$('history-table').innerHTML = `<div class="empty">Couldn't load history: ${escapeHtml(err)}</div>`;
    return;
  }

  const strats = [...new Set(rows.map(r => r.strategy).filter(Boolean))].sort();
  const sectors = [...new Set(rows.map(r => r.sector).filter(Boolean))].sort();
  root$('f-strategy').insertAdjacentHTML('beforeend', strats.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
  root$('f-sector').insertAdjacentHTML('beforeend', sectors.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));

  if (params.side) root$('f-side').value = params.side;

  function refresh() {
    const f = {
      side:     root$('f-side').value,
      strategy: root$('f-strategy').value,
      sector:   root$('f-sector').value,
      winLoss:  root$('f-winloss').value,
      q:        root$('f-q').value.trim(),
    };
    const filtered = applyFilters(rows, f);
    root$('row-count').textContent = `${filtered.length} of ${rows.length} rows`;
    if (!filtered.length) {
      root$('history-table').innerHTML = `<div class="empty">No signals match these filters.</div>`;
      return;
    }
    const html = `
      <table class="data">
        <thead><tr>
          <th></th>
          <th>DATE</th><th>NAME</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th>
          <th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th>
          <th class="num">CURRENT</th><th class="num">%Δ</th><th>W/L</th>
        </tr></thead>
        <tbody>
          ${filtered.map(r => {
            const pct = r.pctChange != null ? r.pctChange : (r.currentPrice && r.entryPrice ? ((r.currentPrice - r.entryPrice) / r.entryPrice) * 100 : null);
            const wl = r.status === 'open' ? '<span class="badge open">open</span>'
                     : r.winLoss === 'win'  ? '<span class="badge win">WIN</span>'
                     : r.winLoss === 'loss' ? '<span class="badge loss">LOSS</span>'
                     : '<span class="badge">—</span>';
            const id = tradeIdFor(r);
            const isEntered = entered.has(id);
            return `<tr data-signal-id="${escapeHtml(id)}">
              <td>
                <button class="star-btn" data-action="${isEntered ? 'remove' : 'enter'}" data-signal-id="${escapeHtml(id)}" title="${isEntered ? 'Remove from My Trades' : 'Track on My Trades'}" aria-label="${isEntered ? 'Remove' : 'Enter'} trade for ${escapeHtml(r.ticker)}">${isEntered ? '★' : '☆'}</button>
              </td>
              <td>${escapeHtml((r.signalTs || '').slice(0, 10))}</td>
              <td>${escapeHtml(r.name || '—')}</td>
              <td>${escapeHtml(r.ticker || '')}</td>
              <td>${escapeHtml(r.sector || '—')}</td>
              <td>${escapeHtml(r.strategy || '—')}</td>
              <td class="num">${(r.entryPrice ?? 0).toFixed(2)}</td>
              <td class="num">${(r.tpPrice ?? 0).toFixed(2)}</td>
              <td class="num">${(r.slPrice ?? 0).toFixed(2)}</td>
              <td class="num">${r.currentPrice != null ? r.currentPrice.toFixed(2) : '—'}</td>
              <td class="num" style="color:${pct == null ? 'var(--text-dim)' : pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct == null ? '—' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'}</td>
              <td>${wl}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    root$('history-table').innerHTML = html;

    // Wire star buttons.
    root$('history-table').querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.signalId;
        const sig = rows.find(r => tradeIdFor(r) === sid);
        if (!sig) return;
        if (btn.dataset.action === 'enter') openEnterModal(sig, btn);
        else openRemoveModal(sig, btn);
      });
    });
  }

  function openEnterModal(signal, btn) {
    const body = `
      <div class="row" style="grid-template-columns:120px 1fr;align-items:center;gap:10px">
        <div style="color:var(--text);font-family:var(--font-mono)">${escapeHtml(signal.ticker)}</div>
        <div>${escapeHtml(signal.name || '')} · ${escapeHtml(signal.strategy || '')}</div>
        <div style="color:var(--text-mute);font-size:0.85rem">SIGNAL ENTRY</div>
        <div style="font-family:var(--font-mono)">${(signal.entryPrice ?? 0).toFixed(2)} · TP ${(signal.tpPrice ?? 0).toFixed(2)} · SL ${(signal.slPrice ?? 0).toFixed(2)}</div>
      </div>
      <div class="row">
        <label for="ov-entry">Override entry price (optional)</label>
        <input id="ov-entry" type="number" step="0.01" placeholder="${(signal.entryPrice ?? 0).toFixed(2)}">
      </div>
      <div class="row">
        <label for="notes">Notes (optional)</label>
        <textarea id="notes" maxlength="500" placeholder="Why did you take this trade? Position size?"></textarea>
      </div>
    `;
    openModal({
      title: `Enter trade · ${signal.ticker}`,
      bodyHtml: body,
      primaryLabel: 'Add to My Trades',
      onPrimary: async (dialog) => {
        const ovStr = dialog.querySelector('#ov-entry').value.trim();
        const override = ovStr ? Number(ovStr) : null;
        if (override !== null && (!Number.isFinite(override) || override <= 0)) {
          throw new Error('Override entry must be a positive number.');
        }
        const notes = dialog.querySelector('#notes').value || '';
        await enterTrade({ signal, notes, overrideEntryPrice: override });
        entered.add(tradeIdFor(signal));
        btn.dataset.action = 'remove';
        btn.textContent = '★';
        btn.title = 'Remove from My Trades';
      },
    });
  }

  function openRemoveModal(signal, btn) {
    const body = `<div>Remove <b>${escapeHtml(signal.ticker)}</b> · ${escapeHtml(signal.strategy)} from My Trades?</div>`;
    openModal({
      title: 'Remove trade',
      bodyHtml: body,
      primaryLabel: 'Remove',
      onPrimary: async () => {
        await removeTrade(tradeIdFor(signal));
        entered.delete(tradeIdFor(signal));
        btn.dataset.action = 'enter';
        btn.textContent = '☆';
        btn.title = 'Track on My Trades';
      },
    });
  }

  ['f-side', 'f-strategy', 'f-sector', 'f-winloss'].forEach(id => root$(id).addEventListener('change', refresh));
  root$('f-q').addEventListener('input', refresh);

  root$('btn-csv').addEventListener('click', () => {
    const f = { side: root$('f-side').value, strategy: root$('f-strategy').value, sector: root$('f-sector').value, winLoss: root$('f-winloss').value, q: root$('f-q').value.trim() };
    const filtered = applyFilters(rows, f);
    const header = ['date','name','ticker','sector','strategy','entry','tp','sl','current','pctChange','status','winLoss'];
    const csvRows = filtered.map(r => [
      (r.signalTs || '').slice(0, 10), r.name || '', r.ticker || '', r.sector || '', r.strategy || '',
      r.entryPrice ?? '', r.tpPrice ?? '', r.slPrice ?? '', r.currentPrice ?? '',
      r.pctChange != null ? r.pctChange : '', r.status || '', r.winLoss || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([header.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signal-history-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  refresh();
}
