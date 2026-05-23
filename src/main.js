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
