// Condor Desk — the morning tab. Pulls the live (15-min delayed) S&P option
// chain, applies the mechanical iron-condor rules, and prints the exact four
// legs to place in the broker (Webull). Configs are adjustable + saveable as
// named presets; placed trades can be logged to a journal.
//
// Rules & rationale live in the Condor Guide tab (and docs/us-weekly-iron-
// condor-rules.md). This view is deliberately "no thinking required".

import { UNDERLYINGS, DEFAULT_CONDOR_CONFIG, fetchCboeChain, buildCondor, condorTicketText } from '../data/condor.js';
import { loadCondorState, saveCondorState, addCondorTrade, listCondorTrades, updateCondorTrade, deleteCondorTrade } from '../data/condorStore.js';
import { loadNotifications } from '../data/notifications.js';
import { sendTelegram } from '../data/telegram.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt2 = n => Number(n).toFixed(2);
const usd = n => `$${Number(n).toLocaleString()}`;

const FIELD_STYLE = 'display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em';

export function renderCondorDesk(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Condor Desk</h1>
      <p class="subtitle">
        Weekly 1-DTE S&amp;P iron condor — the tool picks the four legs mechanically; you place them in Webull.
        Rules &amp; reasoning: <a href="#/condor-guide" style="color:var(--cyan)">Condor Guide</a>.
      </p>

      <div class="card">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button id="cd-compute" class="btn-primary" type="button">GET TODAY'S LEGS</button>
          <span id="cd-status" style="color:var(--text-dim);font-size:0.92rem"></span>
        </div>
        <div id="cd-result" style="margin-top:14px"></div>
      </div>

      <details class="collapsible" id="cd-config">
        <summary>Configuration (the mechanical rules — adjust as you learn)</summary>
        <div class="body">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;max-width:900px">
            <label style="${FIELD_STYLE}">Underlying
              <select id="cf-underlying" class="btn-bare">
                ${Object.values(UNDERLYINGS).map(u => `<option value="${u.key}">${esc(u.label)}</option>`).join('')}
              </select>
            </label>
            <label style="${FIELD_STYLE}">Cadence
              <select id="cf-cadence" class="btn-bare">
                <option value="thu-fri">Thu → Fri (weekly, 1 DTE)</option>
                <option value="any-day">Any day (next expiry, 1 DTE)</option>
                <option value="twice-weekly">Twice weekly (Mon→Tue + Thu→Fri)</option>
              </select>
            </label>
            <label style="${FIELD_STYLE}">Short delta min
              <input id="cf-deltaMin" type="number" step="0.01" min="0.01" max="0.4" class="btn-bare">
            </label>
            <label style="${FIELD_STYLE}">Short delta max
              <input id="cf-deltaMax" type="number" step="0.01" min="0.02" max="0.5" class="btn-bare">
            </label>
            <label style="${FIELD_STYLE}">Wing width (% of spot)
              <input id="cf-wingPct" type="number" step="0.05" min="0.1" max="3" class="btn-bare">
            </label>
            <label style="${FIELD_STYLE}">Min credit / side (% of spot)
              <input id="cf-minCreditPct" type="number" step="0.005" min="0" max="0.2" class="btn-bare">
            </label>
            <label style="${FIELD_STYLE}">Stop multiple (× side credit)
              <input id="cf-stopMult" type="number" step="0.5" min="1" max="10" class="btn-bare">
            </label>
            <label style="${FIELD_STYLE}">Capital ($)
              <input id="cf-capital" type="number" step="500" min="0" class="btn-bare">
            </label>
          </div>
          <p class="muted" style="font-size:0.85rem;margin-top:10px">
            Defaults implement the base rules: 0.06–0.12 delta shorts (≈ the "won't reach by tomorrow" level, auto-adjusts to volatility),
            wings 0.65% of spot further out, skip the week if a side's credit &lt; 0.025% of spot, stop a side at 3× its credit.
          </p>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px">
            <button id="cf-save" class="btn-primary" type="button">SAVE AS ACTIVE</button>
            <input id="cf-preset-name" type="text" placeholder="preset name…" class="btn-bare" style="max-width:160px">
            <button id="cf-preset-save" class="btn-bare" type="button">SAVE PRESET</button>
            <select id="cf-preset-list" class="btn-bare" style="max-width:180px"><option value="">— presets —</option></select>
            <button id="cf-preset-load" class="btn-bare" type="button">LOAD</button>
            <button id="cf-preset-del" class="btn-bare" type="button" style="color:var(--red)">DELETE</button>
            <span id="cf-status" style="color:var(--text-dim);font-size:0.92rem"></span>
          </div>
        </div>
      </details>

      <div class="card" id="cd-journal-card">
        <h2>Journal</h2>
        <p style="color:var(--text-dim);font-size:0.92rem;margin:0 0 10px">
          Log each condor after placing it, then record the outcome — the weekly bookkeeping rule. Win rate and P&amp;L accumulate here.
        </p>
        <div id="cd-journal">Loading…</div>
      </div>
    </div>
  `;

  let state = { config: { ...DEFAULT_CONDOR_CONFIG }, presets: {} };
  let lastCondor = null;   // last computed result (for Telegram / journal)
  let lastCfg = null;

  const $ = id => document.getElementById(id);
  const cfStatus = msg => { $('cf-status').textContent = msg; setTimeout(() => { if ($('cf-status')?.textContent === msg) $('cf-status').textContent = ''; }, 2500); };

  // ----- config form <-> state ----------------------------------------------
  const FIELDS = ['underlying', 'cadence', 'deltaMin', 'deltaMax', 'wingPct', 'minCreditPct', 'stopMult', 'capital'];
  function paintConfig() {
    for (const f of FIELDS) { const el = $(`cf-${f}`); if (el) el.value = state.config[f]; }
    const sel = $('cf-preset-list');
    sel.innerHTML = '<option value="">— presets —</option>'
      + Object.keys(state.presets).sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }
  function readConfig() {
    const c = { ...state.config };
    c.underlying = $('cf-underlying').value;
    c.cadence = $('cf-cadence').value;
    for (const f of ['deltaMin', 'deltaMax', 'wingPct', 'minCreditPct', 'stopMult', 'capital']) {
      const v = Number($(`cf-${f}`).value);
      if (Number.isFinite(v)) c[f] = v;
    }
    if (c.deltaMax < c.deltaMin) [c.deltaMin, c.deltaMax] = [c.deltaMax, c.deltaMin];
    return c;
  }

  $('cf-save').addEventListener('click', async () => {
    state.config = readConfig();
    try { await saveCondorState(state); cfStatus('✓ Saved'); } catch (e) { cfStatus(e.message); }
  });
  $('cf-preset-save').addEventListener('click', async () => {
    const name = $('cf-preset-name').value.trim();
    if (!name) { cfStatus('Name the preset first.'); return; }
    state.presets[name] = readConfig();
    try { await saveCondorState(state); paintConfig(); cfStatus(`✓ Preset "${name}" saved`); } catch (e) { cfStatus(e.message); }
  });
  $('cf-preset-load').addEventListener('click', () => {
    const name = $('cf-preset-list').value;
    if (!name || !state.presets[name]) return;
    state.config = { ...DEFAULT_CONDOR_CONFIG, ...state.presets[name] };
    paintConfig();
    cfStatus(`Loaded "${name}" — click SAVE AS ACTIVE to persist`);
  });
  $('cf-preset-del').addEventListener('click', async () => {
    const name = $('cf-preset-list').value;
    if (!name) return;
    delete state.presets[name];
    try { await saveCondorState(state); paintConfig(); cfStatus(`Preset "${name}" deleted`); } catch (e) { cfStatus(e.message); }
  });

  // ----- compute --------------------------------------------------------------
  $('cd-compute').addEventListener('click', async () => {
    const btn = $('cd-compute'), status = $('cd-status'), out = $('cd-result');
    btn.disabled = true; status.textContent = 'Fetching CBOE chain…'; out.innerHTML = '';
    try {
      const cfg = readConfig();
      const chain = await fetchCboeChain(cfg.underlying);
      status.textContent = 'Selecting legs…';
      const c = buildCondor(chain, cfg);
      lastCondor = c; lastCfg = cfg;
      out.innerHTML = renderCondorCard(c, cfg);
      wireCardButtons(c, cfg);
      status.textContent = c.asOf ? `Chain as of ${esc(String(c.asOf))} (≈15-min delayed)` : '≈15-min delayed data';
    } catch (e) {
      console.error('[condor] compute failed', e);
      out.innerHTML = `<div class="guide-warn" style="text-align:left"><b>Could not compute legs.</b> ${esc(e?.message || String(e))}
        <br><span class="muted" style="font-size:0.88rem">CBOE's free feed occasionally rejects requests — retry in a minute. If it persists, check the browser console for CORS/network details.</span></div>`;
      status.textContent = '';
    } finally { btn.disabled = false; }
  });

  function legRow(action, o, cls) {
    return `<tr>
      <td style="color:${cls};font-weight:700">${action}</td>
      <td style="font-family:var(--font-mono);font-weight:700">${o.strike}</td>
      <td>${o.type === 'C' ? 'CALL' : 'PUT'}</td>
      <td style="font-family:var(--font-mono)">${fmt2(o.bid)} / ${fmt2(o.ask)}</td>
      <td style="font-family:var(--font-mono)">${fmt2(o.mid)}</td>
      <td style="font-family:var(--font-mono)">${o.delta === null ? '—' : Math.abs(o.delta).toFixed(3)}</td>
      <td style="font-family:var(--font-mono)">${o.oi.toLocaleString()}</td>
    </tr>`;
  }

  function renderCondorCard(c, cfg) {
    const u = UNDERLYINGS[c.underlying];
    const entryWarn = c.entryDayOK ? '' :
      `<div class="guide-warn" style="text-align:left">Today (${esc(c.etToday.weekday)}) is not the configured entry day — these numbers preview the ${esc(c.expiryWeekday)} ${esc(c.expiry)} expiry. Base rule: enter the morning before expiry, after 10:00 AM ET.</div>`;
    const timeWarn = (c.etToday.minutes < 600 && c.entryDayOK) ?
      `<div class="guide-warn" style="text-align:left">Before 10:00 AM ET — the base rule waits for the opening volatility to settle. Recompute after 10:00.</div>` : '';
    return `
      ${entryWarn}${timeWarn}
      ${c.warnings.map(w => `<div class="guide-warn" style="text-align:left">${esc(w)}</div>`).join('')}
      <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;margin:6px 0 10px">
        <span style="font-size:1.1rem"><b>${esc(c.underlying)}</b> spot <b style="font-family:var(--font-mono)">${fmt2(c.spot)}</b></span>
        <span>expiry <b>${esc(c.expiry)} (${esc(c.expiryWeekday)})</b></span>
        <span>net credit <b style="font-family:var(--font-mono);color:var(--green)">${fmt2(c.totalCredit)}</b> (${c.totalCreditPct}% of spot)</span>
        <span>contracts <b style="font-family:var(--font-mono)">${c.contracts}</b></span>
      </div>
      <div style="overflow-x:auto">
      <table class="data">
        <thead><tr><th>Action</th><th>Strike</th><th>Type</th><th>Bid / Ask</th><th>Mid</th><th>|Δ|</th><th>OI</th></tr></thead>
        <tbody>
          ${legRow('SELL to open', c.call.sell, 'var(--green)')}
          ${legRow('BUY to open',  c.call.buy,  'var(--red)')}
          ${legRow('SELL to open', c.put.sell,  'var(--green)')}
          ${legRow('BUY to open',  c.put.buy,   'var(--red)')}
        </tbody>
      </table>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin:12px 0">
        <div class="card" style="margin:0"><div class="muted" style="font-size:0.8rem">MAX PROFIT (hold to expiry)</div><b style="font-family:var(--font-mono);color:var(--green)">${usd(c.maxProfitUsd)}</b></div>
        <div class="card" style="margin:0"><div class="muted" style="font-size:0.8rem">LOSS IF ONE SIDE STOPS</div><b style="font-family:var(--font-mono);color:var(--red)">−${usd(c.stopLossUsd)}</b> <span class="muted" style="font-size:0.8rem">(other side's credit offsets)</span></div>
        <div class="card" style="margin:0"><div class="muted" style="font-size:0.8rem">DEFINED RISK (gap worst case)</div><b style="font-family:var(--font-mono)">${usd(c.definedRiskUsd)}</b></div>
        <div class="card" style="margin:0"><div class="muted" style="font-size:0.8rem">STOP MARKS (close side at)</div><b style="font-family:var(--font-mono)">CALL ≥ ${fmt2(c.call.stopMark)} · PUT ≥ ${fmt2(c.put.stopMark)}</b></div>
      </div>
      <div class="guide-pass" style="text-align:left">
        <b>Placing in Webull:</b> Options chain → pick the <b>${esc(c.expiry)}</b> expiry → order type <b>Iron Condor</b> (or 4-leg custom) →
        enter the four legs above → set a <b>net credit limit ≈ ${fmt2(c.totalCredit)}</b> (accept ≥ ${fmt2(c.totalCredit * 0.9)}) → review → submit.
        Then set price alerts at the two stop marks. ${esc(u.note)}
      </div>
      <pre id="cd-ticket" style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:10px 12px;font-family:var(--font-mono);font-size:0.85rem;white-space:pre-wrap">${esc(condorTicketText(c, cfg))}</pre>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="cd-copy" class="btn-bare" type="button">COPY TICKET</button>
        <button id="cd-telegram" class="btn-bare" type="button">SEND TO TELEGRAM</button>
        <button id="cd-log" class="btn-primary" type="button">LOG THIS TRADE</button>
        <span id="cd-card-status" style="color:var(--text-dim);font-size:0.92rem"></span>
      </div>
    `;
  }

  function wireCardButtons(c, cfg) {
    const say = (msg, color) => { const el = $('cd-card-status'); el.style.color = color || 'var(--text-dim)'; el.textContent = msg; };
    $('cd-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(condorTicketText(c, cfg)); say('✓ Copied', 'var(--green)'); }
      catch { say('Copy failed — select the ticket text manually.', 'var(--red)'); }
    });
    $('cd-telegram').addEventListener('click', async () => {
      say('Sending…');
      try {
        const n = await loadNotifications();
        if (!n.telegramBotToken || !n.telegramChatId) { say('Set up Telegram in Settings first.', 'var(--red)'); return; }
        await sendTelegram(n.telegramBotToken, n.telegramChatId,
          `🦅 <b>Condor Desk</b>\n<pre>${condorTicketText(c, cfg)}</pre>`);
        say('✓ Sent to Telegram', 'var(--green)');
      } catch (e) { say(e?.message || String(e), 'var(--red)'); }
    });
    $('cd-log').addEventListener('click', async () => {
      say('Logging…');
      try {
        await addCondorTrade({
          date: c.etToday.iso, underlying: c.underlying, expiry: c.expiry, spot: c.spot,
          contracts: c.contracts,
          callSell: c.call.sell.strike, callBuy: c.call.buy.strike,
          putSell: c.put.sell.strike, putBuy: c.put.buy.strike,
          callCredit: c.call.credit, putCredit: c.put.credit, totalCredit: c.totalCredit,
          callStopMark: c.call.stopMark, putStopMark: c.put.stopMark,
          maxProfitUsd: c.maxProfitUsd, definedRiskUsd: c.definedRiskUsd,
          capital: cfg.capital, pnlUsd: null,
        });
        say('✓ Logged', 'var(--green)');
        paintJournal();
      } catch (e) { say(e?.message || String(e), 'var(--red)'); }
    });
  }

  // ----- journal ---------------------------------------------------------------
  const STATUSES = ['open', 'expired_win', 'stopped', 'closed_manual'];
  const STATUS_LABEL = { open: 'OPEN', expired_win: 'EXPIRED WIN', stopped: 'STOPPED', closed_manual: 'CLOSED' };

  async function paintJournal() {
    const el = $('cd-journal');
    const trades = await listCondorTrades();
    if (!trades.length) { el.innerHTML = '<p class="muted">No condors logged yet.</p>'; return; }
    const settled = trades.filter(t => t.status !== 'open' && Number.isFinite(Number(t.pnlUsd)));
    const wins = settled.filter(t => Number(t.pnlUsd) > 0).length;
    const totalPnl = settled.reduce((s, t) => s + Number(t.pnlUsd), 0);
    const summary = settled.length
      ? `<p style="font-family:var(--font-mono);font-size:0.92rem;margin:0 0 10px">
           ${trades.length} logged · ${settled.length} settled · win rate <b>${Math.round(wins / settled.length * 100)}%</b> ·
           total P&amp;L <b style="color:${totalPnl >= 0 ? 'var(--green)' : 'var(--red)'}">${totalPnl >= 0 ? '+' : ''}${usd(totalPnl)}</b></p>`
      : `<p class="muted" style="margin:0 0 10px">${trades.length} logged — record outcomes to see win rate.</p>`;
    el.innerHTML = summary + `
      <div style="overflow-x:auto">
      <table class="data">
        <thead><tr><th>Date</th><th>U/L</th><th>Expiry</th><th>Legs (sell/buy C · sell/buy P)</th><th>Credit</th><th>Qty</th><th>Status</th><th>P&amp;L $</th><th></th></tr></thead>
        <tbody>
          ${trades.map(t => `
            <tr data-id="${esc(t.id)}">
              <td style="font-family:var(--font-mono)">${esc(t.date || '')}</td>
              <td>${esc(t.underlying || '')}</td>
              <td style="font-family:var(--font-mono)">${esc(t.expiry || '')}</td>
              <td style="font-family:var(--font-mono)">${t.callSell}/${t.callBuy} · ${t.putSell}/${t.putBuy}</td>
              <td style="font-family:var(--font-mono)">${fmt2(t.totalCredit || 0)}</td>
              <td style="font-family:var(--font-mono)">${t.contracts || 1}</td>
              <td>
                <select class="btn-bare jr-status" style="font-size:0.85rem">
                  ${STATUSES.map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}
                </select>
              </td>
              <td><input class="btn-bare jr-pnl" type="number" step="1" value="${t.pnlUsd ?? ''}" placeholder="—" style="width:90px;font-family:var(--font-mono)"></td>
              <td style="white-space:nowrap">
                <button class="btn-bare jr-save" type="button">SAVE</button>
                <button class="btn-bare jr-del" type="button" style="color:var(--red)">✕</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>`;
    el.querySelectorAll('tr[data-id]').forEach(tr => {
      const id = tr.dataset.id;
      tr.querySelector('.jr-save').addEventListener('click', async () => {
        const status = tr.querySelector('.jr-status').value;
        const pnlRaw = tr.querySelector('.jr-pnl').value;
        const pnlUsd = pnlRaw === '' ? null : Number(pnlRaw);
        try { await updateCondorTrade(id, { status, pnlUsd }); paintJournal(); } catch (e) { alert(e?.message || e); }
      });
      tr.querySelector('.jr-del').addEventListener('click', async () => {
        if (!confirm('Delete this journal entry?')) return;
        try { await deleteCondorTrade(id); paintJournal(); } catch (e) { alert(e?.message || e); }
      });
    });
  }

  // ----- boot ------------------------------------------------------------------
  (async () => {
    try { state = await loadCondorState(); } catch (e) { console.warn('[condor] state load failed', e); }
    paintConfig();
    paintJournal();
  })();
}
