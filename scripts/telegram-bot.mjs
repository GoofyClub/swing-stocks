#!/usr/bin/env node
// =============================================================================
// telegram-bot.mjs — Telegram control panel for the swing bot.
//
// A long-running process (systemd service, Restart=always) that long-polls the
// Telegram Bot API and answers commands. Modelled on the ORB bot's panel, minus
// the parts that don't apply here (rvol/gap are ORB entry params; this system's
// tuning lives in the per-user automation config).
//
//   MONITOR   /health  /status  /positions  /pnl  /log [n] [filter]  /errors
//   CONTROL   /pause  /resume  /flatten  /exclude [add|remove|list]  /config
//             /set <field> <value>   /deploy
//
// ── SECURITY ────────────────────────────────────────────────────────────────
// This process can flatten positions and change risk settings, so it is only as
// safe as its allow-list. TELEGRAM_ALLOWED_CHAT_IDS is mandatory: the bot
// REFUSES TO START without it rather than defaulting to open, because a control
// bot anyone can find and message is strictly worse than no bot. Every update is
// checked against that list and unauthorized chats get no reply at all — not
// even an error, which would confirm the bot exists.
//
// Destructive commands (/flatten, /deploy) additionally require an explicit
// CONFIRM argument, so a fat-fingered tap can't liquidate the account.
//
// The bot NEVER prints secrets: /config masks them via describeConfig().
//
// Required env: FIREBASE_PROJECT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS
// See src/config/env.js — every setting is declared there.
// =============================================================================

// Load swing-config/swing.env before anything reads process.env. systemd
// supplies these via EnvironmentFile; a manual `npm run` does not.
import './lib/load-env.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, describeConfig } from '../src/config/env.js';
import { initFirestore, admin } from '../src/config/firebaseAdmin.js';
import { createAlpacaClient, resolveAlpacaBaseUrl, isLiveBaseUrl } from '../src/broker/alpaca.js';
import { sendTelegram } from '../src/data/telegram.js';
import { attachFileLog, tailLog, resolveLogFile } from './lib/logfile.mjs';
import { formatValidationMessage } from './lib/format-validation.mjs';
import { dashboardUrl } from './lib/dashboard-url.mjs';
import { formatDeployMessage } from './lib/format-deploy.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// The checkout /deploy operates on. This file lives at <repo>/scripts/, so the
// repo root is knowable without configuration — requiring REPO_DIR to be set
// meant /deploy failed on a perfectly normal install with an error that read
// like a missing feature rather than a missing setting. REPO_DIR remains as an
// override for the unusual case where the bot runs outside the repo it deploys.
const SELF_REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Attach before loadConfig() so a startup failure (a missing token, a bad
// EnvironmentFile path) is recorded in the shared log rather than only in this
// unit's journal — that failure is exactly the one you go looking for later.
attachFileLog('bot');
const cfg = loadConfig();
const TOKEN = cfg.TELEGRAM_BOT_TOKEN;
const ALLOWED = new Set(cfg.TELEGRAM_ALLOWED_CHAT_IDS.map(String));
const START = Date.now();

if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN is required.'); process.exit(1); }
if (!ALLOWED.size) {
  console.error('TELEGRAM_ALLOWED_CHAT_IDS is required — refusing to start an unrestricted control bot.\n' +
    'Message your bot once, then read the chat id from https://api.telegram.org/bot<token>/getUpdates');
  process.exit(1);
}

// Which system this bot controls. Several control bots can share one Telegram
// app with the same command names but different arguments — ORB's /deploy takes
// a git ref, this one takes CONFIRM — so a reply that does not say who it came
// from leaves you guessing which system just acted on your message.
const LABEL = cfg.BOT_LABEL || 'Swing';

const db = initFirestore({ log: (m) => console.log(`[bot] ${m}`) });
const send = (chatId, text) => sendTelegram(TOKEN, chatId, text).catch(e => console.error('[bot] send failed', e.message));
const fmtUsd = (n) => (n == null || !Number.isFinite(n)) ? '—' : (n >= 0 ? '$' : '-$') + Math.abs(n).toFixed(2);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---- Firestore/broker helpers ----------------------------------------------

// The user this bot reports on. Explicit TELEGRAM_ADMIN_UID wins; otherwise fall
// back to the single automation-enabled user. With several users and no explicit
// id we refuse rather than guess — acting on the wrong account is unrecoverable.
async function resolveUser() {
  if (cfg.TELEGRAM_ADMIN_UID) {
    const snap = await db.collection('users').doc(cfg.TELEGRAM_ADMIN_UID).collection('automation').doc('config').get();
    if (!snap.exists) throw new Error(`No automation config for TELEGRAM_ADMIN_UID=${cfg.TELEGRAM_ADMIN_UID}`);
    return { uid: cfg.TELEGRAM_ADMIN_UID, cfg: snap.data() };
  }
  const snap = await db.collectionGroup('automation').get();
  const users = [];
  snap.forEach(d => {
    if (d.id !== 'config' || d.data()?.enabled !== true) return;
    const uid = d.ref.parent.parent?.id;
    if (uid) users.push({ uid, cfg: d.data() });
  });
  if (!users.length) throw new Error('No automation-enabled user found.');
  if (users.length > 1) throw new Error(`${users.length} automation-enabled users — set TELEGRAM_ADMIN_UID to choose one.`);
  return users[0];
}

function brokerFor(userCfg) {
  const baseUrl = resolveAlpacaBaseUrl(userCfg);
  return {
    client: createAlpacaClient({ baseUrl, apiKey: userCfg.apiKey, apiSecret: userCfg.apiSecret }),
    live: isLiveBaseUrl(baseUrl),
  };
}

async function isPaused() {
  const s = await db.collection('publicConfig').doc('automation').get();
  return s.exists && s.data()?.paused === true;
}

// Most recent run of each worker, for /health and /log.
async function recentRuns(limit = 5) {
  const snap = await db.collection('cronRuns').orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map(d => d.data());
}

// Appended to replies that report system state. Resolved each time rather than
// stored, so it can never drift from the dashboard's actual scheme or port.
async function dashboardLine() {
  try {
    const url = await dashboardUrl();
    return url ? `\n\n📊 <a href="${url}">${url}</a>` : '';
  } catch { return ''; }
}

const uptime = () => {
  const s = Math.floor((Date.now() - START) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// ---- Commands ---------------------------------------------------------------

const COMMANDS = {
  async help() {
    return [
      `<b>${esc(LABEL)} Control Panel</b>`, '',
      '<b>MONITOR</b>',
      '/health — bot, broker and last-run status',
      '/status — automation state, equity, open count',
      '/positions — open positions',
      '/pnl — realized + unrealized P&amp;L',
      '/log [n] [filter] — shared log tail, e.g. <code>/log 40 PLACED</code>',
      '/errors — recent failed runs',
      '/validate — full system check (read-only)', '',
      '<b>CONTROL</b>',
      '/pause — stop all new entries (persists)',
      '/resume — re-enable entries',
      '/flatten CONFIRM — close ALL positions, cancel orders',
      '/exclude [add|remove|list] TICKER — never-trade list',
      '/set &lt;field&gt; &lt;value&gt; — change an automation setting',
      '/config — effective runtime config (secrets masked)',
      '/deploy CONFIRM — pull, test, restart (<code>/deploy check</code> to preview)',
    ].join('\n');
  },

  async health() {
    const lines = [`<b>${esc(LABEL)} — Health</b>`, `<i>bot up ${uptime()}</i>`, ''];
    try {
      const paused = await isPaused();
      lines.push(`${paused ? '⛔' : '✅'} automation ${paused ? 'PAUSED' : 'active'}`);
    } catch (e) { lines.push(`⚠️ automation: ${esc(e.message)}`); }

    try {
      const { uid, cfg: uc } = await resolveUser();
      lines.push(`${uc.enabled ? '✅' : '⛔'} account ${uid.slice(0, 6)}… ${uc.enabled ? 'enabled' : 'DISABLED'}`);
      const { client, live } = brokerFor(uc);
      const acct = await client.getAccount();
      const clock = await client.getClock();
      lines.push(`✅ broker ${live ? '🔴 LIVE' : 'paper'} · ${fmtUsd(acct.equity)}`);
      lines.push(`${clock.isOpen ? '🔔' : '🌙'} market ${clock.isOpen ? 'open' : `closed until ${esc(String(clock.nextOpen).slice(0, 16))}`}`);
    } catch (e) { lines.push(`❌ broker: ${esc(e.message)}`); }
    lines.push('');

    // Both timers, because the system is only whole with both. A disarmed
    // maintenance timer looks like nothing is wrong until a position is sitting
    // unmanaged and the drawdown peak has quietly frozen.
    for (const [unit, what] of [['swing-sameday.timer', 'entries 15:38'], ['swing-maintenance.timer', 'maintenance 09:45+16:15']]) {
      try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', unit], { timeout: 4000 });
        const state = stdout.trim();
        lines.push(`${state === 'active' ? '✅' : '❌'} ${unit.replace('.timer', '')}: ${esc(state)} (${what})`);
      } catch (e) {
        // is-active exits non-zero when inactive; that IS the answer.
        const state = String(e.stdout || '').trim() || 'unknown';
        lines.push(`❌ ${unit.replace('.timer', '')}: ${esc(state)} (${what}) — not armed`);
      }
    }

    try {
      const runs = await recentRuns(3);
      if (!runs.length) lines.push('<i>no runs recorded yet</i>');
      else lines.push('<b>Recent runs</b>');
      for (const r of runs) {
        const when = r.finishedAt?.toDate ? r.finishedAt.toDate().toISOString().replace('T', ' ').slice(0, 16) : '?';
        lines.push(`  ${r.ok ? '✓' : '❌'} ${esc(r.job)} <i>${when}</i>`
          + (r.placed || r.skipped ? ` · placed ${r.placed ?? 0}, skipped ${r.skipped ?? 0}` : ''));
      }
    } catch (e) { lines.push(`runs: ⚠️ ${esc(e.message)}`); }
    return lines.join('\n') + await dashboardLine();
  },

  async status() {
    const { uid, cfg: uc } = await resolveUser();
    const { client, live } = brokerFor(uc);
    const [acct, positions] = await Promise.all([client.getAccount(), client.getPositions()]);
    const paused = await isPaused();
    const slots = uc.maxConcurrentPositions ?? null;
    return [
      `${paused ? '⛔' : '✅'} <b>${esc(LABEL)} — ${paused ? 'PAUSED' : 'Active'}</b>`,
      `<i>${uid.slice(0, 6)}… · ${live ? '🔴 LIVE' : 'paper'}</i>`,
      '',
      `💰 <b>${fmtUsd(acct.equity)}</b> equity · ${fmtUsd(acct.buyingPower)} buying power`,
      `📈 ${positions.length}${slots ? `/${slots}` : ''} position${positions.length === 1 ? '' : 's'}${slots && positions.length >= slots ? '  <i>(full — new signals will be turned away)</i>' : ''}`,
      '',
      `<b>Rules</b>`,
      `  risk ${uc.riskPerTradePct ?? '—'}% per trade · sizing ${esc(uc.sizingMode || 'risk')}`,
      `  strategies ${esc((uc.strategies?.length ? uc.strategies : ['all']).join(', '))}`,
      `  tiers ${esc((uc.tiers?.length ? uc.tiers : ['all']).join(', '))}`,
      `  indexes ${esc((uc.indexes?.length ? uc.indexes : ['all']).join(', '))}`,
    ].join('\n') + await dashboardLine();
  },

  async positions() {
    const { cfg: uc } = await resolveUser();
    const { client } = brokerFor(uc);
    const ps = await client.getPositions();
    if (!ps.length) return `<b>${esc(LABEL)}</b> — no open positions.`;
    let total = 0;
    const rows = ps.map(p => {
      const pl = Number(p.unrealizedPl ?? p.unrealized_pl ?? NaN);
      const mv = Number(p.marketValue ?? p.market_value ?? NaN);
      const entry = Number(p.avgEntry ?? p.avgEntryPrice ?? p.avg_entry_price ?? 0);
      // Percent from the entry basis rather than a field that may be absent —
      // Alpaca's shape differs between the raw API and our adapter.
      const basis = entry * Math.abs(Number(p.qty) || 0);
      const plpc = basis > 0 && Number.isFinite(pl) ? (pl / basis) * 100 : NaN;
      if (Number.isFinite(pl)) total += pl;
      const arrow = !Number.isFinite(pl) ? '·' : pl >= 0 ? '🟢' : '🔴';
      return `${arrow} <b>${esc(p.symbol)}</b> ×${esc(p.qty)} @ ${entry.toFixed(2)}`
        + `\n     ${fmtUsd(pl)}${Number.isFinite(plpc) ? ` (${plpc >= 0 ? '+' : ''}${plpc.toFixed(2)}%)` : ''}`
        + `${Number.isFinite(mv) ? ` · value ${fmtUsd(mv)}` : ''}`;
    });
    return `<b>${esc(LABEL)} — ${ps.length} position${ps.length === 1 ? '' : 's'}</b>\n`
      + `<i>unrealized ${fmtUsd(total)}</i>\n\n`
      + rows.join('\n');
  },

  async pnl() {
    const { uid, cfg: uc } = await resolveUser();
    const { client } = brokerFor(uc);
    const acct = await client.getAccount();
    const dayPl = acct.lastEquity > 0 ? acct.equity - acct.lastEquity : null;
    const dayPct = acct.lastEquity > 0 ? (dayPl / acct.lastEquity) * 100 : null;

    // Realized totals from the order journal (written by the workers' realize pass).
    let wins = 0, losses = 0, net = 0, counted = 0;
    try {
      const snap = await db.collection('users').doc(uid).collection('autoOrders')
        .where('realizedWinLoss', 'in', ['win', 'loss']).get();
      snap.forEach(d => {
        const o = d.data();
        if (o.realizedWinLoss === 'win') wins++; else losses++;
        if (Number.isFinite(o.realizedPnl)) { net += o.realizedPnl; counted++; }
      });
    } catch (e) { /* index may be missing; day P&L below still works */ }

    const closed = wins + losses;
    const dayMark = dayPl == null ? '·' : dayPl >= 0 ? '🟢' : '🔴';
    return [
      `<b>${esc(LABEL)} — P&amp;L</b>`,
      '',
      `${dayMark} <b>Today</b> ${dayPl == null ? '—' : `${fmtUsd(dayPl)} (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)`}`,
      `💰 <b>Equity</b> ${fmtUsd(acct.equity)}`,
      '',
      closed ? `<b>Realized</b> ${net >= 0 ? '🟢' : '🔴'} ${fmtUsd(net)} over ${counted} trade${counted === 1 ? '' : 's'}`
             : '<b>Realized</b> — nothing journalled yet',
      closed ? `  ${wins}W / ${losses}L · ${Math.round((wins / closed) * 100)}% win rate` : '',
      // Unrealized is deliberately absent: it is in /positions, and a headline
      // number mixing booked and open P&L reads as more certain than it is.
    ].filter(Boolean).join('\n');
  },

  // Reads the SHARED log file, so it shows every process on this box in one
  // interleaved sequence — the runner, this bot, and deploys. Firestore's
  // cronRuns holds only what the GitHub workers recorded, and each doc covers
  // one job; that is the fallback when the file isn't there (e.g. a fresh box).
  // An optional second argument filters: /log 40 PLACED
  async log(args) {
    const n = Math.min(Math.max(parseInt(args[0], 10) || 20, 1), 80);
    const filter = args.slice(1).join(' ').trim() || null;
    let text = '';
    try { text = tailLog(n, filter ? { grep: filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } : {}); }
    catch { /* fall through to Firestore */ }
    if (text.trim()) {
      const head = `📄 <b>${esc(LABEL)} log</b> · last ${text.split('\n').length} line${text.split('\n').length === 1 ? '' : 's'}`
        + (filter ? ` matching <code>${esc(filter)}</code>` : '');
      // Telegram rejects messages over ~4096 chars; keep the NEWEST lines.
      return `${head}\n<pre>${esc(text.slice(-3400))}</pre>` + await dashboardLine();
    }
    // A filter that matched nothing is NOT the same as an empty log, and the
    // Firestore fallback below would make it look like one.
    if (filter) return `📄 <b>${esc(LABEL)} log</b> — nothing matching <code>${esc(filter)}</code> in the last ${n * 40} lines.`;
    const runs = await recentRuns(1);
    if (!runs.length) return 'No log file on this box and no runs recorded.';
    const r = runs[0];
    const logs = (r.logs || []).slice(-n);
    if (!logs.length) return `Last run (${esc(r.job)}) recorded no log lines.`;
    return `<b>${esc(r.job)}</b> (from Firestore — no local log file) · last ${logs.length} line(s)\n<pre>${esc(logs.join('\n'))}</pre>`;
  },

  async errors() {
    const snap = await db.collection('cronRuns').orderBy('createdAt', 'desc').limit(25).get();
    const bad = snap.docs.map(d => d.data()).filter(r => !r.ok || r.errors > 0);
    if (!bad.length) return `✅ <b>${esc(LABEL)}</b> — no failed runs in the last 25.`;
    return `<b>${esc(LABEL)} — ${bad.length} failed run${bad.length === 1 ? '' : 's'}</b> <i>(of the last 25)</i>\n\n`
      + bad.slice(0, 8).map(r => {
        const when = r.finishedAt?.toDate ? r.finishedAt.toDate().toISOString().replace('T', ' ').slice(0, 16) : '?';
        return `❌ <b>${esc(r.job)}</b> <i>${when}</i>\n     ${esc(String(r.error || `${r.errors} error(s)`).slice(0, 180))}`;
      }).join('\n\n');
  },

  async pause() {
    await db.collection('publicConfig').doc('automation')
      .set({ paused: true, pausedAt: admin.firestore.FieldValue.serverTimestamp(), pausedVia: 'telegram' }, { merge: true });
    return `⛔ <b>${esc(LABEL)} paused</b>\n\nNo new entries will be placed by any runner.\n`
      + `<i>Open positions and their protective orders are untouched, and exits keep running — pausing is not abandoning risk. Use /flatten to close out.</i>`;
  },

  async resume() {
    await db.collection('publicConfig').doc('automation')
      .set({ paused: false, resumedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return `✅ <b>${esc(LABEL)} resumed</b>\n\n<i>Entries resume at the next runner firing — 15:38 ET on a weekday.</i>`;
  },

  // Destructive: requires CONFIRM so a mistap can't liquidate the account.
  async flatten(args) {
    if ((args[0] || '').toUpperCase() !== 'CONFIRM') {
      const { cfg: uc } = await resolveUser();
      const { client, live } = brokerFor(uc);
      const ps = await client.getPositions();
      if (!ps.length) return `<b>${esc(LABEL)}</b> — no open positions to flatten.`;
      return `⚠️ <b>${esc(LABEL)} — close ${ps.length} position${ps.length === 1 ? '' : 's'}?</b>\n`
        + `<i>${live ? '🔴 REAL MONEY' : 'paper'} account · market orders · protective orders cancelled</i>\n\n`
        + ps.map(p => `• <b>${esc(p.symbol)}</b> ×${esc(p.qty)}`).join('\n')
        + '\n\nSend <code>/flatten CONFIRM</code> to proceed.';
    }
    const { cfg: uc } = await resolveUser();
    const { client } = brokerFor(uc);
    const ps = await client.getPositions();
    if (!ps.length) return `<b>${esc(LABEL)}</b> — no open positions to flatten.`;
    const done = [], failed = [];
    for (const p of ps) {
      try { await client.closePosition(p.symbol, { cancelOrders: true }); done.push(p.symbol); }
      catch (e) { failed.push(`${p.symbol} (${e.message})`); }
    }
    return `${failed.length ? '⚠️' : '✅'} <b>${esc(LABEL)} — flatten submitted</b>\n\n`
      + (done.length ? `✅ closed: ${esc(done.join(', '))}\n` : '')
      + (failed.length ? `❌ failed: ${esc(failed.join(', '))}\n` : '')
      + `\n<i>Market orders are submitted, not filled — check /positions in a moment.</i>`;
  },

  async exclude(args) {
    const [op, tickerRaw] = args;
    const { uid, cfg: uc } = await resolveUser();
    const list = Array.isArray(uc.excludeTickers) ? [...uc.excludeTickers] : [];
    const ref = db.collection('users').doc(uid).collection('automation').doc('config');
    if (!op || op === 'list') {
      return list.length
        ? `🚫 <b>${esc(LABEL)} — never-trade list (${list.length})</b>\n${esc(list.join(', '))}`
        : `<b>${esc(LABEL)}</b> — the never-trade list is empty.`;
    }
    const ticker = (tickerRaw || '').toUpperCase();
    if (!ticker) return 'Usage: /exclude add TSLA  |  /exclude remove TSLA  |  /exclude list';
    if (op === 'add') {
      if (list.includes(ticker)) return `${ticker} is already excluded.`;
      list.push(ticker);
      await ref.set({ excludeTickers: list, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return `🚫 <b>${esc(ticker)}</b> added — it will never be auto-traded.\n<i>${list.length} name${list.length === 1 ? '' : 's'} excluded.</i>`;
    }
    if (op === 'remove') {
      const i = list.indexOf(ticker);
      if (i < 0) return `${ticker} is not on the list.`;
      list.splice(i, 1);
      await ref.set({ excludeTickers: list, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return `✅ <b>${esc(ticker)}</b> removed — it can be auto-traded again.\n<i>${list.length} name${list.length === 1 ? '' : 's'} still excluded.</i>`;
    }
    return 'Usage: /exclude add TSLA  |  /exclude remove TSLA  |  /exclude list';
  },

  // Only numeric risk/sizing fields are settable. Strategy/index/tier selection
  // stays in the UI: they are multi-value and easy to corrupt from a chat line,
  // and a corrupt allow-list silently stops all trading (that exact bug cost
  // days of no entries).
  async set(args) {
    const NUMERIC = new Set([
      'riskPerTradePct', 'maxConcurrentPositions', 'maxPositionsPerSector',
      'maxPortfolioHeatPct', 'dailyLossHaltPct', 'maxDrawdownHaltPct',
      'slippageBudgetPct', 'minPrice', 'maxPrice', 'minAdvUsd',
      'fixedNotional', 'maxPositionNotional',
    ]);
    const [field, rawVal] = args;
    if (!field) {
      return `<b>${esc(LABEL)} — /set</b>\n<code>/set &lt;field&gt; &lt;value&gt;</code>\n\n<b>Settable</b>\n`
        + [...NUMERIC].map(f => `  ${f}`).join('\n')
        + '\n\n<i>Strategy, tier and index selection stays in the UI — they are multi-value and a corrupt allow-list silently stops all trading.</i>';
    }
    if (!NUMERIC.has(field)) {
      return `❌ <code>${esc(field)}</code> is not settable here.\n\n<b>Settable</b>\n`
        + [...NUMERIC].map(f => `  ${f}`).join('\n')
        + '\n\n<i>Strategy, tier and index selection is UI-only by design.</i>';
    }
    const val = Number(rawVal);
    if (!Number.isFinite(val) || val < 0) return `❌ '${esc(rawVal)}' is not a valid number.`;
    const { uid, cfg: uc } = await resolveUser();
    await db.collection('users').doc(uid).collection('automation').doc('config')
      .set({ [field]: val, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return `✅ <b>${esc(field)}</b>\n  ${uc[field] ?? '—'} → <b>${val}</b>\n\n<i>Applies from the next runner firing.</i>`;
  },

  async config() {
    return `<b>Runtime config</b> (secrets masked)\n<pre>${esc(describeConfig(cfg))}</pre>`;
  },

  // Full system check. Read-only by construction, so it is always safe to run
  // from a phone — including in the middle of a session, which is exactly when
  // you want it and exactly when a state-changing "health check" would be
  // unusable. --quick skips the test suite and bar fetch to fit Telegram's
  // timeout; `/validate full` runs everything.
  async validate(args) {
    const full = (args[0] || '').toLowerCase() === 'full';
    const repoDir = cfg.REPO_DIR || SELF_REPO_DIR;
    // --json so the reply can be a readable message rather than a pasted
    // terminal dump. Exit code 1 means problems were FOUND, which is a
    // successful run with a useful report — the JSON is on stdout either way.
    const run = () => execFileAsync(
      'node', ['scripts/validate.mjs', '--json', ...(full ? [] : ['--quick'])],
      { cwd: repoDir, timeout: full ? 420_000 : 90_000, maxBuffer: 8 * 1024 * 1024 },
    );
    let stdout;
    try { ({ stdout } = await run()); }
    catch (e) { stdout = e.stdout; if (!stdout) return `❌ validation could not run: ${esc(e.message)}`; }
    try {
      return `<b>${esc(LABEL)}</b>\n` + formatValidationMessage(JSON.parse(stdout)) + await dashboardLine();
    } catch (e) {
      return `❌ could not parse the validation result: ${esc(e.message)}`;
    }
  },

  // Delegates to scripts/deploy.sh — one deploy procedure, whether it is
  // triggered from Telegram or from a shell. The script owns the ordering that
  // matters (verify before restart, refuse mid-session, restart the bot
  // detached because this process is its own parent here).
  async deploy(args) {
    if (!cfg.DEPLOY_ENABLED) return '❌ /deploy is disabled (DEPLOY_ENABLED=false).';
    const repoDir = cfg.REPO_DIR || SELF_REPO_DIR;
    const dry = (args[0] || '').toLowerCase() === 'check';
    if (!dry && (args[0] || '').toUpperCase() !== 'CONFIRM') {
      return `⚠️ <b>${esc(LABEL)}</b> — <code>/deploy CONFIRM</code> pulls, runs the tests, and restarts the services in `
        + `${esc(repoDir)}.\nScheduled runs use the code on disk, so this changes what trades next.\n`
        + 'It refuses to run inside the 15:38 ET window.\nUse <code>/deploy check</code> to see what would happen first.';
    }
    try {
      // Generous timeout: npm ci plus the full suite is slower than a git pull.
      const { stdout, stderr } = await execFileAsync(
        'bash', ['scripts/deploy.sh', dry ? '--check' : ''].filter(Boolean),
        { cwd: repoDir, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return formatDeployMessage(`${stdout}${stderr}`, { label: LABEL, ok: true, check: dry })
        + await dashboardLine();
    } catch (e) {
      return formatDeployMessage(`${e.stdout || ''}${e.stderr || e.message}`, { label: LABEL, ok: false, check: dry });
    }
  },
};

// ---- Long-poll loop ---------------------------------------------------------

async function handle(msg) {
  const chatId = String(msg.chat?.id ?? '');
  // Unauthorized chats get NO reply — an error would confirm the bot exists.
  if (!ALLOWED.has(chatId)) { console.warn(`[bot] ignored message from unauthorized chat ${chatId}`); return; }

  const text = String(msg.text || '').trim();
  if (!text.startsWith('/')) return;
  // Strip the @BotName suffix Telegram adds in groups.
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.slice(1).split('@')[0].toLowerCase();
  const fn = COMMANDS[cmd] || (cmd === 'start' ? COMMANDS.help : null);
  if (!fn) { await send(chatId, `Unknown command /${esc(cmd)} — try /help`); return; }

  console.log(`[bot] ${chatId} → /${cmd} ${args.join(' ')}`);
  try { await send(chatId, await fn(args)); }
  catch (e) { console.error(`[bot] /${cmd} failed`, e); await send(chatId, `❌ /${esc(cmd)} failed: ${esc(e.message)}`); }
}

async function main() {
  console.log(`[bot] started · ${ALLOWED.size} authorized chat(s) · project ${cfg.FIREBASE_PROJECT_ID}`);
  let offset = 0;
  // Never exits on error: this runs under systemd Restart=always, but a transient
  // network blip should be a retry, not a restart cycle.
  for (;;) {
    try {
      const url = `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=${cfg.BOT_POLL_SECONDS}${offset ? `&offset=${offset}` : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!json.ok) { console.error('[bot] getUpdates error', json.description); await sleep(5000); continue; }
      for (const u of json.result || []) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message);
      }
    } catch (e) {
      console.error('[bot] poll error', e.message);
      await sleep(5000);
    }
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
main().catch(e => { console.error('[bot] fatal', e); process.exit(1); });
