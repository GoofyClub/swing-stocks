// Settings — profile, preferences, and (collapsed by default) Data Source config.

import { state, setMarket, setApiKey } from '../core/state.js';
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
            API keys live <b>locally in this browser only</b>. Used by Live Signals (browser scan) and Stocks in Play. The cron worker has its own keys in GitHub Secrets — these inputs don't affect it.
          </p>
          <div class="api-key-row">
            <label for="key-av">Alpha Vantage</label>
            <input id="key-av" type="password" autocomplete="off" placeholder="set to enable Stocks in Play + faster scans">
            <button id="btn-save-av" class="btn-primary api-key-save" type="button">SAVE</button>
            <span id="state-av" class="api-key-state"></span>
            <span class="muted">Free: <a href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noopener">alphavantage.co/support/#api-key</a> (25 calls/day)</span>
          </div>
          <div class="api-key-row">
            <label for="key-fh">Finnhub</label>
            <input id="key-fh" type="password" autocomplete="off" placeholder="optional — second priority data source">
            <button id="btn-save-fh" class="btn-primary api-key-save" type="button">SAVE</button>
            <span id="state-fh" class="api-key-state"></span>
            <span class="muted">Free: <a href="https://finnhub.io/register" target="_blank" rel="noopener">finnhub.io/register</a> (60 calls/min)</span>
          </div>
          <div class="api-key-row">
            <label for="key-fmp">FMP</label>
            <input id="key-fmp" type="password" autocomplete="off" placeholder="paid — enables PEAD / Insider / Analyst strategies">
            <button id="btn-save-fmp" class="btn-primary api-key-save" type="button">SAVE</button>
            <span id="state-fmp" class="api-key-state"></span>
            <span class="muted">Paid: <a href="https://financialmodelingprep.com" target="_blank" rel="noopener">financialmodelingprep.com</a></span>
          </div>
          <p id="api-key-status" style="color:var(--text-dim);font-size:0.85rem;font-family:var(--font-mono);margin-top:8px"></p>

          <h3 style="color:var(--text-mute);font-size:0.77rem;letter-spacing:0.12em;text-transform:uppercase;margin:20px 0 8px;font-weight:500">Sources priority (read-only)</h3>
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

  // ----- API key inputs (Alpha Vantage / Finnhub / FMP) -----
  // Each row has explicit SAVE button + status indicator + blur fallback.
  const keyAv    = document.getElementById('key-av');
  const keyFh    = document.getElementById('key-fh');
  const keyFmp   = document.getElementById('key-fmp');
  const stateAv  = document.getElementById('state-av');
  const stateFh  = document.getElementById('state-fh');
  const stateFmp = document.getElementById('state-fmp');
  const keyStatus = document.getElementById('api-key-status');

  keyAv.value  = state.fetchCtx.apiKeys.alphavantage || '';
  keyFh.value  = state.fetchCtx.apiKeys.finnhub      || '';
  keyFmp.value = state.fetchCtx.apiKeys.fmp          || '';

  function paintState(el, key) {
    if (key) {
      el.textContent = '✓ Saved';
      el.className = 'api-key-state saved';
    } else {
      el.textContent = 'not set';
      el.className = 'api-key-state empty';
    }
  }
  paintState(stateAv,  keyAv.value);
  paintState(stateFh,  keyFh.value);
  paintState(stateFmp, keyFmp.value);

  function flashStatus(msg) {
    keyStatus.textContent = msg;
    setTimeout(() => { if (keyStatus.textContent === msg) keyStatus.textContent = ''; }, 2500);
  }

  function wireSave(provider, btnId, input, stateEl, label) {
    document.getElementById(btnId).addEventListener('click', () => {
      const val = input.value.trim();
      setApiKey(provider, val);
      paintState(stateEl, val);
      flashStatus(val ? `${label} key saved locally.` : `${label} key cleared.`);
    });
    // Backup paths so users don't lose data even without clicking SAVE
    input.addEventListener('blur', () => {
      const val = input.value.trim();
      if (val !== (state.fetchCtx.apiKeys[provider] || '')) {
        setApiKey(provider, val);
        paintState(stateEl, val);
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById(btnId).click(); }
    });
  }
  wireSave('alphavantage', 'btn-save-av',  keyAv,  stateAv,  'Alpha Vantage');
  wireSave('finnhub',      'btn-save-fh',  keyFh,  stateFh,  'Finnhub');
  wireSave('fmp',          'btn-save-fmp', keyFmp, stateFmp, 'FMP');

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
