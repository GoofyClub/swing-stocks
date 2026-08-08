// =============================================================================
// Performance — realized P&L from the BROKER'S OWN fills.
//
// Nothing here comes from signals, settlement models, or the order journal. Every
// figure is derived from what Alpaca actually filled, because those two had
// already disagreed and only fills settle it.
//
// Alpaca has no closed-trade endpoint, so round trips are reconstructed FIFO
// from /v2/account/activities (see src/perf/roundTrips.js). The equity headline
// uses /v2/account/portfolio/history — Alpaca's own numbers — so the top of the
// page agrees with the broker rather than re-deriving it.
// =============================================================================

import { createAlpacaClient } from '../broker/alpaca.js';
import { listBrokerAccounts, saveBrokerAccount, deleteBrokerAccount, AUTOMATION_ID } from '../data/brokerAccounts.js';
import { buildRoundTrips, summarize, groupByPeriod, groupBySymbol, realizedDrawdown } from '../perf/roundTrips.js';
import { isPhoneLayout } from '../ui/mobile-rows.js';

const LS_ACCOUNT = 'swing.perf.account';
const LS_RANGE = 'swing.perf.range';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => n == null || !Number.isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
const pct = (n, d = 2) => n == null || !Number.isFinite(n) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%';
const col = (n) => n == null ? '' : `color:${n >= 0 ? 'var(--green)' : 'var(--red)'}`;
const dt = (d) => d ? new Date(d).toISOString().slice(0, 10) : '—';

const RANGES = [
  { key: '1M', days: 30, label: '1M', period: '1M' },
  { key: '3M', days: 90, label: '3M', period: '3M' },
  { key: '1A', days: 365, label: '1Y', period: '1A' },
  { key: 'all', days: 1095, label: 'All', period: 'all' },
];

function stat(label, value, style = '', hint = '') {
  return `<div style="display:flex;flex-direction:column;gap:2px;min-width:110px">
    <span style="color:var(--text-mute);font-size:0.72rem;text-transform:uppercase;letter-spacing:0.06em">${esc(label)}</span>
    <span style="font-family:var(--font-mono);font-size:1.15rem;${style}">${value}</span>
    ${hint ? `<span style="color:var(--text-dim);font-size:0.7rem">${esc(hint)}</span>` : ''}
  </div>`;
}

// Minimal inline equity curve — no chart library, same approach as Auto Orders.
function sparkline(points, { h = 130 } = {}) {
  if (!points || points.length < 2) return '<div class="empty" style="padding:8px 0">Not enough history to plot.</div>';
  const vals = points.map(p => p.equity);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1, pad = 6, w = 640;
  const x = (i) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const y = (v) => pad + (1 - (v - min) / span) * (h - 2 * pad);
  const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" style="display:block">
    <polyline fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="1.5" points="${pts}" />
  </svg>`;
}

export async function renderPerformance(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Performance</h1>
      <p class="subtitle">Realized P&amp;L computed from your broker's actual fills — not from signals or the order journal. Round trips are reconstructed FIFO, so partial fills, scaling and shorts are all accounted for.</p>
      <div class="card" id="perf-controls"><div class="empty">Loading accounts…</div></div>
      <div id="perf-body"></div>
    </div>`;

  let accounts = [];
  try { accounts = await listBrokerAccounts(); }
  catch (e) {
    document.getElementById('perf-controls').innerHTML = `<div class="empty">Couldn't load accounts: ${esc(e.message)}</div>`;
    return;
  }

  if (!accounts.length) {
    document.getElementById('perf-controls').innerHTML = `<div class="empty" style="text-align:left">
      <b>No broker account configured.</b><br><br>
      Add credentials on the <a href="#/automation" style="color:var(--cyan)">Automation</a> page, or add a
      read-only account below.</div>
      ${addFormHtml()}`;
    wireAddForm(() => renderPerformance(root));
    return;
  }

  let accountId = localStorage.getItem(LS_ACCOUNT) || accounts[0].id;
  if (!accounts.some(a => a.id === accountId)) accountId = accounts[0].id;
  let rangeKey = localStorage.getItem(LS_RANGE) || '3M';

  function controls() {
    document.getElementById('perf-controls').innerHTML = `
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">
        <label style="display:flex;flex-direction:column;gap:6px;font-size:0.75rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">Account
          <select id="perf-account" class="btn-bare" style="min-width:220px">
            ${accounts.map(a => `<option value="${esc(a.id)}" ${a.id === accountId ? 'selected' : ''}>${esc(a.label)}${a.live ? ' · LIVE' : ' · paper'}</option>`).join('')}
          </select>
        </label>
        <div style="display:flex;flex-direction:column;gap:6px">
          <span style="font-size:0.75rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">Range</span>
          <div style="display:flex;gap:6px">
            ${RANGES.map(r => `<button class="btn-bare perf-range${r.key === rangeKey ? ' active' : ''}" data-range="${r.key}">${r.label}</button>`).join('')}
          </div>
        </div>
        <div style="flex:1"></div>
        <button id="perf-refresh" class="btn-bare" type="button">Refresh</button>
        <button id="perf-manage" class="btn-bare" type="button">Manage accounts</button>
      </div>
      <div id="perf-manage-panel" style="display:none;margin-top:14px">${addFormHtml(accounts)}</div>`;

    document.getElementById('perf-account').addEventListener('change', (e) => {
      accountId = e.target.value; localStorage.setItem(LS_ACCOUNT, accountId); load();
    });
    document.querySelectorAll('.perf-range').forEach(b => b.addEventListener('click', () => {
      rangeKey = b.dataset.range; localStorage.setItem(LS_RANGE, rangeKey);
      document.querySelectorAll('.perf-range').forEach(x => x.classList.toggle('active', x === b));
      load();
    }));
    document.getElementById('perf-refresh').addEventListener('click', load);
    document.getElementById('perf-manage').addEventListener('click', () => {
      const p = document.getElementById('perf-manage-panel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });
    wireAddForm(() => renderPerformance(root));
  }

  async function load() {
    const body = document.getElementById('perf-body');
    body.innerHTML = '<div class="card"><div class="empty">Loading fills from the broker…</div></div>';
    const acct = accounts.find(a => a.id === accountId);
    const range = RANGES.find(r => r.key === rangeKey) || RANGES[1];

    let client;
    try { client = createAlpacaClient({ baseUrl: acct.baseUrl, apiKey: acct.apiKey, apiSecret: acct.apiSecret }); }
    catch (e) { body.innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div></div>`; return; }

    const after = new Date(Date.now() - range.days * 86400_000).toISOString();
    let fills = [], history = null, account = null;
    try {
      // Portfolio history is Alpaca's own equity math; failing it shouldn't hide
      // the fills-derived table, so it's tolerated separately.
      [fills, account] = await Promise.all([client.getActivities({ after }), client.getAccount()]);
      try { history = await client.getPortfolioHistory({ period: range.period, timeframe: '1D' }); } catch { /* optional */ }
    } catch (e) {
      body.innerHTML = `<div class="card"><div class="empty" style="text-align:left">
        <b>Couldn't reach the broker.</b><br>
        <span style="color:var(--red);font-family:var(--font-mono);font-size:0.9rem">${esc(e.message)}</span><br><br>
        Check the API key and secret for this account, and that the base URL matches the key type
        (paper keys only work against <code>paper-api.alpaca.markets</code>).</div></div>`;
      return;
    }

    const { trades, open } = buildRoundTrips(fills);
    const s = summarize(trades);
    const dd = realizedDrawdown(trades);
    body.innerHTML = renderBody({ acct, range, account, history, trades, open, s, dd });
  }

  controls();
  await load();
}

function renderBody({ acct, range, account, history, trades, open, s, dd }) {
  const phone = isPhoneLayout();
  const equityCard = `
    <div class="card">
      <h2>Account <span class="count">${esc(acct.label)}${acct.live ? ' · LIVE' : ' · paper'}</span></h2>
      <div style="display:flex;gap:26px;flex-wrap:wrap;margin-bottom:12px">
        ${stat('Equity', usd(account?.equity))}
        ${stat('Buying power', usd(account?.buyingPower))}
        ${stat('Realized P&L', usd(s.netPnl), col(s.netPnl), `${range.label} · ${s.trades} closed`)}
        ${stat('Open positions', String(open.length))}
      </div>
      ${history ? sparkline(history.points) : ''}
      ${history?.points?.length ? `<div style="color:var(--text-dim);font-size:0.78rem;font-family:var(--font-mono);margin-top:4px">
        ${dt(history.points[0].date)} → ${dt(history.points[history.points.length - 1].date)} · equity curve from Alpaca</div>` : ''}
    </div>`;

  const statsCard = `
    <div class="card">
      <h2>Realized stats <span class="count">(closed round trips, ${range.label})</span></h2>
      <div style="display:flex;gap:26px;flex-wrap:wrap">
        ${stat('Trades', String(s.trades))}
        ${stat('Win rate', s.winRate == null ? '—' : Math.round(s.winRate * 100) + '%',
          s.winRate == null ? '' : `color:${s.winRate >= 0.55 ? 'var(--green)' : s.winRate <= 0.4 ? 'var(--red)' : 'var(--amber)'}`,
          `${s.wins}W / ${s.losses}L`)}
        ${stat('Net P&L', usd(s.netPnl), col(s.netPnl))}
        ${stat('Expectancy', usd(s.expectancy), col(s.expectancy), 'per trade')}
        ${stat('Avg win', usd(s.avgWin), col(s.avgWin))}
        ${stat('Avg loss', usd(s.avgLoss), col(s.avgLoss))}
        ${stat('Profit factor', s.profitFactor == null ? '—' : (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)))}
        ${stat('Max drawdown', usd(-dd.maxDrawdown), 'color:var(--red)', 'realized')}
        ${stat('Avg hold', s.avgHoldDays == null ? '—' : s.avgHoldDays.toFixed(1) + 'd')}
      </div>
      ${s.best ? `<div style="color:var(--text-dim);font-size:0.8rem;margin-top:10px">
        Best ${esc(s.best.symbol)} ${usd(s.best.pnl)} · Worst ${esc(s.worst.symbol)} ${usd(s.worst.pnl)}</div>` : ''}
    </div>`;

  const periodTable = (title, rows) => `
    <div class="card">
      <h2>${title} <span class="count">(${rows.length})</span></h2>
      ${!rows.length ? '<div class="empty">No closed trades in this range.</div>' : `
      <div style="overflow-x:auto"><table class="data">
        <thead><tr><th>PERIOD</th><th class="num">TRADES</th><th class="num">W/L</th><th class="num">WIN %</th><th class="num">P&L</th><th class="num">CUMULATIVE</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${esc(r.key)}</td>
          <td class="num">${r.trades}</td>
          <td class="num">${r.wins}/${r.losses}</td>
          <td class="num">${r.winRate == null ? '—' : Math.round(r.winRate * 100) + '%'}</td>
          <td class="num" style="${col(r.pnl)}">${usd(r.pnl)}</td>
          <td class="num" style="${col(r.cumulative)}">${usd(r.cumulative)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>`;

  const tradesCard = `
    <div class="card">
      <h2>Closed trades <span class="count">(${trades.length})</span></h2>
      ${!trades.length ? '<div class="empty">No closed round trips in this range.</div>' : `
      <div style="overflow-x:auto"><table class="data">
        <thead><tr>
          <th>SYMBOL</th><th>SIDE</th><th class="num">QTY</th>
          <th class="num">ENTRY</th><th class="num">EXIT</th>
          <th>OPENED</th><th>CLOSED</th><th class="num">HOLD</th>
          <th class="num">P&L</th><th class="num">%</th><th>RESULT</th>
        </tr></thead>
        <tbody>${[...trades].reverse().map(t => `<tr>
          <td>${esc(t.symbol)}</td>
          <td>${esc(t.side)}</td>
          <td class="num">${t.qty}</td>
          <td class="num">${t.entryPrice.toFixed(2)}</td>
          <td class="num">${t.exitPrice.toFixed(2)}</td>
          <td>${dt(t.entryTime)}</td>
          <td>${dt(t.exitTime)}</td>
          <td class="num">${t.holdDays.toFixed(1)}d</td>
          <td class="num" style="${col(t.pnl)}">${usd(t.pnl)}</td>
          <td class="num" style="${col(t.pnlPct)}">${pct(t.pnlPct)}</td>
          <td><span class="badge ${t.winLoss === 'win' ? 'win' : 'loss'}">${t.winLoss.toUpperCase()}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>`;

  const bySym = groupBySymbol(trades);
  const symbolCard = !bySym.length ? '' : `
    <div class="card">
      <h2>By symbol <span class="count">(${bySym.length})</span></h2>
      <div style="overflow-x:auto"><table class="data">
        <thead><tr><th>SYMBOL</th><th class="num">TRADES</th><th class="num">WIN %</th><th class="num">P&L</th></tr></thead>
        <tbody>${bySym.map(r => `<tr>
          <td>${esc(r.symbol)}</td><td class="num">${r.trades}</td>
          <td class="num">${r.winRate == null ? '—' : Math.round(r.winRate * 100) + '%'}</td>
          <td class="num" style="${col(r.pnl)}">${usd(r.pnl)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;

  const openCard = !open.length ? '' : `
    <div class="card">
      <h2>Still open <span class="count">(${open.length})</span></h2>
      <p style="color:var(--text-dim);font-size:0.85rem;margin-top:0">Excluded from every realized figure above — an open position has no result yet.</p>
      <div style="overflow-x:auto"><table class="data">
        <thead><tr><th>SYMBOL</th><th>SIDE</th><th class="num">QTY</th><th class="num">ENTRY</th><th>OPENED</th></tr></thead>
        <tbody>${open.map(o => `<tr>
          <td>${esc(o.symbol)}</td><td>${esc(o.side)}</td><td class="num">${o.qty}</td>
          <td class="num">${o.entryPrice.toFixed(2)}</td><td>${dt(o.entryTime)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;

  return equityCard + statsCard
    + periodTable('Daily P&L', groupByPeriod(trades, 'day'))
    + (phone ? '' : periodTable('Weekly P&L', groupByPeriod(trades, 'week')))
    + periodTable('Monthly P&L', groupByPeriod(trades, 'month'))
    + tradesCard + symbolCard + openCard;
}

function addFormHtml(accounts = []) {
  const extra = accounts.filter(a => !a.readOnly);
  return `
    <div style="border-top:1px solid var(--line-soft);padding-top:14px">
      <h3 style="margin:0 0 8px">Add a broker account</h3>
      <p style="color:var(--text-dim);font-size:0.85rem;margin-top:0">
        Stored against your user in Firestore, readable only by you. Alpaca keys can't withdraw funds,
        but they can trade — prefer the narrowest permissions the broker offers.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:640px">
        <input id="pa-label" class="btn-bare" placeholder="Label (e.g. Paper 5k)">
        <select id="pa-base" class="btn-bare">
          <option value="https://paper-api.alpaca.markets">Paper</option>
          <option value="https://api.alpaca.markets">Live</option>
        </select>
        <input id="pa-key" class="btn-bare" placeholder="API key" autocomplete="off">
        <input id="pa-secret" type="password" class="btn-bare" placeholder="API secret" autocomplete="off">
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
        <button id="pa-save" class="btn-primary" type="button">Save account</button>
        <span id="pa-status" style="color:var(--text-dim);font-size:0.9rem"></span>
      </div>
      ${extra.length ? `<div style="margin-top:14px">
        <div style="font-size:0.75rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Saved accounts</div>
        ${extra.map(a => `<div style="display:flex;gap:10px;align-items:center;margin-bottom:6px">
          <span style="font-family:var(--font-mono)">${esc(a.label)}</span>
          <span class="badge ${a.live ? 'loss' : ''}">${a.live ? 'LIVE' : 'paper'}</span>
          <button class="btn-bare pa-del" data-id="${esc(a.id)}" type="button">Remove</button>
        </div>`).join('')}
      </div>` : ''}
    </div>`;
}

function wireAddForm(onChange) {
  const save = document.getElementById('pa-save');
  if (save) save.addEventListener('click', async () => {
    const status = document.getElementById('pa-status');
    status.textContent = 'Saving…';
    try {
      await saveBrokerAccount({
        label: document.getElementById('pa-label').value,
        apiKey: document.getElementById('pa-key').value,
        apiSecret: document.getElementById('pa-secret').value,
        baseUrl: document.getElementById('pa-base').value,
      });
      status.textContent = 'Saved.';
      onChange();
    } catch (e) { status.textContent = e.message; }
  });
  document.querySelectorAll('.pa-del').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(`Remove account "${b.dataset.id}"? This only deletes the stored credentials here.`)) return;
    try { await deleteBrokerAccount(b.dataset.id); onChange(); }
    catch (e) { alert(e.message); }
  }));
}
