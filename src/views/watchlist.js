// Watchlist — per-user cloud-synced list at /users/{uid}/watchlist/{ticker}.
// Defaults to NIFTY 50 (India) or S&P 500 large-cap leaders (US) via IMPORT STARTER LIST.

import { state } from '../core/state.js';
import { initFirebase } from '../data/firebase.js';
import {
  loadWatchlist, addToWatchlist, removeFromWatchlist, updateWatchlistNotes,
  importStarterWatchlist, sectorOptionsForMarket, bulkAddWatchlist,
} from '../data/watchlist.js';
import { STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA } from '../data/markets.js';
import { openModal } from '../ui/modal.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function starterLabel(market) {
  if (market === 'INDIA') return `NIFTY 50 (${STARTER_WATCHLIST_INDIA.length} names)`;
  return `S&P 500 large-cap leaders (${STARTER_WATCHLIST.length} names across 8 sectors)`;
}

export async function renderWatchlist(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Watchlist</h1>
      <p class="subtitle">Your personal watchlist for <b>${escapeHtml(state.market)}</b>. Cloud-synced across devices. Cron-generated signals scan this list when it's populated; otherwise they fall back to the curated default basket.</p>

      <div class="card">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button id="btn-add"     class="btn-bare" type="button">+ ADD TICKER</button>
          <button id="btn-bulk"    class="btn-bare" type="button">BULK ADD…</button>
          <button id="btn-import"  class="btn-bare" type="button">IMPORT ${escapeHtml(state.market === 'INDIA' ? 'NIFTY 50' : 'S&P 500 LEADERS')}</button>
          <span id="wl-count" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem"></span>
        </div>
        <div style="margin-top:8px;color:var(--text-dim);font-size:0.85rem">
          Default basket: <b>${escapeHtml(starterLabel(state.market))}</b>.
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
      tableEl.innerHTML = `<div class="empty">Your ${escapeHtml(state.market)} watchlist is empty. Click <b>IMPORT ${escapeHtml(state.market === 'INDIA' ? 'NIFTY 50' : 'S&amp;P 500 LEADERS')}</b> to load the curated basket, <b>BULK ADD</b> to paste your own list, or <b>+ ADD TICKER</b> to add one by hand.</div>`;
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

  document.getElementById('btn-bulk').addEventListener('click', () => {
    const market = state.market;
    const example = market === 'INDIA'
      ? `HDFCBANK\nINFY, ^CNXIT, IT bellwether\nRELIANCE, ^CNXENERGY`
      : `AAPL\nMSFT, XLK, megacap tech\nNVDA, XLK, AI leader`;
    const sectorList = sectorOptionsForMarket(market).map(s => s.code).join(', ');
    openModal({
      title: `Bulk add to ${market} watchlist`,
      bodyHtml: `
        <div style="color:var(--text-dim);margin-bottom:12px;font-size:0.92rem;line-height:1.6">
          Paste tickers <b>one per line</b>. Each line accepts up to three comma-separated fields:
          <div style="margin-top:8px;padding:10px 12px;background:var(--bg);border:1px solid var(--line);border-radius:4px;font-family:var(--font-mono);font-size:0.85rem;color:var(--text)">
            TICKER<br>
            TICKER, sector<br>
            TICKER, sector, notes
          </div>
          <ul style="margin:10px 0 0 18px;padding:0">
            <li>Tickers are upper-cased automatically.</li>
            <li>Sector codes for ${escapeHtml(market)}: <code>${escapeHtml(sectorList || '—')}</code>.</li>
            <li>Lines starting with <code>#</code> are treated as comments. Blank lines are ignored.</li>
            <li>A header row (e.g. "ticker,sector,notes") is skipped automatically.</li>
            <li>Existing tickers in your watchlist are <b>merged</b> — not duplicated.</li>
          </ul>
        </div>
        <div class="row">
          <label for="bulk-text">Tickers</label>
          <textarea id="bulk-text" maxlength="20000" rows="10" placeholder="${escapeHtml(example)}" style="min-height:180px;font-family:var(--font-mono);font-size:0.92rem"></textarea>
        </div>
      `,
      primaryLabel: 'Add all',
      onPrimary: async (dialog) => {
        const text = dialog.querySelector('#bulk-text').value || '';
        if (!text.trim()) throw new Error('Paste at least one ticker.');
        const { added, skipped, errors } = await bulkAddWatchlist(text, market);
        if (errors.length && added === 0) {
          throw new Error(`No tickers added. First error: ${errors[0]}`);
        }
        await refresh();
        // Show a follow-up modal with the summary.
        setTimeout(() => {
          openModal({
            title: 'Bulk add complete',
            bodyHtml: `
              <div><b style="color:var(--green)">${added}</b> added · <b>${skipped}</b> skipped${errors.length ? ` · <b style="color:var(--red)">${errors.length}</b> errors` : ''}.</div>
              ${errors.length ? `<div style="margin-top:10px;color:var(--text-dim);font-size:0.85rem;max-height:160px;overflow-y:auto">${errors.map(e => `<div>${escapeHtml(e)}</div>`).join('')}</div>` : ''}
            `,
            primaryLabel: 'OK',
            onPrimary: () => true,
          });
        }, 80);
      },
    });
  });

  document.getElementById('btn-import').addEventListener('click', () => {
    openModal({
      title: 'Import starter basket',
      bodyHtml: `<div>Add the curated <b>${escapeHtml(starterLabel(state.market))}</b> to your watchlist? Existing tickers will be left untouched (merged, not duplicated).</div>`,
      primaryLabel: 'Import',
      onPrimary: async () => {
        const n = await importStarterWatchlist(state.market);
        await refresh();
        return n > 0;
      },
    });
  });

  await refresh();
}
