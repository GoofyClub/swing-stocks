// Watchlist — cloud-synced per-user list at /users/{uid}/watchlist.
// In v0.2 we render the starter watchlist from local config; cloud-sync writes land in v0.3.

import { state } from '../core/state.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderWatchlist(root) {
  const items = state.watchlist;
  root.innerHTML = `
    <div class="view">
      <h1>Watchlist</h1>
      <p class="subtitle">${items.length} stocks · curated for the current market (${escapeHtml(state.market)}).</p>
      <div class="card">
        <table class="data">
          <thead><tr><th>TICKER</th><th>SECTOR</th><th>WHY</th></tr></thead>
          <tbody>
            ${items.map(it => `<tr>
              <td>${escapeHtml(it.t)}</td>
              <td>${escapeHtml(it.s)}</td>
              <td>${escapeHtml(it.why)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
