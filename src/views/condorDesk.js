// Condor Desk — the morning tab. Pulls the (15-min delayed) S&P option chain,
// applies the selected mode's mechanical iron-condor rules, and prints the
// exact four legs to place in the broker (Webull). Two modes:
//   30–45 DTE managed (default)  — enter ~35-40 DTE, TP 50%, exit 21 DTE, stop 2× credit
//   1 DTE weekly                 — the source "1%" strategy, per-side 3× stop
// Configs are adjustable + saveable as named presets; trades log to a journal.
// Rules & rationale: the Condor Guide tab / docs/us-weekly-iron-condor-rules.md.

import {
  UNDERLYINGS, MODE_DEFAULTS, MODE_INFO, DEFAULT_CONDOR_CONFIG, activeParams,
  fetchChainSmart, fetchVixSpot, buildCondor, condorTicketText, daysBetween, etNow,
  CHAIN_SOURCE_LABEL, formatExitPlan, computePositionSnapshot, entryBreakevens, derivePositionStatus,
} from '../data/condor.js';
import { loadAutomationConfig } from '../data/automation.js';
import { saveChainCache, loadChainCache } from '../data/condorChainCache.js';
import { loadCondorState, saveCondorState, addCondorTrade, listCondorTrades, updateCondorTrade, deleteCondorTrade } from '../data/condorStore.js';
import { loadNotifications } from '../data/notifications.js';
import { sendTelegram } from '../data/telegram.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt2 = n => Number(n).toFixed(2);
const usd = n => `$${Number(n).toLocaleString()}`;
const fmtEtTime = iso => new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date(iso)) + ' ET';

// ----- open positions (the tracker) — pure HTML generators, no DOM/Firestore -----
export const CHIP_CLASS = { ok: 'good', target: 'good', watch: 'watch', time: 'watch', stop: 'action' };

export function renderManagedGauge(status) {
  const pinClass = CHIP_CLASS[status.overall] || 'good';
  const subtext = status.overall === 'stop'
    ? `at/above the ${fmt2(status.lossMark)} stop — close everything now`
    : status.overall === 'target'
      ? `at/below the ${fmt2(status.targetMark)} target — your GTC buy-back should already have filled`
      : status.mark <= status.entryCredit
        ? `down ${Math.round((1 - status.mark / status.entryCredit) * 100)}% from entry, needs ≤ ${fmt2(status.targetMark)} to hit target`
        : `up ${Math.round((status.mark / status.entryCredit - 1) * 100)}% from entry, ${Math.round(100 - status.pct)}% of the way to the ${fmt2(status.lossMark)} stop`;
  return `
    <div class="postrk-gauge-labels">
      <span style="color:var(--red)">STOP ${fmt2(status.lossMark)}</span>
      <span class="mid">ENTRY ${fmt2(status.entryCredit)}</span>
      <span style="color:var(--green)">TARGET ${fmt2(status.targetMark)}</span>
    </div>
    <div class="postrk-gauge-wrap">
      <div class="postrk-gauge-track"></div>
      <div class="postrk-gauge-tick entry" style="left:${status.entryPct}%"></div>
      <div class="postrk-gauge-tick" style="left:${status.targetPct}%"></div>
      <div class="postrk-gauge-pin ${pinClass}" style="left:${status.pct}%"><div class="dot"></div></div>
    </div>
    <div class="postrk-gauge-readout">
      <span class="pct ${pinClass}">Mark ${fmt2(status.mark)}</span>
      <span class="sub">— ${esc(subtext)}</span>
    </div>`;
}

export function renderSideGauge(label, side) {
  const pinClass = side.state === 'stop' ? 'action' : side.state === 'watch' ? 'watch' : 'good';
  const subtext = side.state === 'stop' ? 'at/above stop — close this side now'
    : side.state === 'watch' ? 'approaching the stop — watch closely'
    : 'holding fine';
  return `
    <div>
      <div class="postrk-side-label">${esc(label)} side</div>
      <div class="postrk-gauge-labels"><span style="color:var(--red)">STOP ${fmt2(side.stop)}</span><span class="mid">ENTRY ${fmt2(side.entry)}</span><span style="color:var(--green)">$0</span></div>
      <div class="postrk-gauge-wrap">
        <div class="postrk-gauge-track"></div>
        <div class="postrk-gauge-tick entry" style="left:${side.entryPct}%"></div>
        <div class="postrk-gauge-pin ${pinClass}" style="left:${side.pct}%"><div class="dot"></div></div>
      </div>
      <div class="postrk-gauge-readout"><span class="pct ${pinClass}">${fmt2(side.mark)}</span><span class="sub">${esc(subtext)}</span></div>
    </div>`;
}

export function rulerHtml(t, spot) {
  const be = entryBreakevens(t);
  const domainMin = t.putBuy - (t.callBuy - t.putBuy) * 0.08;
  const domainMax = t.callBuy + (t.callBuy - t.putBuy) * 0.08;
  const pos = x => Math.max(0, Math.min(100, (x - domainMin) / (domainMax - domainMin) * 100));
  return `
    <div class="postrk-ruler-block">
      <div class="postrk-ruler-title">Spot vs. strikes</div>
      <div class="postrk-ruler-wrap">
        <div class="postrk-ruler-line"></div>
        <div class="postrk-ruler-zone" style="left:${pos(be.breakevenDown)}%; width:${Math.max(0, pos(be.breakevenUp) - pos(be.breakevenDown))}%"></div>
        <div class="postrk-ruler-pt strike" style="left:${pos(t.putBuy)}%"><div class="tick"></div><div class="lab">${t.putBuy}P</div></div>
        <div class="postrk-ruler-pt strike" style="left:${pos(t.putSell)}%"><div class="tick"></div><div class="lab">${t.putSell}P</div></div>
        <div class="postrk-ruler-pt spot" style="left:${pos(spot)}%"><div class="tick"></div><div class="lab">${fmt2(spot)}</div></div>
        <div class="postrk-ruler-pt strike" style="left:${pos(t.callSell)}%"><div class="tick"></div><div class="lab">${t.callSell}C</div></div>
        <div class="postrk-ruler-pt strike" style="left:${pos(t.callBuy)}%"><div class="tick"></div><div class="lab">${t.callBuy}C</div></div>
      </div>
    </div>`;
}

// Answers "how many days until I have to decide anyway" — the ask behind
// this strip: a separate axis from the profit/loss gauge (the 21-DTE rule
// fires on a calendar date regardless of where the mark sits).
export function timeStripHtml(t, status) {
  if (!t.date || !t.expiry || !t.exitPlan?.timeExitDate) return '';
  const totalSpan = daysBetween(t.date, t.expiry);
  if (totalSpan <= 0) return '';
  const today = etNow().iso;
  const elapsed = Math.max(0, Math.min(totalSpan, daysBetween(t.date, today)));
  const markPos = Math.max(0, Math.min(100, daysBetween(t.date, t.exitPlan.timeExitDate) / totalSpan * 100));
  const fillPct = Math.max(0, Math.min(100, elapsed / totalSpan * 100));
  const d = status.daysToTimeExit;
  const text = d > 0
    ? `${d} day${d === 1 ? '' : 's'} until time-exit (${t.exitPlan.timeExitDate}) — sooner if the profit target hits first`
    : `time-exit date reached (${t.exitPlan.timeExitDate}) — close or roll today`;
  return `
    <div class="postrk-time">
      <span class="lab">DTE</span>
      <div class="postrk-time-track"><div class="postrk-time-fill" style="width:${fillPct}%"></div><div class="postrk-time-mark" style="left:${markPos}%"></div></div>
      <span class="postrk-time-text">${esc(text)}</span>
    </div>`;
}

export function renderPositionCard(t) {
  const today = etNow().iso;
  const dteLeft = t.expiry ? daysBetween(today, t.expiry) : null;
  const headHtml = chipHtml => `
    <div class="postrk-head">
      <div class="postrk-id">${esc(t.underlying)} <span class="sep">·</span> opened <b>${esc(t.date || '—')}</b> <span class="sep">·</span> exp <b>${esc(t.expiry || '—')}</b>${dteLeft !== null ? ` <span class="sep">·</span> <b>${dteLeft}</b> DTE left` : ''}</div>
      ${chipHtml}
    </div>`;
  const footHtml = asOf => `
    <div class="postrk-foot">
      <span class="postrk-as-of">${esc(asOf)}</span>
      <button class="btn-bare postrk-check" type="button" data-id="${esc(t.id)}">↻ Check status</button>
    </div>`;

  if (!t.lastCheck) {
    return `<div class="postrk-card" data-trade-id="${esc(t.id)}">
      ${headHtml('<span class="postrk-chip watch">NOT YET CHECKED</span>')}
      <p class="muted" style="margin:0 0 4px">Refresh to see live status.</p>
      ${footHtml('never checked')}
    </div>`;
  }

  let status;
  try { status = derivePositionStatus(t, t.lastCheck); }
  catch (e) {
    return `<div class="postrk-card" data-trade-id="${esc(t.id)}">
      ${headHtml('<span class="postrk-chip watch">STATUS UNAVAILABLE</span>')}
      <p class="muted" style="margin:0 0 4px">${esc(e?.message || String(e))}</p>
      ${footHtml(`as of ${fmtEtTime(t.lastCheck.fetchedAt)}`)}
    </div>`;
  }

  const chipClass = CHIP_CLASS[status.overall] || 'good';
  const body = t.mode === '1dte'
    ? `<div class="postrk-dual">${renderSideGauge('Call', status.sides.find(s => s.key === 'call'))}${renderSideGauge('Put', status.sides.find(s => s.key === 'put'))}</div>`
    : renderManagedGauge(status);
  const ruler = rulerHtml(t, status.spot);
  const timeStrip = t.mode === '30-45dte' ? timeStripHtml(t, status) : '';
  const annot = t.mode === '1dte'
    ? (status.overall === 'stop' ? `<div class="postrk-annot"><b>Action:</b> close the ${esc(status.worstSideLabel)} side's two legs now (sell first, then buy). The other side is untouched and can stay on.</div>` : '')
    : (status.overall === 'watch' && status.defendSide ? `<div class="postrk-annot"><b>Defend (optional):</b> roll the untested side in to collect extra credit and widen the loss cushion — see Strategy Guide §6.</div>` : '');

  return `<div class="postrk-card" data-trade-id="${esc(t.id)}">
    ${headHtml(`<span class="postrk-chip ${chipClass}">${esc(status.chipLabel)}</span>`)}
    ${body}
    ${ruler}
    ${timeStrip}
    ${annot}
    ${footHtml(`as of ${fmtEtTime(t.lastCheck.fetchedAt)}`)}
  </div>`;
}

const FIELD_STYLE = 'display:flex;flex-direction:column;gap:6px;font-size:0.8rem;color:var(--text-mute);text-transform:uppercase;letter-spacing:0.06em';

// Per-mode form fields: [key, label, tooltip, inputAttrs]
const MODE_FIELDS = {
  '30-45dte': [
    ['targetDte', 'Target DTE', 'Days to expiry to aim for at entry. ~40 is the blueprint sweet spot: enough premium, slow gamma, time to manage.', 'type="number" step="1" min="20" max="70"'],
    ['dteMin', 'DTE min', 'Lower bound when snapping to a listed expiry. Below ~30 DTE gamma accelerates and the managed edge decays.', 'type="number" step="1" min="7" max="60"'],
    ['dteMax', 'DTE max', 'Upper bound when snapping to a listed expiry. Above ~45 DTE theta is slow and capital sits idle.', 'type="number" step="1" min="21" max="90"'],
    ['deltaMin', 'Short delta min', 'Lower edge of the short-strike delta band. Default 0.12–0.18 targets ~0.15Δ shorts ≈ 70–75% probability of profit.', 'type="number" step="0.01" min="0.05" max="0.4"'],
    ['deltaMax', 'Short delta max', 'Upper edge of the band. Higher delta = more credit but a lower win rate.', 'type="number" step="0.01" min="0.08" max="0.5"'],
    ['wingPct', 'Wing width (% of spot)', 'How far beyond the short strike the protective long sits. 0.75% ≈ the blueprint\'s $5 SPY wings; wider = more credit kept but more capital at risk.', 'type="number" step="0.05" min="0.3" max="5"'],
    ['minCreditWidthPct', 'Min credit (% of width)', 'Skip the entry if total credit is below this % of wing width. 20% ≈ the blueprint\'s $1.00+ on $5 wings.', 'type="number" step="1" min="5" max="50"'],
    ['profitTargetPct', 'Profit target (% of credit)', 'Buy the whole condor back at this % of max profit. 50% is the consensus number — most of the P&L, none of the late-cycle gamma.', 'type="number" step="5" min="20" max="90"'],
    ['timeExitDte', 'Time exit (DTE)', 'If the target hasn\'t hit by this many days to expiry, close (or roll) anyway. 21 DTE is the consensus number.', 'type="number" step="1" min="7" max="35"'],
    ['lossMult', 'Loss exit (× credit)', 'Hard stop: close everything when the total loss reaches this multiple of the credit received. Blueprint: 2–3×; default 2×.', 'type="number" step="0.5" min="1" max="4"'],
    ['riskPct', 'Risk per trade (% of capital)', 'Sizing: one trade\'s defined risk (width − credit) may use at most this % of capital. Blueprint: 2–5%.', 'type="number" step="1" min="1" max="100"'],
    ['minVix', 'Min VIX to enter', 'Premium sellers get paid for volatility. Below this VIX level the Desk warns that premium is too thin — the blueprint prefers entries on pullbacks / pre-event IV bumps.', 'type="number" step="0.5" min="0" max="30"'],
    ['highVix', 'High-VIX caution level', 'At/above this VIX the Desk flags a headline/panic regime (tariff shocks, geopolitics): strikes auto-widen via delta, but guidance is half size, wider staggering, strict stops — or stand aside.', 'type="number" step="0.5" min="15" max="60"'],
  ],
  '1dte': [
    ['cadence', 'Cadence', 'Thu→Fri is the source strategy\'s weekly rhythm. Any-day trades every 1-DTE expiry; twice-weekly adds Mon→Tue.', 'select'],
    ['deltaMin', 'Short delta min', 'Lower edge of the short-strike delta band. 0.06–0.12 ≈ ~90% chance each side expires OTM tomorrow.', 'type="number" step="0.01" min="0.01" max="0.4"'],
    ['deltaMax', 'Short delta max', 'Upper edge of the band.', 'type="number" step="0.01" min="0.02" max="0.5"'],
    ['wingPct', 'Wing width (% of spot)', 'Distance to the protective long. 0.65% scales the source strategy\'s 150-point Nifty wing.', 'type="number" step="0.05" min="0.1" max="3"'],
    ['minCreditPct', 'Min credit / side (% of spot)', 'The skip-week floor: below this the reward doesn\'t pay for the risk.', 'type="number" step="0.005" min="0" max="0.2"'],
    ['stopMult', 'Stop (× side credit)', 'Close a SIDE when its loss reaches this multiple of that side\'s credit. Source rule: 3×.', 'type="number" step="0.5" min="1" max="10"'],
    ['highVix', 'High-VIX caution level', 'At/above this VIX the Desk flags a headline/panic regime. 1-DTE is gap-sensitive, so it fires earlier (25) than managed mode: half size or skip the week.', 'type="number" step="0.5" min="15" max="60"'],
  ],
};

export function renderCondorDesk(root) {
  root.innerHTML = `
    <div class="view">
      <h1>Condor Desk</h1>
      <p class="subtitle">
        Mechanical S&amp;P iron condors — the tool picks the four legs; you place them in Webull.
        Rules &amp; reasoning: <a href="#/condor-guide" style="color:var(--cyan)">Condor Guide</a>.
      </p>

      <div class="card">
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <button id="cd-compute" class="btn-primary" type="button">GET TODAY'S LEGS</button>
          <span id="cd-mode-chip" style="font-family:var(--font-mono);font-size:0.85rem;color:var(--cyan)"></span>
          <span id="cd-status" style="color:var(--text-dim);font-size:0.92rem"></span>
          <button id="cd-refresh" class="btn-bare" type="button" style="display:none;font-size:0.8rem;padding:2px 10px" title="Bypass the cached chain and pull fresh quotes right now">↻ Refresh data</button>
        </div>
        <div id="cd-result" style="margin-top:14px"></div>
      </div>

      <details class="collapsible" id="cd-config">
        <summary title="The defaults already implement the successful-trader consensus — you don't need to open this to start trading.">Configuration — defaults are the recommended setup; open only to customize</summary>
        <div class="body">
          <div class="guide-pass" style="text-align:left;margin:0 0 12px">
            <b>You can leave everything as is.</b> The defaults are the consensus setup successful systematic condor
            sellers use (~0.15Δ shorts at ~40 DTE, $5-equivalent wings, 50% profit target, 21-DTE time exit,
            2× credit hard stop, 5% risk sizing) — see the <a href="#/condor-guide" style="color:var(--cyan)">Strategy Guide</a>
            for why each number. Change fields only when you have a reason; hover any field for its tooltip.
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;max-width:960px;margin-bottom:6px">
            <label style="${FIELD_STYLE}" title="Which S&P product to quote. XSP/SPX are cash-settled European (no assignment risk); SPY is American-style.">Underlying
              <select id="cf-underlying" class="btn-bare">
                ${Object.values(UNDERLYINGS).map(u => `<option value="${u.key}">${esc(u.label)}</option>`).join('')}
              </select>
            </label>
            <label style="${FIELD_STYLE}" title="Two complete rulebooks — switching swaps every parameter below (both sets are saved).">Expiry mode
              <select id="cf-mode" class="btn-bare">
                ${Object.entries(MODE_INFO).map(([k, m]) => `<option value="${k}">${esc(m.label)}</option>`).join('')}
              </select>
            </label>
            <label style="${FIELD_STYLE}" title="Account capital used by the sizing rule.">Capital ($)
              <input id="cf-capital" type="number" step="500" min="0" class="btn-bare">
            </label>
          </div>
          <div id="cf-mode-info"></div>
          <div id="cf-mode-fields" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;max-width:960px;margin-top:6px"></div>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px">
            <button id="cf-save" class="btn-primary" type="button">SAVE AS ACTIVE</button>
            <input id="cf-preset-name" type="text" placeholder="preset name…" class="btn-bare" style="max-width:160px">
            <button id="cf-preset-save" class="btn-bare" type="button">SAVE PRESET</button>
            <select id="cf-preset-list" class="btn-bare" style="max-width:180px"><option value="">— presets —</option></select>
            <button id="cf-preset-load" class="btn-bare" type="button">LOAD</button>
            <button id="cf-preset-del" class="btn-bare" type="button" style="color:var(--red)">DELETE</button>
            <button id="cf-reset" class="btn-bare" type="button" title="Restore this mode's playbook defaults">RESET MODE DEFAULTS</button>
            <span id="cf-status" style="color:var(--text-dim);font-size:0.92rem"></span>
          </div>
        </div>
      </details>

      <div class="card" id="cd-positions-card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <h2 style="margin:0">Open Positions</h2>
          <button id="cd-check-all" class="btn-bare" type="button" style="font-size:0.82rem">↻ Check all open positions</button>
        </div>
        <p style="color:var(--text-dim);font-size:0.92rem;margin:6px 0 12px">
          Where each open trade stands right now, and whether it's time to close it. Checked once automatically per day; use ↻ for a live update.
        </p>
        <div id="cd-positions">Loading…</div>
      </div>

      <div class="card" id="cd-journal-card">
        <h2>Journal</h2>
        <p style="color:var(--text-dim);font-size:0.92rem;margin:0 0 10px">
          Log each condor after placing it, then record the outcome — win rate and P&amp;L accumulate here.
        </p>
        <div id="cd-journal">Loading…</div>
      </div>
    </div>
  `;

  let state = { config: JSON.parse(JSON.stringify(DEFAULT_CONDOR_CONFIG)), presets: {} };
  // The mode whose fields are currently painted in the form. Needed because on
  // a mode switch the <select> already holds the NEW mode while the inputs
  // still belong to the OLD one — reading them under the new mode's key would
  // leak old values into shared-name fields (deltaMin, wingPct, …).
  let uiMode = state.config.mode;

  const $ = id => document.getElementById(id);
  const cfStatus = msg => { $('cf-status').textContent = msg; setTimeout(() => { if ($('cf-status')?.textContent === msg) $('cf-status').textContent = ''; }, 2500); };

  // ----- config form <-> state ----------------------------------------------
  function normalizeConfig(raw) {
    const c = { ...DEFAULT_CONDOR_CONFIG, ...raw };
    if (!MODE_DEFAULTS[c.mode]) c.mode = DEFAULT_CONDOR_CONFIG.mode;
    c.modes = {};
    for (const m of Object.keys(MODE_DEFAULTS)) {
      c.modes[m] = { ...MODE_DEFAULTS[m], ...(raw?.modes?.[m] || {}) };
    }
    return c;
  }

  // True when the active mode's params all match the shipped defaults — the
  // chip then says "defaults" so the user knows there's nothing to tweak.
  function usingDefaults(config) {
    const d = MODE_DEFAULTS[config.mode];
    const p = config.modes?.[config.mode] || {};
    return Object.keys(d).every(k => String(p[k] ?? d[k]) === String(d[k]));
  }
  function paintChip(config) {
    const custom = !usingDefaults(config);
    $('cd-mode-chip').textContent = `${MODE_INFO[config.mode].label} · ${custom ? 'customized' : 'recommended defaults'}`;
    $('cd-mode-chip').style.color = custom ? 'var(--amber)' : 'var(--cyan)';
  }

  function paintModeInfo(mode) {
    const info = MODE_INFO[mode];
    $('cf-mode-info').innerHTML = `
      <div class="guide-pass" style="text-align:left;margin:8px 0"><b>Pros:</b> ${esc(info.pros)}</div>
      <div class="guide-warn" style="text-align:left;margin:8px 0"><b>Cons:</b> ${esc(info.cons)}</div>`;
  }

  function paintModeFields(mode) {
    const p = state.config.modes[mode];
    $('cf-mode-fields').innerHTML = MODE_FIELDS[mode].map(([key, label, tip, attrs]) => {
      if (attrs === 'select' && key === 'cadence') {
        return `<label style="${FIELD_STYLE}" title="${esc(tip)}">${esc(label)}
          <select id="cfm-${key}" class="btn-bare">
            <option value="thu-fri">Thu → Fri (weekly)</option>
            <option value="any-day">Any day (next expiry)</option>
            <option value="twice-weekly">Twice weekly (Mon→Tue + Thu→Fri)</option>
          </select></label>`;
      }
      return `<label style="${FIELD_STYLE}" title="${esc(tip)}">${esc(label)}
        <input id="cfm-${key}" ${attrs} class="btn-bare"></label>`;
    }).join('');
    for (const [key] of MODE_FIELDS[mode]) {
      const el = $(`cfm-${key}`);
      if (el) el.value = p[key];
    }
  }

  function paintConfig() {
    $('cf-underlying').value = state.config.underlying;
    $('cf-mode').value = state.config.mode;
    $('cf-capital').value = state.config.capital;
    paintChip(state.config);
    uiMode = state.config.mode;
    paintModeInfo(state.config.mode);
    paintModeFields(state.config.mode);
    const sel = $('cf-preset-list');
    sel.innerHTML = '<option value="">— presets —</option>'
      + Object.keys(state.presets).sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }

  // Read the currently-painted fields grid into params for `mode`.
  function readModeFields(mode) {
    const params = { ...MODE_DEFAULTS[mode], ...(state.config.modes?.[mode] || {}) };
    for (const [key, , , attrs] of MODE_FIELDS[mode]) {
      const el = $(`cfm-${key}`);
      if (!el) continue;
      if (attrs === 'select') params[key] = el.value;
      else { const v = Number(el.value); if (Number.isFinite(v)) params[key] = v; }
    }
    if (params.deltaMax < params.deltaMin) [params.deltaMin, params.deltaMax] = [params.deltaMax, params.deltaMin];
    if (params.dteMin != null && params.dteMax != null && params.dteMax < params.dteMin) [params.dteMin, params.dteMax] = [params.dteMax, params.dteMin];
    return params;
  }

  function readConfig() {
    const c = normalizeConfig(state.config);
    c.underlying = $('cf-underlying').value;
    c.mode = $('cf-mode').value;
    const cap = Number($('cf-capital').value);
    if (Number.isFinite(cap)) c.capital = cap;
    // The painted fields belong to uiMode (== c.mode except mid-switch).
    c.modes[uiMode] = readModeFields(uiMode);
    return c;
  }

  $('cf-mode').addEventListener('change', () => {
    // Persist the OLD mode's field edits, then swap the form to the new mode.
    state.config.modes[uiMode] = readModeFields(uiMode);
    state.config.mode = $('cf-mode').value;
    uiMode = state.config.mode;
    paintChip(state.config);
    paintModeInfo(state.config.mode);
    paintModeFields(state.config.mode);
  });

  $('cf-save').addEventListener('click', async () => {
    state.config = readConfig();
    paintChip(state.config);
    try { await saveCondorState(state); cfStatus('✓ Saved'); } catch (e) { cfStatus(e.message); }
  });
  $('cf-reset').addEventListener('click', () => {
    const m = $('cf-mode').value;
    state.config.modes[m] = { ...MODE_DEFAULTS[m] };
    paintModeFields(m);
    cfStatus(`Restored ${MODE_INFO[m].label} defaults — SAVE AS ACTIVE to persist`);
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
    state.config = normalizeConfig(state.presets[name]);
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
  // Chain + VIX are cached per underlying+mode for the current US-Eastern
  // trading day (src/data/condorChainCache.js) — repeat clicks (or a page
  // reload) reuse them instead of re-hitting CBOE/Alpaca. `forceRefresh`
  // bypasses the cache for one compute (the "↻ Refresh data" control).
  async function computeLegs(forceRefresh) {
    const btn = $('cd-compute'), status = $('cd-status'), out = $('cd-result'), refreshBtn = $('cd-refresh');
    btn.disabled = true; refreshBtn.disabled = true; out.innerHTML = '';
    try {
      const cfg = readConfig();
      let chain, vix, cached = false;

      if (!forceRefresh) {
        const hit = loadChainCache(cfg.underlying, cfg.mode);
        if (hit) { chain = hit.chain; vix = hit.vix; cached = true; }
      }
      if (!chain) {
        status.textContent = 'Fetching option chain…';
        const [creds, freshVix] = await Promise.all([
          loadAutomationConfig().catch(() => ({})),  // Alpaca keys, if the user set them up
          fetchVixSpot().catch(() => null),          // informational — never blocks
        ]);
        chain = await fetchChainSmart(cfg, creds);
        vix = freshVix;
        saveChainCache(cfg.underlying, cfg.mode, chain, vix);
      }

      status.textContent = 'Selecting legs…';
      const trades = await listCondorTrades().catch(() => []); // always fresh — Firestore read, not the chain pull
      const c = buildCondor(chain, cfg, new Date(), { vix });
      // Time diversification (blueprint: one entry every 1–2 weeks, staggered).
      const today = etNow().iso;
      const recentOpen = trades.find(t => t.status === 'open' && t.date && daysBetween(t.date, today) < 7);
      if (recentOpen) {
        c.warnings.unshift(`Staggered-entry rule: you already opened a condor on ${recentOpen.date} (${daysBetween(recentOpen.date, today)} day(s) ago). `
          + 'The blueprint spaces entries 1–2 weeks apart for time diversification — consider waiting or sizing down.');
      }
      out.innerHTML = renderCondorCard(c, cfg);
      wireCardButtons(c, cfg);
      $('cd-config').open = false; // collapse config once there's a live card
      const srcLabel = CHAIN_SOURCE_LABEL[chain.source] || 'chain';
      const fetchedLabel = chain.fetchedAt ? fmtEtTime(chain.fetchedAt) : (chain.asOf ? String(chain.asOf) : 'unknown time');
      status.textContent = `Data: ${srcLabel} · fetched ${fetchedLabel}${cached ? ' (cached — click ↻ Refresh for live quotes)' : ''} — confirm the credit in Webull before submitting`;
      refreshBtn.style.display = '';
    } catch (e) {
      console.error('[condor] compute failed', e);
      out.innerHTML = `<div class="guide-warn" style="text-align:left"><b>Could not compute legs.</b> ${esc(e?.message || String(e))}
        <br><span class="muted" style="font-size:0.88rem">
        Fixes, in order: <b>1)</b> Add your Alpaca API keys in the <a href="#/automation" style="color:var(--cyan)">Automation</a> tab
        (paper keys are fine) — that enables Alpaca's reliable real-time options feed for SPY and skips CBOE entirely.
        <b>2)</b> Disable ad-blockers/shields for this site — they commonly block cdn.cboe.com and proxy fallbacks.
        <b>3)</b> Retry in a minute; CBOE's CDN intermittently rejects whole networks.</span></div>`;
      status.textContent = '';
    } finally { btn.disabled = false; refreshBtn.disabled = false; }
  }
  $('cd-compute').addEventListener('click', () => computeLegs(false));
  $('cd-refresh').addEventListener('click', () => computeLegs(true));

  function legRow(action, o, cls) {
    return `<tr>
      <td style="color:${cls};font-weight:700">${action}</td>
      <td style="font-family:var(--font-mono);font-weight:700">${o.strike}</td>
      <td>${o.type === 'C' ? 'CALL' : 'PUT'}</td>
      <td style="font-family:var(--font-mono)">${fmt2(o.bid)} / ${fmt2(o.ask)}</td>
      <td style="font-family:var(--font-mono)">${fmt2(o.mid)}</td>
      <td style="font-family:var(--font-mono)">${o.delta === null ? '—' : Math.abs(o.delta).toFixed(3)}</td>
      <td style="font-family:var(--font-mono)" title="${o.oi === null ? 'This data source does not report open interest' : 'Open interest'}">${o.oi === null ? '—' : o.oi.toLocaleString()}</td>
    </tr>`;
  }

  const tile = (label, value, tip = '') =>
    `<div class="card" style="margin:0" ${tip ? `title="${esc(tip)}"` : ''}><div class="muted" style="font-size:0.8rem">${label}</div>${value}</div>`;

  // Concise at-a-glance box: date, price, the four legs, profit/loss plan and
  // a GO/WAIT verdict — everything needed without reading the full card.
  function renderSummary(c, cfg) {
    const p = activeParams(cfg);
    // Blockers = warnings that mean "don't enter today" (vs. cautions).
    const blockers = c.warnings.filter(w =>
      w.includes('SKIP RULE') || w.includes('below your') || w.includes('PREVIEW')
      || w.includes('Staggered-entry') || w.includes('first Friday'));
    if (!c.entryDayOK) blockers.push('not the configured entry day');
    const go = blockers.length === 0;
    const cautions = c.warnings.length - c.warnings.filter(w => blockers.includes(w)).length;
    const verdict = go
      ? `<b style="color:var(--green)">✅ GO</b> — all entry rules pass${cautions > 0 ? ` <span class="muted">(${cautions} caution${cautions > 1 ? 's' : ''} below)</span>` : ''}`
      : `<b style="color:var(--amber)">⏸ WAIT</b> — ${blockers.length} blocking rule${blockers.length > 1 ? 's' : ''}, details below`;
    const row = (label, value) => `
      <div style="display:flex;gap:10px;align-items:baseline">
        <span class="muted" style="font-size:0.75rem;letter-spacing:0.08em;min-width:74px;text-transform:uppercase">${label}</span>
        <span style="font-family:var(--font-mono);font-size:0.95rem">${value}</span>
      </div>`;
    const legs = `
      <span style="color:var(--green);font-weight:700">SELL ${c.call.sell.strike}C</span> · <span style="color:var(--red)">BUY ${c.call.buy.strike}C</span>
      &nbsp;&nbsp;<span style="color:var(--green);font-weight:700">SELL ${c.put.sell.strike}P</span> · <span style="color:var(--red)">BUY ${c.put.buy.strike}P</span>
      &nbsp;<span class="muted">× ${c.contracts}</span>`;
    const profit = c.mode === '30-45dte'
      ? `<b style="color:var(--green)">+${usd(c.profitTargetUsd)}</b> at 50% target (GTC buy-back ≤ ${fmt2(c.profitTargetMark)}) · out by ${esc(c.timeExitDate)} latest`
      : `<b style="color:var(--green)">+${usd(c.maxProfitUsd)}</b> if it expires inside ${fmt2(c.breakevenDown)}–${fmt2(c.breakevenUp)}`;
    const loss = c.mode === '30-45dte'
      ? `<b style="color:var(--red)">−${usd(c.plannedLossUsd)}</b> at the stop (mark ≥ ${fmt2(c.lossMark)}) · absolute worst ${usd(c.definedRiskUsd)}`
      : `<b style="color:var(--red)">−${usd(c.stopLossUsd)}</b> if one side stops · gap worst case ${usd(c.definedRiskUsd)}`;
    const when = c.mode === '30-45dte'
      ? `any day at ${p.dteMin}–${p.dteMax} DTE, VIX ${p.minVix}–${p.highVix}, ≥ 1 week after your last entry`
      : `the morning before expiry, after 10:00 AM ET`;
    return `
      <div id="cd-summary" style="border:1px solid var(--cyan);border-radius:6px;padding:12px 16px;margin:2px 0 14px;display:flex;flex-direction:column;gap:6px;background:var(--bg-elev)">
        ${row('Today', `${esc(c.etToday.iso)} (${esc(c.etToday.weekday)}) · ${esc(c.underlying)} <b>${fmt2(c.spot)}</b>${c.vix !== null ? ` · VIX ${c.vix.toFixed(1)}` : ''}`)}
        ${row('Trade', `Iron condor · exp ${esc(c.expiry)} (${c.dte} DTE)${c.popPct !== null ? ` · POP ≈ ${c.popPct}%` : ''}`)}
        ${row('Legs', legs)}
        ${row('Collect', `<b style="color:var(--green)">${fmt2(c.totalCredit)}</b> credit ≈ ${usd(c.maxProfitUsd)} max`)}
        ${row('Profit', profit)}
        ${row('Loss', loss)}
        ${row('Enter when', esc(when))}
        ${row('Verdict', verdict)}
      </div>`;
  }

  function renderCondorCard(c, cfg) {
    const u = UNDERLYINGS[c.underlying];
    const p = activeParams(cfg);
    const entryWarn = c.entryDayOK ? '' :
      `<div class="guide-warn" style="text-align:left">Today (${esc(c.etToday.weekday)}) is not the configured entry day — these numbers preview the ${esc(c.expiryWeekday)} ${esc(c.expiry)} expiry. Base rule: enter the morning before expiry, after 10:00 AM ET.</div>`;
    const timeWarn = (c.mode === '1dte' && c.etToday.minutes < 600 && c.entryDayOK) ?
      `<div class="guide-warn" style="text-align:left">Before 10:00 AM ET — the 1-DTE rule waits for the opening volatility to settle. Recompute after 10:00.</div>` : '';

    const mgmtTiles = c.mode === '30-45dte' ? [
      tile('TAKE PROFIT AT', `<b style="font-family:var(--font-mono);color:var(--green)">mark ≤ ${fmt2(c.profitTargetMark)}</b> <span class="muted" style="font-size:0.8rem">≈ +${usd(c.profitTargetUsd)}</span>`,
        `Buy the condor back at ${p.profitTargetPct}% of max profit — the playbook exit.`),
      tile('TIME EXIT', `<b style="font-family:var(--font-mono)">${esc(c.timeExitDate)}</b> <span class="muted" style="font-size:0.8rem">(${p.timeExitDte} DTE)</span>`,
        'If the profit target has not hit by this date, close or roll anyway — gamma accelerates after 21 DTE.'),
      tile('HARD STOP', `<b style="font-family:var(--font-mono);color:var(--red)">mark ≥ ${fmt2(c.lossMark)}</b> <span class="muted" style="font-size:0.8rem">≈ −${usd(c.plannedLossUsd)}</span>`,
        `Close everything when the loss reaches ${p.lossMult}× the credit received.`),
      tile('DEFINED RISK (gap worst case)', `<b style="font-family:var(--font-mono)">${usd(c.definedRiskUsd)}</b>`,
        'Absolute maximum loss if price blows through a wing — the wings cap it here.'),
    ] : [
      tile('MAX PROFIT (hold to expiry)', `<b style="font-family:var(--font-mono);color:var(--green)">${usd(c.maxProfitUsd)}</b>`),
      tile('LOSS IF ONE SIDE STOPS', `<b style="font-family:var(--font-mono);color:var(--red)">−${usd(c.stopLossUsd)}</b> <span class="muted" style="font-size:0.8rem">(other side's credit offsets)</span>`,
        'One side stopping at 3× its credit while the other expires ≈ a −1% week.'),
      tile('DEFINED RISK (gap worst case)', `<b style="font-family:var(--font-mono)">${usd(c.definedRiskUsd)}</b>`),
      tile('STOP MARKS (close side at)', `<b style="font-family:var(--font-mono)">CALL ≥ ${fmt2(c.call.stopMark)} · PUT ≥ ${fmt2(c.put.stopMark)}</b>`,
        'Per-side: close that side\'s two legs when its spread mark reaches 4× the credit collected on it.'),
    ];

    const warnCount = c.warnings.length + (entryWarn ? 1 : 0) + (timeWarn ? 1 : 0);
    return `
      ${renderSummary(c, cfg)}
      <details class="collapsible" id="cd-details">
        <summary>Full trade details${warnCount ? ` (${warnCount} note${warnCount > 1 ? 's' : ''} inside)` : ''} — legs, breakevens, exit tiles, Webull ticket</summary>
        <div class="body">
          ${entryWarn}${timeWarn}
          ${c.warnings.map(w => `<div class="guide-warn" style="text-align:left">${esc(w)}</div>`).join('')}
          <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:baseline;margin:6px 0 10px">
            <span style="font-size:1.1rem"><b>${esc(c.underlying)}</b> spot <b style="font-family:var(--font-mono)">${fmt2(c.spot)}</b></span>
            <span>expiry <b>${esc(c.expiry)} (${esc(c.expiryWeekday)}, ${c.dte} DTE)</b></span>
            <span title="Mid-price credit; the natural (instant-fill) credit is lower.">net credit <b style="font-family:var(--font-mono);color:var(--green)">${fmt2(c.totalCredit)}</b> mid / ${fmt2(c.naturalCredit)} natural</span>
            <span title="Credit as % of wing width — the risk/reward gauge for a condor.">credit = <b>${c.creditOfWidthPct}%</b> of width</span>
            ${c.popPct !== null ? `<span title="Probability of Profit — the estimated chance the index finishes between your short strikes at expiry, so both sides expire worthless and you keep the credit. Computed as 1 − (call Δ + put Δ) using the short legs' deltas.">POP <b>${c.popPct}%</b> <span class="muted" style="font-size:0.8rem">(win prob.)</span></span>` : ''}
            ${c.vix !== null ? `<span title="VIX — the market's implied volatility. Premium sellers want this elevated; below your configured floor the Desk warns.">VIX <b style="font-family:var(--font-mono)">${c.vix.toFixed(1)}</b></span>` : ''}
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
          <p class="muted" style="font-size:0.9rem;margin:8px 0" title="Price levels where the position starts losing at expiry.">
            Profit zone at expiry: <b style="font-family:var(--font-mono)">${fmt2(c.breakevenDown)} — ${fmt2(c.breakevenUp)}</b>
            (spot ${fmt2(c.spot)} sits ${fmt2(c.spot - c.breakevenDown)} above the lower / ${fmt2(c.breakevenUp - c.spot)} below the upper breakeven)
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;margin:12px 0">
            ${mgmtTiles.join('')}
          </div>
          ${c.mode === '30-45dte' ? `<p class="muted" style="font-size:0.9rem;margin:8px 0" title="The blueprint's defense move — optional, done before the hard stop is threatened.">
            <b>Defend (optional):</b> if a short strike's delta reaches ~0.30 (price approaching it), roll the <b>untested</b> side —
            buy its spread back cheap and re-sell at the new ~0.15Δ closer in. Extra credit collected reduces your max risk.
          </p>` : ''}
          <div class="guide-pass" style="text-align:left">
            <b>Placing in Webull:</b> Options chain → pick the <b>${esc(c.expiry)}</b> expiry → order type <b>Iron Condor</b> (or 4-leg custom) →
            enter the four legs above → <b>net credit limit ≈ ${fmt2(c.totalCredit)}</b> (start at mid; accept ≥ ${fmt2(Math.max(c.naturalCredit, c.totalCredit * 0.9))}) → review → submit.
            Then set price alerts at the exit marks above. ${esc(u.note)}
          </div>
          <pre id="cd-ticket" style="background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:10px 12px;font-family:var(--font-mono);font-size:0.85rem;white-space:pre-wrap">${esc(condorTicketText(c, cfg))}</pre>
        </div>
      </details>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
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
          date: c.etToday.iso, mode: c.mode, underlying: c.underlying, expiry: c.expiry, dte: c.dte, spot: c.spot,
          contracts: c.contracts,
          callSell: c.call.sell.strike, callBuy: c.call.buy.strike,
          putSell: c.put.sell.strike, putBuy: c.put.buy.strike,
          callCredit: c.call.credit, putCredit: c.put.credit, totalCredit: c.totalCredit,
          exitPlan: c.mode === '30-45dte'
            ? { profitTargetMark: c.profitTargetMark, timeExitDate: c.timeExitDate, lossMark: c.lossMark }
            : { callStopMark: c.call.stopMark, putStopMark: c.put.stopMark },
          maxProfitUsd: c.maxProfitUsd, definedRiskUsd: c.definedRiskUsd,
          capital: cfg.capital, pnlUsd: null,
        });
        say('✓ Logged', 'var(--green)');
        paintJournal();
      } catch (e) { say(e?.message || String(e), 'var(--red)'); }
    });
  }

  // ----- open positions (the tracker) -------------------------------------------
  function paintPositions(trades) {
    const el = $('cd-positions');
    const open = trades.filter(t => t.status === 'open');
    if (!open.length) {
      el.innerHTML = '<p class="muted">No open positions — logged trades appear here once you LOG THIS TRADE, and drop off once their journal status changes from OPEN.</p>';
      return;
    }
    el.innerHTML = open.map(renderPositionCard).join('');
    el.querySelectorAll('.postrk-check').forEach(btn => {
      btn.addEventListener('click', async () => {
        const t = open.find(x => x.id === btn.dataset.id);
        if (!t) return;
        btn.disabled = true; btn.textContent = 'Checking…';
        try { await checkOpenPositions([t], { force: true }); await paintJournal(); }
        catch (e) { alert(e?.message || String(e)); btn.disabled = false; btn.textContent = '↻ Check status'; }
      });
    });
  }

  // Re-prices OPEN trades against a live chain and persists the result onto
  // each trade doc (lastCheck), so the card renders instantly from stored
  // data next time — no network call — until a new ET calendar day begins or
  // force=true (the "↻ Check" controls). Trades sharing an (underlying,
  // expiry, mode) share a single chain fetch. Returns how many were updated.
  async function checkOpenPositions(trades, { force = false } = {}) {
    const todayISO = etNow().iso;
    const isStale = t => !t.lastCheck?.fetchedAt || etNow(new Date(t.lastCheck.fetchedAt)).iso !== todayISO;
    const targets = trades.filter(t => t.status === 'open' && (force || isStale(t)));
    if (!targets.length) return 0;
    const creds = await loadAutomationConfig().catch(() => ({}));
    const groups = new Map();
    for (const t of targets) {
      const key = `${t.underlying}|${t.expiry}|${t.mode}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    let updated = 0;
    for (const group of groups.values()) {
      const { underlying, expiry, mode } = group[0];
      let chain;
      try { chain = await fetchChainSmart({ underlying, mode }, creds, undefined, expiry); }
      catch (e) { console.warn('[condor] position check: chain fetch failed', underlying, expiry, e); continue; }
      for (const t of group) {
        try {
          const snap = computePositionSnapshot(t, chain);
          await updateCondorTrade(t.id, { lastCheck: snap });
          updated++;
        } catch (e) { console.warn('[condor] position check: snapshot failed', t.id, e); }
      }
    }
    return updated;
  }

  $('cd-check-all').addEventListener('click', async () => {
    const btn = $('cd-check-all');
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const trades = await listCondorTrades().catch(() => []);
      await checkOpenPositions(trades, { force: true });
      await paintJournal();
    } catch (e) { alert(e?.message || String(e)); }
    finally { btn.disabled = false; btn.textContent = prev; }
  });

  // ----- journal ---------------------------------------------------------------
  const STATUSES = ['open', 'profit_target', 'expired_win', 'time_exit', 'stopped', 'closed_manual'];
  const STATUS_LABEL = {
    open: 'OPEN', profit_target: 'TP HIT', expired_win: 'EXPIRED WIN',
    time_exit: 'TIME EXIT', stopped: 'STOPPED', closed_manual: 'CLOSED',
  };

  // Orchestrator: one trades fetch feeds both the Open Positions cards
  // (instant, from stored lastCheck) and the Journal table, then kicks a
  // background check for any stale open position and repaints just the
  // positions strip if that changed anything.
  async function paintJournal() {
    const trades = await listCondorTrades().catch(() => []);
    paintPositions(trades);
    renderJournalTable(trades);
    checkOpenPositions(trades)
      .then(updated => { if (updated > 0) listCondorTrades().then(paintPositions).catch(() => {}); })
      .catch(e => console.warn('[condor] auto position check failed', e));
  }

  function renderJournalTable(trades) {
    const el = $('cd-journal');
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
        <thead><tr><th>Date</th><th>Mode</th><th>U/L</th><th>Expiry</th><th>Legs (C sell/buy · P sell/buy)</th><th>Credit</th><th>Qty</th><th title="When to close and at what — stored from the trade card at log time">Exit Plan</th><th>Status</th><th>P&amp;L $</th><th></th></tr></thead>
        <tbody>
          ${trades.map(t => `
            <tr data-id="${esc(t.id)}">
              <td style="font-family:var(--font-mono)">${esc(t.date || '')}</td>
              <td style="font-family:var(--font-mono);font-size:0.85rem">${esc(t.mode === '1dte' ? '1DTE' : (t.dte ? `${t.dte}DTE` : '30-45'))}</td>
              <td>${esc(t.underlying || '')}</td>
              <td style="font-family:var(--font-mono)">${esc(t.expiry || '')}</td>
              <td style="font-family:var(--font-mono)">${t.callSell}/${t.callBuy} · ${t.putSell}/${t.putBuy}</td>
              <td style="font-family:var(--font-mono)">${fmt2(t.totalCredit || 0)}</td>
              <td style="font-family:var(--font-mono)">${t.contracts || 1}</td>
              <td style="font-family:var(--font-mono);font-size:0.82rem;white-space:nowrap">${esc(formatExitPlan(t))}</td>
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
    try {
      const loaded = await loadCondorState();
      state = { config: normalizeConfig(loaded.config), presets: loaded.presets || {} };
    } catch (e) { console.warn('[condor] state load failed', e); }
    paintConfig();
    paintJournal();
    // Restore today's already-computed card on reload, silently, from the
    // same-day chain cache — never a network fetch on plain page load. GET
    // TODAY'S LEGS still requires an explicit click when there's nothing
    // cached yet; this only avoids losing a result you already paid for.
    if (loadChainCache(state.config.underlying, state.config.mode)) computeLegs(false);
  })();
}
