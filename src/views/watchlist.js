// Watchlist — per-user cloud-synced list at /users/{uid}/watchlist/{ticker}.

import { state, subscribe } from '../core/state.js';
import { initFirebase } from '../data/firebase.js';
import {
  loadWatchlist, addToWatchlist, removeFromWatchlist, updateWatchlistNotes,
  importStarterWatchlist, sectorOptionsForMarket,
} from '../data/watchlist.js';
import { openModal } from '../ui/modal.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function renderWatchlist(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Watchlist</h1>
      <p class="subtitle">Your personal watchlist for <b>${escapeHtml(state.market)}</b>. Synced across devices.</p>

      <div class="card">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button id="btn-add" class="btn-bare" type="button">+ ADD TICKER</button>
          <button id="btn-import" class="btn-bare" type="button">IMPORT STARTER LIST</button>
          <span id="wl-count" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:11px"></span>
        </div>
      </div>

      <div class="card">
        <div id="wl-table"><div class="empty">Loading…</div></div>
      </div>
    </div>
  `;

  if (!state.user) {
    document.getElementById('wl-table').innerHTML = `<div class="empty">Sign in to manage your watchlist.</div>`;
    return;
  }
  const { ok } = initFirebase();
  if (!ok) {
    document.getElementById('wl-table').innerHTML = `<div class="empty">Firebase not configured. See SETUP.md.</div>`;
    return;
  }

  async function refresh() {
    const items = await loadWatchlist(state.market);
    document.getElementById('wl-count').textContent = `${items.length} ticker${items.length === 1 ? '' : 's'}`;
    const tableEl = document.getElementById('wl-table');
    if (!items.length) {
      tableEl.innerHTML = `<div class="empty">Your ${escapeHtml(state.market)} watchlist is empty. Click <b>IMPORT STARTER LIST</b> to add the curated ${state.market === 'INDIA' ? 'NIFTY 50' : 'S&amp;P / NDX'} basket, or <b>+ ADD TICKER</b> to add one by hand.</div>`;
      return;
    }
    tableEl.innerHTML = `
      <table class="data">
        <thead><tr>
          <th>TICKER</th><th>NAME</th><th>SECTOR</th><th>NOTES</th><th>ADDED</th><th></th>
        </tr></thead>
        <tbody>
          ${items.map(w => {
            const added = w.addedAt?.toDate?.()?.toISOString?.()?.slice(0, 10) || '';
            return `<tr data-ticker="${escapeHtml(w.ticker)}">
              <td>${escapeHtml(w.ticker)}</td>
              <td>${escapeHtml(w.name || w.ticker)}</td>
              <td>${escapeHtml(w.sector || '—')}</td>
              <td class="notes-cell" title="${escapeHtml(w.notes || '')}">${escapeHtml((w.notes || '').slice(0, 80))}</td>
              <td>${escapeHtml(added)}</td>
              <td>
                <button class="btn-bare wl-edit" data-ticker="${escapeHtml(w.ticker)}" title="Edit notes">✎</button>
                <button class="btn-bare wl-remove" data-ticker="${escapeHtml(w.ticker)}" title="Remove">✕</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    tableEl.querySelectorAll('.wl-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.ticker;
        openModal({
          title: 'Remove from watchlist',
          bodyHtml: `<div>Remove <b>${escapeHtml(t)}</b> from your watchlist?</div>`,
          primaryLabel: 'Remove',
          onPrimary: async () => { await removeFromWatchlist(t); await refresh(); },
        });
      });
    });

    tableEl.querySelectorAll('.wl-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const t = btn.dataset.ticker;
        const item = items.find(w => w.ticker === t);
        openModal({
          title: `Edit notes · ${escapeHtml(t)}`,
          bodyHtml: `
            <div class="row">
              <label for="wl-notes">Notes (max 500 chars)</label>
              <textarea id="wl-notes" maxlength="500">${escapeHtml(item?.notes || '')}</textarea>
            </div>
          `,
          primaryLabel: 'Save',
          onPrimary: async (dialog) => {
            const notes = dialog.querySelector('#wl-notes').value || '';
            await updateWatchlistNotes(t, notes);
            await refresh();
          },
        });
      });
    });
  }

  document.getElementById('btn-add').addEventListener('click', () => {
    const sectors = sectorOptionsForMarket(state.market);
    const sectorOpts = sectors.map(s => `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)} (${escapeHtml(s.code)})</option>`).join('');
    openModal({
      title: 'Add to watchlist',
      bodyHtml: `
        <div class="row">
          <label for="add-ticker">Ticker</label>
          <input id="add-ticker" type="text" placeholder="${state.market === 'INDIA' ? 'HDFCBANK' : 'AAPL'}" autocomplete="off">
        </div>
        <div class="row">
          <label for="add-sector">Sector (optional)</label>
          <select id="add-sector"><option value="">—</option>${sectorOpts}</select>
        </div>
        <div class="row">
          <label for="add-notes">Notes (optional)</label>
          <textarea id="add-notes" maxlength="500" placeholder="Why are you tracking this?"></textarea>
        </div>
      `,
      primaryLabel: 'Add',
      onPrimary: async (dialog) => {
        const ticker = dialog.querySelector('#add-ticker').value.trim();
        const sector = dialog.querySelector('#add-sector').value || null;
        const notes  = dialog.querySelector('#add-notes').value || '';
        if (!ticker) throw new Error('Ticker is required.');
        await addToWatchlist({ ticker, sector, notes, market: state.market });
        await refresh();
      },
    });
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    openModal({
      title: 'Import starter list',
      bodyHtml: `<div>Add the curated <b>${escapeHtml(state.market)}</b> starter watchlist (${state.market === 'INDIA' ? '48 NIFTY 50 names across 8 sectors' : '53 large-cap US names across 8 sectors'}) to your watchlist? Existing tickers will be left untouched.</div>`,
      primaryLabel: 'Import',
      onPrimary: async () => {
        const n = await importStarterWatchlist(state.market);
        await refresh();
        return n > 0;
      },
    });
  });

  // Refresh when the market toggle flips (state subscriber fires on 'market').
  // The router already re-dispatches the view, so we just need to refresh data
  // for the currently mounted instance. We use a one-shot subscription that the
  // next render call will replace.
  await refresh();
}
