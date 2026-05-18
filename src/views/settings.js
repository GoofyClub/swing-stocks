// Settings — profile, preferences, and (collapsed by default) Data Source config.

import { state, setMarket } from '../core/state.js';
import { signOut } from '../data/firebase.js';
import { DATA_SOURCE_ORDER } from '../data/markets.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderSettings(root) {
  const u = state.user;
  root.innerHTML = `
    <div class="view">
      <h1>Settings</h1>
      <p class="subtitle">Profile, preferences, and data-source configuration.</p>

      <div class="card">
        <h2>Profile</h2>
        <div style="display:flex;gap:14px;align-items:center">
          <div class="avatar" style="width:44px;height:44px;font-size:16px">
            ${u?.photoURL ? `<img src="${escapeHtml(u.photoURL)}" alt="">` : escapeHtml(u?.email?.[0]?.toUpperCase() || '?')}
          </div>
          <div>
            <div><b>${escapeHtml(u?.displayName || '—')}</b></div>
            <div style="color:var(--text-dim);font-size:12px">${escapeHtml(u?.email || '—')}</div>
          </div>
          <button id="set-signout" class="btn-bare" style="margin-left:auto">SIGN OUT</button>
        </div>
      </div>

      <div class="card">
        <h2>Preferences</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:520px">
          <label style="display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em">
            Market
            <select id="pref-market" class="btn-bare">
              <option value="US">US (SPY)</option>
              <option value="INDIA">India (NIFTY 50)</option>
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:6px;font-size:11px;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em">
            Font size
            <select id="pref-fs" class="btn-bare">
              <option value="S">Small</option>
              <option value="M" selected>Medium</option>
              <option value="L">Large</option>
            </select>
          </label>
        </div>
        <p style="color:var(--text-dim);font-size:12px;margin-top:14px">
          Win/Loss is computed per signal from the TP / SL prices recorded at signal time.
          Win = high &ge; TP after signal date. Loss = low &le; SL after signal date.
        </p>
      </div>

      <details class="collapsible" id="ds-collapse">
        <summary>Data Source</summary>
        <div class="body">
          <p style="color:var(--text-dim);font-size:12px;margin-top:0">
            API keys are stored locally for interactive scans. The shared signal history is
            populated by the GitHub Actions cron — its keys live in repo Secrets.
          </p>
          <table class="data">
            <thead><tr><th>SOURCE</th><th>STATUS</th></tr></thead>
            <tbody>
              ${DATA_SOURCE_ORDER.map(src => `
                <tr>
                  <td>${escapeHtml(src)}</td>
                  <td style="color:var(--text-dim)">${state.fetchCtx.enabledSources.has(src) ? 'enabled' : 'disabled'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  `;

  document.getElementById('set-signout').addEventListener('click', async () => {
    try { await signOut(); } catch (e) { console.error(e); }
  });

  const m = document.getElementById('pref-market');
  m.value = state.market;
  m.addEventListener('change', () => setMarket(m.value));

  const fs = document.getElementById('pref-fs');
  fs.value = document.documentElement.getAttribute('data-fs') || state.prefs.fontSize || 'M';
  fs.addEventListener('change', () => {
    state.prefs.fontSize = fs.value;
    document.documentElement.setAttribute('data-fs', fs.value);
    try { localStorage.setItem('swing.fs', fs.value); } catch {}
  });
}
