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

// Theme bootstrap — read from localStorage before first paint to avoid flash.
const storedTheme = localStorage.getItem('swing.theme') || 'dark';
document.documentElement.setAttribute('data-theme', storedTheme);
const storedFs = localStorage.getItem('swing.fs') || 'M';
document.documentElement.setAttribute('data-fs', storedFs);

const appRoot = document.getElementById('app');

// -----------------------------------------------------------------------------
// Mount one of two shells: auth-gated app, or the login screen.
// -----------------------------------------------------------------------------
function mountAppShell() {
  appRoot.innerHTML = `
    <div class="app-shell">
      <header class="topbar" id="topbar" role="banner"></header>
      <nav class="sidebar" id="sidebar" role="navigation"></nav>
      <main class="main" id="main-view" role="main" tabindex="-1"></main>
    </div>
  `;
  renderTopbar(document.getElementById('topbar'));
  renderSidebar(document.getElementById('sidebar'));

  const main = document.getElementById('main-view');
  route('dashboard', renderDashboard);
  route('signals',   renderSignals);
  route('history',   renderHistory);
  route('mytrades',  renderMyTrades);
  route('watchlist', renderWatchlist);
  route('settings',  renderSettings);
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
