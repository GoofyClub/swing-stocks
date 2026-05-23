// Top bar — brand, market switcher, search, sync status, theme toggle, user menu.

import { state, setMarket } from '../core/state.js';
import { signOut } from '../data/firebase.js';

export function renderTopbar(el) {
  const u = state.user;
  const initials = u?.displayName ? u.displayName.split(/\s+/).map(s => s[0]).join('').slice(0, 2).toUpperCase() : (u?.email?.[0]?.toUpperCase() || '?');
  const m = state.market;
  el.innerHTML = `
    <button class="hamburger" id="btn-hamburger" type="button" aria-label="Toggle menu" title="Menu">☰</button>
    <div class="brand">SWING · TERMINAL</div>
    <span class="pulse" aria-hidden="true" title="connected"></span>
    <div class="market-toggle" role="tablist" aria-label="Select market">
      <button data-market="US"    class="${m === 'US'    ? 'active' : ''}" role="tab" aria-selected="${m === 'US'}">US</button>
      <button data-market="INDIA" class="${m === 'INDIA' ? 'active' : ''}" role="tab" aria-selected="${m === 'INDIA'}">INDIA</button>
    </div>
    <input class="search" id="universal-search" type="search" placeholder="/ search ticker, name, sector" aria-label="Search">
    <div class="meta">
      <button class="btn-bare btn-fs" id="btn-fs" type="button" title="Cycle font size (S / M / L)">A</button>
      <button class="btn-bare" id="btn-theme" type="button" title="Toggle theme">DARK</button>
      <button class="btn-bare" id="btn-signout" type="button">SIGN OUT</button>
      <div class="avatar" id="avatar" title="${escapeAttr(u?.email || '')}">
        ${u?.photoURL ? `<img src="${escapeAttr(u.photoURL)}" alt="">` : escapeHtml(initials)}
      </div>
    </div>
  `;

  // Market toggle — fires state.notify('market'), which triggers a view re-render
  // via the subscription set up in main.js.
  el.querySelectorAll('.market-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.market;
      if (next === state.market) return;
      el.querySelectorAll('.market-toggle button').forEach(b => {
        b.classList.toggle('active', b.dataset.market === next);
        b.setAttribute('aria-selected', String(b.dataset.market === next));
      });
      setMarket(next);
      try { localStorage.setItem('swing.market', next); } catch {}
    });
  });

  document.getElementById('btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    document.getElementById('btn-theme').textContent = next.toUpperCase();
    state.prefs.theme = next;
    try { localStorage.setItem('swing.theme', next); } catch {}
  });
  document.getElementById('btn-theme').textContent = (document.documentElement.getAttribute('data-theme') || 'dark').toUpperCase();

  const FS_ORDER = ['S', 'M', 'L'];
  const fsBtn = document.getElementById('btn-fs');
  function refreshFsLabel() {
    const cur = document.documentElement.getAttribute('data-fs') || 'M';
    fsBtn.textContent = `A·${cur}`;
    // The button label intentionally stays a fixed pixel size so it remains a
    // stable indicator regardless of the global font-scale choice.
    fsBtn.style.fontSize = cur === 'S' ? '10px' : cur === 'L' ? '14px' : '12px';
  }
  fsBtn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-fs') || 'M';
    const idx = FS_ORDER.indexOf(cur);
    const next = FS_ORDER[(idx + 1) % FS_ORDER.length];
    document.documentElement.setAttribute('data-fs', next);
    state.prefs.fontSize = next;
    try { localStorage.setItem('swing.fs', next); } catch {}
    refreshFsLabel();
  });
  refreshFsLabel();

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
