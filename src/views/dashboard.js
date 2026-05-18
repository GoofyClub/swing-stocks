// Dashboard — KPI tiles + today's top signals + open trades summary.

import { state } from '../core/state.js';
import { navigate } from '../core/router.js';
import { collection, doc, getDoc } from 'firebase/firestore';
import { initFirebase } from '../data/firebase.js';
import { query, where, orderBy, limit, getDocs, collectionGroup } from 'firebase/firestore';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function loadTodaySignals() {
  const { db, ok } = initFirebase();
  if (!ok) return { signals: [], err: 'Firebase not configured (see SETUP.md)' };
  try {
    // Try the current trading day first; if empty (e.g. weekend), walk back up to 4 days.
    for (let back = 0; back < 5; back++) {
      const d = new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
      const ref = collection(db, 'marketData', d, 'signals');
      const snap = await getDocs(query(ref, orderBy('signalTs', 'desc'), limit(5)));
      if (!snap.empty) return { signals: snap.docs.map(d => ({ id: d.id, ...d.data() })), date: d };
    }
    return { signals: [], date: todayKey() };
  } catch (e) {
    console.error('[dashboard] loadTodaySignals failed', e);
    return { signals: [], err: e.message };
  }
}

async function loadOpenTrades() {
  if (!state.user) return [];
  const { db, ok } = initFirebase();
  if (!ok) return [];
  try {
    const ref = collection(db, 'users', state.user.uid, 'enteredTrades');
    const snap = await getDocs(query(ref, where('status', '==', 'open'), limit(5)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[dashboard] loadOpenTrades failed (collection may be empty)', e.message);
    return [];
  }
}

export async function renderDashboard(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Dashboard</h1>
      <p class="subtitle">Today's top signals, open trades, and quick navigation.</p>

      <div class="tile-grid" id="tile-grid">
        <div class="tile skeleton" style="height:104px"></div>
        <div class="tile skeleton" style="height:104px"></div>
        <div class="tile skeleton" style="height:104px"></div>
        <div class="tile skeleton" style="height:104px"></div>
      </div>

      <div class="card">
        <h2>Today's top signals <span class="count" id="sig-count"></span></h2>
        <div id="today-signals"><div class="empty">Loading…</div></div>
      </div>

      <div class="card">
        <h2>My open trades <span class="count" id="open-count"></span></h2>
        <div id="open-trades"><div class="empty">Loading…</div></div>
      </div>
    </div>
  `;

  const [{ signals, date, err }, openTrades] = await Promise.all([
    loadTodaySignals(),
    loadOpenTrades(),
  ]);

  // Tiles
  const buys  = signals.filter(s => s.side === 'buy').length;
  const sells = signals.filter(s => s.side === 'sell').length;
  const opens = openTrades.length;
  const todayPL = openTrades.reduce((s, t) => s + ((t.unrealizedPct || 0)), 0);

  document.getElementById('tile-grid').innerHTML = `
    <div class="tile" data-go="history?side=buy">
      <div class="label">Buy signals</div>
      <div class="big">${buys}</div>
      <div class="delta">${date ? 'as of ' + escapeHtml(date) : 'no recent data'}</div>
    </div>
    <div class="tile" data-go="history?side=sell">
      <div class="label">Sell signals</div>
      <div class="big">${sells}</div>
      <div class="delta">${date ? 'as of ' + escapeHtml(date) : ''}</div>
    </div>
    <div class="tile" data-go="mytrades">
      <div class="label">Open trades</div>
      <div class="big">${opens}</div>
      <div class="delta ${todayPL >= 0 ? 'up' : 'down'}">
        ${todayPL >= 0 ? '+' : ''}${todayPL.toFixed(2)}% unrealized
      </div>
    </div>
    <div class="tile" data-go="signals">
      <div class="label">Live scan</div>
      <div class="big">▶</div>
      <div class="delta">Run a fresh scan now</div>
    </div>
  `;
  document.querySelectorAll('#tile-grid .tile').forEach(t => {
    t.addEventListener('click', () => {
      const target = t.dataset.go;
      if (target) navigate(target);
    });
  });

  // Today's signals
  const sigEl = document.getElementById('today-signals');
  document.getElementById('sig-count').textContent = signals.length ? `(${signals.length})` : '';
  if (err) {
    sigEl.innerHTML = `<div class="empty">Couldn't load shared signals: ${escapeHtml(err)}<br>If this is your first deploy, the GitHub Actions cron has not yet run.</div>`;
  } else if (!signals.length) {
    sigEl.innerHTML = `<div class="empty">No signals yet. The cron job populates these once per refresh window — see SETUP.md → "Schedule the cron".</div>`;
  } else {
    sigEl.innerHTML = `
      <table class="data">
        <thead><tr><th>TIME</th><th>NAME</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th><th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th><th>SIDE</th></tr></thead>
        <tbody>
          ${signals.map(s => `
            <tr>
              <td>${escapeHtml(s.signalTs?.slice(11, 16) || '—')}</td>
              <td>${escapeHtml(s.name || '—')}</td>
              <td>${escapeHtml(s.ticker)}</td>
              <td>${escapeHtml(s.sector || '—')}</td>
              <td>${escapeHtml(s.strategy)}</td>
              <td class="num">${(s.entryPrice ?? 0).toFixed(2)}</td>
              <td class="num">${(s.tpPrice ?? 0).toFixed(2)}</td>
              <td class="num">${(s.slPrice ?? 0).toFixed(2)}</td>
              <td><span class="badge ${s.side === 'sell' ? 'loss' : 'open'}">${escapeHtml(s.side || '—')}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // Open trades
  const otEl = document.getElementById('open-trades');
  document.getElementById('open-count').textContent = openTrades.length ? `(${openTrades.length})` : '';
  if (!openTrades.length) {
    otEl.innerHTML = `<div class="empty">No open trades. Mark a signal as "Entered" from Signal History to start tracking.</div>`;
  } else {
    otEl.innerHTML = `
      <table class="data">
        <thead><tr><th>NAME</th><th>TICKER</th><th>STRATEGY</th><th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th><th class="num">UNREAL.</th></tr></thead>
        <tbody>
          ${openTrades.map(t => `
            <tr>
              <td>${escapeHtml(t.name || '—')}</td>
              <td>${escapeHtml(t.ticker)}</td>
              <td>${escapeHtml(t.strategy || '—')}</td>
              <td class="num">${(t.entryPrice ?? 0).toFixed(2)}</td>
              <td class="num">${(t.tpPrice ?? 0).toFixed(2)}</td>
              <td class="num">${(t.slPrice ?? 0).toFixed(2)}</td>
              <td class="num">${(t.unrealizedPct ?? 0).toFixed(2)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}
