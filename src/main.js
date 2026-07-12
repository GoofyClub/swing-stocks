// =============================================================================
// SPA entry point — bootstraps router, auth gate, and view registration.
// =============================================================================

import './styles/app.css';
import { route, defaultRoute, start, navigate } from './core/router.js';
import { state, setUser, subscribe } from './core/state.js';
import { initFirebase, onUser, ensureUserDoc, completeRedirectIfAny } from './data/firebase.js';
import { renderLogin } from './auth/ui.js';
import { renderSidebar, highlightActive } from './ui/sidebar.js';
import { renderTopbar } from './ui/topbar.js';
import { renderDashboard } from './views/dashboard.js';
import { renderSignals } from './views/signals.js';
import { renderHistory } from './views/history.js';
import { renderMyTrades } from './views/mytrades.js';
import { renderWatchlist } from './views/watchlist.js';
import { renderSettings } from './views/settings.js';
import { renderGuide } from './views/guide.js';
import { renderStocksInPlay } from './views/stocksInPlay.js';
import { renderAutomation } from './views/automation.js';
import { renderAutomationGuide } from './views/automationGuide.js';
import { renderAutoOrders } from './views/autoOrders.js';
import { renderCronStatus } from './views/cronStatus.js';
import { renderOptionsPlaybook } from './views/optionsPlaybook.js';
import { renderCondorDesk } from './views/condorDesk.js';
import { renderCondorGuide } from './views/condorGuide.js';
import { onForegroundMessage, isFCMSupported } from './data/messaging.js';

// Theme + font-size attributes are pre-set by an inline script in index.html
// (runs before this bundle loads — eliminates flicker AND guarantees the
// settings always apply, even if this module never finishes loading).
// We just keep them in sync with state.prefs for the rest of the app.

const appRoot = document.getElementById('app');

// -----------------------------------------------------------------------------
// Mount one of two shells: auth-gated app, or the login screen.
// -----------------------------------------------------------------------------
function mountAppShell() {
  appRoot.innerHTML = `
    <div class="app-shell">
      <header class="topbar" id="topbar" role="banner"></header>
      <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
      <nav class="sidebar" id="sidebar" role="navigation"></nav>
      <main class="main" id="main-view" role="main" tabindex="-1"></main>
    </div>
  `;
  renderTopbar(document.getElementById('topbar'));
  renderSidebar(document.getElementById('sidebar'));

  // Mobile sidebar toggle
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  function closeSidebar() {
    sidebar.classList.remove('open');
    backdrop.classList.remove('open');
  }
  document.getElementById('btn-hamburger')?.addEventListener('click', () => {
    const isOpen = sidebar.classList.contains('open');
    sidebar.classList.toggle('open', !isOpen);
    backdrop.classList.toggle('open', !isOpen);
  });
  backdrop.addEventListener('click', closeSidebar);
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('.nav-item')) closeSidebar();
  });

  const main = document.getElementById('main-view');
  route('dashboard', renderDashboard);
  route('signals',   renderSignals);
  route('history',   renderHistory);
  route('mytrades',  renderMyTrades);
  route('watchlist', renderWatchlist);
  route('settings',     renderSettings);
  route('guide',        renderGuide);
  route('stocksinplay', renderStocksInPlay);
  route('automation',       renderAutomation);
  route('automation-guide', renderAutomationGuide);
  route('auto-orders',      renderAutoOrders);
  route('cron-status',      renderCronStatus);
  route('options-playbook', renderOptionsPlaybook);
  route('condor-desk',      renderCondorDesk);
  route('condor-guide',     renderCondorGuide);
  defaultRoute('dashboard');
  const dispatch = start(main);

  // Reflect route changes in sidebar highlight.
  window.addEventListener('hashchange', () => {
    const cur = (window.location.hash || '').replace(/^#\/?/, '').split('?')[0] || 'dashboard';
    highlightActive(document.getElementById('sidebar'), cur);
  });

  // When the user flips market (US/INDIA) in the topbar, re-render the active
  // view so data scoped to the chosen market reloads.
  subscribe((reason) => {
    if (reason === 'market') dispatch();
  });

  // Views render EITHER the desktop table OR the compact phone rows (not both —
  // that doubled the DOM and made filtering slow). Crossing the breakpoint
  // (rotate / split-screen / window resize) re-renders the active view so the
  // right variant appears.
  PHONE_MQ.addEventListener('change', () => dispatch());

  // Keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('universal-search')?.focus();
    } else if (e.key === '1') navigate('dashboard');
    else if (e.key === '2')   navigate('signals');
    else if (e.key === '3')   navigate('history');
    else if (e.key === '4')   navigate('mytrades');
  });

  // Foreground push: show an in-app toast so the user sees the alert even when
  // the OS suppresses the native notification (which happens when this tab is
  // already focused).
  (async () => {
    if (!(await isFCMSupported())) return;
    try {
      await onForegroundMessage((payload) => {
        const n = payload.notification || {};
        showToast(n.title || 'Swing Terminal', n.body || '');
      });
    } catch (e) {
      console.warn('[main] foreground FCM subscribe failed', e);
    }
  })();
}

function showToast(title, body) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:5000;max-width:340px;padding:14px 18px;background:var(--bg-elev);border:1px solid var(--cyan);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.35);font-family:var(--font-sans);color:var(--text)';
  el.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${escapeText(title)}</div><div style="color:var(--text-dim);font-size:0.92rem">${escapeText(body)}</div>`;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 350); }, 5000);
}
function escapeText(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mountLogin() {
  appRoot.innerHTML = '';
  renderLogin(appRoot);
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------
async function boot() {
  const { ok } = initFirebase();
  if (!ok) {
    // No Firebase configured — show login with an obvious error so the user
    // knows to fill out SETUP.md. We still mount the login screen.
    mountLogin();
    return;
  }

  // Wait for redirect completion (mobile sign-in) before flipping shells.
  await completeRedirectIfAny();

  onUser(async (user) => {
    setUser(user || null);
    if (user) {
      try { await ensureUserDoc(user); } catch (e) { console.warn('[boot] ensureUserDoc failed', e); }
      mountAppShell();
    } else {
      mountLogin();
    }
  });
}

// -----------------------------------------------------------------------------
// Mobile table labels — on phones (≤640px) app.css stacks each table row into a
// labelled card instead of forcing sideways scrolling. The per-cell labels come
// from a data-label attribute (rendered by `td::before { content: attr(...) }`),
// stamped here from the column headers. Views render plain HTML strings and
// re-render freely, so this runs generically off a MutationObserver instead of
// every view wiring it up itself.
// -----------------------------------------------------------------------------
const WIDE_CELL_MIN_CHARS = 28; // prose-length cells span the full card width
const PHONE_MQ = window.matchMedia('(max-width: 640px)');

function labelDataTables() {
  // Labels are only ever rendered by the ≤640px card CSS — skip the work
  // entirely on larger screens (it was making desktop re-renders sluggish).
  if (!PHONE_MQ.matches) return;
  document.querySelectorAll('table.data').forEach((table) => {
    // Tables with a compact .mrows alternative are hidden on phones — their
    // cells never show labels, so don't walk them (History alone is ~8k cells).
    if (table.closest('.tbl-mobile-switch')) return;
    const heads = [...table.querySelectorAll(':scope > thead th')].map(th => th.textContent.trim());
    if (!heads.length) return;
    table.querySelectorAll(':scope > tbody > tr, :scope > tfoot > tr').forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        const label = heads[i] || '';
        if (td.getAttribute('data-label') !== label) td.setAttribute('data-label', label);
        td.classList.toggle('cell-wide', (td.textContent || '').trim().length >= WIDE_CELL_MIN_CHARS);
      });
    });
  });
}

// Observe childList only: the attribute/class writes above don't re-trigger it.
let tableLabelQueued = false;
new MutationObserver(() => {
  if (tableLabelQueued) return;
  tableLabelQueued = true;
  requestAnimationFrame(() => { tableLabelQueued = false; labelDataTables(); });
}).observe(document.documentElement, { childList: true, subtree: true });

// Persist prefs on change.
window.addEventListener('beforeunload', () => {
  try {
    localStorage.setItem('swing.theme', document.documentElement.getAttribute('data-theme') || 'dark');
    localStorage.setItem('swing.fs',    document.documentElement.getAttribute('data-fs') || 'M');
  } catch {}
});

boot().catch(e => {
  console.error('[boot] fatal', e);
  appRoot.innerHTML = `<div class="login-screen"><div class="login-card"><h1>Startup failed</h1><p class="sub">${String(e?.message || e)}</p></div></div>`;
});
