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
import { computeEntryStatus, entryStatusBadge, indexMultiSignal, multiSignalBadge } from '../ui/signal-status.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
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

// Pulls a generous window of signals (cap 500) — Firestore Index is on signalTs DESC.
// We then filter client-side by the user-chosen date range so users can flip
// timeframes without re-reading from the backend.
async function loadHistory() {
  const { db, ok } = initFirebase();
  if (!ok) return { rows: [], err: 'Firebase not configured (see SETUP.md)' };
  try {
    const q1 = query(collectionGroup(db, 'signals'), orderBy('signalTs', 'desc'), limit(500));
    const snap = await getDocs(q1);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return { rows };
  } catch (e) {
    console.error('[history] loadHistory failed', e);
    return { rows: [], err: e.message };
  }
}

function tierBadge(t) {
  if (!t) return '';
  const cls = t === 'A+' ? 'tier-aplus' : t === 'Tier 1' ? 'tier-t1' : 'tier-t2';
  return `<span class="badge ${cls}">${escapeHtml(t)}</span>`;
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
    if (f.tier     && r.tier     !== f.tier)     return false;
    if (f.strategy && r.strategy !== f.strategy) return false;
    if (f.sector   && r.sector   !== f.sector)   return false;
    if (f.entryStatus) {
      const es = computeEntryStatus(r);
      if (es !== f.entryStatus) return false;
    }
    if (f.winLoss) {
      if (f.winLoss === 'open' && r.status !== 'open') return false;
      if (f.winLoss === 'win'  && r.winLoss !== 'win')  return false;
      if (f.winLoss === 'loss' && r.winLoss !== 'loss') return false;
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
    if (!m.has(k)) m.set(k, { strategy: k, total: 0, wins: 0, losses: 0, open: 0, aplus: 0, totalPct: 0 });
    const s = m.get(k);
    s.total++;
    if (r.tier === 'A+') s.aplus++;
    if (r.status === 'closed') {
      if (r.winLoss === 'win')  s.wins++;
      else if (r.winLoss === 'loss') s.losses++;
    } else {
      s.open++;
    }
    if (r.pctChange != null) s.totalPct += r.pctChange;
  }
  const out = [...m.values()].map(s => {
    const closed = s.wins + s.losses;
    return {
      ...s,
      winRate: closed ? s.wins / closed : null,
      avgPct:  s.total ? s.totalPct / s.total : 0,
    };
  });
  // Sort by total descending, then win rate descending.
  out.sort((a, b) => b.total - a.total || ((b.winRate ?? -1) - (a.winRate ?? -1)));
  return out;
}

export async function renderHistory(root) {
  const params = parseHashParams();
  root.innerHTML = `
    <div class="view">
      <h1>Signal History · <span style="color:var(--cyan);font-weight:300">${escapeHtml(state.market)}</span></h1>
      <p class="subtitle">Signals from the last 3 months, scoped to your selected market. Pick a timeframe, filter, and click <span style="color:var(--amber)">★</span> on any row to track it. Switch market in the top bar to view the other side.</p>

      <div class="card">
        <!-- Timeframe row -->
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
          <span style="color:var(--text-mute);font-size:0.85rem;text-transform:uppercase;letter-spacing:0.08em;margin-right:4px">Timeframe</span>
          <button class="btn-bare tf-chip" data-days="7">7D</button>
          <button class="btn-bare tf-chip" data-days="30">30D</button>
          <button class="btn-bare tf-chip active" data-days="90">90D</button>
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
          <div class="seg-group" id="seg-winloss" role="group" aria-label="Win/Loss filter">
            <span class="seg-label">W/L</span>
            <button data-value=""     class="active" type="button">ALL</button>
            <button data-value="open" type="button">OPEN</button>
            <button data-value="win"  class="wl-win"  type="button">WIN</button>
            <button data-value="loss" class="wl-loss" type="button">LOSS</button>
          </div>
          <select id="f-strategy" class="btn-bare" title="Filter by strategy"><option value="">All strategies</option></select>
          <select id="f-sector"   class="btn-bare" title="Filter by sector"><option value="">All sectors</option></select>
          <input  id="f-q"   class="search" type="search" placeholder="ticker / name" style="max-width:220px">
          <button id="btn-csv" class="btn-bare" type="button">CSV ↓</button>
          <span id="row-count" style="margin-left:auto;color:var(--text-dim);font-family:var(--font-mono);font-size:0.85rem"></span>
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

  const $ = (id) => document.getElementById(id);

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
  $('f-strategy').insertAdjacentHTML('beforeend', strats.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));
  $('f-sector').insertAdjacentHTML('beforeend', sectors.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join(''));

  // Pre-seed filters from URL query (Dashboard tiles can deep-link with ?side=buy or ?tier=A+).
  if (params.side) setSeg('seg-side', params.side);
  if (params.tier) setSeg('seg-tier', params.tier);
  if (params.strategy) $('f-strategy').value = params.strategy;

  // ---- Timeframe state ----
  let tfDays = 90;
  let tfCustom = null; // { from, to }

  function activeRange() {
    if (tfCustom) return { from: tfCustom.from, to: tfCustom.to };
    const today = new Date();
    const from = new Date(today.getTime() - tfDays * 86400_000);
    return { from: fmtDate(from), to: fmtDate(today) };
  }

  function refreshTfLabel() {
    const { from, to } = activeRange();
    $('tf-label').textContent = `${from} → ${to}`;
  }

  // Wire timeframe chips
  $$('tf-chip').forEach(btn => btn.addEventListener('click', () => {
    $$('tf-chip').forEach(b => b.classList.toggle('active', b === btn));
    const v = btn.dataset.days;
    if (v === 'custom') {
      const today = new Date();
      const start = new Date(today.getTime() - tfDays * 86400_000);
      $('f-from').value = fmtDate(start);
      $('f-to').value   = fmtDate(today);
      tfCustom = { from: $('f-from').value, to: $('f-to').value };
      $('tf-range').style.display = 'inline-flex';
    } else {
      tfDays = Number(v);
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
      tier:     getSeg('seg-tier'),
      strategy: $('f-strategy').value,
      sector:   $('f-sector').value,
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
    $('summary-table').innerHTML = `
      <table class="data">
        <thead><tr>
          <th>STRATEGY</th>
          <th class="num">TOTAL</th>
          <th class="num">A+</th>
          <th class="num">WIN</th>
          <th class="num">LOSS</th>
          <th class="num">OPEN</th>
          <th class="num">WIN RATE</th>
          <th class="num">AVG %Δ</th>
        </tr></thead>
        <tbody>
          ${groups.map(g => {
            const wr = g.winRate == null ? '—' : Math.round(g.winRate * 100) + '%';
            const wrColor = g.winRate == null ? 'var(--text-dim)'
              : g.winRate >= 0.55 ? 'var(--green)'
              : g.winRate <= 0.4  ? 'var(--red)'
              : 'var(--amber)';
            const avgColor = g.avgPct >= 0 ? 'var(--green)' : 'var(--red)';
            return `<tr style="cursor:pointer" data-strategy="${escapeHtml(g.strategy)}" title="Click to filter the table below to ${escapeHtml(g.strategy)} only">
              <td><b>${escapeHtml(g.strategy)}</b></td>
              <td class="num">${g.total}</td>
              <td class="num">${g.aplus}</td>
              <td class="num" style="color:var(--green)">${g.wins}</td>
              <td class="num" style="color:var(--red)">${g.losses}</td>
              <td class="num" style="color:var(--amber)">${g.open}</td>
              <td class="num" style="color:${wrColor}">${wr}</td>
              <td class="num" style="color:${avgColor}">${g.avgPct >= 0 ? '+' : ''}${g.avgPct.toFixed(2)}%</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    // Click a summary row → set the strategy filter to that row's strategy.
    $('summary-table').querySelectorAll('tr[data-strategy]').forEach(tr => {
      tr.addEventListener('click', () => {
        const s = tr.dataset.strategy;
        $('f-strategy').value = $('f-strategy').value === s ? '' : s;
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
    const html = `
      <table class="data">
        <thead><tr>
          <th></th>
          <th>TIER</th>
          <th>DATE</th><th>NAME</th><th>TICKER</th><th>SECTOR</th><th>STRATEGY</th>
          <th class="num">ENTRY</th><th class="num">TP</th><th class="num">SL</th>
          <th class="num">CURRENT</th><th class="num">%Δ</th>
          <th>STATUS</th><th>W/L</th>
        </tr></thead>
        <tbody>
          ${filtered.map(r => {
            const pct = r.pctChange != null ? r.pctChange : (r.currentPrice && r.entryPrice ? ((r.currentPrice - r.entryPrice) / r.entryPrice) * 100 : null);
            const wl = r.status === 'open' ? '<span class="badge open">open</span>'
                     : r.winLoss === 'win'  ? '<span class="badge win">WIN</span>'
                     : r.winLoss === 'loss' ? '<span class="badge loss">LOSS</span>'
                     : '<span class="badge">—</span>';
            const id = tradeIdFor(r);
            const isEntered = entered.has(id);
            const entryStatus = r.status === 'open' ? computeEntryStatus(r) : null;
            const multi = multiSignalBadge(r.ticker, multiTickers, tickerCount);
            return `<tr data-signal-id="${escapeHtml(id)}">
              <td>
                <button class="star-btn" data-action="${isEntered ? 'remove' : 'enter'}" data-signal-id="${escapeHtml(id)}" title="${isEntered ? 'Remove from My Trades' : 'Track on My Trades'}" aria-label="${isEntered ? 'Remove' : 'Enter'} trade for ${escapeHtml(r.ticker)}">${isEntered ? '★' : '☆'}</button>
              </td>
              <td>${tierBadge(r.tier)}</td>
              <td>${escapeHtml((r.signalTs || '').slice(0, 10))}</td>
              <td>${escapeHtml(r.name || '—')}${multi}</td>
              <td>${escapeHtml(r.ticker || '')}</td>
              <td>${escapeHtml(r.sector || '—')}</td>
              <td>${escapeHtml(r.strategy || '—')}</td>
              <td class="num" title="${r.slPct != null ? 'Risk: ' + r.slPct.toFixed(2) + '% · R:R: ' + (r.expectedR != null ? r.expectedR.toFixed(2) + 'R' : '—') : ''}">${(r.entryPrice ?? 0).toFixed(2)}</td>
              <td class="num" style="color:var(--green)">${(r.tpPrice ?? 0).toFixed(2)}</td>
              <td class="num" style="color:var(--red)">${(r.slPrice ?? 0).toFixed(2)}</td>
              <td class="num">${r.currentPrice != null ? r.currentPrice.toFixed(2) : '—'}</td>
              <td class="num" style="color:${pct == null ? 'var(--text-dim)' : pct >= 0 ? 'var(--green)' : 'var(--red)'}">${pct == null ? '—' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'}</td>
              <td>${entryStatus ? entryStatusBadge(entryStatus) : '<span class="badge">—</span>'}</td>
              <td>${wl}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    $('history-table').innerHTML = html;

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
        <div>${escapeHtml(signal.name || '')} · ${escapeHtml(signal.strategy || '')} · ${tierBadge(signal.tier)}</div>
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

  wireSeg('seg-tier',    refresh);
  wireSeg('seg-side',    refresh);
  wireSeg('seg-winloss', refresh);
  ['f-strategy', 'f-sector'].forEach(id => $(id).addEventListener('change', refresh));
  $('f-q').addEventListener('input', refresh);

  // Re-render when the user toggles US ↔ INDIA in the topbar. The router also
  // re-dispatches the view on market change, but if this view is the active
  // one we want to filter the EXISTING rows array rather than refetching.
  if (window.__historyMarketUnsub) window.__historyMarketUnsub();
  window.__historyMarketUnsub = subscribe((reason) => {
    if (reason === 'market') refresh();
  });

  $('btn-csv').addEventListener('click', () => {
    const filtered = applyFilters(rows, currentFilters());
    const header = ['date','market','tier','name','ticker','sector','strategy','side','entry','tp','sl','slPct','expectedR','current','pctChange','status','winLoss','entryStatus'];
    const csvRows = filtered.map(r => [
      (r.signalTs || '').slice(0, 10), r.market || '', r.tier || '', r.name || '', r.ticker || '', r.sector || '', r.strategy || '', r.side || '',
      r.entryPrice ?? '', r.tpPrice ?? '', r.slPrice ?? '',
      r.slPct != null ? r.slPct.toFixed(3) : '', r.expectedR != null ? r.expectedR.toFixed(2) : '',
      r.currentPrice ?? '', r.pctChange != null ? r.pctChange : '',
      r.status || '', r.winLoss || '',
      computeEntryStatus(r) || '',
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob([header.join(',') + '\n' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `signal-history-${fmtDate(new Date())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  refresh();
}

// Tiny helper: querySelectorAll within document, returning Array.
function $$(cls) { return Array.from(document.getElementsByClassName(cls)); }
