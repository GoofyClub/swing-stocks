// Automation — configure rules for auto-trading signals via a broker API.
// Config-only: this page persists settings to Firestore. Order execution is
// performed by a server-side worker (see the Automation guide). Nothing here
// places a trade. `enabled` defaults OFF and `mode` defaults to paper.

import { navigate } from '../core/router.js';
import { STRATEGIES } from '../strategy/normalize.js';
import { loadAutomationConfig, saveAutomationConfig, DEFAULT_AUTOMATION } from '../data/automation.js';
import { createAlpacaClient, resolveAlpacaBaseUrl, isLiveBaseUrl } from '../broker/alpaca.js';

const ALPACA_PAPER_URL = 'https://paper-api.alpaca.markets';
const ALPACA_LIVE_URL  = 'https://api.alpaca.markets';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const TIERS = ['A+', 'Tier 1', 'Tier 2'];
const INDEXES = [{ v: 'sp500', label: 'S&P 500' }, { v: 'sp400', label: 'MidCap 400' }, { v: 'sp600', label: 'SmallCap 600' }];
const MARKETS = ['US', 'INDIA'];
const SIDES = ['buy', 'sell'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const BROKERS = [
  { v: 'alpaca',  label: 'Alpaca (US)' },
  { v: 'zerodha', label: 'Zerodha Kite (India)' },
  { v: 'dhan',    label: 'Dhan (India)' },
  { v: 'other',   label: 'Other / custom' },
];

// A row of checkbox chips. `name` groups them; `current` is the selected array.
function chips(name, options, current) {
  const set = new Set(current || []);
  return `<div class="auto-chips" data-group="${name}" style="display:flex;gap:8px;flex-wrap:wrap">
    ${options.map(o => {
      const v = typeof o === 'string' ? o : o.v;
      const label = typeof o === 'string' ? o : o.label;
      const on = set.has(v);
      return `<label class="auto-chip" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid ${on ? 'var(--cyan)' : 'var(--line-soft)'};border-radius:6px;cursor:pointer;color:var(--text)">
        <input type="checkbox" data-group="${name}" value="${escapeHtml(v)}" ${on ? 'checked' : ''}>
        <span>${escapeHtml(label)}</span>
      </label>`;
    }).join('')}
  </div>`;
}

function numField(id, label, value, attrs = '', hint = '') {
  return `<label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">
    ${escapeHtml(label)}
    <input id="${id}" type="number" class="btn-bare" value="${value ?? ''}" ${attrs} style="font-family:var(--font-mono)">
    ${hint ? `<span style="text-transform:none;letter-spacing:normal;color:var(--text-dim);font-size:0.8rem">${hint}</span>` : ''}
  </label>`;
}

export async function renderAutomation(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Automation</h1>
      <p class="subtitle">Rules for auto-trading signals through your broker. <b>Config only</b> — orders are placed by a server-side worker, not this page. New here? Read the <a href="#/automation-guide" style="color:var(--cyan)">Automation guide</a> first.</p>
      <div id="auto-body"><div class="empty">Loading…</div></div>
    </div>
  `;

  const cfg = await loadAutomationConfig();
  const $ = (id) => document.getElementById(id);

  $('auto-body').innerHTML = `
    <div class="guide-warn" style="text-align:left">
      <b>Safety:</b> automation is <b>${cfg.enabled ? 'ENABLED' : 'disabled'}</b> in <b>${escapeHtml(cfg.mode)}</b> mode.
      Start in <b>paper</b> mode and forward-test for weeks before going live. Live trading uses real money and is irreversible.
    </div>
    <div class="guide-warn" style="text-align:left;border-color:var(--cyan)">
      <b>How it runs:</b> the worker runs <b>automatically each trading day</b> (just after the US open, and near the close to reconcile)
      — plus you can trigger it any time via <b>GitHub → Actions → “Auto-trade (paper)”</b>. By default every run is <b>dry-run</b>
      (logs intended orders, places nothing). To make scheduled runs place real <b>paper</b> orders, set the repo variable
      <code>AUTO_DRY_RUN = false</code> (Repo → Settings → Secrets and variables → Actions → Variables). Review every decision on the
      <a href="#/auto-orders" style="color:var(--cyan)">Auto Orders</a> page.
    </div>
    <div class="guide-warn" style="text-align:left;border-color:var(--red)">
      <b>Going to REAL MONEY (live):</b> the broker <b>URL</b> is the paper-vs-live switch. To trade live you flip exactly three things —
      (1) the broker URL to <code>https://api.alpaca.markets</code>, (2) your <b>live</b> Alpaca API key + secret, and (3) the repo variable
      <code>ALLOW_LIVE = true</code>. <b>Without ALLOW_LIVE the worker hard-skips any live URL</b>, so the in-app flag alone can never trade real money.
    </div>

    <div class="card">
      <h2>Master switch</h2>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
        <label style="display:flex;align-items:center;gap:8px"><input id="a-enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> <span>Enable automation</span></label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">Mode
          <select id="a-mode" class="btn-bare">
            <option value="paper" ${cfg.mode === 'paper' ? 'selected' : ''}>Paper (simulated)</option>
            <option value="live"  ${cfg.mode === 'live'  ? 'selected' : ''}>Live (real money)</option>
          </select>
        </label>
      </div>
    </div>

    <div class="card">
      <h2>Broker connection</h2>
      <p style="color:var(--text-dim);font-size:0.92rem;margin-top:0">⚠️ Secrets are stored in your private Firestore doc for the worker to use. Use a <b>paper-trading key</b> until you go live, and never reuse a key with withdrawal permissions.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:640px">
        <label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">Broker
          <select id="a-broker" class="btn-bare">${BROKERS.map(b => `<option value="${b.v}" ${cfg.broker === b.v ? 'selected' : ''}>${escapeHtml(b.label)}</option>`).join('')}</select>
        </label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">REST API base URL
          <input id="a-resturl" type="text" class="btn-bare" value="${escapeHtml(cfg.restApiBase)}" placeholder="https://paper-api.alpaca.markets" style="font-family:var(--font-mono)">
        </label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">API key
          <input id="a-apikey" type="password" autocomplete="off" class="btn-bare" value="${escapeHtml(cfg.apiKey)}" placeholder="key id" style="font-family:var(--font-mono)">
        </label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">API secret
          <input id="a-apisecret" type="password" autocomplete="off" class="btn-bare" value="${escapeHtml(cfg.apiSecret)}" placeholder="secret" style="font-family:var(--font-mono)">
        </label>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-top:12px">
        <button id="a-test" class="btn-bare" type="button">Test connection</button>
        <span id="a-test-status" style="color:var(--text-dim);font-size:0.92rem"></span>
      </div>
    </div>

    <div class="card">
      <h2>What to trade</h2>
      <div style="display:flex;flex-direction:column;gap:16px">
        <div><div class="seg-label" style="margin-bottom:6px">Markets</div>${chips('markets', MARKETS, cfg.markets)}</div>
        <div><div class="seg-label" style="margin-bottom:6px">Tiers</div>${chips('tiers', TIERS, cfg.tiers)}</div>
        <div><div class="seg-label" style="margin-bottom:6px">Indices <span style="text-transform:none;color:var(--text-dim)">(none checked = all)</span></div>${chips('indexes', INDEXES, cfg.indexes)}</div>
        <div><div class="seg-label" style="margin-bottom:6px">Sides</div>${chips('sides', SIDES, cfg.sides)}</div>
        <div>
          <div class="seg-label" style="margin-bottom:6px">Strategies <span style="text-transform:none;color:var(--text-dim)">(none checked = all)</span></div>
          ${chips('strategies', Object.entries(STRATEGIES).map(([k, v]) => ({ v: k, label: v.short || v.name || k })), cfg.strategies)}
        </div>
      </div>

      <details class="collapsible" style="margin-top:14px">
        <summary>Per-strategy index override (advanced)</summary>
        <div class="body">
          <p style="color:var(--text-dim);font-size:0.9rem;margin-top:0">Restrict a specific strategy to specific indices — e.g. RSI2 → S&amp;P 500, VCP → SmallCap 600. <b>A row with nothing checked uses the global Indices setting above.</b></p>
          <div style="overflow-x:auto">
          <table class="data">
            <thead><tr><th>Strategy</th><th class="num">S&amp;P 500</th><th class="num">MidCap 400</th><th class="num">SmallCap 600</th></tr></thead>
            <tbody>
              ${Object.entries(STRATEGIES).map(([k, v]) => {
                const sel = new Set((cfg.strategyIndexes && cfg.strategyIndexes[k]) || []);
                const cell = (ix) => `<td class="num"><input type="checkbox" data-si-strat="${k}" data-si-index="${ix}" ${sel.has(ix) ? 'checked' : ''}></td>`;
                return `<tr><td>${escapeHtml(v.short || k)}</td>${cell('sp500')}${cell('sp400')}${cell('sp600')}</tr>`;
              }).join('')}
            </tbody>
          </table>
          </div>
        </div>
      </details>
    </div>

    <div class="card">
      <h2>When to trade</h2>
      <div class="seg-label" style="margin-bottom:6px">Trade days</div>
      ${chips('tradeDays', DAYS, cfg.tradeDays)}
      <label style="display:flex;align-items:center;gap:8px;margin-top:14px">
        <input id="a-regime" type="checkbox" ${cfg.respectRegime !== false ? 'checked' : ''}>
        <span>Respect market regime — block new long entries when the market is risk-off (index below its 200-day average / volatility spike)</span>
      </label>
    </div>

    <div class="card">
      <h2>Universe filters</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;max-width:640px">
        ${numField('a-minprice', 'Min price', cfg.minPrice, 'step="0.01" min="0"')}
        ${numField('a-maxprice', 'Max price', cfg.maxPrice, 'step="0.01" min="0"')}
        ${numField('a-minadv', 'Min 20d $ ADV', cfg.minAdvUsd, 'step="1000000" min="0"', 'Liquidity floor')}
      </div>
      <label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em;margin-top:16px;max-width:640px">
        Exclude tickers (never auto-trade)
        <textarea id="a-exclude" class="btn-bare" rows="2" placeholder="TSLA, GME, AMC" style="font-family:var(--font-mono);resize:vertical">${escapeHtml((cfg.excludeTickers || []).join(', '))}</textarea>
        <span style="text-transform:none;letter-spacing:normal;color:var(--text-dim);font-size:0.8rem">Comma- or space-separated symbols.</span>
      </label>
    </div>

    <div class="card">
      <h2>Position sizing</h2>
      <p style="color:var(--text-dim);font-size:0.92rem;margin-top:0"><b>Risk %</b> sizes each trade so a fixed % of equity is at risk (capital used varies with stop width). <b>Fixed $</b> spends a set dollar amount per trade — best for small accounts. Whole shares only; a budget below one share's price skips the trade. <b>Max $ per position</b> hard-caps either mode.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;max-width:760px">
        <label style="display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em">Sizing mode
          <select id="a-sizingmode" class="btn-bare">
            <option value="risk"  ${cfg.sizingMode !== 'fixed' ? 'selected' : ''}>Risk % of equity</option>
            <option value="fixed" ${cfg.sizingMode === 'fixed' ? 'selected' : ''}>Fixed $ per trade</option>
          </select>
        </label>
        ${numField('a-fixednotional', 'Fixed $ per trade', cfg.fixedNotional, 'step="10" min="0"', 'Used in fixed mode')}
        ${numField('a-maxnotional', 'Max $ per position', cfg.maxPositionNotional, 'step="10" min="0"', '0 = no cap')}
      </div>
    </div>

    <div class="card">
      <h2>Risk limits</h2>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;max-width:760px">
        ${numField('a-risk', 'Risk per trade %', cfg.riskPerTradePct, 'step="0.05" min="0"', 'Risk mode only')}
        ${numField('a-maxpos', 'Max open positions', cfg.maxConcurrentPositions, 'step="1" min="0"')}
        ${numField('a-maxsector', 'Max per sector', cfg.maxPositionsPerSector, 'step="1" min="0"')}
        ${numField('a-heat', 'Max portfolio heat %', cfg.maxPortfolioHeatPct, 'step="0.5" min="0"', 'Sum of open risk')}
        ${numField('a-dailyhalt', 'Daily loss halt %', cfg.dailyLossHaltPct, 'step="0.5" min="0"', 'Stop new entries (intraday)')}
        ${numField('a-ddhalt', 'Max drawdown halt %', cfg.maxDrawdownHaltPct, 'step="1" min="0"', 'Equity peak-to-now (0 = off)')}
        ${numField('a-slippage', 'Slippage budget %', cfg.slippageBudgetPct, 'step="0.05" min="0"', 'Skip if price ran away')}
      </div>
    </div>

    <div class="card" style="display:flex;align-items:center;gap:14px">
      <button id="a-save" class="btn-primary" type="button">SAVE AUTOMATION CONFIG</button>
      <button id="a-reset" class="btn-bare" type="button">Reset to defaults</button>
      <span id="a-status" style="color:var(--text-dim);font-size:0.92rem"></span>
    </div>
  `;

  function readChips(group) {
    return Array.from(document.querySelectorAll(`input[type=checkbox][data-group="${group}"]:checked`)).map(i => i.value);
  }
  function readStrategyIndexes() {
    const out = {};
    document.querySelectorAll('input[data-si-strat]:checked').forEach(cb => {
      (out[cb.dataset.siStrat] ||= []).push(cb.dataset.siIndex);
    });
    return out;
  }
  function num(id, fallback) {
    const v = Number($(id).value);
    return Number.isFinite(v) ? v : fallback;
  }
  function gather() {
    const excludeRaw = $('a-exclude').value || '';
    const restApiBase = $('a-resturl').value.trim();
    return {
      enabled: $('a-enabled').checked,
      // mode is derived from the broker URL — the URL is the paper-vs-live switch.
      mode: isLiveBaseUrl(restApiBase) ? 'live' : 'paper',
      broker: $('a-broker').value,
      restApiBase,
      apiKey: $('a-apikey').value.trim(),
      apiSecret: $('a-apisecret').value.trim(),
      markets: readChips('markets'),
      tiers: readChips('tiers'),
      indexes: readChips('indexes'),
      strategyIndexes: readStrategyIndexes(),
      sides: readChips('sides'),
      strategies: readChips('strategies'),
      tradeDays: readChips('tradeDays'),
      respectRegime: $('a-regime').checked,
      excludeTickers: excludeRaw.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean),
      minPrice: num('a-minprice', DEFAULT_AUTOMATION.minPrice),
      maxPrice: num('a-maxprice', DEFAULT_AUTOMATION.maxPrice),
      minAdvUsd: num('a-minadv', DEFAULT_AUTOMATION.minAdvUsd),
      sizingMode: $('a-sizingmode').value,
      fixedNotional: num('a-fixednotional', DEFAULT_AUTOMATION.fixedNotional),
      maxPositionNotional: num('a-maxnotional', DEFAULT_AUTOMATION.maxPositionNotional),
      riskPerTradePct: num('a-risk', DEFAULT_AUTOMATION.riskPerTradePct),
      maxConcurrentPositions: num('a-maxpos', DEFAULT_AUTOMATION.maxConcurrentPositions),
      maxPositionsPerSector: num('a-maxsector', DEFAULT_AUTOMATION.maxPositionsPerSector),
      maxPortfolioHeatPct: num('a-heat', DEFAULT_AUTOMATION.maxPortfolioHeatPct),
      dailyLossHaltPct: num('a-dailyhalt', DEFAULT_AUTOMATION.dailyLossHaltPct),
      maxDrawdownHaltPct: num('a-ddhalt', DEFAULT_AUTOMATION.maxDrawdownHaltPct),
      slippageBudgetPct: num('a-slippage', DEFAULT_AUTOMATION.slippageBudgetPct),
    };
  }

  // Live border feedback on chip toggle.
  document.querySelectorAll('.auto-chip input').forEach(cb => {
    cb.addEventListener('change', () => {
      cb.closest('.auto-chip').style.borderColor = cb.checked ? 'var(--cyan)' : 'var(--line-soft)';
    });
  });

  // The broker URL is the real paper-vs-live switch. Keep the Mode dropdown in
  // sync as a convenience: picking a mode fills the matching URL, and editing the
  // URL updates the dropdown.
  const syncModeFromUrl = () => { $('a-mode').value = isLiveBaseUrl($('a-resturl').value.trim()) ? 'live' : 'paper'; };
  $('a-mode').addEventListener('change', () => {
    $('a-resturl').value = $('a-mode').value === 'live' ? ALPACA_LIVE_URL : ALPACA_PAPER_URL;
  });
  $('a-resturl').addEventListener('input', syncModeFromUrl);
  syncModeFromUrl();

  $('a-save').addEventListener('click', async () => {
    const status = $('a-status');
    const next = gather();
    if (next.enabled && next.mode === 'live') {
      if (!confirm('This sets a LIVE (real-money) broker URL. Real orders will be placed only if the repo variable ALLOW_LIVE=true is ALSO set. Continue?')) return;
    }
    $('a-save').disabled = true;
    status.textContent = 'Saving…';
    try {
      await saveAutomationConfig(next);
      status.style.color = 'var(--green)';
      status.textContent = '✓ Saved';
    } catch (e) {
      status.style.color = 'var(--red)';
      status.textContent = e?.message || String(e);
    } finally {
      $('a-save').disabled = false;
      setTimeout(() => { if (status.textContent === '✓ Saved') status.textContent = ''; }, 2500);
    }
  });

  $('a-test').addEventListener('click', async () => {
    const status = $('a-test-status');
    const broker = $('a-broker').value;
    if (broker !== 'alpaca') { status.style.color = 'var(--amber)'; status.textContent = 'Connection test currently supports Alpaca only.'; return; }
    const key = $('a-apikey').value.trim(), secret = $('a-apisecret').value.trim();
    if (!key || !secret) { status.style.color = 'var(--red)'; status.textContent = 'Enter API key and secret first.'; return; }
    status.style.color = 'var(--text-dim)';
    status.textContent = 'Testing…';
    try {
      const baseUrl = resolveAlpacaBaseUrl({ mode: $('a-mode').value, restApiBase: $('a-resturl').value.trim() });
      const client = createAlpacaClient({ baseUrl, apiKey: key, apiSecret: secret });
      const acct = await client.getAccount();
      status.style.color = 'var(--green)';
      status.textContent = `✓ Connected — ${acct.status}, equity $${acct.equity?.toFixed(2)}, buying power $${acct.buyingPower?.toFixed(2)}`;
    } catch (e) {
      status.style.color = 'var(--red)';
      // Alpaca blocks browser cross-origin calls; guide the user to the smoke-test.
      const cors = /Failed to fetch|NetworkError|CORS/i.test(e.message);
      status.textContent = cors
        ? 'Browser blocked by broker CORS — verify keys with: npm run auto:smoketest'
        : (e.message || 'Connection failed');
    }
  });

  $('a-reset').addEventListener('click', () => {
    if (confirm('Reset all automation settings on this screen to defaults? (Not saved until you click Save.)')) {
      renderAutomation(root);
    }
  });
}
