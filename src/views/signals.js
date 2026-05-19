// Live Signals — on-demand interactive scan.
// Pulls bars for every ticker in the user's watchlist (current market) and runs
// every strategy from /src/strategy/normalize.js. Streams results into the
// table as each ticker completes; failed fetches are surfaced in a live log.
//
// This deliberately uses the SAME `fetchBars` + `scanAllStrategies` plumbing
// as the scheduled cron worker so the math is guaranteed identical to what
// appears in Signal History.

import { state } from '../core/state.js';
import { fetchBars, DataFetchError } from '../data/fetchers.js';
import { scanAllStrategies, STRATEGIES } from '../strategy/normalize.js';
import { loadWatchlist } from '../data/watchlist.js';
import {
  STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA, companyName,
} from '../data/markets.js';
import { enterTrade, loadEnteredTradeIds, tradeIdFor } from '../data/trades.js';
import { openModal } from '../ui/modal.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Pull tickers for the scan: prefer the user's cloud watchlist, fall back to starter.
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

// Concurrency-limited iterator. `worker(item)` returns a promise; runs at most
// `concurrency` workers in parallel until all items are processed OR `shouldStop()`
// flips true (cooperative cancellation — in-flight requests keep their result).
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

let _activeRun = null; // shared so a re-render can find an in-progress run

export async function renderSignals(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Live Signals</h1>
      <p class="subtitle">Run every strategy against your watchlist for <b>${escapeHtml(state.market)}</b> right now. Results are computed in your browser and stream in as each ticker completes.</p>

      <div class="card">
        <div class="scan-controls">
          <button id="btn-run"  class="btn-primary" type="button">▶ RUN SCAN</button>
          <button id="btn-stop" class="btn-bare"    type="button" disabled>STOP</button>
          <div class="scan-progress" aria-hidden="true"><div class="bar" id="scan-bar"></div></div>
          <span id="scan-stat" style="font-family:var(--font-mono);font-size:0.85rem;color:var(--text-dim);white-space:nowrap">idle</span>
        </div>
      </div>

      <div class="card">
        <h2>Activity</h2>
        <div class="scan-log" id="scan-log">Click <b>RUN SCAN</b> to begin. The scanner walks your watchlist, fetches the last 5 years of daily bars from the data sources, then evaluates every strategy at the latest bar.</div>
      </div>

      <div class="card">
        <h2>Signals detected <span class="count" id="hits-count"></span></h2>
        <div id="scan-results"><div class="empty">No scan run yet.</div></div>
      </div>
    </div>
  `;

  const $ = (id) => document.getElementById(id);
  const log = (msg, cls = '') => {
    const el = $('scan-log');
    if (!el) return;
    const ts = new Date().toLocaleTimeString();
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = `[${ts}] ${msg}\n`;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
  };

  // Snapshot of detected signals for the current run. We render the table after
  // each ticker so users see results in real time.
  let detected = [];
  let enteredIds = new Set();

  const renderRow = (sig, idx) => {
    const id = `${sig.ticker}_${sig.strategy}_${new Date().toISOString().slice(0, 10)}`;
    // We don't have a signalTs here (it's an ad-hoc client run, not a cron write),
    // so the "Enter trade" button writes a doc that will be reconciled if the same
    // signal lands in /marketData on the next cron pass.
    const already = enteredIds.has(id);
    const env = sig.envelope;
    return `
      <tr>
        <td>
          <button class="star-btn" data-action="${already ? 'remove' : 'enter'}" data-idx="${idx}" title="${already ? 'Already tracked' : 'Track on My Trades'}">${already ? '★' : '☆'}</button>
        </td>
        <td>${escapeHtml(sig.name || sig.ticker)}</td>
        <td>${escapeHtml(sig.ticker)}</td>
        <td>${escapeHtml(sig.sector || '—')}</td>
        <td>${escapeHtml(sig.short)}</td>
        <td>${escapeHtml(env.side)}</td>
        <td class="num">${(env.entry ?? 0).toFixed(2)}</td>
        <td class="num" style="color:var(--green)">${(env.tp ?? 0).toFixed(2)}</td>
        <td class="num" style="color:var(--red)">${(env.sl ?? 0).toFixed(2)}</td>
        <td title="${escapeHtml(sig.raw?.reason || '')}">${escapeHtml((sig.raw?.reason || '').slice(0, 80))}</td>
      </tr>
    `;
  };

  const renderTable = () => {
    $('hits-count').textContent = detected.length ? `(${detected.length})` : '';
    if (!detected.length) {
      $('scan-results').innerHTML = `<div class="empty">No signals matched any strategy in this run.</div>`;
      return;
    }
    $('scan-results').innerHTML = `
      <table class="data">
        <thead><tr>
          <th></th><th>NAME</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th><th>SIDE</th>
          <th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th><th>REASON</th>
        </tr></thead>
        <tbody>${detected.map((s, i) => renderRow(s, i)).join('')}</tbody>
      </table>
    `;
    // Wire star buttons
    $('scan-results').querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const sig = detected[idx];
        if (!sig) return;
        openEnterModal(sig, btn);
      });
    });
  };

  function openEnterModal(sig, btn) {
    const env = sig.envelope;
    const today = new Date().toISOString().slice(0, 10);
    const pseudoSignal = {
      id: `${sig.ticker}_${sig.strategy}_${today}`,
      ticker: sig.ticker, name: sig.name || sig.ticker,
      sector: sig.sector, market: state.market,
      strategy: sig.short, strategyKey: sig.strategy, side: env.side,
      entryPrice: env.entry, tpPrice: env.tp, slPrice: env.sl,
      signalTs: new Date().toISOString(),
    };
    const body = `
      <div class="row" style="grid-template-columns:120px 1fr;align-items:center;gap:10px">
        <div style="color:var(--text);font-family:var(--font-mono)">${escapeHtml(sig.ticker)}</div>
        <div>${escapeHtml(sig.name || '')} · ${escapeHtml(sig.short)}</div>
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
        enteredIds.add(tradeIdFor(pseudoSignal));
        btn.dataset.action = 'remove';
        btn.textContent = '★';
        btn.title = 'Already tracked';
      },
    });
  }

  const updateProgress = (done, total, errors) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('scan-bar').style.width = pct + '%';
    $('scan-stat').textContent = `${done}/${total} · ${errors} error${errors === 1 ? '' : 's'} · ${detected.length} hit${detected.length === 1 ? '' : 's'}`;
  };

  async function runScan() {
    if (_activeRun) return;
    _activeRun = { stopped: false };
    detected = [];
    $('scan-results').innerHTML = `<div class="empty">Scanning…</div>`;
    $('btn-run').disabled = true;
    $('btn-stop').disabled = false;
    $('scan-log').textContent = '';
    log(`Loading watchlist for ${state.market}…`);

    const [tickers, enteredSet] = await Promise.all([
      loadScanTickers(state.market),
      loadEnteredTradeIds().catch(() => new Set()),
    ]);
    enteredIds = enteredSet;

    if (!tickers.length) {
      log(`Watchlist is empty. Open Watchlist → IMPORT STARTER LIST.`, 'warn');
      $('btn-run').disabled = false;
      $('btn-stop').disabled = true;
      _activeRun = null;
      return;
    }
    log(`Scanning ${tickers.length} ticker${tickers.length === 1 ? '' : 's'}…`);

    // Fetch the regime index once for relative-strength filters.
    let spyBars = null;
    try {
      spyBars = await fetchBars(state.marketCfg.indexTicker, state.fetchCtx);
      log(`Index ${state.marketCfg.indexTicker} loaded (${spyBars.length} bars).`, 'ok');
    } catch (e) {
      log(`Could not load index ${state.marketCfg.indexTicker}: ${e.message}. Relative-strength gates will be skipped for the pullback strategy.`, 'warn');
    }

    let done = 0, errors = 0;
    updateProgress(0, tickers.length, 0);

    await runConcurrent(tickers, 3, async (item) => {
      if (_activeRun?.stopped) return;
      try {
        const bars = await fetchBars(item.t, state.fetchCtx);
        const hits = scanAllStrategies(bars, { spyBars, marketCfg: state.marketCfg });
        for (const h of hits) {
          detected.push({ ticker: item.t, sector: item.s, name: item.name, ...h });
        }
        log(`${item.t}: ${hits.length} signal${hits.length === 1 ? '' : 's'}`, hits.length ? 'ok' : '');
      } catch (e) {
        errors++;
        if (e instanceof DataFetchError) {
          log(`${item.t}: ${e.cause || e.message}`, 'fail');
        } else {
          log(`${item.t}: ${e.message || String(e)}`, 'fail');
        }
      }
      done++;
      updateProgress(done, tickers.length, errors);
      // Re-render table periodically (every 5 completions or on hit) so users see
      // results without thrashing the DOM on every single ticker.
      if (detected.length && (done % 5 === 0 || done === tickers.length)) renderTable();
    }, () => _activeRun?.stopped);

    renderTable();
    log(`Done. ${detected.length} signal${detected.length === 1 ? '' : 's'} detected across ${tickers.length} ticker${tickers.length === 1 ? '' : 's'}. ${errors} fetch error${errors === 1 ? '' : 's'}.`, detected.length ? 'ok' : '');
    $('btn-run').disabled = false;
    $('btn-stop').disabled = true;
    _activeRun = null;
  }

  $('btn-run').addEventListener('click', runScan);
  $('btn-stop').addEventListener('click', () => {
    if (_activeRun) {
      _activeRun.stopped = true;
      log('Stop requested — finishing in-flight fetches and aborting.', 'warn');
    }
  });
}
