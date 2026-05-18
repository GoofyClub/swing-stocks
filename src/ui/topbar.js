// Top bar — brand, search, sync status, theme toggle, user menu.

import { state } from '../core/state.js';
import { signOut } from '../data/firebase.js';

export function renderTopbar(el) {
  const u = state.user;
  const initials = u?.displayName ? u.displayName.split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase() : (u?.email?.[0]?.toUpperCase() || '?');
  el.innerHTML = `
    <div class="brand">SWING · TERMINAL</div>
    <span class="pulse" aria-hidden="true" title="connected"></span>
    <input class="search" id="universal-search" type="search" placeholder="/ search ticker, name, sector" aria-label="Search">
    <div class="meta">
      <div class="item" id="sync-status" title="Last sync">— · synced</div>
      <button class="btn-bare" id="btn-theme" type="button" title="Toggle theme">DARK</button>
      <button class="btn-bare" id="btn-signout" type="button">SIGN OUT</button>
      <div class="avatar" id="avatar" title="${escapeAttr(u?.email || '')}">
        ${u?.photoURL ? `<img src="${escapeAttr(u.photoURL)}" alt="">` : escapeHtml(initials)}
      </div>
    </div>
  `;

  document.getElementById('btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.getElementById('btn-theme').textContent = next.toUpperCase();
    state.prefs.theme = next;
  });
  document.getElementById('btn-theme').textContent = (document.documentElement.getAttribute('data-theme') || 'dark').toUpperCase();

  document.getElementById('btn-signout').addEventListener('click', async () => {
    try { await signOut(); } catch (e) { console.error(e); }
  });

  document.getElementById('universal-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') e.target.blur();
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
