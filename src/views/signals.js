// Live Signals — primary view of trading signals.
//
// TWO DATA SOURCES, switchable per market:
//
//   1. CRON (default) — signals written by the GitHub Actions cron worker to
//      /marketData/{date}/signals/{id}. Auto-loads on mount. Fresh from the
//      most-recent successful cron pass. Best for "what does the system say
//      right now?"
//
//   2. BROWSER SCAN — ad-hoc scan run in this browser. User clicks RUN BROWSER
//      SCAN. Walks the watchlist, fetches bars directly, evaluates every
//      strategy. Best for "what would the system say if it ran NOW?"
//
// The two sources are kept in separate module-level state and switched via a
// source toggle at the top of the view. Filters apply identically to both.
// Scan results persist to localStorage so reloads don't wipe them.

import { state } from '../core/state.js';
import { fetchBars, DataFetchError } from '../data/fetchers.js';
import { scanAllStrategies } from '../strategy/normalize.js';
import { loadWatchlist } from '../data/watchlist.js';
import {
  STARTER_WATCHLIST, STARTER_WATCHLIST_INDIA, companyName, nameForTicker, sectorName,
} from '../data/markets.js';
import { enterTrade, loadEnteredTradeIds, tradeIdFor } from '../data/trades.js';
import { openModal } from '../ui/modal.js';
import { initFirebase } from '../data/firebase.js';
import {
  collection, doc, getDoc, getDocs, query, where, orderBy, limit,
} from 'firebase/firestore';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Planned reward-to-risk for a signal: TP distance ÷ SL distance (the setup
// geometry, known at signal time). Prefers a stored expectedR if present.
function plannedRR(s) {
  if (s.expectedR != null) return s.expectedR;
  if (s.entry != null && s.tp != null && s.sl != null) {
    const reward = Math.abs(s.tp - s.entry);
    const risk = Math.abs(s.entry - s.sl);
    return risk > 0 ? reward / risk : null;
  }
  return null;
}

// =============================================================================
// Module-level state
// =============================================================================

// Scan state (per market). Survives view re-mounts + page reloads (localStorage).
function blankScan() {
  return {
    detected: [], log: [],
    lastRunTs: null, inProgress: false, stopRequested: false,
    tickersTotal: 0, tickersDone: 0, errors: 0,
    enteredIds: new Set(),
  };
}

// Cron-cache state (per market). Always re-fetched from Firestore on view mount;
// not persisted (Firestore is the source of truth and reads are cheap).
function blankCron() {
  return { signals: [], date: null, refreshedAt: null, loading: false, err: null };
}

// Per-market view mode: 'cron' or 'scan'. Persists to localStorage.
function loadModePref(market) {
  try {
    const v = localStorage.getItem('swing.signalSource.' + market);
    return v === 'scan' ? 'scan' : 'cron';
  } catch { return 'cron'; }
}
function saveModePref(market, mode) {
  try { localStorage.setItem('swing.signalSource.' + market, mode); } catch {}
}

const SCAN_LS_PREFIX = 'swing.scan.';
const SCAN_LS_VERSION = 1;
const SCAN_LS_MAX_HITS = 500;
const SCAN_LS_MAX_LOG  = 200;

function loadScanFromLs(market) {
  try {
    const raw = localStorage.getItem(SCAN_LS_PREFIX + market);
    if (!raw) return blankScan();
    const parsed = JSON.parse(raw);
    if (parsed.v !== SCAN_LS_VERSION) return blankScan();
    return {
      detected:   Array.isArray(parsed.detected) ? parsed.detected : [],
      log:        Array.isArray(parsed.log) ? parsed.log : [],
      lastRunTs:  Number.isFinite(parsed.lastRunTs) ? parsed.lastRunTs : null,
      inProgress: false,
      stopRequested: false,
      tickersTotal: parsed.tickersTotal || 0,
      tickersDone:  parsed.tickersDone || 0,
      errors:       parsed.errors || 0,
      enteredIds:   new Set(),
    };
  } catch (e) {
    console.warn('[signals] failed to load scan from localStorage', e?.message);
    return blankScan();
  }
}

let _saveDebounce = null;
function saveScanToLs(market, sc) {
  if (_saveDebounce) clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(() => {
    try {
      const detected = sc.detected.slice(0, SCAN_LS_MAX_HITS).map(d => ({
        ticker: d.ticker, sector: d.sector, name: d.name,
        strategy: d.strategy, short: d.short, tier: d.tier,
        tierReasons: d.tierReasons || [],
        envelope: d.envelope,
        raw: { reason: d.raw?.reason },
      }));
      const log = sc.log.slice(-SCAN_LS_MAX_LOG);
      const payload = {
        v: SCAN_LS_VERSION,
        detected, log,
        lastRunTs:    sc.lastRunTs,
        tickersTotal: sc.tickersTotal,
        tickersDone:  sc.tickersDone,
        errors:       sc.errors,
      };
      localStorage.setItem(SCAN_LS_PREFIX + market, JSON.stringify(payload));
    } catch (e) {
      console.warn('[signals] localStorage save failed — dropping cache', e?.message);
      try { localStorage.removeItem(SCAN_LS_PREFIX + market); } catch {}
    }
  }, 250);
}

const _scans    = { US: loadScanFromLs('US'),  INDIA: loadScanFromLs('INDIA') };
const _crons    = { US: blankCron(),           INDIA: blankCron() };
const _viewMode = { US: loadModePref('US'),    INDIA: loadModePref('INDIA') };

let _renderHook = null;
let _activeMarket = null;
function notifyTick() {
  try { _renderHook?.(); } catch (e) { console.warn('[signals] tick failed', e); }
  if (_activeMarket && _scans[_activeMarket]) saveScanToLs(_activeMarket, _scans[_activeMarket]);
}

// =============================================================================
// Cron-data loader — reads the most recent /marketData/{date}/signals/* docs
// for the given market. Walks back up to 5 days to handle weekends.
// =============================================================================
async function loadLatestCron(market) {
  const cv = _crons[market];
  cv.loading = true; cv.err = null;
  notifyTick();
  try {
    const { db, ok } = initFirebase();
    if (!ok) throw new Error('Firebase not configured.');
    for (let i = 0; i < 5; i++) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      try {
        const ref = collection(db, 'marketData', d, 'signals');
        const snap = await getDocs(query(ref, where('market', '==', market), orderBy('signalTs', 'desc'), limit(500)));
        if (!snap.empty) {
          cv.signals = snap.docs.map(x => ({ id: x.id, ...x.data() }));
          cv.date = d;
          // Pull refreshedAt from parent doc for the timestamp display.
          try {
            const meta = await getDoc(doc(db, 'marketData', d));
            const ts = meta.data()?.refreshedAt?.toDate?.();
            cv.refreshedAt = ts ? ts.getTime() : null;
          } catch { cv.refreshedAt = null; }
          cv.loading = false;
          notifyTick();
          return;
        }
      } catch (e) {
        // First-pass might fail if composite index hasn't built yet — try the
        // unfiltered fallback so the user still sees data while indexes build.
        try {
          const ref = collection(db, 'marketData', d, 'signals');
          const snap = await getDocs(query(ref, orderBy('signalTs', 'desc'), limit(500)));
          if (!snap.empty) {
            const rows = snap.docs.map(x => ({ id: x.id, ...x.data() })).filter(r => !r.market || r.market === market);
            if (rows.length) {
              cv.signals = rows;
              cv.date = d;
              cv.refreshedAt = null;
              cv.loading = false;
              notifyTick();
              return;
            }
          }
        } catch (e2) {
          throw e2;
        }
      }
    }
    cv.signals = []; cv.date = null; cv.refreshedAt = null; cv.loading = false;
    notifyTick();
  } catch (e) {
    cv.signals = []; cv.err = e.message; cv.loading = false;
    notifyTick();
  }
}

// =============================================================================
// Unified row shape — both cron docs and scan results pass through here so the
// table renderer doesn't care where the data came from.
// =============================================================================
function unify(row, source) {
  if (source === 'cron') {
    return {
      source: 'cron',
      ticker: row.ticker,
      name:   row.name || nameForTicker(row.ticker) || row.ticker,
      sector: row.sector,
      tier:   row.tier || 'Tier 1',
      tierReasons: row.tierReasons || [],
      pendingEntry: row.pendingEntry ?? false,
      side:   row.side || 'buy',
      short:  row.strategy,
      strategyKey: row.strategyKey,
      entry:  row.entryPrice,
      tp:     row.tpPrice,
      sl:     row.slPrice,
      currentPrice: row.currentPrice ?? null,
      pctChange:    row.pctChange ?? null,
      status:       row.status || 'open',
      winLoss:      row.winLoss || null,
      signalTs:     row.signalTs,
      reason:       row.rawReason || '',
      tradeId:      row.id,
      market:       row.market || _activeMarket,
    };
  }
  // scan
  const env = row.envelope || {};
  const today = new Date().toISOString().slice(0, 10);
  return {
    source: 'scan',
    ticker: row.ticker,
    name:   row.name || nameForTicker(row.ticker) || row.ticker,
    sector: row.sector,
    tier:   row.tier || 'Tier 1',
    tierReasons: row.tierReasons || [],
    pendingEntry: env.pendingEntry ?? false,
    side:   env.side || 'buy',
    short:  row.short,
    strategyKey: row.strategy,
    entry:  env.entry,
    tp:     env.tp,
    sl:     env.sl,
    currentPrice: null,
    pctChange:    null,
    status:       null,
    winLoss:      null,
    signalTs:     null,
    reason:       row.raw?.reason || '',
    tradeId:      `${row.ticker}_${row.strategy}_${today}`,
    market:       _activeMarket,
  };
}

// =============================================================================
// Browser scan loop (unchanged from previous iteration — only DOM-decoupled).
// =============================================================================
async function loadScanTickers(market) {
  const resolveName = (ticker, wlName) => {
    if (wlName && wlName !== ticker) return wlName;
    return nameForTicker(ticker) || ticker;
  };
  try {
    const wl = await loadWatchlist(market);
    if (wl && wl.length) {
      return wl.map(w => ({ t: w.ticker, s: w.sector, name: resolveName(w.ticker, w.name) }));
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

async function executeScan(market) {
  const sc = _scans[market];
  if (sc.inProgress) return;
  _activeMarket = market;

  // Auto-switch to scan mode so the user sees the streaming results.
  _viewMode[market] = 'scan';
  saveModePref(market, 'scan');

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

  const cfg = state.marketCfg;
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
        // Spread h FIRST then override — keeps stock name from being clobbered
        // by strategy name. See unify() comment.
        sc.detected.push({ ...h, ticker: item.t, sector: item.s, name: item.name });
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
const TIER_ORDER = { 'A+': 0, 'Tier 1': 1, 'Tier 2': 2 };
function tierBadge(t, reasons) {
  const cls = t === 'A+' ? 'tier-aplus' : t === 'Tier 1' ? 'tier-t1' : 'tier-t2';
  const why = Array.isArray(reasons) && reasons.length
    ? ` title="${escapeHtml(t)} — ${escapeHtml(reasons.join(' · '))}"` : '';
  // For A+ append a small dotted-underline cue so users know to hover for the why.
  const cue = (t === 'A+' && why) ? ' style="text-decoration:underline dotted"' : '';
  return `<span class="badge ${cls}"${why}${cue}>${escapeHtml(t)}</span>`;
}
function statusBadge(status, winLoss) {
  if (winLoss === 'win')  return '<span class="badge win">WIN</span>';
  if (winLoss === 'loss') return '<span class="badge loss">LOSS</span>';
  if (status === 'open')  return '<span class="badge open">open</span>';
  return '<span class="badge">—</span>';
}

function fmtRelative(date) {
  if (!date) return 'never';
  const ms = typeof date === 'number' ? date : date.getTime?.() ?? 0;
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)   return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export async function renderSignals(root) {
  const market = state.market;
  const sc = _scans[market]    ?? (_scans[market] = blankScan());
  const cv = _crons[market]    ?? (_crons[market] = blankCron());
  _activeMarket = market;

  root.innerHTML = `
    <div class="view">
      <h1>Live Signals</h1>
      <p class="subtitle">Latest signals for <b>${escapeHtml(market)}</b>. By default this view shows signals computed by the scheduled cron job. Use <b>RUN BROWSER SCAN</b> to run a fresh scan in this browser right now. <span style="color:var(--text-mute)">Both modes apply the same trade-quality guards — signals with too-tight or too-wide stops are auto-rejected regardless of source.</span></p>

      <div class="card">
        <div class="signal-source-bar">
          <div class="seg-group" id="seg-source" role="tablist" aria-label="Signal source">
            <span class="seg-label">Source</span>
            <button data-value="cron" class="${_viewMode[market] === 'cron' ? 'active' : ''}" type="button" role="tab">LATEST CRON</button>
            <button data-value="scan" class="${_viewMode[market] === 'scan' ? 'active' : ''}" type="button" role="tab">BROWSER SCAN</button>
          </div>
          <button id="btn-refresh-cron" class="btn-bare" type="button" title="Re-fetch latest cron signals from Firestore">↻ REFRESH</button>
          <button id="btn-run-scan"     class="btn-primary" type="button">▶ RUN BROWSER SCAN</button>
          <button id="btn-stop-scan"    class="btn-bare" type="button" disabled>STOP</button>
          <div class="scan-progress" aria-hidden="true"><div class="bar" id="scan-bar" style="width:0%"></div></div>
          <span id="source-stat" style="margin-left:auto;font-family:var(--font-mono);font-size:0.85rem;color:var(--text-dim);white-space:nowrap"></span>
        </div>
      </div>

      <div class="card" id="filter-card">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <div class="seg-group" id="seg-tier" role="group" aria-label="Tier filter">
            <span class="seg-label">Tier</span>
            <button data-value=""       class="active" type="button">ALL</button>
            <button data-value="A+"     class="tier-aplus" type="button">A+</button>
            <button data-value="Tier 1" class="tier-t1"    type="button">T1</button>
            <button data-value="Tier 2" class="tier-t2"    type="button">T2</button>
          </div>
          <div class="seg-group" id="seg-side" role="group" aria-label="Side filter">
            <span class="seg-label">Side</span>
            <button data-value=""     class="active" type="button">ALL</button>
            <button data-value="buy"  type="button">BUYS</button>
            <button data-value="sell" type="button">SELLS</button>
          </div>
          <select id="f-strategy" class="btn-bare" title="Filter by strategy"><option value="">All strategies</option></select>
          <select id="f-sector" class="btn-bare" title="Filter by sector"><option value="">All sectors</option></select>
          <input id="f-min" type="number" step="0.01" placeholder="min price" class="btn-bare" style="width:100px">
          <input id="f-max" type="number" step="0.01" placeholder="max price" class="btn-bare" style="width:100px">
          <input id="f-q" type="search" placeholder="ticker / name" class="search" style="max-width:200px">
          <button id="btn-save-filters" class="btn-bare" type="button" title="Save these filters for next time (this browser)">★ SAVE FILTERS</button>
          <button id="btn-reset" class="btn-bare" type="button">RESET</button>
          <span id="hit-count" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem"></span>
        </div>
      </div>

      <div class="card">
        <h2>Signals <span class="count" id="hits-count"></span></h2>
        <div id="signal-results"></div>
      </div>

      <details class="collapsible" id="log-collapse">
        <summary>Browser-scan activity log <span id="log-count" style="color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem;margin-left:8px"></span></summary>
        <div class="body">
          <div class="scan-log" id="scan-log"></div>
        </div>
      </details>
    </div>
  `;

  const $ = (id) => document.getElementById(id);
  const logEl = $('scan-log');
  let drawnLogIdx = 0;
  // Saved-filter selection pending until its <option> populates (see renderResults).
  let pendingSavedSelects = null;
  const SIGNALS_FILTERS_KEY = 'swing.signals.filters';

  // ---- Helpers
  function getSeg(id) {
    return $(id)?.querySelector('button.active')?.dataset.value || '';
  }
  function setSeg(id, value) {
    const el = $(id);
    if (!el) return;
    el.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', (b.dataset.value || '') === value);
    });
  }
  function wireSeg(id, onChange) {
    $(id).querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        setSeg(id, btn.dataset.value || '');
        onChange(btn.dataset.value || '');
      });
    });
  }

  function appendLogLine({ ts, msg, cls }) {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = `[${ts}] ${msg}\n`;
    logEl.appendChild(span);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function updateLogCount() {
    $('log-count').textContent = `(${sc.log.length} line${sc.log.length === 1 ? '' : 's'})`;
  }

  // ---- Source / status line
  function updateSourceStat() {
    const mode = _viewMode[market];
    const stat = $('source-stat');
    if (mode === 'cron') {
      if (cv.loading) {
        stat.textContent = 'loading from Firestore…';
      } else if (cv.err) {
        stat.innerHTML = `<span style="color:var(--red)">error: ${escapeHtml(cv.err)}</span>`;
      } else if (cv.signals.length) {
        const dt = cv.refreshedAt ? new Date(cv.refreshedAt) : null;
        const rel = dt ? fmtRelative(dt) : 'unknown time';
        stat.innerHTML = `${cv.signals.length} signals · cron · ${escapeHtml(cv.date)} · refreshed ${escapeHtml(rel)}`;
      } else {
        stat.textContent = 'no cron signals yet — trigger the workflow';
      }
    } else {
      if (sc.inProgress) {
        stat.textContent = `${sc.tickersDone}/${sc.tickersTotal} · ${sc.errors} error${sc.errors === 1 ? '' : 's'} · ${sc.detected.length} hit${sc.detected.length === 1 ? '' : 's'}`;
      } else if (sc.lastRunTs) {
        stat.textContent = `${sc.detected.length} signals · browser scan · ${fmtRelative(sc.lastRunTs)}`;
      } else {
        stat.textContent = 'no browser scan yet';
      }
    }
    // Progress bar (scan mode only)
    const pct = sc.tickersTotal ? Math.round((sc.tickersDone / sc.tickersTotal) * 100) : 0;
    $('scan-bar').style.width = (mode === 'scan' && sc.inProgress) ? (pct + '%') : '0%';
    // Button states
    $('btn-run-scan').disabled  = sc.inProgress;
    $('btn-stop-scan').disabled = !sc.inProgress;
    $('btn-refresh-cron').disabled = cv.loading;
  }

  // ---- Active rows + filters
  function activeRows() {
    if (_viewMode[market] === 'scan') return sc.detected.map(r => unify(r, 'scan'));
    return cv.signals.map(r => unify(r, 'cron'));
  }

  // Populate a <select> with the distinct values found in `rows[field]`, keeping
  // the current selection. Used for both the sector and strategy filters.
  function refreshSelectOptions(selId, field, rows) {
    const sel = $(selId);
    const cur = sel.value;
    const seen = new Set(Array.from(sel.options).map(o => o.value));
    for (const v of rows.map(x => x[field]).filter(Boolean)) {
      if (!seen.has(v)) {
        sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`);
        seen.add(v);
      }
    }
    sel.value = cur;
  }
  function refreshSectorOptions(rows) {
    refreshSelectOptions('f-sector', 'sector', rows);
    refreshSelectOptions('f-strategy', 'short', rows);
  }

  function applyFilters(rows) {
    const tier     = getSeg('seg-tier');
    const side     = getSeg('seg-side');
    const strategy = $('f-strategy').value;
    const sector   = $('f-sector').value;
    const minP   = parseFloat($('f-min').value);
    const maxP   = parseFloat($('f-max').value);
    const q      = $('f-q').value.trim().toLowerCase();
    return rows.filter(r => {
      if (tier     && r.tier !== tier) return false;
      if (side     && r.side !== side) return false;
      if (strategy && r.short !== strategy) return false;
      if (sector   && r.sector !== sector) return false;
      if (Number.isFinite(minP) && r.entry < minP) return false;
      if (Number.isFinite(maxP) && r.entry > maxP) return false;
      if (q) {
        const hay = `${r.ticker} ${r.name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderResults() {
    const rows = activeRows();
    refreshSectorOptions(rows);
    // Strategy/sector options populate from data, so a saved selection can only
    // be applied once its <option> exists — do it here, then stop trying.
    if (pendingSavedSelects) {
      const s = pendingSavedSelects;
      if (s.strategy && [...$('f-strategy').options].some(o => o.value === s.strategy)) $('f-strategy').value = s.strategy;
      if (s.sector   && [...$('f-sector').options].some(o => o.value === s.sector))     $('f-sector').value   = s.sector;
      if ((!s.strategy || $('f-strategy').value === s.strategy) && (!s.sector || $('f-sector').value === s.sector)) pendingSavedSelects = null;
    }
    if (!rows.length) {
      const mode = _viewMode[market];
      $('hits-count').textContent = '';
      $('hit-count').textContent = '';
      const msg = mode === 'cron'
        ? (cv.loading ? 'Loading latest cron signals…'
          : cv.err  ? `Couldn't load: ${escapeHtml(cv.err)}`
          : 'No cron signals yet. Trigger Actions → Refresh shared signals on GitHub, or click ▶ RUN BROWSER SCAN above.')
        : (sc.inProgress ? 'Scanning…' : sc.lastRunTs ? 'No signals matched any strategy.' : 'Click ▶ RUN BROWSER SCAN to begin.');
      $('signal-results').innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    const filtered = applyFilters(rows);
    filtered.sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (a.short || '').localeCompare(b.short || '') || a.ticker.localeCompare(b.ticker));

    $('hits-count').textContent = `(${filtered.length}/${rows.length})`;
    $('hit-count').textContent = `${filtered.length} of ${rows.length}`;
    const isCron = _viewMode[market] === 'cron';
    $('signal-results').innerHTML = `
      <table class="data">
        <thead><tr>
          <th></th><th>TIER</th><th>NAME</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th><th>SIDE</th>
          <th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th><th class="num">R:R</th>
          ${isCron ? '<th class="num">CURRENT</th><th class="num">%Δ</th><th>W/L</th>' : '<th>REASON</th>'}
        </tr></thead>
        <tbody>
          ${filtered.map((s, idx) => {
            const already = sc.enteredIds.has(s.tradeId);
            const lastCols = isCron
              ? `
                <td class="num">${s.currentPrice != null ? s.currentPrice.toFixed(2) : '—'}</td>
                <td class="num" style="color:${s.pctChange == null ? 'var(--text-dim)' : s.pctChange >= 0 ? 'var(--green)' : 'var(--red)'}">${s.pctChange == null ? '—' : (s.pctChange >= 0 ? '+' : '') + s.pctChange.toFixed(2) + '%'}</td>
                <td>${statusBadge(s.status, s.winLoss)}</td>
              `
              : `<td title="${escapeHtml(s.reason || '')}">${escapeHtml((s.reason || '').slice(0, 80))}</td>`;
            return `<tr>
              <td>
                <button class="star-btn" data-action="${already ? 'remove' : 'enter'}" data-idx="${idx}" title="${already ? 'Already tracked' : 'Track on My Trades'}">${already ? '★' : '☆'}</button>
              </td>
              <td>${tierBadge(s.tier, s.tierReasons)}</td>
              <td>${escapeHtml(s.name || s.ticker)}</td>
              <td>${escapeHtml(s.ticker)}</td>
              <td title="${escapeHtml(s.sector || '')}">${escapeHtml(sectorName(s.sector) || '—')}</td>
              <td>${escapeHtml(s.short)}</td>
              <td>${escapeHtml(s.side)}</td>
              <td class="num">${(s.entry ?? 0).toFixed(2)}</td>
              <td class="num" style="color:var(--green)">${(s.tp ?? 0).toFixed(2)}</td>
              <td class="num" style="color:var(--red)">${(s.sl ?? 0).toFixed(2)}</td>
              <td class="num" title="Planned reward-to-risk: TP distance ÷ SL distance">${(() => { const rr = plannedRR(s); return rr == null ? '—' : rr.toFixed(2) + ':1'; })()}</td>
              ${lastCols}
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    // Wire star buttons (works on both sources — same trade-doc structure).
    $('signal-results').querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.idx);
        const sig = filtered[idx];
        if (!sig) return;
        openEnterModal(sig, btn);
      });
    });
  }

  function openEnterModal(sig, btn) {
    const pseudoSignal = {
      id: sig.tradeId,
      ticker: sig.ticker, name: sig.name,
      sector: sig.sector, market,
      strategy: sig.short, strategyKey: sig.strategyKey, side: sig.side,
      tier: sig.tier,
      pendingEntry: sig.pendingEntry ?? false,
      entryPrice: sig.entry, tpPrice: sig.tp, slPrice: sig.sl,
      signalTs: sig.signalTs || new Date().toISOString(),
    };
    const body = `
      <div class="row" style="grid-template-columns:120px 1fr;align-items:center;gap:10px">
        <div style="color:var(--text);font-family:var(--font-mono)">${escapeHtml(sig.ticker)}</div>
        <div>${escapeHtml(sig.name || '')} · ${escapeHtml(sig.short)} · ${tierBadge(sig.tier, sig.tierReasons)}</div>
        <div style="color:var(--text-mute);font-size:0.85rem">SIGNAL</div>
        <div style="font-family:var(--font-mono)">entry ${sig.entry.toFixed(2)} · TP ${sig.tp.toFixed(2)} · SL ${sig.sl.toFixed(2)}</div>
      </div>
      <div class="row">
        <label for="ov-entry">Override entry price (optional)</label>
        <input id="ov-entry" type="number" step="0.01" placeholder="${sig.entry.toFixed(2)}">
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
        sc.enteredIds.add(sig.tradeId);
        btn.dataset.action = 'remove';
        btn.textContent = '★';
        btn.title = 'Already tracked';
      },
    });
  }

  // ---- Render hook (re-installed on every mount)
  function renderTick() {
    // Append new log lines incrementally
    for (let i = drawnLogIdx; i < sc.log.length; i++) appendLogLine(sc.log[i]);
    drawnLogIdx = sc.log.length;
    updateLogCount();
    updateSourceStat();
    renderResults();
  }
  _renderHook = renderTick;

  // ---- Initial paint
  if (sc.log.length === 0) {
    logEl.textContent = 'Click ▶ RUN BROWSER SCAN to begin. The scanner walks your watchlist, fetches ~5 years of daily bars from the data sources, then evaluates every strategy at the latest bar.';
  } else {
    logEl.innerHTML = '';
    for (const line of sc.log) appendLogLine(line);
    drawnLogIdx = sc.log.length;
  }
  updateLogCount();
  // Always refresh entered-trade IDs on mount (for the ★ button).
  if (!sc.inProgress) {
    sc.enteredIds = await loadEnteredTradeIds().catch(() => sc.enteredIds || new Set());
  }

  // ---- Wire controls
  $('btn-run-scan').addEventListener('click', () => executeScan(market));
  $('btn-stop-scan').addEventListener('click', () => {
    sc.stopRequested = true;
    sc.log.push({ ts: new Date().toLocaleTimeString(), msg: 'Stop requested — finishing in-flight fetches.', cls: 'warn' });
    notifyTick();
  });
  $('btn-refresh-cron').addEventListener('click', () => loadLatestCron(market));
  $('btn-reset').addEventListener('click', () => {
    setSeg('seg-tier', '');
    setSeg('seg-side', '');
    $('f-strategy').value = '';
    $('f-sector').value = '';
    $('f-min').value = '';
    $('f-max').value = '';
    $('f-q').value = '';
    pendingSavedSelects = null;
    try { localStorage.removeItem(SIGNALS_FILTERS_KEY); } catch {}
    renderResults();
  });
  wireSeg('seg-source', (v) => {
    _viewMode[market] = v;
    saveModePref(market, v);
    renderTick();
  });
  wireSeg('seg-tier', renderResults);
  wireSeg('seg-side', renderResults);
  $('f-strategy').addEventListener('change', renderResults);
  $('f-sector').addEventListener('change', renderResults);
  ['f-min', 'f-max', 'f-q'].forEach(id => $(id).addEventListener('input', renderResults));

  // ---- Saved filters (localStorage): persist + restore the filter set. The
  // source toggle (cron/scan) and market are intentionally NOT saved here.
  $('btn-save-filters').addEventListener('click', () => {
    const payload = {
      tier: getSeg('seg-tier'), side: getSeg('seg-side'),
      strategy: $('f-strategy').value, sector: $('f-sector').value,
      min: $('f-min').value, max: $('f-max').value, q: $('f-q').value.trim(),
    };
    try { localStorage.setItem(SIGNALS_FILTERS_KEY, JSON.stringify(payload)); } catch {}
    const b = $('btn-save-filters'); const prev = b.textContent;
    b.textContent = '✓ SAVED';
    setTimeout(() => { b.textContent = prev; }, 1500);
  });
  (() => {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SIGNALS_FILTERS_KEY) || 'null'); } catch {}
    if (!saved) return;
    setSeg('seg-tier', saved.tier || '');
    setSeg('seg-side', saved.side || '');
    if (saved.min != null) $('f-min').value = saved.min;
    if (saved.max != null) $('f-max').value = saved.max;
    if (saved.q   != null) $('f-q').value   = saved.q;
    // strategy/sector options aren't populated yet — apply once they are.
    pendingSavedSelects = { strategy: saved.strategy || '', sector: saved.sector || '' };
  })();

  // ---- Auto-load cron data on mount (always, in the background — cheap reads)
  // If we don't have cron data yet OR it's older than 2 min, refetch.
  const stale = !cv.refreshedAt || (Date.now() - (cv.refreshedAt || 0) > 120_000);
  if (stale && !cv.loading) {
    loadLatestCron(market); // fire-and-forget; calls notifyTick when done
  }

  // Initial paint based on current mode + current data
  renderTick();
}
