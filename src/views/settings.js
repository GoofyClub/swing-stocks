// Settings — profile, preferences, and (collapsed by default) Data Source config.

import { state, setMarket } from '../core/state.js';
import { signOut } from '../data/firebase.js';
import { DATA_SOURCE_ORDER } from '../data/markets.js';
import {
  isFCMSupported, enableNotifications, disableNotifications, isCurrentDeviceRegistered,
} from '../data/messaging.js';

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
          <div class="avatar" style="width:44px;height:44px;font-size:1.23rem">
            ${u?.photoURL ? `<img src="${escapeHtml(u.photoURL)}" alt="">` : escapeHtml(u?.email?.[0]?.toUpperCase() || '?')}
          </div>
          <div>
            <div><b>${escapeHtml(u?.displayName || '—')}</b></div>
            <div style="color:var(--text-dim);font-size:0.92rem">${escapeHtml(u?.email || '—')}</div>
          </div>
          <button id="set-signout" class="btn-bare" style="margin-left:auto">SIGN OUT</button>
        </div>
      </div>

      <div class="card">
        <h2>Preferences</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:520px">
          <label style="display:flex;flex-direction:column;gap:6px;font-size:0.85rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em">
            Market
            <select id="pref-market" class="btn-bare">
              <option value="US">US (SPY)</option>
              <option value="INDIA">India (NIFTY 50)</option>
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:6px;font-size:0.85rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.08em">
            Font size
            <select id="pref-fs" class="btn-bare">
              <option value="S">Small</option>
              <option value="M" selected>Medium</option>
              <option value="L">Large</option>
            </select>
          </label>
        </div>
        <p style="color:var(--text-dim);font-size:0.92rem;margin-top:14px">
          Win/Loss is computed per signal from the TP / SL prices recorded at signal time.
          Win = high &ge; TP after signal date. Loss = low &le; SL after signal date.
        </p>
      </div>

      <div class="card" id="notif-card">
        <h2>Push notifications</h2>
        <p style="color:var(--text-dim);font-size:0.92rem;margin:0 0 12px">
          Get a browser push when one of your tracked trades hits its target or stop.
          Notifications are sent from the scheduled refresh job via Firebase Cloud Messaging.
        </p>
        <div id="notif-status" style="margin-bottom:10px;font-family:var(--font-mono);font-size:0.85rem;color:var(--text-dim)">Checking…</div>
        <button id="btn-notif" class="btn-bare" type="button" disabled>—</button>
        <div id="notif-err" style="display:none;margin-top:10px;color:var(--red);font-size:0.92rem"></div>
      </div>

      <details class="collapsible" id="ds-collapse">
        <summary>Data Source</summary>
        <div class="body">
          <p style="color:var(--text-dim);font-size:0.92rem;margin-top:0">
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

  // ----- Notification card wiring -----
  const notifBtn    = document.getElementById('btn-notif');
  const notifStatus = document.getElementById('notif-status');
  const notifErr    = document.getElementById('notif-err');
  const showErr = (msg) => { notifErr.style.display = 'block'; notifErr.textContent = msg; };
  const hideErr = () => { notifErr.style.display = 'none'; notifErr.textContent = ''; };

  (async () => {
    const supported = await isFCMSupported();
    if (!supported) {
      notifStatus.textContent = 'Your browser does not support push notifications.';
      notifBtn.textContent = 'Unavailable';
      return;
    }
    const browserState = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
    notifStatus.textContent = `Browser permission: ${browserState}`;
    let registered = false;
    try { registered = await isCurrentDeviceRegistered(u); } catch {}
    notifBtn.disabled = false;
    notifBtn.textContent = registered ? 'DISABLE ON THIS DEVICE' : 'ENABLE NOTIFICATIONS';
    notifBtn.dataset.action = registered ? 'disable' : 'enable';
  })();

  notifBtn.addEventListener('click', async () => {
    hideErr();
    notifBtn.disabled = true;
    const prev = notifBtn.textContent;
    notifBtn.textContent = '…';
    try {
      if (notifBtn.dataset.action === 'enable') {
        await enableNotifications(u);
        notifStatus.textContent = 'Notifications enabled on this device.';
        notifBtn.dataset.action = 'disable';
        notifBtn.textContent = 'DISABLE ON THIS DEVICE';
      } else {
        await disableNotifications(u);
        notifStatus.textContent = 'Notifications disabled on this device.';
        notifBtn.dataset.action = 'enable';
        notifBtn.textContent = 'ENABLE NOTIFICATIONS';
      }
    } catch (e) {
      console.error('[settings] notif toggle failed', e);
      showErr(e?.message || String(e));
      notifBtn.textContent = prev;
    } finally {
      notifBtn.disabled = false;
    }
  });
}
