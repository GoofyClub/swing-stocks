// Stocks in Play — pre-trade ORB candidate scanner.
//
// Used as morning prep before the 09:30 ET open. Displays the top 10 candidates
// for the 5-Minute Opening Range Breakout strategy, filtered by the universe
// criteria (price > $5, daily volume > 1M shares) and ranked by an activity
// score that combines liquidity (log10 volume) and catalyst (|change%|).
//
// Cached for 12h in localStorage so refreshing the app doesn't re-burn API quota.

import { state } from '../core/state.js';
import { fetchStocksInPlay, clearCache, ORB_CRITERIA, getCachedAt } from '../data/stocksInPlay.js';
import { openModal } from '../ui/modal.js';
import { nameForTicker } from '../data/markets.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtRelative(ts) {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24)  return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function fmtVolume(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

function categoryBadge(cat) {
  const cls = cat === 'gainer' ? 'win' : cat === 'loser' ? 'loss' : 'open';
  return `<span class="badge ${cls}">${escapeHtml(cat)}</span>`;
}

const STRATEGY_HELP_HTML = `
  <h4 style="margin:0 0 8px;font-weight:500">What is "Stocks in Play"?</h4>
  <p style="margin:0 0 14px;color:var(--text-dim);line-height:1.55">
    This list surfaces candidates for the <b>5-Minute Opening Range Breakout (ORB)</b> intraday strategy — an entirely different system from the swing strategies the rest of this app tracks. ORB is mechanical, day-trades a single name, and is held no more than ~6 hours.
  </p>

  <h4 style="margin:14px 0 6px;font-weight:500">The full ORB selection criteria</h4>
  <p style="margin:0 0 4px;color:var(--text-dim);line-height:1.55"><b>Section 3.1 — Universe filters (ALL must pass):</b></p>
  <ul style="margin:0 0 10px 18px;color:var(--text-dim);line-height:1.6">
    <li>Opening price <b>&gt; $5.00</b> — excludes penny stocks.</li>
    <li>Avg daily volume (14d) <b>≥ 1,000,000 shares</b> — liquidity floor.</li>
    <li>ATR(14) daily <b>&gt; $0.50</b> — volatility floor (informational here; not verified per-row).</li>
  </ul>
  <p style="margin:0 0 4px;color:var(--text-dim);line-height:1.55"><b>Section 3.2 — Catalyst narrowing (08:00–09:15 ET):</b></p>
  <ul style="margin:0 0 10px 18px;color:var(--text-dim);line-height:1.6">
    <li>Pre-market gap <b>≥ 2%</b> or heavy pre-market volume.</li>
    <li>Identifiable catalyst — earnings, guidance, FDA, M&amp;A, analyst action, sector shock.</li>
  </ul>
  <p style="margin:0 0 4px;color:var(--text-dim);line-height:1.55"><b>Section 3.3 — Final selection signal (09:35:00 ET):</b></p>
  <ul style="margin:0 0 10px 18px;color:var(--text-dim);line-height:1.6">
    <li><b>RVOL_OR ≥ 100%</b> — the 09:30–09:34 5-min bar's volume vs that ticker's 14d avg of the same window.</li>
    <li><b>Pick the highest RVOL_OR</b> survivor as the trade ticket.</li>
  </ul>

  <h4 style="margin:14px 0 6px;font-weight:500">What this view does vs. what you do</h4>
  <p style="margin:0 0 8px;color:var(--text-dim);line-height:1.55">
    The list below applies Section 3.1 (universe filters) and proxies Section 3.2 (the gainers/losers/most-active lists naturally capture stocks with real catalysts driving them). You still have to do the <b>09:35 ET RVOL_OR check yourself</b> in your trading platform — that's the actual selection signal and it can't be computed from a static list at 8 AM.
  </p>

  <h4 style="margin:14px 0 6px;font-weight:500">Data source</h4>
  <p style="margin:0 0 8px;color:var(--text-dim);line-height:1.55">
    Alpha Vantage <code>TOP_GAINERS_LOSERS</code> endpoint. Free with an API key (25 calls/day). Returns 25 top gainers + 25 top losers + 25 most-actively-traded = up to 75 unique US tickers across the entire market — NOT limited to our 58-stock starter list.
  </p>

  <h4 style="margin:14px 0 6px;font-weight:500">Play Score formula</h4>
  <p style="margin:0 0 4px;color:var(--text-dim);line-height:1.55;font-family:var(--font-mono);font-size:0.92rem">
    playScore = log₁₀(volume) + |change%| / 5
  </p>
  <p style="margin:0 0 8px;color:var(--text-dim);line-height:1.55">
    Combines liquidity and catalyst strength on comparable scales. A 5% move on 20M shares scores ~9.3; a 30% move on 500K scores ~11.7. Both pass — and per the ORB research, both have edge.
  </p>

  <p style="margin:14px 0 0;color:var(--text-mute);font-size:0.85rem;line-height:1.55">
    See User Guide → 1. Quick start for the swing strategies. The ORB strategy guide lives in <code>orb_5m_mechanical_guide.md</code> at the repo root.
  </p>
`;

const _helpRegistry = new Map();

function helpIconHtml(html) {
  const key = `sip-${Math.random().toString(36).slice(2, 9)}`;
  _helpRegistry.set(key, html);
  return `<span class="help-icon" tabindex="0" role="button" aria-label="About Stocks in Play" data-help-key="${key}">?</span>`;
}

// In-flight guard so double-clicking REFRESH doesn't fire two requests.
let _inFlight = false;

export async function renderStocksInPlay(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Stocks in Play <span style="color:var(--text-mute);font-weight:300;font-size:1rem">— 5-Min ORB</span></h1>
      <p class="subtitle">
        Top US candidates for the 5-Minute Opening Range Breakout intraday strategy.
        Refresh in the morning and pick one to focus on for today's open. ${helpIconHtml(STRATEGY_HELP_HTML)}
      </p>

      <div class="card">
        <div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center">
          <button id="btn-refresh" class="btn-primary" type="button">↻ REFRESH</button>
          <div class="last-refresh">
            <span class="lr-label">DATA</span>
            <span id="data-stat" class="lr-value">—</span>
          </div>
          <div id="cache-note" style="color:var(--text-mute);font-size:0.85rem;flex:1;text-align:right">
            cached for 12 hours · click REFRESH to bypass
          </div>
        </div>
        <div id="key-warning" style="display:none;margin-top:12px;padding:10px 14px;background:var(--fail-bg);border:1px solid var(--red);border-radius:4px;color:var(--red);font-size:0.92rem">
          <b>Alpha Vantage API key not set.</b>
          Open <a href="#/settings" style="color:var(--red);text-decoration:underline">Settings → Data Source</a> and paste your free key from
          <a href="https://www.alphavantage.co/support/#api-key" target="_blank" rel="noopener" style="color:var(--red);text-decoration:underline">alphavantage.co</a> (25 calls/day).
        </div>
      </div>

      <div class="card">
        <h2>Filter criteria <span class="count" id="filt-count"></span></h2>
        <div class="orb-criteria">
          <div class="orb-crit-row"><span class="ok-tag">✓</span> <b>Price &gt; $${ORB_CRITERIA.minPrice.toFixed(2)}</b> <span class="muted">— excludes penny stocks</span></div>
          <div class="orb-crit-row"><span class="ok-tag">✓</span> <b>Daily volume ≥ ${(ORB_CRITERIA.minDailyVolume / 1e6).toFixed(0)}M shares</b> <span class="muted">— liquidity floor</span></div>
          <div class="orb-crit-row"><span class="info-tag">★</span> <b>Highest gap + volume catalyst</b> <span class="muted">— ranked by play score (proxies Section 3.2 narrowing)</span></div>
          <div class="orb-crit-row warn"><span class="warn-tag">!</span> <b>RVOL_OR ≥ ${ORB_CRITERIA.rvolOrFloorPct}% at 09:35 ET</b> <span class="muted">— you must verify on your platform; can't compute from static list</span></div>
        </div>
      </div>

      <div class="card">
        <h2>Top ${ORB_CRITERIA.topN} candidates <span class="count" id="top-count"></span></h2>
        <div id="sip-table"><div class="empty">Loading…</div></div>
      </div>
    </div>
  `;

  // Wire help icon
  root.querySelectorAll('.help-icon').forEach(icon => {
    const show = () => {
      const html = _helpRegistry.get(icon.dataset.helpKey) || '';
      openModal({
        title: 'About Stocks in Play (ORB)',
        bodyHtml: html,
        primaryLabel: 'Got it',
        onPrimary: () => true,
      });
    };
    icon.addEventListener('click', show);
    icon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
    });
  });

  // Show / hide the API-key warning based on current state.
  const $ = (id) => document.getElementById(id);
  function refreshKeyWarning() {
    const hasKey = !!state.fetchCtx.apiKeys.alphavantage;
    $('key-warning').style.display = hasKey ? 'none' : 'block';
    $('btn-refresh').disabled = !hasKey || _inFlight;
  }
  refreshKeyWarning();

  function renderResult(result, err) {
    if (err) {
      const isKeyErr = /key not set|API key/i.test(err);
      $('sip-table').innerHTML = `<div class="empty" style="text-align:left">
        <b style="color:var(--red)">${escapeHtml(err)}</b>
        ${isKeyErr ? `<div style="margin-top:10px"><a href="#/settings">Open Settings → Data Source</a> to add your key, then come back and click REFRESH.</div>` : ''}
      </div>`;
      $('data-stat').innerHTML = `<span style="color:var(--red)">error</span>`;
      $('top-count').textContent = '';
      $('filt-count').textContent = '';
      return;
    }
    if (!result) {
      $('sip-table').innerHTML = `<div class="empty">No data yet. Click REFRESH to fetch.</div>`;
      $('data-stat').textContent = 'never';
      return;
    }
    const rel = fmtRelative(result.fetchedAt);
    const upstreamTs = result.lastUpdated ? `· upstream ${escapeHtml(result.lastUpdated)}` : '';
    const cacheNote = result.fromCache ? ' <span style="color:var(--text-mute)">(from cache)</span>' : '';
    $('data-stat').innerHTML = `<b>${escapeHtml(rel)}</b>${cacheNote} · ${escapeHtml(result.source)} ${upstreamTs}`;
    $('top-count').textContent = `(${result.candidates.length})`;
    $('filt-count').textContent = `· ${result.passing} of ${result.total} survived filters`;

    if (!result.candidates.length) {
      $('sip-table').innerHTML = `<div class="empty">No stocks passed the universe filters in this refresh. Most-likely cause: pre-market data not yet available — try again after 09:30 ET.</div>`;
      return;
    }

    $('sip-table').innerHTML = `
      <table class="data">
        <thead><tr>
          <th class="num">#</th>
          <th>TICKER</th>
          <th>NAME</th>
          <th>CATEGORY</th>
          <th class="num">PRICE</th>
          <th class="num">CHANGE</th>
          <th class="num">VOLUME</th>
          <th class="num">PLAY SCORE</th>
        </tr></thead>
        <tbody>
          ${result.candidates.map((c, idx) => {
            // Don't fall back to the ticker — that just duplicates the TICKER
            // column. Show an em-dash so it's obvious we don't have a real
            // company name (Alpha Vantage's gainers feed doesn't include names,
            // and our local lookup only covers ~300 popular US tickers).
            const realName = nameForTicker(c.ticker);
            const nameCell = (realName && realName !== c.ticker)
              ? escapeHtml(realName)
              : '<span style="color:var(--text-mute)">—</span>';
            const sign = c.changePct >= 0 ? '+' : '';
            const chColor = c.changePct >= 0 ? 'var(--green)' : 'var(--red)';
            const scoreColor = c.playScore >= 10 ? 'var(--cyan)' : 'var(--text)';
            return `<tr>
              <td class="num"><b>${idx + 1}</b></td>
              <td><b>${escapeHtml(c.ticker)}</b></td>
              <td>${nameCell}</td>
              <td>${categoryBadge(c.category)}</td>
              <td class="num">$${(c.price ?? 0).toFixed(2)}</td>
              <td class="num" style="color:${chColor}">${sign}${(c.changePct ?? 0).toFixed(2)}%</td>
              <td class="num">${fmtVolume(c.volume)}</td>
              <td class="num" style="color:${scoreColor};font-weight:500">${(c.playScore ?? 0).toFixed(2)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      <p style="color:var(--text-mute);font-size:0.85rem;margin-top:14px">
        <b>Reminder:</b> these candidates pass Section 3.1 filters and proxy Section 3.2 (catalyst narrowing).
        <b>You still need to compute RVOL_OR at 09:35 ET</b> on your trading platform and pick the highest RVOL survivor — that's the actual ORB selection signal per the strategy guide.
      </p>
    `;
  }

  async function doRefresh(bypassCache) {
    if (_inFlight) return;
    _inFlight = true;
    $('btn-refresh').disabled = true;
    const prevLabel = $('btn-refresh').textContent;
    $('btn-refresh').textContent = '…';
    $('sip-table').innerHTML = `<div class="empty">Fetching from Alpha Vantage…</div>`;
    try {
      const result = await fetchStocksInPlay(state.fetchCtx, { bypassCache });
      renderResult(result, null);
    } catch (e) {
      console.error('[stocks-in-play]', e);
      renderResult(null, e?.message || String(e));
    } finally {
      _inFlight = false;
      $('btn-refresh').disabled = !state.fetchCtx.apiKeys.alphavantage;
      $('btn-refresh').textContent = prevLabel;
    }
  }

  // Refresh button bypasses cache. Initial mount uses cache if fresh.
  $('btn-refresh').addEventListener('click', () => doRefresh(true));

  // Initial paint: prefer cache, otherwise try a live fetch if a key is set.
  if (state.fetchCtx.apiKeys.alphavantage) {
    doRefresh(false);
  } else {
    // No key → show empty state + the warning banner is already visible.
    const cachedAt = getCachedAt();
    if (cachedAt) {
      // Still show cached data even if key was later removed
      doRefresh(false);
    } else {
      renderResult(null, null);
    }
  }
}
