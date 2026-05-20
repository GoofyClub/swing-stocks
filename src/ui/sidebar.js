// Sidebar nav. Tabs grouped into Trading / Research / System.

import { navigate, currentRoute } from '../core/router.js';

const NAV = [
  { group: 'Trading', items: [
    { id: 'dashboard',     icon: '▣', label: 'Dashboard' },
    { id: 'signals',       icon: '⚡', label: 'Live Signals' },
    { id: 'stocksinplay',  icon: '◆', label: 'Stocks in Play' },
    { id: 'mytrades',      icon: '★', label: 'My Trades' },
    { id: 'history',       icon: '⏱', label: 'Signal History' },
    { id: 'watchlist',     icon: '≡', label: 'Watchlist' },
  ]},
  { group: 'System', items: [
    { id: 'guide',     icon: 'i', label: 'User Guide' },
    { id: 'settings',  icon: '⚙', label: 'Settings' },
  ]},
];

export function renderSidebar(el) {
  const active = currentRoute();
  const html = [];
  for (const grp of NAV) {
    html.push(`<div class="section-label">${grp.group}</div>`);
    for (const it of grp.items) {
      const cls = it.id === active ? 'nav-item active' : 'nav-item';
      html.push(`
        <div class="${cls}" data-view="${it.id}" role="tab" tabindex="0">
          <span class="icon" aria-hidden="true">${it.icon}</span>
          <span>${it.label}</span>
        </div>
      `);
    }
  }
  html.push(`<div class="foot">v0.2.0 · alpha</div>`);
  el.innerHTML = html.join('');
  el.querySelectorAll('.nav-item').forEach(n => {
    n.addEventListener('click', () => navigate(n.dataset.view));
    n.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(n.dataset.view); }
    });
  });
}

export function highlightActive(el, route) {
  el.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === route);
  });
}
