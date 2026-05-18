// Dashboard — regime banner + KPI tiles with sparklines + sector ranks + recent activity.

import { state } from '../core/state.js';
import { navigate } from '../core/router.js';
import { initFirebase } from '../data/firebase.js';
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
} from 'firebase/firestore';
import { sparkline } from '../ui/sparkline.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nDayKeys(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
  }
  return out;
}

// Load up to 7 daily summary docs in parallel. Returns oldest-first.
async function load7DaySummaries(market) {
  const { db, ok } = initFirebase();
  if (!ok) return [];
  const dates = nDayKeys(7);
  const snaps = await Promise.all(dates.map(d => getDoc(doc(db, 'marketData', d)).catch(() => null)));
  return dates.map((d, i) => {
    const data = snaps[i]?.exists?.() ? snaps[i].data() : null;
    return { date: d, summary: data?.summaries?.[market] || null };
  }).reverse();
}

async function loadRegime(market) {
  const { db, ok } = initFirebase();
  if (!ok) return null;
  // Walk back up to 5 days to find a regime snapshot (handles weekends).
  for (const d of nDayKeys(5)) {
    try {
      const snap = await getDoc(doc(db, 'marketData', d, 'regime', market));
      if (snap.exists()) return { date: d, ...snap.data() };
    } catch {}
  }
  return null;
}

// Find the most recent date bucket that has signals (handles weekends).
async function loadTodaysSignals(market) {
  const { db, ok } = initFirebase();
  if (!ok) return { signals: [], date: null };
  for (const d of nDayKeys(5)) {
    try {
      const ref = collection(db, 'marketData', d, 'signals');
      const snap = await getDocs(query(ref, where('market', '==', market), orderBy('signalTs', 'desc'), limit(5)));
      if (!snap.empty) return { signals: snap.docs.map(x => ({ id: x.id, ...x.data() })), date: d };
    } catch (e) {
      // Composite-index missing? Fall back to unfiltered.
      try {
        const ref = collection(db, 'marketData', d, 'signals');
        const snap = await getDocs(query(ref, orderBy('signalTs', 'desc'), limit(10)));
        const rows = snap.docs.map(x => ({ id: x.id, ...x.data() })).filter(r => !r.market || r.market === market).slice(0, 5);
        if (rows.length) return { signals: rows, date: d };
      } catch {}
    }
  }
  return { signals: [], date: null };
}

async function loadOpenTrades() {
  if (!state.user) return [];
  const { db, ok } = initFirebase();
  if (!ok) return [];
  try {
    const ref = collection(db, 'users', state.user.uid, 'enteredTrades');
    const snap = await getDocs(query(ref, where('status', '==', 'open'), limit(20)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Status filter requires no index for a single-equality query, but be tolerant.
    try {
      const ref = collection(db, 'users', state.user.uid, 'enteredTrades');
      const snap = await getDocs(query(ref, limit(50)));
      return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(t => t.status !== 'closed');
    } catch {}
    return [];
  }
}

// ---- Regime banner ---------------------------------------------------------------

function regimeBannerHtml(regime) {
  if (!regime) {
    return `
      <div class="regime-banner regime-unknown">
        <div class="rb-label">MARKET REGIME</div>
        <div class="rb-headline">— · waiting for first cron run</div>
        <div class="rb-sub">The scheduled refresh hasn't published a regime snapshot yet.</div>
      </div>
    `;
  }
  const tradeable = regime.tradeable === true;
  const cash      = regime.go_to_cash === true;
  const cls   = cash ? 'regime-bad' : (tradeable ? 'regime-good' : 'regime-warn');
  const icon  = cash ? '⚠' : (tradeable ? '✓' : '○');
  const head  = cash ? 'GO TO CASH' : (tradeable ? 'TRADEABLE' : 'CAUTION');
  const checks = (regime.checks || [])
    .filter(c => c.pass !== null)
    .map(c => `<span class="${c.pass ? 'ok' : 'fail'}">${c.pass ? '✓' : '✗'} ${escapeHtml(c.name)}</span>`)
    .join(' · ');
  return `
    <div class="regime-banner ${cls}">
      <div class="rb-label">MARKET REGIME · ${escapeHtml(regime.indexLabel || '')} · as of ${escapeHtml(regime.date || '')}</div>
      <div class="rb-headline">${icon} ${head}</div>
      <div class="rb-sub">${checks || '—'}</div>
    </div>
  `;
}

// ---- KPI tile w/ sparkline -------------------------------------------------------

function tileHtml({ label, value, delta, deltaCls, sparkValues, sparkColor, deepLink }) {
  const sub = delta != null
    ? `<div class="delta ${deltaCls}">${delta}</div>`
    : '';
  const spark = Array.isArray(sparkValues)
    ? `<div class="tile-spark" style="color:${sparkColor || 'var(--cyan)'}">${sparkline(sparkValues, { width: 140, height: 28 })}</div>`
    : '';
  const data = deepLink ? `data-go="${escapeHtml(deepLink)}"` : '';
  return `
    <div class="tile" ${data}>
      <div class="label">${escapeHtml(label)}</div>
      <div class="big">${escapeHtml(String(value))}</div>
      ${sub}
      ${spark}
    </div>
  `;
}

// ---- Sector ranks widget --------------------------------------------------------

function sectorRanksHtml(regime) {
  const ranks = regime?.sectorRanks;
  if (!Array.isArray(ranks) || !ranks.length) {
    return `<div class="empty">No sector data yet.</div>`;
  }
  const maxAbs = Math.max(...ranks.map(r => Math.abs(r.ret_20d || 0)));
  return `
    <table class="data sector-ranks">
      <thead><tr><th>#</th><th>SECTOR</th><th class="num">20d</th><th class="bar-col"></th></tr></thead>
      <tbody>
        ${ranks.slice(0, 8).map(r => {
          const pct = (r.ret_20d || 0) * 100;
          const w = maxAbs > 0 ? Math.min(100, Math.abs(pct) / (maxAbs * 100) * 100) : 0;
          const cls = pct >= 0 ? 'up' : 'down';
          return `<tr>
            <td>${r.rank}</td>
            <td>${escapeHtml(r.name || r.etf)}</td>
            <td class="num" style="color:${pct >= 0 ? 'var(--green)' : 'var(--red)'}">${(pct >= 0 ? '+' : '') + pct.toFixed(2)}%</td>
            <td class="bar-col"><div class="rank-bar ${cls}" style="width:${w.toFixed(0)}%"></div></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ---- Render --------------------------------------------------------------------

export async function renderDashboard(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Dashboard</h1>
      <p class="subtitle">Current market regime, today's signals, and your open positions.</p>

      <div id="regime-slot">
        <div class="regime-banner skeleton" style="height:88px"></div>
      </div>

      <div class="tile-grid" id="tile-grid">
        <div class="tile skeleton" style="height:130px"></div>
        <div class="tile skeleton" style="height:130px"></div>
        <div class="tile skeleton" style="height:130px"></div>
        <div class="tile skeleton" style="height:130px"></div>
      </div>

      <div class="two-col">
        <div class="card">
          <h2>Today's top signals <span class="count" id="sig-count"></span></h2>
          <div id="today-signals"><div class="empty">Loading…</div></div>
        </div>
        <div class="card">
          <h2>Sector rank (20d)</h2>
          <div id="sector-ranks"><div class="empty">Loading…</div></div>
        </div>
      </div>

      <div class="card">
        <h2>My open trades <span class="count" id="open-count"></span></h2>
        <div id="open-trades"><div class="empty">Loading…</div></div>
      </div>
    </div>
  `;

  const market = state.market;
  const [series, regime, sigs, openTrades] = await Promise.all([
    load7DaySummaries(market),
    loadRegime(market),
    loadTodaysSignals(market),
    loadOpenTrades(),
  ]);

  // ---- Regime
  document.getElementById('regime-slot').innerHTML = regimeBannerHtml(regime);

  // ---- KPI tiles
  const buys  = series.map(s => s.summary?.buyCount  ?? null);
  const sells = series.map(s => s.summary?.sellCount ?? null);
  const todayBuys  = buys[buys.length - 1] ?? 0;
  const todaySells = sells[sells.length - 1] ?? 0;
  const ydayBuys   = buys[buys.length - 2] ?? null;
  const ydaySells  = sells[sells.length - 2] ?? null;
  const buyDelta  = ydayBuys  != null ? todayBuys  - ydayBuys  : null;
  const sellDelta = ydaySells != null ? todaySells - ydaySells : null;

  // Open trades count over the 7-day window (count per entry date).
  const openByDay = new Map(series.map(s => [s.date, 0]));
  for (const t of openTrades) {
    const d = t.signalDate || (t.enteredAt?.toDate?.()?.toISOString?.().slice(0, 10));
    if (d && openByDay.has(d)) openByDay.set(d, openByDay.get(d) + 1);
  }
  const openSeries = series.map(s => openByDay.get(s.date) ?? 0);

  // Unrealized P/L sum (today only — no historical series).
  const totalUnreal = openTrades.reduce((s, t) => {
    if (t.currentPrice != null && t.entryPrice) {
      return s + ((t.currentPrice - t.entryPrice) / t.entryPrice) * 100;
    }
    return s;
  }, 0);

  document.getElementById('tile-grid').innerHTML = [
    tileHtml({
      label: 'Buy signals today', value: todayBuys,
      delta: buyDelta == null ? 'no comparison data' : `${buyDelta >= 0 ? '▲ +' : '▼ '}${buyDelta} vs yesterday`,
      deltaCls: buyDelta == null ? '' : (buyDelta >= 0 ? 'up' : 'down'),
      sparkValues: buys, sparkColor: 'var(--green)',
      deepLink: 'history?side=buy',
    }),
    tileHtml({
      label: 'Sell signals today', value: todaySells,
      delta: sellDelta == null ? 'no comparison data' : `${sellDelta >= 0 ? '▲ +' : '▼ '}${sellDelta} vs yesterday`,
      deltaCls: sellDelta == null ? '' : (sellDelta > 0 ? 'down' : 'up'),
      sparkValues: sells, sparkColor: 'var(--red)',
      deepLink: 'history?side=sell',
    }),
    tileHtml({
      label: 'Open trades', value: openTrades.length,
      delta: openTrades.length ? 'tracked across devices' : 'none yet',
      deltaCls: '',
      sparkValues: openSeries.some(v => v > 0) ? openSeries : null,
      sparkColor: 'var(--cyan)',
      deepLink: 'mytrades',
    }),
    tileHtml({
      label: 'Unrealized P/L', value: (totalUnreal >= 0 ? '+' : '') + totalUnreal.toFixed(2) + '%',
      delta: openTrades.length ? `across ${openTrades.length} open` : '—',
      deltaCls: totalUnreal >= 0 ? 'up' : 'down',
      sparkValues: null,
      deepLink: 'mytrades',
    }),
  ].join('');

  document.querySelectorAll('#tile-grid .tile').forEach(t => {
    t.addEventListener('click', () => {
      const target = t.dataset.go;
      if (target) navigate(target);
    });
  });

  // ---- Today's top signals
  document.getElementById('sig-count').textContent = sigs.signals.length ? `(${sigs.signals.length})` : '';
  document.getElementById('today-signals').innerHTML = sigs.signals.length ? `
    <table class="data">
      <thead><tr><th>TIME</th><th>NAME</th><th>TICKER</th><th>STRATEGY</th><th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th><th>SIDE</th></tr></thead>
      <tbody>
        ${sigs.signals.map(s => `<tr>
          <td>${escapeHtml(s.signalTs?.slice(11, 16) || '—')}</td>
          <td>${escapeHtml(s.name || '—')}</td>
          <td>${escapeHtml(s.ticker)}</td>
          <td>${escapeHtml(s.strategy)}</td>
          <td class="num">${(s.entryPrice ?? 0).toFixed(2)}</td>
          <td class="num">${(s.tpPrice ?? 0).toFixed(2)}</td>
          <td class="num">${(s.slPrice ?? 0).toFixed(2)}</td>
          <td><span class="badge ${s.side === 'sell' ? 'loss' : 'open'}">${escapeHtml(s.side || '—')}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>
  ` : `<div class="empty">No signals yet for ${escapeHtml(market)}. The cron job populates these once per refresh window.</div>`;

  // ---- Sector ranks
  document.getElementById('sector-ranks').innerHTML = sectorRanksHtml(regime);

  // ---- Open trades
  document.getElementById('open-count').textContent = openTrades.length ? `(${openTrades.length})` : '';
  document.getElementById('open-trades').innerHTML = openTrades.length ? `
    <table class="data">
      <thead><tr><th>NAME</th><th>TICKER</th><th>STRATEGY</th><th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th><th class="num">CURRENT</th><th class="num">UNREAL.</th></tr></thead>
      <tbody>
        ${openTrades.map(t => {
          const pl = t.currentPrice != null && t.entryPrice ? ((t.currentPrice - t.entryPrice) / t.entryPrice) * 100 : null;
          return `<tr>
            <td>${escapeHtml(t.name || '—')}</td>
            <td>${escapeHtml(t.ticker)}</td>
            <td>${escapeHtml(t.strategy || '—')}</td>
            <td class="num">${(t.entryPrice ?? 0).toFixed(2)}</td>
            <td class="num">${(t.tpPrice ?? 0).toFixed(2)}</td>
            <td class="num">${(t.slPrice ?? 0).toFixed(2)}</td>
            <td class="num">${t.currentPrice != null ? t.currentPrice.toFixed(2) : '—'}</td>
            <td class="num" style="color:${pl == null ? 'var(--text-dim)' : pl >= 0 ? 'var(--green)' : 'var(--red)'}">${pl == null ? '—' : (pl >= 0 ? '+' : '') + pl.toFixed(2) + '%'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  ` : `<div class="empty">No open trades. Mark a signal as "Entered" from Signal History to start tracking.</div>`;
}
