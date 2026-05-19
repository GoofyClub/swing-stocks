// Live Signals — on-demand interactive scan.
//
// Design:
//   - Scan state lives at module scope per market (_scans[market]). Survives
//     view re-mounts so navigating away and back doesn't lose results.
//   - The scan loop ONLY mutates state. It never touches the DOM directly.
//     Instead it calls `_renderHook?.()` after every state change.
//   - Each view mount installs a fresh `_renderHook` closure with live DOM
//     references. So even when the user navigates away mid-scan, the running
//     loop's notifications always reach the currently-mounted view, and the
//     new view catches up incrementally.

import { state } from '../core/state.js';
import { fetchBars, DataFetchError } from '../data/fetchers.js';
import { scanAllStrategies } from '../strategy/normalize.js';
import { loadWatchlist } from '../data/watchlist.js';
import {
  STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA, companyName,
} from '../data/markets.js';
import { enterTrade, loadEnteredTradeIds, tradeIdFor } from '../data/trades.js';
import { openModal } from '../ui/modal.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----- Module-level persistence (per market) -----
const _scans = {
  US:    blankScan(),
  INDIA: blankScan(),
};
function blankScan() {
  return {
    detected: [],
    log: [],        // [{ ts, msg, cls }]
    lastRunTs: null,
    inProgress: false,
    stopRequested: false,
    tickersTotal: 0,
    tickersDone:  0,
    errors:       0,
    enteredIds: new Set(),
  };
}

// The currently-mounted view installs a hook; the scan loop pings it on every
// state change. Survives any number of view re-mounts; always points to the
// latest one.
let _renderHook = null;
function notifyTick() {
  try { _renderHook?.(); } catch (e) { console.warn('[signals] tick failed', e); }
}

async function loadScanTickers(market) {
  try {
    const wl = await loadWatchlist(market);
    if (wl && wl.length) {
      return wl.map(w => ({ t: w.ticker, s: w.sector, name: w.name || w.ticker }));
    }
  } catch {}
  const starter = market === 'INDIA' ? STARTER_WATCHLIST_INDIA : STARTER_WATCHLIST;
  return starter.map(it => ({ t: it.t, s: it.s, name: companyName(it) }));
}

async function runConcurrent(items, concurrency, worker, shouldStop) {
  const queue = [...items];
  const fns = Array.from({ length: concurrency }, async () => {
    while (queue.length && !shouldStop()) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(fns);
}

const TIER_ORDER = { 'A+': 0, 'Tier 1': 1, 'Tier 2': 2 };
function tierBadge(t) {
  const cls = t === 'A+' ? 'tier-aplus' : t === 'Tier 1' ? 'tier-t1' : 'tier-t2';
  return `<span class="badge ${cls}">${escapeHtml(t)}</span>`;
}

// =============================================================================
// Scan loop — module-level so it survives view re-mounts. Only mutates sc state
// + calls notifyTick(). NEVER touches the DOM directly.
// =============================================================================
async function executeScan(market) {
  const sc = _scans[market];
  if (sc.inProgress) return;

  sc.detected = [];
  sc.log = [];
  sc.lastRunTs = null;
  sc.inProgress = true;
  sc.stopRequested = false;
  sc.tickersDone = 0;
  sc.errors = 0;
  sc.tickersTotal = 0;

  function pushLog(msg, cls = '') {
    const ts = new Date().toLocaleTimeString();
    sc.log.push({ ts, msg, cls });
    notifyTick();
  }

  pushLog(`Loading watchlist for ${market}…`);
  notifyTick();

  const cfg = state.marketCfg; // Captured once; if user toggles market mid-scan we still use the start market's cfg.
  const fetchCtx = state.fetchCtx;

  let tickers = [];
  try {
    tickers = await loadScanTickers(market);
  } catch (e) {
    pushLog(`Could not load watchlist: ${e.message}`, 'fail');
  }
  sc.tickersTotal = tickers.length;

  try { sc.enteredIds = await loadEnteredTradeIds(); } catch { sc.enteredIds = new Set(); }
  notifyTick();

  if (!tickers.length) {
    pushLog('Watchlist is empty. Open Watchlist → IMPORT STARTER LIST.', 'warn');
    sc.inProgress = false;
    sc.lastRunTs = Date.now();
    notifyTick();
    return;
  }

  pushLog(`Scanning ${tickers.length} ticker${tickers.length === 1 ? '' : 's'}…`);

  let spyBars = null;
  try {
    spyBars = await fetchBars(cfg.indexTicker, fetchCtx);
    pushLog(`Index ${cfg.indexTicker} loaded (${spyBars.length} bars).`, 'ok');
  } catch (e) {
    pushLog(`Could not load index ${cfg.indexTicker}: ${e.message}. Pullback strategy will skip RS gates.`, 'warn');
  }

  await runConcurrent(tickers, 3, async (item) => {
    if (sc.stopRequested) return;
    try {
      const bars = await fetchBars(item.t, fetchCtx);
      const hits = scanAllStrategies(bars, { spyBars, marketCfg: cfg });
      for (const h of hits) {
        sc.detected.push({ ticker: item.t, sector: item.s, name: item.name, ...h });
      }
      pushLog(`${item.t}: ${hits.length} signal${hits.length === 1 ? '' : 's'}`, hits.length ? 'ok' : '');
    } catch (e) {
      sc.errors++;
      if (e instanceof DataFetchError) {
        pushLog(`${item.t}: ${e.cause || e.message}`, 'fail');
      } else {
        pushLog(`${item.t}: ${e.message || String(e)}`, 'fail');
      }
    }
    sc.tickersDone++;
    notifyTick();
  }, () => sc.stopRequested);

  sc.inProgress = false;
  sc.lastRunTs = Date.now();
  pushLog(`Done. ${sc.detected.length} signal${sc.detected.length === 1 ? '' : 's'} detected across ${tickers.length} ticker${tickers.length === 1 ? '' : 's'}. ${sc.errors} fetch error${sc.errors === 1 ? '' : 's'}.`, sc.detected.length ? 'ok' : '');
  notifyTick();
}

// =============================================================================
// View
// =============================================================================
export async function renderSignals(root) {
  const market = state.market;
  const sc = _scans[market] ?? (_scans[market] = blankScan());

  root.innerHTML = `
    <div class="view">
      <h1>Live Signals</h1>
      <p class="subtitle">Run every strategy against your <b>${escapeHtml(market)}</b> watchlist on demand. Results are computed in your browser and persist while you navigate to other tabs.</p>

      <div class="card">
        <div class="scan-controls">
          <button id="btn-run"  class="btn-primary" type="button">▶ RUN SCAN</button>
          <button id="btn-stop" class="btn-bare"    type="button" disabled>STOP</button>
          <button id="btn-clear" class="btn-bare"   type="button" disabled>CLEAR</button>
          <div class="scan-progress" aria-hidden="true"><div class="bar" id="scan-bar" style="width:0%"></div></div>
          <span id="scan-stat" style="font-family:var(--font-mono);font-size:0.85rem;color:var(--text-dim);white-space:nowrap"></span>
        </div>
      </div>

      <div class="card" id="filter-card" style="display:none">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <select id="f-tier" class="btn-bare">
            <option value="">All tiers</option>
            <option value="A+">A+ only</option>
            <option value="Tier 1">Tier 1</option>
            <option value="Tier 2">Tier 2</option>
          </select>
          <select id="f-side" class="btn-bare">
            <option value="">All sides</option>
            <option value="buy">Buys</option>
            <option value="sell">Sells</option>
          </select>
          <select id="f-sector" class="btn-bare"><option value="">All sectors</option></select>
          <input id="f-min" type="number" step="0.01" placeholder="min price" class="btn-bare" style="width:110px">
          <input id="f-max" type="number" step="0.01" placeholder="max price" class="btn-bare" style="width:110px">
          <input id="f-q" type="search" placeholder="ticker / name" class="search" style="max-width:200px">
          <button id="btn-reset" class="btn-bare" type="button">RESET</button>
          <span id="hit-count" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem"></span>
        </div>
      </div>

      <div class="card">
        <h2>Signals detected <span class="count" id="hits-count"></span></h2>
        <div id="scan-results"></div>
      </div>

      <details class="collapsible" id="log-collapse">
        <summary>Activity log <span id="log-count" style="color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem;margin-left:8px"></span></summary>
        <div class="body">
          <div class="scan-log" id="scan-log"></div>
        </div>
      </details>
    </div>
  `;

  const $ = (id) => document.getElementById(id);
  const logEl = $('scan-log');
  // Track what we've already drawn so renderTick() only does incremental work.
  let drawnLogIdx     = 0;
  let drawnDetectedLen = -1;
  let lastTotalCount   = -1;

  // ---- Reusable helpers
  function appendLogLine({ ts, msg, cls }) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = `[${ts}] ${msg}\n`;
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function updateProgress() {
    const pct = sc.tickersTotal ? Math.round((sc.tickersDone / sc.tickersTotal) * 100) : 0;
    $('scan-bar').style.width = pct + '%';
    if (sc.inProgress) {
      $('scan-stat').textContent = `${sc.tickersDone}/${sc.tickersTotal} · ${sc.errors} error${sc.errors === 1 ? '' : 's'} · ${sc.detected.length} hit${sc.detected.length === 1 ? '' : 's'}`;
    } else if (sc.lastRunTs) {
      const dt = new Date(sc.lastRunTs).toLocaleTimeString();
      $('scan-stat').textContent = `last run ${dt} · ${sc.detected.length} hit${sc.detected.length === 1 ? '' : 's'} · ${sc.errors} error${sc.errors === 1 ? '' : 's'}`;
    } else {
      $('scan-stat').textContent = 'idle';
    }
    $('btn-run').disabled  = sc.inProgress;
    $('btn-stop').disabled = !sc.inProgress;
    $('btn-clear').disabled = sc.inProgress || !(sc.detected.length || sc.log.length);
  }
  function updateLogCount() {
    $('log-count').textContent = `(${sc.log.length} line${sc.log.length === 1 ? '' : 's'})`;
  }
  function refreshSectorOptions() {
    const sel = $('f-sector');
    const cur = sel.value;
    const seen = new Set(Array.from(sel.options).map(o => o.value));
    for (const s of sc.detected.map(x => x.sector).filter(Boolean)) {
      if (!seen.has(s)) {
        sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
        seen.add(s);
      }
    }
    sel.value = cur;
  }
  function applyFilters(rows) {
    const tier   = $('f-tier').value;
    const side   = $('f-side').value;
    const sector = $('f-sector').value;
    const minP   = parseFloat($('f-min').value);
    const maxP   = parseFloat($('f-max').value);
    const q      = $('f-q').value.trim().toLowerCase();
    return rows.filter(r => {
      if (tier   && r.tier !== tier) return false;
      if (side   && r.envelope.side !== side) return false;
      if (sector && r.sector !== sector) return false;
      const p = r.envelope.entry;
      if (Number.isFinite(minP) && p < minP) return false;
      if (Number.isFinite(maxP) && p > maxP) return false;
      if (q) {
        const hay = `${r.ticker} ${r.name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  function renderResults() {
    refreshSectorOptions();
    if (!sc.detected.length) {
      $('hits-count').textContent = '';
      $('hit-count').textContent = '';
      $('filter-card').style.display = 'none';
      $('scan-results').innerHTML = `<div class="empty">${sc.inProgress ? 'Scanning…' : sc.lastRunTs ? 'No signals matched any strategy in this run.' : 'No scan run yet.'}</div>`;
      return;
    }
    $('filter-card').style.display = '';
    const filtered = applyFilters(sc.detected);
    filtered.sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || a.short.localeCompare(b.short) || a.ticker.localeCompare(b.ticker));

    $('hits-count').textContent = `(${filtered.length}/${sc.detected.length})`;
    $('hit-count').textContent = `${filtered.length} of ${sc.detected.length}`;
    $('scan-results').innerHTML = `
      <table class="data">
        <thead><tr>
          <th></th><th>TIER</th><th>NAME</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th><th>SIDE</th>
          <th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th><th>REASON</th>
        </tr></thead>
        <tbody>
          ${filtered.map((s, idx) => {
            const env = s.envelope;
            const tradeId = tradeIdFor({ id: `${s.ticker}_${s.strategy}_${new Date().toISOString().slice(0, 10)}` });
            const already = sc.enteredIds.has(tradeId);
            return `<tr>
              <td>
                <button class="star-btn" data-action="${already ? 'remove' : 'enter'}" data-idx="${idx}" title="${already ? 'Already tracked' : 'Track on My Trades'}">${already ? '★' : '☆'}</button>
              </td>
              <td>${tierBadge(s.tier)}</td>
              <td>${escapeHtml(s.name || s.ticker)}</td>
              <td>${escapeHtml(s.ticker)}</td>
              <td>${escapeHtml(s.sector || '—')}</td>
              <td>${escapeHtml(s.short)}</td>
              <td>${escapeHtml(env.side)}</td>
              <td class="num">${(env.entry ?? 0).toFixed(2)}</td>
              <td class="num" style="color:var(--green)">${(env.tp ?? 0).toFixed(2)}</td>
              <td class="num" style="color:var(--red)">${(env.sl ?? 0).toFixed(2)}</td>
              <td title="${escapeHtml(s.raw?.reason || '')}">${escapeHtml((s.raw?.reason || '').slice(0, 80))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    $('scan-results').querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const sig = filtered[idx];
        if (!sig) return;
        openEnterModal(sig, btn);
      });
    });
  }
  function openEnterModal(sig, btn) {
    const env = sig.envelope;
    const today = new Date().toISOString().slice(0, 10);
    const pseudoSignal = {
      id: `${sig.ticker}_${sig.strategy}_${today}`,
      ticker: sig.ticker, name: sig.name || sig.ticker,
      sector: sig.sector, market: state.market,
      strategy: sig.short, strategyKey: sig.strategy, side: env.side,
      tier: sig.tier,
      entryPrice: env.entry, tpPrice: env.tp, slPrice: env.sl,
      signalTs: new Date().toISOString(),
    };
    const body = `
      <div class="row" style="grid-template-columns:120px 1fr;align-items:center;gap:10px">
        <div style="color:var(--text);font-family:var(--font-mono)">${escapeHtml(sig.ticker)}</div>
        <div>${escapeHtml(sig.name || '')} · ${escapeHtml(sig.short)} · ${tierBadge(sig.tier)}</div>
        <div style="color:var(--text-mute);font-size:0.85rem">SIGNAL</div>
        <div style="font-family:var(--font-mono)">entry ${env.entry.toFixed(2)} · TP ${env.tp.toFixed(2)} · SL ${env.sl.toFixed(2)}</div>
      </div>
      <div class="row">
        <label for="ov-entry">Override entry price (optional)</label>
        <input id="ov-entry" type="number" step="0.01" placeholder="${env.entry.toFixed(2)}">
      </div>
      <div class="row">
        <label for="notes">Notes (optional)</label>
        <textarea id="notes" maxlength="500" placeholder="Why are you taking this trade?"></textarea>
      </div>
    `;
    openModal({
      title: `Enter trade · ${sig.ticker}`,
      bodyHtml: body,
      primaryLabel: 'Add to My Trades',
      onPrimary: async (dialog) => {
        const ovStr = dialog.querySelector('#ov-entry').value.trim();
        const override = ovStr ? Number(ovStr) : null;
        if (override !== null && (!Number.isFinite(override) || override <= 0)) {
          throw new Error('Override entry must be a positive number.');
        }
        const notes = dialog.querySelector('#notes').value || '';
        await enterTrade({ signal: pseudoSignal, notes, overrideEntryPrice: override });
        sc.enteredIds.add(tradeIdFor(pseudoSignal));
        btn.dataset.action = 'remove';
        btn.textContent = '★';
        btn.title = 'Already tracked';
      },
    });
  }

  // ----- Incremental redraw based on current sc state -----
  function renderTick() {
    // Append new log lines without rerendering the whole list.
    for (let i = drawnLogIdx; i < sc.log.length; i++) {
      appendLogLine(sc.log[i]);
    }
    drawnLogIdx = sc.log.length;
    updateLogCount();
    updateProgress();
    // Re-render results when count changes, or when scan flips between
    // in-progress / idle (so the empty-state messaging updates correctly).
    if (sc.detected.length !== drawnDetectedLen || sc.tickersDone !== lastTotalCount) {
      drawnDetectedLen = sc.detected.length;
      lastTotalCount = sc.tickersDone;
      renderResults();
    }
  }

  // ----- Initial hydration on mount: catch up to whatever's in sc -----
  if (sc.log.length === 0) {
    logEl.textContent = 'Click RUN SCAN to begin. The scanner walks your watchlist, fetches ~5 years of daily bars from the data sources, then evaluates every strategy at the latest bar.';
  } else {
    logEl.innerHTML = '';
    for (const line of sc.log) appendLogLine(line);
    drawnLogIdx = sc.log.length;
  }
  updateLogCount();
  // Make sure we have the freshest entered-trade set when coming back to the view.
  if (!sc.inProgress) {
    sc.enteredIds = await loadEnteredTradeIds().catch(() => sc.enteredIds || new Set());
  }
  renderResults();
  drawnDetectedLen = sc.detected.length;
  lastTotalCount = sc.tickersDone;
  updateProgress();

  // Install hook AFTER initial paint so the running scan starts pinging us.
  _renderHook = renderTick;

  // ----- Wire controls -----
  $('btn-run').addEventListener('click', () => {
    // Fire-and-forget; the scan loop calls notifyTick() as it makes progress.
    executeScan(market);
  });
  $('btn-stop').addEventListener('click', () => {
    sc.stopRequested = true;
    sc.log.push({ ts: new Date().toLocaleTimeString(), msg: 'Stop requested — finishing in-flight fetches.', cls: 'warn' });
    notifyTick();
  });
  $('btn-clear').addEventListener('click', () => {
    _scans[market] = blankScan();
    renderSignals(root);
  });
  $('btn-reset').addEventListener('click', () => {
    $('f-tier').value = '';
    $('f-side').value = '';
    $('f-sector').value = '';
    $('f-min').value = '';
    $('f-max').value = '';
    $('f-q').value = '';
    renderResults();
  });
  ['f-tier', 'f-side', 'f-sector'].forEach(id => $(id).addEventListener('change', renderResults));
  ['f-min', 'f-max', 'f-q'].forEach(id => $(id).addEventListener('input', renderResults));
}
