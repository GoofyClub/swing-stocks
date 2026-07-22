// Signal History — read-only view of the shared /marketData/{date}/signals/* collection.
// Each row has a ★ button to add it to /users/{uid}/enteredTrades.
//
// Timeframe is customizable (7D / 30D / 90D preset chips + custom date range).
// A per-strategy win/loss summary sits above the table, scoped to the current
// filter set so users can see how each strategy is performing in the window.

import { state, subscribe } from '../core/state.js';
import { initFirebase } from '../data/firebase.js';
import { collection, query, orderBy, limit, getDocs, collectionGroup } from 'firebase/firestore';
import { enterTrade, removeTrade, loadEnteredTradeIds, tradeIdFor } from '../data/trades.js';
import { openModal } from '../ui/modal.js';
import { mobileRowsHTML, guardMobileRowButtons, isPhoneLayout } from '../ui/mobile-rows.js';
import { initFilterCollapse } from '../ui/filter-collapse.js';
import { computeEntryStatus, entryStatusBadge, indexMultiSignal, multiSignalBadge } from '../ui/signal-status.js';
import { sectorName } from '../data/markets.js';
import { loadColumnPrefs, saveColumnPrefs, resetColumnPrefs, visibleColumns, openColumnConfig } from '../ui/column-prefs.js';
import { multiSelectHtml, fillMultiSelect, getMultiSelectValues, setMultiSelectValues, wireMultiSelect } from '../ui/multiselect.js';
import { indexOptionsForMarket, TIER_OPTIONS, indexMemberships, indexBadgeLabel } from '../data/indexes.js';

const FILTERS_LS_KEY = 'swing.history.filters';
const COLS_TABLE_KEY = 'history';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// --- Realized-performance helpers ------------------------------------------
// A CLOSED trade's return is frozen at its EXIT price. The signal doc stores
// `hitPrice` (the tp/sl/native/time-stop level it left at), so we compute the
// realized % from that directly — correct even if the stored `pctChange` is a
// stale pre-settlement live mark. Open trades use the live (current-price) mark.
function pctFor(r) {
  if (r.status === 'closed' && r.hitPrice != null && r.entryPrice) {
    return ((r.hitPrice - r.entryPrice) / r.entryPrice) * 100;
  }
  if (r.pctChange != null) return r.pctChange;
  if (r.currentPrice != null && r.entryPrice) return ((r.currentPrice - r.entryPrice) / r.entryPrice) * 100;
  return null;
}
// Stop distance as % of entry (the risk taken). Prefer the stored slPct; fall
// back to deriving it from entry/SL for older signals that lack the field.
function slPctFor(r) {
  if (r.slPct != null && r.slPct > 0) return r.slPct;
  if (r.entryPrice && r.slPrice != null && r.entryPrice > r.slPrice) {
    return ((r.entryPrice - r.slPrice) / r.entryPrice) * 100;
  }
  return null;
}
// Planned reward-to-risk ratio (e.g. 2.0 = 2:1). Known at signal time — this is
// the SETUP geometry (TP distance ÷ SL distance), not the result.
function rrFor(r) {
  if (r.expectedR != null) return r.expectedR;
  if (r.entryPrice && r.tpPrice != null && r.slPrice != null) {
    const reward = Math.abs(r.tpPrice - r.entryPrice);
    const risk = Math.abs(r.entryPrice - r.slPrice);
    return risk > 0 ? reward / risk : null;
  }
  return null;
}
// Outcome R — the realized R multiple once CLOSED (return ÷ risk taken). A
// TP-hit on a 2:1 setup ≈ +2R; an SL-hit ≈ −1R. Null while the trade is open,
// so the column stays empty until there's a real result to show.
function resultRFor(r) {
  if (r.status !== 'closed') return null;
  const p = pctFor(r);
  const slp = slPctFor(r);
  if (p == null || slp == null) return null;
  return p / slp;
}

function parseHashParams() {
  const h = window.location.hash || '';
  const q = h.includes('?') ? h.split('?')[1] : '';
  const out = {};
  for (const part of q.split('&')) {
    if (!part) continue;
    const [k, v] = part.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return out;
}

// Pulls a generous window of signals (cap 3000) — Firestore Index is on signalTs DESC.
// We then filter client-side by the user-chosen date range so users can flip
// timeframes without re-reading from the backend. The cap is high enough to cover
// 1Y+ of daily signals across the watchlist; the timeframe chips slice this set.
async function loadHistory() {
  const { db, ok } = initFirebase();
  if (!ok) return { rows: [], err: 'Firebase not configured (see SETUP.md)' };
  try {
    const q1 = query(collectionGroup(db, 'signals'), orderBy('signalTs', 'desc'), limit(3000));
    const snap = await getDocs(q1);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { rows };
  } catch (e) {
    console.error('[history] loadHistory failed', e);
    return { rows: [], err: e.message };
  }
}

function tierBadge(t, reasons) {
  if (!t) return '';
  const cls = t === 'A+' ? 'tier-aplus' : t === 'Tier 1' ? 'tier-t1' : 'tier-t2';
  const why = Array.isArray(reasons) && reasons.length
    ? ` title="${escapeHtml(t)} — ${escapeHtml(reasons.join(' · '))}"` : '';
  const cue = (t === 'A+' && why) ? ' style="text-decoration:underline dotted"' : '';
  return `<span class="badge ${cls}"${why}${cue}>${escapeHtml(t)}</span>`;
}

function applyFilters(rows, f) {
  return rows.filter(r => {
    // Date range
    if (f.from || f.to) {
      const d = (r.signalTs || '').slice(0, 10);
      if (!d) return false;
      if (f.from && d < f.from) return false;
      if (f.to   && d > f.to)   return false;
    }
    // Market filter — always enforced from state.market. Docs missing a market
    // field are treated as belonging to whichever market is active, to support
    // legacy signals written before the market field existed.
    if (f.market && r.market && r.market !== f.market) return false;
    if (f.side     && r.side     !== f.side)     return false;
    if (f.tiers?.length && !f.tiers.includes(r.tier)) return false;
    if (f.strategies?.length && !f.strategies.includes(r.strategy)) return false;
    if (f.sector   && r.sector   !== f.sector)   return false;
    if (f.indexes?.length && !indexMemberships(r).some(m => f.indexes.includes(m))) return false;
    if (f.entryStatus) {
      const es = computeEntryStatus(r);
      if (es !== f.entryStatus) return false;
    }
    if (f.winLoss) {
      if (f.winLoss === 'open'   && r.status !== 'open')   return false;
      if (f.winLoss === 'closed' && r.status !== 'closed') return false;
      if (f.winLoss === 'win'    && r.winLoss !== 'win')   return false;
      if (f.winLoss === 'loss'   && r.winLoss !== 'loss')  return false;
    }
    if (f.q) {
      const needle = f.q.toLowerCase();
      const hay = `${r.ticker || ''} ${r.name || ''}`.toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
}

// Group filtered rows by strategy and compute counts + win rate.
function summariseByStrategy(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = r.strategy || '—';
    if (!m.has(k)) m.set(k, { strategy: k, total: 0, wins: 0, losses: 0, open: 0, aplus: 0, totalPct: 0, sumR: 0, rCount: 0, grossWin: 0, grossLoss: 0, sumRR: 0, rrCount: 0 });
    const s = m.get(k);
    s.total++;
    if (r.tier === 'A+') s.aplus++;
    // Planned reward:risk is known for every signal (open or closed).
    const rr = rrFor(r);
    if (rr != null) { s.sumRR += rr; s.rrCount++; }
    if (r.status === 'closed') {
      if (r.winLoss === 'win')  s.wins++;
      else if (r.winLoss === 'loss') s.losses++;
      // Only closed trades contribute to realized performance — frozen at the
      // exit price via pctFor(). Open trades carry an unrealized live mark we
      // deliberately exclude so AVG/TOTAL % reflect booked results, not paper P&L.
      const p = pctFor(r);
      if (p != null) {
        s.totalPct += p;
        // Profit factor: gross wins vs gross losses (absolute).
        if (p >= 0) s.grossWin += p;
        else s.grossLoss += -p;
        // Realized R = return ÷ risk taken. Normalizes each trade by its own
        // stop distance (a TP-hit ≈ +2R, an SL-hit ≈ −1R).
        const slp = slPctFor(r);
        if (slp != null) { s.sumR += p / slp; s.rCount++; }
      }
    } else {
      s.open++;
    }
  }
  const out = [...m.values()].map(s => {
    const closed = s.wins + s.losses;
    return {
      ...s,
      winRate: closed ? s.wins / closed : null,
      avgPct:  closed ? s.totalPct / closed : 0,
      avgR:    s.rCount ? s.sumR / s.rCount : null,
      // Net R = total profit/loss in R across all closed trades for this strategy.
      netR:    s.rCount ? s.sumR : null,
      avgRR:   s.rrCount ? s.sumRR / s.rrCount : null,
      // Profit factor: >1 net-profitable, ∞ when there are wins but no losses yet.
      profitFactor: s.grossLoss > 0 ? s.grossWin / s.grossLoss : (s.grossWin > 0 ? Infinity : null),
    };
  });
  // Sort by total descending, then win rate descending.
  out.sort((a, b) => b.total - a.total || ((b.winRate ?? -1) - (a.winRate ?? -1)));
  return out;
}

// Win/Loss outcome badge (the column the UI labels "STATUS").
function wlBadgeInner(r) {
  const exitWhy = {
    tp: 'Hit take-profit', sl: 'Hit stop-loss',
    native: 'Indicator exit (close > 5-SMA)', time_stop: 'Time stop (max hold reached)',
    trail: 'Trailing stop (breakeven at +1R, trail 2R below high)',
  }[r.exitReason] || '';
  const t = exitWhy ? ` title="${escapeHtml(exitWhy)}"` : '';
  return r.status === 'open' ? '<span class="badge open">open</span>'
    : r.winLoss === 'win'  ? `<span class="badge win"${t}>WIN</span>`
    : r.winLoss === 'loss' ? `<span class="badge loss"${t}>LOSS</span>`
    : '<span class="badge">—</span>';
}
function wlBadge(r) {
  return `<td>${wlBadgeInner(r)}</td>`;
}

// Column registry for the Signals table. Each entry renders one <th> (header)
// and one <td> via render(row, ctx). The action column ('star') is fixed-first
// and can't be hidden. Order + visibility are user-customizable (column-prefs).
const SIGNAL_COLUMNS = {
  star:    { label: 'Track ★', header: '<th></th>',
             render: (r, ctx) => { const id = tradeIdFor(r); const on = ctx.entered.has(id);
               return `<td><button class="star-btn" data-action="${on ? 'remove' : 'enter'}" data-signal-id="${escapeHtml(id)}" title="${on ? 'Remove from My Trades' : 'Track on My Trades'}" aria-label="${on ? 'Remove' : 'Enter'} trade for ${escapeHtml(r.ticker)}">${on ? '★' : '☆'}</button></td>`; } },
  date:    { label: 'Date',          header: '<th>DATE</th>',     render: r => `<td>${escapeHtml((r.signalTs || '').slice(0, 10))}</td>` },
  name:    { label: 'Name',          header: '<th>NAME</th>',     render: (r, ctx) => `<td>${escapeHtml(r.name || '—')}${multiSignalBadge(r.ticker, ctx.multiTickers, ctx.tickerCount)}</td>` },
  ticker:  { label: 'Ticker',        header: '<th>TICKER</th>',   render: r => `<td>${escapeHtml(r.ticker || '')}</td>` },
  strategy:{ label: 'Strategy',      header: '<th>STRATEGY</th>', render: r => `<td>${escapeHtml(r.strategy || '—')}</td>` },
  wl:      { label: 'Status (W/L)',  header: '<th>STATUS</th>',   render: r => wlBadge(r) },
  pct:     { label: '%Δ (return)',   header: '<th class="num">%Δ</th>',
             render: r => { const p = pctFor(r); const c = p == null ? 'var(--text-dim)' : p >= 0 ? 'var(--green)' : 'var(--red)';
               return `<td class="num" style="color:${c}">${p == null ? '—' : (p >= 0 ? '+' : '') + p.toFixed(2) + '%'}</td>`; } },
  entry:   { label: 'Entry',         header: '<th class="num">ENTRY</th>',
             render: r => { const slp = slPctFor(r); return `<td class="num" title="${slp != null ? 'Risk: ' + slp.toFixed(2) + '%' : ''}">${(r.entryPrice ?? 0).toFixed(2)}</td>`; } },
  tp:      { label: 'TP',            header: '<th class="num">TP</th>', render: r => `<td class="num" style="color:var(--green)">${(r.tpPrice ?? 0).toFixed(2)}</td>` },
  sl:      { label: 'SL',            header: '<th class="num">SL</th>', render: r => `<td class="num" style="color:var(--red)">${(r.slPrice ?? 0).toFixed(2)}</td>` },
  rr:      { label: 'R:R (planned)', header: '<th class="num">R:R</th>',
             render: r => { const rr = rrFor(r); return `<td class="num" title="Planned reward-to-risk at signal time: TP distance ÷ SL distance. Fixed regardless of outcome.">${rr == null ? '—' : rr.toFixed(2) + ':1'}</td>`; } },
  resultr: { label: 'Outcome R (result)', header: '<th class="num">OUT R</th>',
             render: r => { const rr = resultRFor(r); if (rr == null) return '<td class="num" style="color:var(--text-dim)">—</td>';
               const c = rr >= 0 ? 'var(--green)' : 'var(--red)'; return `<td class="num" style="color:${c}" title="Realized R once closed: return ÷ risk taken. +2R = made twice the risk; −1R = lost the full risk.">${(rr >= 0 ? '+' : '') + rr.toFixed(2)}R</td>`; } },
  current: { label: 'Current price', header: '<th class="num">CURRENT</th>', render: r => `<td class="num">${r.currentPrice != null ? r.currentPrice.toFixed(2) : '—'}</td>` },
  sector:  { label: 'Sector',        header: '<th>SECTOR</th>', render: r => `<td title="${escapeHtml(r.sector || '')}">${escapeHtml(sectorName(r.sector) || '—')}</td>` },
  index:   { label: 'Index',         header: '<th>INDEX</th>',
             render: r => { const m = indexBadgeLabel(r); return `<td>${m ? `<span class="badge">${m}</span>` : '<span style="color:var(--text-dim)">—</span>'}</td>`; } },
  tier:    { label: 'Tier',          header: '<th>TIER</th>', render: r => `<td>${tierBadge(r.tier, r.tierReasons)}</td>` },
  estatus: { label: 'Entry status',  header: '<th>ENTRY STATUS</th>',
             render: r => { const es = r.status === 'open' ? computeEntryStatus(r) : null; return `<td>${es ? entryStatusBadge(es) : '<span class="badge">—</span>'}</td>`; } },
};
// User-requested default order: date, name, ticker, strategy, status, %, entry,
// TP, SL, then the remaining columns. 'star' is the fixed action column.
const DEFAULT_SIGNAL_COL_ORDER = ['star', 'date', 'name', 'ticker', 'strategy', 'wl', 'pct', 'entry', 'tp', 'sl', 'rr', 'resultr', 'current', 'sector', 'index', 'tier', 'estatus'];
const FIXED_SIGNAL_COLS = ['star'];

export async function renderHistory(root) {
  const params = parseHashParams();
  root.innerHTML = `
    <div class="view">
      <h1>Signal History · <span style="color:var(--cyan);font-weight:300">${escapeHtml(state.market)}</span></h1>
      <p class="subtitle">Your full signal history, scoped to your selected market. Pick a timeframe (up to 2Y or All), filter, and click <span style="color:var(--amber)">★</span> on any row to track it. Switch market in the top bar to view the other side.</p>

      <div class="card">
        <div style="display:flex;gap:10px;align-items:center">
          <button id="btn-toggle-filters" class="btn-bare" type="button" aria-controls="history-filter-body">▾ FILTERS</button>
          <span id="row-count" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem"></span>
        </div>
        <div id="history-filter-body" style="margin-top:10px">
        <!-- Timeframe row -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <span style="color:var(--text-mute);font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;margin-right:4px">Timeframe</span>
          <button class="btn-bare tf-chip" data-days="7">7D</button>
          <button class="btn-bare tf-chip" data-days="30">30D</button>
          <button class="btn-bare tf-chip active" data-days="90">90D</button>
          <button class="btn-bare tf-chip" data-days="180">6M</button>
          <button class="btn-bare tf-chip" data-days="365">1Y</button>
          <button class="btn-bare tf-chip" data-days="730">2Y</button>
          <button class="btn-bare tf-chip" data-days="all">All</button>
          <button class="btn-bare tf-chip" data-days="custom">Custom…</button>
          <span id="tf-range" style="display:none;gap:6px;align-items:center">
            <input id="f-from" type="date" class="btn-bare">
            <span style="color:var(--text-mute)">→</span>
            <input id="f-to"   type="date" class="btn-bare">
          </span>
          <span id="tf-label" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem"></span>
        </div>
        <!-- Filter row -->
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${multiSelectHtml('f-tier', 'All tiers')}
          <div class="seg-group" id="seg-side" role="group" aria-label="Side filter">
            <span class="seg-label">Side</span>
            <button data-value=""     class="active" type="button">ALL</button>
            <button data-value="buy"  type="button">BUYS</button>
            <button data-value="sell" type="button">SELLS</button>
          </div>
          <div class="seg-group" id="seg-winloss" role="group" aria-label="Win/Loss filter">
            <span class="seg-label">W/L</span>
            <button data-value=""       class="active" type="button">ALL</button>
            <button data-value="open"   type="button">OPEN</button>
            <button data-value="closed" type="button">CLOSED</button>
            <button data-value="win"    class="wl-win"  type="button">WIN</button>
            <button data-value="loss"   class="wl-loss" type="button">LOSS</button>
          </div>
          ${multiSelectHtml('f-strategy', 'All strategies')}
          <select id="f-sector"   class="btn-bare" title="Filter by sector"><option value="">All sectors</option></select>
          ${multiSelectHtml('f-index', 'All indices')}
          <input  id="f-q"   class="search" type="search" placeholder="ticker / name" style="max-width:220px">
          <button id="btn-save-filters" class="btn-bare" type="button" title="Save these filters for next time (this browser)">★ SAVE FILTERS</button>
          <button id="btn-columns" class="btn-bare" type="button" title="Reorder / show / hide table columns">⚙ COLUMNS</button>
          <button id="btn-csv" class="btn-bare" type="button">CSV ↓</button>
        </div>
        </div>
      </div>

      <div class="card" id="summary-card">
        <h2>Strategy summary <span class="count" id="summary-count"></span></h2>
        <div id="summary-table"><div class="empty">No data.</div></div>
      </div>

      <div class="card">
        <h2>Signals</h2>
        <div id="history-table"><div class="empty">Loading…</div></div>
      </div>
    </div>
  `;

  const [{ rows, err }, enteredIds] = await Promise.all([
    loadHistory(),
    loadEnteredTradeIds(),
  ]);
  const entered = new Set(enteredIds);

  // User-customizable column order/visibility for the Signals table.
  let colPrefs = loadColumnPrefs(COLS_TABLE_KEY, DEFAULT_SIGNAL_COL_ORDER);

  const $ = (id) => document.getElementById(id);
  // Static multi-selects (index + tier) — fixed options, filled once. Must run
  // before deep-link params + saved filters apply their selections below.
  fillMultiSelect('f-index', indexOptionsForMarket(state.market));
  fillMultiSelect('f-tier', TIER_OPTIONS);
  // Collapsible filter bar; choice persists per view (hidden by default on phones).
  initFilterCollapse({ viewKey: 'history', bodyEl: $('history-filter-body'), btnEl: $('btn-toggle-filters') });

  if (err) {
    const isPermission = /permission|insufficient/i.test(err);
    const isIndex      = /requires an index|FAILED_PRECONDITION/i.test(err);
    let hint = '';
    if (isPermission) {
      hint = `
        <div class="guide-warn" style="text-align:left;margin-top:14px">
          <b>Looks like a Firestore Security Rules issue.</b> Deploy the latest rules:
          <pre style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px 10px;margin:8px 0;font-family:var(--font-mono);font-size:0.85rem;color:var(--text);overflow-x:auto">firebase deploy --only firestore:rules</pre>
          The History view uses a <code>collectionGroup</code> query which needs the wildcard rule
          <code>match /{path=**}/signals/{id}</code> — included in <code>firestore.rules</code> at the repo root.
        </div>
      `;
    } else if (isIndex) {
      hint = `
        <div class="guide-warn" style="text-align:left;margin-top:14px">
          <b>Missing Firestore index.</b> Deploy the index manifest:
          <pre style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:8px 10px;margin:8px 0;font-family:var(--font-mono);font-size:0.85rem;color:var(--text);overflow-x:auto">firebase deploy --only firestore:indexes</pre>
          Or click the URL in the browser console (F12) to auto-create the index on first try. Indexes build asynchronously — wait 1–5 minutes after deploy.
        </div>
      `;
    } else {
      hint = `<div style="margin-top:10px;color:var(--text-mute);font-size:0.85rem">Check the browser console (F12) for the full error.</div>`;
    }
    $('history-table').innerHTML = `<div class="empty" style="text-align:left">
      <b>Couldn't load history.</b><br>
      <span style="color:var(--red);font-family:var(--font-mono);font-size:0.92rem">${escapeHtml(err)}</span>
      ${hint}
    </div>`;
    $('summary-table').innerHTML = `<div class="empty">—</div>`;
    return;
  }
  if (!rows.length) {
    const today = fmtDate(new Date());
    $('history-table').innerHTML = `<div class="empty">
      <b>No signal history yet.</b><br><br>
      The scheduled cron job populates this view by running every strategy across the watchlist once per refresh window. Today is <code>${escapeHtml(today)}</code>.<br><br>
      Trigger the first run manually: <b>GitHub → Actions → Refresh shared signals → Run workflow</b>. It takes 60–90 seconds. Refresh this page when it completes.<br><br>
      For an instant scan in your browser, use <b>Live Signals → RUN SCAN</b> — those results don't get saved to history but show what the engine sees right now.
    </div>`;
    $('summary-table').innerHTML = `<div class="empty">Nothing to summarise yet.</div>`;
    return;
  }

  // Show how fresh the newest signal is, so users know if STATUS column reflects
  // up-to-date intraday price or yesterday's close (signals are generated EOD).
  const fresh = rows[0];
  if (fresh?.signalTs) {
    const ts = new Date(fresh.signalTs);
    const diff = Date.now() - ts.getTime();
    const ageMin = Math.round(diff / 60000);
    const ageStr = ageMin < 60 ? `${ageMin} min ago`
                 : ageMin < 1440 ? `${Math.round(ageMin / 60)} hour${Math.round(ageMin/60)===1?'':'s'} ago`
                 : `${Math.round(ageMin / 1440)} day${Math.round(ageMin/1440)===1?'':'s'} ago`;
    const stale = ageMin >= 60 * 16; // >16h = likely from yesterday's close
    const note = document.createElement('div');
    note.style.cssText = `color:${stale ? 'var(--amber)' : 'var(--text-mute)'};font-size:0.85rem;font-family:var(--font-mono);margin-top:6px;margin-bottom:14px`;
    note.innerHTML = `Newest signal generated <b style="color:var(--text)">${escapeHtml(ageStr)}</b> (<span title="${escapeHtml(ts.toISOString())}">${escapeHtml(ts.toLocaleString())}</span>). ${stale ? '<b style="color:var(--amber)">STALE — </b>' : ''}STATUS column uses cron\'s last close, not real-time intraday price. Compare to live prices on your broker before trading.`;
    const subtitleEl = root.querySelector('.view > .subtitle');
    if (subtitleEl) subtitleEl.after(note);
  }

  // Populate strategy/sector dropdowns from actual data (full set, not filtered).
  const strats  = [...new Set(rows.map(r => r.strategy).filter(Boolean))].sort();
  const sectors = [...new Set(rows.map(r => r.sector).filter(Boolean))].sort();
  fillMultiSelect('f-strategy', strats);
  $('f-sector').insertAdjacentHTML('beforeend', sectors.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));

  // Pre-seed filters from URL query (Dashboard tiles can deep-link with ?side=buy or ?tier=A+).
  if (params.side) setSeg('seg-side', params.side);
  if (params.tier) setMultiSelectValues('f-tier', [params.tier]);
  if (params.strategy) setMultiSelectValues('f-strategy', [params.strategy]);

  // ---- Timeframe state ----
  let tfDays = 90;     // number of days, or 'all' for the entire loaded set
  let tfCustom = null; // { from, to }

  function activeRange() {
    if (tfCustom) return { from: tfCustom.from, to: tfCustom.to };
    const today = new Date();
    // 'all' = no lower bound: show everything the query returned.
    if (tfDays === 'all') return { from: '', to: fmtDate(today) };
    const from = new Date(today.getTime() - tfDays * 86400_000);
    return { from: fmtDate(from), to: fmtDate(today) };
  }

  function refreshTfLabel() {
    const { from, to } = activeRange();
    $('tf-label').textContent = from ? `${from} → ${to}` : `all → ${to}`;
  }

  // Wire timeframe chips
  $$('tf-chip').forEach(btn => btn.addEventListener('click', () => {
    $$('tf-chip').forEach(b => b.classList.toggle('active', b === btn));
    const v = btn.dataset.days;
    if (v === 'custom') {
      const today = new Date();
      // Seed the custom range from a sensible default (90d) when coming from 'all'.
      const seedDays = typeof tfDays === 'number' ? tfDays : 90;
      const start = new Date(today.getTime() - seedDays * 86400_000);
      $('f-from').value = fmtDate(start);
      $('f-to').value   = fmtDate(today);
      tfCustom = { from: $('f-from').value, to: $('f-to').value };
      $('tf-range').style.display = 'inline-flex';
    } else {
      tfDays = v === 'all' ? 'all' : Number(v);
      tfCustom = null;
      $('tf-range').style.display = 'none';
    }
    refreshTfLabel();
    refresh();
  }));

  $('f-from').addEventListener('change', () => {
    tfCustom = { from: $('f-from').value, to: tfCustom?.to || fmtDate(new Date()) };
    refreshTfLabel();
    refresh();
  });
  $('f-to').addEventListener('change', () => {
    tfCustom = { from: tfCustom?.from || fmtDate(new Date(Date.now() - 90*86400_000)), to: $('f-to').value };
    refreshTfLabel();
    refresh();
  });

  refreshTfLabel();

  // Compact helpers for the segmented-button filter groups (replace the legacy
  // selects). Each `.seg-group` keeps its current value as a `.active` class on
  // one of its inner buttons; `data-value=""` means "no filter".
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
        onChange();
      });
    });
  }

  function currentFilters() {
    const r = activeRange();
    return {
      from: r.from, to: r.to,
      market:   state.market,          // ALWAYS scope to current market
      side:     getSeg('seg-side'),
      tiers:    getMultiSelectValues('f-tier'),
      strategies: getMultiSelectValues('f-strategy'),
      sector:   $('f-sector').value,
      indexes:  getMultiSelectValues('f-index'),
      winLoss:  getSeg('seg-winloss'),
      q:        $('f-q').value.trim(),
    };
  }

  function renderSummary(filtered) {
    const groups = summariseByStrategy(filtered);
    $('summary-count').textContent = groups.length ? `(${groups.length} strateg${groups.length === 1 ? 'y' : 'ies'})` : '';
    if (!groups.length) {
      $('summary-table').innerHTML = `<div class="empty">No signals in this window.</div>`;
      return;
    }
    // Grand totals across every strategy in view — the bottom line of how all
    // listed trades resulted (net R is the headline profit/loss figure).
    const tot = groups.reduce((a, g) => ({
      total: a.total + g.total, aplus: a.aplus + g.aplus,
      wins: a.wins + g.wins, losses: a.losses + g.losses, open: a.open + g.open,
      netR: a.netR + (g.netR || 0), netRClosed: a.netRClosed + (g.netR != null ? 1 : 0),
      totalPct: a.totalPct + g.totalPct, grossWin: a.grossWin + g.grossWin, grossLoss: a.grossLoss + g.grossLoss,
    }), { total: 0, aplus: 0, wins: 0, losses: 0, open: 0, netR: 0, netRClosed: 0, totalPct: 0, grossWin: 0, grossLoss: 0 });
    const totClosed = tot.wins + tot.losses;
    const totWr = totClosed ? Math.round(tot.wins / totClosed * 100) + '%' : '—';
    const totAvgR = tot.netRClosed ? tot.netR / tot.netRClosed : null;
    const totPf = tot.grossLoss > 0 ? tot.grossWin / tot.grossLoss : (tot.grossWin > 0 ? Infinity : null);
    const rSpan = (v, suffix = 'R') => v == null ? '<span style="color:var(--text-dim)">—</span>'
      : `<span style="color:${v >= 0 ? 'var(--green)' : 'var(--red)'}">${(v >= 0 ? '+' : '') + v.toFixed(2) + suffix}</span>`;

    // Build ONLY the variant this screen shows; main.js re-renders on breakpoint change.
    const phone = isPhoneLayout();

    // Compact 2-line rows for phones (≤640px).
    const pfFmt = (pf) => pf == null ? '—' : pf === Infinity ? '∞' : pf.toFixed(2);
    const msumL2 = (n, wr, w, l, o, pf, avgR, totPct) => `
      <div class="msum-l2">
        <span>${n} trades</span>
        <span>WR ${wr}</span>
        <span><span style="color:var(--green)">${w}W</span>/<span style="color:var(--red)">${l}L</span>/${o}O</span>
        <span>PF ${pf}</span>
        ${avgR != null ? `<span>avg ${(avgR >= 0 ? '+' : '') + avgR.toFixed(2)}R</span>` : ''}
        <span>${rSpan(totPct, '%')}</span>
      </div>`;
    const msum = !phone ? '' : `
      <div class="mrows">
        ${groups.map(g => `
          <div class="msum" data-strategy="${escapeHtml(g.strategy)}" title="Tap to filter the table below to ${escapeHtml(g.strategy)} only">
            <div class="msum-l1"><span class="msum-name">${escapeHtml(g.strategy)}</span><span class="msum-net">${rSpan(g.netR ?? null)}</span></div>
            ${msumL2(g.total, g.winRate == null ? '—' : Math.round(g.winRate * 100) + '%', g.wins, g.losses, g.open, pfFmt(g.profitFactor), g.avgR, g.totalPct)}
          </div>`).join('')}
        ${groups.length > 1 ? `
          <div class="msum">
            <div class="msum-l1"><span class="msum-name">ALL</span><span class="msum-net">${rSpan(tot.netRClosed ? tot.netR : null)}</span></div>
            ${msumL2(tot.total, totWr, tot.wins, tot.losses, tot.open, pfFmt(totPf), totAvgR, tot.totalPct)}
          </div>` : ''}
      </div>`;

    if (phone) {
      $('summary-table').innerHTML = `<div class="tbl-mobile-switch">${msum}</div>`;
      $('summary-table').querySelectorAll('[data-strategy]').forEach(tr => {
        tr.addEventListener('click', () => {
          const s = tr.dataset.strategy;
          const cur = getMultiSelectValues('f-strategy');
          setMultiSelectValues('f-strategy', (cur.length === 1 && cur[0] === s) ? [] : [s]);
          refresh();
        });
      });
      return;
    }

    $('summary-table').innerHTML = `
      <div class="tbl-mobile-switch">
      <table class="data">
        <thead><tr>
          <th>STRATEGY</th>
          <th class="num">TOTAL</th>
          <th class="num">A+</th>
          <th class="num">WIN</th>
          <th class="num">LOSS</th>
          <th class="num">OPEN</th>
          <th class="num">WIN RATE</th>
          <th class="num">R:R</th>
          <th class="num">AVG R</th>
          <th class="num">NET R</th>
          <th class="num">PF</th>
          <th class="num">AVG %Δ</th>
          <th class="num">TOTAL %Δ</th>
        </tr></thead>
        <tbody>
          ${groups.map(g => {
            const wr = g.winRate == null ? '—' : Math.round(g.winRate * 100) + '%';
            const wrColor = g.winRate == null ? 'var(--text-dim)'
              : g.winRate >= 0.55 ? 'var(--green)'
              : g.winRate <= 0.4  ? 'var(--red)'
              : 'var(--amber)';
            const avgColor = g.avgPct >= 0 ? 'var(--green)' : 'var(--red)';
            const totalColor = g.totalPct >= 0 ? 'var(--green)' : 'var(--red)';
            const rStr = g.avgR == null ? '—' : (g.avgR >= 0 ? '+' : '') + g.avgR.toFixed(2) + 'R';
            const rColor = g.avgR == null ? 'var(--text-dim)' : g.avgR >= 0 ? 'var(--green)' : 'var(--red)';
            const netRStr = g.netR == null ? '—' : (g.netR >= 0 ? '+' : '') + g.netR.toFixed(2) + 'R';
            const netRColor = g.netR == null ? 'var(--text-dim)' : g.netR >= 0 ? 'var(--green)' : 'var(--red)';
            const pfStr = g.profitFactor == null ? '—' : g.profitFactor === Infinity ? '∞' : g.profitFactor.toFixed(2);
            const pfColor = g.profitFactor == null ? 'var(--text-dim)'
              : g.profitFactor === Infinity || g.profitFactor >= 1.5 ? 'var(--green)'
              : g.profitFactor < 1 ? 'var(--red)' : 'var(--amber)';
            const rrStr = g.avgRR == null ? '—' : g.avgRR.toFixed(2) + ':1';
            return `<tr style="cursor:pointer" data-strategy="${escapeHtml(g.strategy)}" title="Click to filter the table below to ${escapeHtml(g.strategy)} only">
              <td><b>${escapeHtml(g.strategy)}</b></td>
              <td class="num">${g.total}</td>
              <td class="num">${g.aplus}</td>
              <td class="num" style="color:var(--green)">${g.wins}</td>
              <td class="num" style="color:var(--red)">${g.losses}</td>
              <td class="num" style="color:var(--amber)">${g.open}</td>
              <td class="num" style="color:${wrColor}">${wr}</td>
              <td class="num" title="Average planned reward-to-risk ratio (TP distance ÷ SL distance) across these signals.">${rrStr}</td>
              <td class="num" style="color:${rColor}" title="Average realized R per closed trade (return ÷ risk).">${rStr}</td>
              <td class="num" style="color:${netRColor}" title="Net R = total profit/loss in R across all closed trades for this strategy (sum of each closed trade's outcome R).">${netRStr}</td>
              <td class="num" style="color:${pfColor}" title="Profit factor: gross wins ÷ gross losses. >1 is net-profitable.">${pfStr}</td>
              <td class="num" style="color:${avgColor}" title="Average realized %Δ per closed trade">${g.avgPct >= 0 ? '+' : ''}${g.avgPct.toFixed(2)}%</td>
              <td class="num" style="color:${totalColor}" title="Sum of realized %Δ across all closed trades">${g.totalPct >= 0 ? '+' : ''}${g.totalPct.toFixed(2)}%</td>
            </tr>`;
          }).join('')}
        </tbody>
        <tfoot><tr style="border-top:2px solid var(--line);font-weight:600">
          <td><b>ALL</b></td>
          <td class="num">${tot.total}</td>
          <td class="num">${tot.aplus}</td>
          <td class="num" style="color:var(--green)">${tot.wins}</td>
          <td class="num" style="color:var(--red)">${tot.losses}</td>
          <td class="num" style="color:var(--amber)">${tot.open}</td>
          <td class="num">${totWr}</td>
          <td class="num">—</td>
          <td class="num" title="Average realized R per closed trade, across all strategies.">${rSpan(totAvgR)}</td>
          <td class="num" title="NET R — total profit/loss in R across every closed trade listed. This is the bottom line of how all the trades resulted.">${rSpan(tot.netRClosed ? tot.netR : null)}</td>
          <td class="num" title="Profit factor across all closed trades.">${totPf == null ? '—' : totPf === Infinity ? '∞' : totPf.toFixed(2)}</td>
          <td class="num">—</td>
          <td class="num" title="Sum of realized %Δ across every closed trade listed.">${rSpan(tot.totalPct, '%')}</td>
        </tr></tfoot>
      </table>
      ${msum}
      </div>
    `;
    // Click a summary row (table row on desktop, compact row on mobile) → set
    // the strategy filter to that row's strategy.
    $('summary-table').querySelectorAll('[data-strategy]').forEach(tr => {
      tr.addEventListener('click', () => {
        const s = tr.dataset.strategy;
        const cur = getMultiSelectValues('f-strategy');
        // Click a row → focus just that strategy; click again (it's the only one) → clear.
        setMultiSelectValues('f-strategy', (cur.length === 1 && cur[0] === s) ? [] : [s]);
        refresh();
      });
    });
  }

  function renderTable(filtered) {
    $('row-count').textContent = `${filtered.length} of ${rows.length} rows`;
    if (!filtered.length) {
      $('history-table').innerHTML = `<div class="empty">No signals match these filters.</div>`;
      return;
    }
    // Index multi-signal tickers within the filtered set so the MULTI×N badge
    // reflects what the user is currently looking at (e.g. when scoped to a
    // single strategy, no row gets the badge).
    const { tickerCount, multiTickers } = indexMultiSignal(filtered);
    const ctx = { entered, multiTickers, tickerCount };
    // Render columns in the user's chosen order, skipping hidden ones.
    // Build ONLY the variant this screen shows (rendering both doubled the DOM
    // for hundreds of rows and made filtering slow). main.js re-renders the
    // view if the breakpoint changes.
    if (isPhoneLayout()) {
      // Compact 3-line rows for phones (≤640px).
      const mrows = mobileRowsHTML(filtered.map(r => {
        const id = tradeIdFor(r);
        const on = ctx.entered.has(id);
        const p = pctFor(r);
        const rr = rrFor(r);
        const outR = resultRFor(r);
        const es = r.status === 'open' ? computeEntryStatus(r) : null;
        const idxLbl = indexBadgeLabel(r);
        const nums = [
          { k: 'E', v: (r.entryPrice ?? 0).toFixed(2) },
          { k: 'TP', v: (r.tpPrice ?? 0).toFixed(2), color: 'var(--green)' },
          { k: 'SL', v: (r.slPrice ?? 0).toFixed(2), color: 'var(--red)' },
        ];
        if (r.currentPrice != null) nums.push({ k: 'Now', v: r.currentPrice.toFixed(2) });
        return {
          starHtml: `<button class="star-btn" data-action="${on ? 'remove' : 'enter'}" data-signal-id="${escapeHtml(id)}" title="${on ? 'Remove from My Trades' : 'Track on My Trades'}">${on ? '★' : '☆'}</button>`,
          ticker: escapeHtml(r.ticker || ''),
          name: escapeHtml(r.name || ''),
          badgesHtml: tierBadge(r.tier, r.tierReasons) + wlBadgeInner(r),
          meta: [escapeHtml(r.strategy || ''), escapeHtml(sectorName(r.sector) || ''), idxLbl, escapeHtml((r.signalTs || '').slice(5, 10))].filter(Boolean).join(' · '),
          nums,
          right: { v: p == null ? '—' : (p >= 0 ? '+' : '') + p.toFixed(2) + '%', color: p == null ? 'var(--text-dim)' : p >= 0 ? 'var(--green)' : 'var(--red)' },
          detail: [
            { k: 'R:R', v: rr == null ? '—' : rr.toFixed(2) + ':1' },
            { k: 'Out R', v: outR == null ? '—' : `<span style="color:${outR >= 0 ? 'var(--green)' : 'var(--red)'}">${(outR >= 0 ? '+' : '') + outR.toFixed(2)}R</span>` },
            { k: 'Date', v: escapeHtml((r.signalTs || '').slice(0, 10)) },
            { k: 'Side', v: escapeHtml(r.side || '—') },
            { k: 'Entry status', v: es ? entryStatusBadge(es) : '—' },
          ],
        };
      }));
      $('history-table').innerHTML = `<div class="tbl-mobile-switch">${mrows}</div>`;
      guardMobileRowButtons($('history-table'));
    } else {
      const cols = visibleColumns(colPrefs, FIXED_SIGNAL_COLS);
      const thead = cols.map(k => SIGNAL_COLUMNS[k]?.header || '').join('');
      const body = filtered.map(r =>
        `<tr data-signal-id="${escapeHtml(tradeIdFor(r))}">${cols.map(k => SIGNAL_COLUMNS[k]?.render(r, ctx) || '').join('')}</tr>`
      ).join('');
      $('history-table').innerHTML = `<table class="data"><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table>`;
    }

    $('history-table').querySelectorAll('.star-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sid = btn.dataset.signalId;
        const sig = rows.find(r => tradeIdFor(r) === sid);
        if (!sig) return;
        if (btn.dataset.action === 'enter') openEnterModal(sig, btn);
        else openRemoveModal(sig, btn);
      });
    });
  }

  function refresh() {
    const f = currentFilters();
    const filtered = applyFilters(rows, f);
    renderSummary(filtered);
    renderTable(filtered);
  }

  function openEnterModal(signal, btn) {
    const body = `
      <div class="row" style="grid-template-columns:120px 1fr;align-items:center;gap:10px">
        <div style="color:var(--text);font-family:var(--font-mono)">${escapeHtml(signal.ticker)}</div>
        <div>${escapeHtml(signal.name || '')} · ${escapeHtml(signal.strategy || '')} · ${tierBadge(signal.tier, signal.tierReasons)}</div>
        <div style="color:var(--text-mute);font-size:0.85rem">SIGNAL ENTRY</div>
        <div style="font-family:var(--font-mono)">${(signal.entryPrice ?? 0).toFixed(2)} · TP ${(signal.tpPrice ?? 0).toFixed(2)} · SL ${(signal.slPrice ?? 0).toFixed(2)}</div>
      </div>
      <div class="row">
        <label for="ov-entry">Override entry price (optional)</label>
        <input id="ov-entry" type="number" step="0.01" placeholder="${(signal.entryPrice ?? 0).toFixed(2)}">
      </div>
      <div class="row">
        <label for="notes">Notes (optional)</label>
        <textarea id="notes" maxlength="500" placeholder="Why did you take this trade? Position size?"></textarea>
      </div>
    `;
    openModal({
      title: `Enter trade · ${signal.ticker}`,
      bodyHtml: body,
      primaryLabel: 'Add to My Trades',
      onPrimary: async (dialog) => {
        const ovStr = dialog.querySelector('#ov-entry').value.trim();
        const override = ovStr ? Number(ovStr) : null;
        if (override !== null && (!Number.isFinite(override) || override <= 0)) {
          throw new Error('Override entry must be a positive number.');
        }
        const notes = dialog.querySelector('#notes').value || '';
        await enterTrade({ signal, notes, overrideEntryPrice: override });
        entered.add(tradeIdFor(signal));
        btn.dataset.action = 'remove';
        btn.textContent = '★';
        btn.title = 'Remove from My Trades';
      },
    });
  }

  function openRemoveModal(signal, btn) {
    const body = `<div>Remove <b>${escapeHtml(signal.ticker)}</b> · ${escapeHtml(signal.strategy)} from My Trades?</div>`;
    openModal({
      title: 'Remove trade',
      bodyHtml: body,
      primaryLabel: 'Remove',
      onPrimary: async () => {
        await removeTrade(tradeIdFor(signal));
        entered.delete(tradeIdFor(signal));
        btn.dataset.action = 'enter';
        btn.textContent = '☆';
        btn.title = 'Track on My Trades';
      },
    });
  }

  wireMultiSelect('f-tier', refresh);
  wireSeg('seg-side',    refresh);
  wireSeg('seg-winloss', refresh);
  wireMultiSelect('f-strategy', refresh);
  $('f-sector').addEventListener('change', refresh);
  wireMultiSelect('f-index', refresh);
  $('f-q').addEventListener('input', refresh);

  // ----- Saved filters (localStorage) --------------------------------------
  // Persist the full filter set + timeframe so the user doesn't re-pick them on
  // every visit. Applied on load unless the URL deep-links specific filters.
  function applySavedFilters(saved) {
    if (!saved) return;
    setSeg('seg-side',    saved.side    || '');
    setSeg('seg-winloss', saved.winLoss || '');
    // tiers/indexes/strategies: arrays (current) or legacy single strings.
    setMultiSelectValues('f-tier', Array.isArray(saved.tiers) ? saved.tiers : (saved.tier ? [saved.tier] : []));
    setMultiSelectValues('f-index', Array.isArray(saved.indexes) ? saved.indexes : (saved.index ? [saved.index] : []));
    const savedStrats = Array.isArray(saved.strategies) ? saved.strategies
      : (saved.strategy ? [saved.strategy] : []);
    setMultiSelectValues('f-strategy', savedStrats);
    if (saved.sector   != null) $('f-sector').value   = saved.sector;
    if (saved.q        != null) $('f-q').value         = saved.q;
    if (saved.tfCustom) {
      tfCustom = saved.tfCustom;
      $('f-from').value = saved.tfCustom.from || '';
      $('f-to').value   = saved.tfCustom.to   || '';
      $('tf-range').style.display = 'inline-flex';
      $$('tf-chip').forEach(b => b.classList.toggle('active', b.dataset.days === 'custom'));
    } else if (saved.tfDays != null) {
      tfDays = saved.tfDays;
      tfCustom = null;
      $('tf-range').style.display = 'none';
      $$('tf-chip').forEach(b => b.classList.toggle('active', b.dataset.days === String(saved.tfDays)));
    }
    refreshTfLabel();
  }

  $('btn-save-filters').addEventListener('click', () => {
    const payload = {
      side:     getSeg('seg-side'),
      tiers:    getMultiSelectValues('f-tier'),
      winLoss:  getSeg('seg-winloss'),
      strategies: getMultiSelectValues('f-strategy'),
      sector:   $('f-sector').value,
      indexes:  getMultiSelectValues('f-index'),
      q:        $('f-q').value.trim(),
      tfDays:   tfCustom ? null : tfDays,
      tfCustom: tfCustom || null,
    };
    try { localStorage.setItem(FILTERS_LS_KEY, JSON.stringify(payload)); } catch {}
    const btn = $('btn-save-filters');
    const prev = btn.textContent;
    btn.textContent = '✓ SAVED';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  });

  // ----- Column customization ----------------------------------------------
  $('btn-columns').addEventListener('click', () => {
    openColumnConfig({
      tableKey: COLS_TABLE_KEY,
      columns: SIGNAL_COLUMNS,
      prefs: colPrefs,
      defaultOrder: DEFAULT_SIGNAL_COL_ORDER,
      fixedKeys: FIXED_SIGNAL_COLS,
      onApply: (next) => {
        colPrefs = next;
        saveColumnPrefs(COLS_TABLE_KEY, colPrefs);
        renderTable(applyFilters(rows, currentFilters()));
      },
    });
  });

  // Re-render when the user toggles US ↔ INDIA in the topbar. The router also
  // re-dispatches the view on market change, but if this view is the active
  // one we want to filter the EXISTING rows array rather than refetching.
  if (window.__historyMarketUnsub) window.__historyMarketUnsub();
  window.__historyMarketUnsub = subscribe((reason) => {
    if (reason === 'market') refresh();
  });

  $('btn-csv').addEventListener('click', () => {
    const filtered = applyFilters(rows, currentFilters());
    const header = ['date','market','index','tier','tierReasons','name','ticker','sector','sectorName','strategy','side','entry','tp','sl','slPct','plannedRR','outcomeR','current','realizedOrLivePct','status','winLoss','exitReason','entryStatus'];
    const csvRows = filtered.map(r => {
      const p = pctFor(r); const rr = rrFor(r); const outR = resultRFor(r);
      return [
        (r.signalTs || '').slice(0, 10), r.market || '', r.index || '', r.tier || '', (r.tierReasons || []).join(' | '), r.name || '', r.ticker || '', r.sector || '', sectorName(r.sector) || '', r.strategy || '', r.side || '',
        r.entryPrice ?? '', r.tpPrice ?? '', r.slPrice ?? '',
        slPctFor(r) != null ? slPctFor(r).toFixed(3) : '', rr != null ? rr.toFixed(2) : '', outR != null ? outR.toFixed(3) : '',
        r.currentPrice ?? '', p != null ? p.toFixed(3) : '',
        r.status || '', r.winLoss || '', r.exitReason || '',
        computeEntryStatus(r) || '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const blob = new Blob([header.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signal-history-${fmtDate(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // Restore saved filters on load — unless the URL deep-links specific filters
  // (those take precedence so dashboard tiles always land on what they target).
  if (!params.side && !params.tier && !params.strategy) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(FILTERS_LS_KEY) || 'null'); } catch {}
    applySavedFilters(saved);
  }

  refresh();
}

// Tiny helper: querySelectorAll within document, returning Array.
function $$(cls) { return Array.from(document.getElementsByClassName(cls)); }
