// Live Signals — on-demand interactive scan.
//
// Results persist in module state so navigating away and back does not destroy
// a completed scan. Filters apply at render time (tier / sector / side / price)
// without re-running the scan.

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

// ----- Module-level persistence -----
// One scan state per market. Survives view re-renders (sidebar nav, market toggle,
// route change, etc.) so the user doesn't lose results just by clicking around.
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

export async function renderSignals(root) {
  const market = state.market;
  const sc = _scans[market] ?? (_scans[market] = blankScan());

  root.innerHTML = `
    <div class="view">
      <h1>Live Signals</h1>
      <p class="subtitle">Run every strategy against your <b>${escapeHtml(market)}</b> watchlist on demand. Results are computed in your browser and persist while you navigate to other tabs.</p>

      <div class="card">
        <div class="scan-controls">
          <button id="btn-run"  class="btn-primary" type="button" ${sc.inProgress ? 'disabled' : ''}>▶ RUN SCAN</button>
          <button id="btn-stop" class="btn-bare"    type="button" ${sc.inProgress ? '' : 'disabled'}>STOP</button>
          <button id="btn-clear" class="btn-bare"   type="button" ${sc.detected.length || sc.log.length ? '' : 'disabled'}>CLEAR</button>
          <div class="scan-progress" aria-hidden="true"><div class="bar" id="scan-bar" style="width:${sc.tickersTotal ? Math.round((sc.tickersDone/sc.tickersTotal)*100) : 0}%"></div></div>
          <span id="scan-stat" style="font-family:var(--font-mono);font-size:0.85rem;color:var(--text-dim);white-space:nowrap"></span>
        </div>
      </div>

      <div class="card" id="filter-card" style="${sc.detected.length ? '' : 'display:none'}">
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
        <summary>Activity log <span style="color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem;margin-left:8px">(${sc.log.length} line${sc.log.length === 1 ? '' : 's'})</span></summary>
        <div class="body">
          <div class="scan-log" id="scan-log"></div>
        </div>
      </details>
    </div>
  `;

  const $ = (id) => document.getElementById(id);

  // ----- Hydrate log
  const logEl = $('scan-log');
  logEl.innerHTML = '';
  if (sc.log.length === 0) {
    logEl.textContent = 'Click RUN SCAN to begin. The scanner walks your watchlist, fetches ~5 years of daily bars from the data sources, then evaluates every strategy at the latest bar.';
  } else {
    for (const line of sc.log) appendLogLine(line);
  }

  // ----- Populate sector filter from current results
  const sectors = [...new Set(sc.detected.map(s => s.sector).filter(Boolean))].sort();
  $('f-sector').insertAdjacentHTML('beforeend', sectors.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));

  // ----- Render any persisted results
  if (sc.detected.length) {
    sc.enteredIds = await loadEnteredTradeIds().catch(() => new Set());
    renderResults();
  } else {
    $('scan-results').innerHTML = `<div class="empty">${sc.lastRunTs ? 'No signals matched any strategy in this run.' : 'No scan run yet.'}</div>`;
  }
  updateStat();

  // ----- Wire controls
  $('btn-run').addEventListener('click', () => runScan());
  $('btn-stop').addEventListener('click', () => {
    sc.stopRequested = true;
    appendLog('Stop requested — finishing in-flight fetches.', 'warn');
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

  function appendLogLine({ ts, msg, cls }) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = `[${ts}] ${msg}\n`;
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function appendLog(msg, cls = '') {
    const ts = new Date().toLocaleTimeString();
    sc.log.push({ ts, msg, cls });
    appendLogLine({ ts, msg, cls });
    // Update summary count in the collapsed header.
    const summary = root.querySelector('#log-collapse > summary > span');
    if (summary) summary.textContent = `(${sc.log.length} line${sc.log.length === 1 ? '' : 's'})`;
  }
  function updateStat() {
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
    $('btn-clear').disabled = !(sc.detected.length || sc.log.length);
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
    if (!sc.detected.length) {
      $('hits-count').textContent = '';
      $('hit-count').textContent = '';
      $('filter-card').style.display = 'none';
      $('scan-results').innerHTML = `<div class="empty">${sc.lastRunTs ? 'No signals matched any strategy in this run.' : 'No scan run yet.'}</div>`;
      return;
    }
    $('filter-card').style.display = '';
    const filtered = applyFilters(sc.detected);
    // Sort: tier first, then strategy, then ticker (stable, deterministic).
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

  async function runScan() {
    if (sc.inProgress) return;
    sc.detected = [];
    sc.log = [];
    sc.lastRunTs = null;
    sc.inProgress = true;
    sc.stopRequested = false;
    sc.tickersDone = 0;
    sc.errors = 0;
    logEl.innerHTML = '';
    $('btn-run').disabled = true;
    $('btn-stop').disabled = false;
    $('filter-card').style.display = 'none';
    $('scan-results').innerHTML = `<div class="empty">Scanning…</div>`;
    appendLog(`Loading watchlist for ${state.market}…`);

    const [tickers, enteredSet] = await Promise.all([
      loadScanTickers(state.market),
      loadEnteredTradeIds().catch(() => new Set()),
    ]);
    sc.enteredIds = enteredSet;
    sc.tickersTotal = tickers.length;

    if (!tickers.length) {
      appendLog(`Watchlist is empty. Open Watchlist → IMPORT STARTER LIST.`, 'warn');
      sc.inProgress = false;
      sc.lastRunTs = Date.now();
      $('btn-run').disabled = false;
      $('btn-stop').disabled = true;
      updateStat();
      return;
    }
    appendLog(`Scanning ${tickers.length} ticker${tickers.length === 1 ? '' : 's'}…`);

    let spyBars = null;
    try {
      spyBars = await fetchBars(state.marketCfg.indexTicker, state.fetchCtx);
      appendLog(`Index ${state.marketCfg.indexTicker} loaded (${spyBars.length} bars).`, 'ok');
    } catch (e) {
      appendLog(`Could not load index ${state.marketCfg.indexTicker}: ${e.message}. Pullback strategy will skip RS gates.`, 'warn');
    }

    updateStat();

    await runConcurrent(tickers, 3, async (item) => {
      if (sc.stopRequested) return;
      try {
        const bars = await fetchBars(item.t, state.fetchCtx);
        const hits = scanAllStrategies(bars, { spyBars, marketCfg: state.marketCfg });
        for (const h of hits) {
          sc.detected.push({ ticker: item.t, sector: item.s, name: item.name, ...h });
        }
        appendLog(`${item.t}: ${hits.length} signal${hits.length === 1 ? '' : 's'}`, hits.length ? 'ok' : '');
      } catch (e) {
        sc.errors++;
        if (e instanceof DataFetchError) {
          appendLog(`${item.t}: ${e.cause || e.message}`, 'fail');
        } else {
          appendLog(`${item.t}: ${e.message || String(e)}`, 'fail');
        }
      }
      sc.tickersDone++;
      updateStat();
      if (sc.detected.length && (sc.tickersDone % 5 === 0 || sc.tickersDone === sc.tickersTotal)) {
        // Refresh sector options as new sectors appear
        const sel = $('f-sector');
        const cur = sel.value;
        const seen = new Set(['', ...Array.from(sel.options).map(o => o.value)]);
        for (const s of sc.detected.map(x => x.sector).filter(Boolean)) {
          if (!seen.has(s)) {
            sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`);
            seen.add(s);
          }
        }
        sel.value = cur;
        renderResults();
      }
    }, () => sc.stopRequested);

    sc.inProgress = false;
    sc.lastRunTs = Date.now();
    appendLog(`Done. ${sc.detected.length} signal${sc.detected.length === 1 ? '' : 's'} detected across ${tickers.length} ticker${tickers.length === 1 ? '' : 's'}. ${sc.errors} fetch error${sc.errors === 1 ? '' : 's'}.`, sc.detected.length ? 'ok' : '');
    $('btn-run').disabled = false;
    $('btn-stop').disabled = true;
    renderResults();
    updateStat();
  }
}
