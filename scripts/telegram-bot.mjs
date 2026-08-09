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

const uptime = () => {
  const s = Math.floor((Date.now() - START) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};

// ---- Commands ---------------------------------------------------------------

const COMMANDS = {
  async help() {
    return [
      '<b>Swing Control Panel</b>', '',
      '<b>MONITOR</b>',
      '/health — bot, broker and last-run status',
      '/status — automation state, equity, open count',
      '/positions — open positions',
      '/pnl — realized + unrealized P&amp;L',
      '/log [n] [filter] — shared log tail, e.g. <code>/log 40 PLACED</code>',
      '/errors — recent failed runs', '',
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
    const lines = [`<b>Health</b>`, `bot uptime: ${uptime()}`];
    try {
      const paused = await isPaused();
      lines.push(`automation: ${paused ? '⛔ PAUSED' : '✅ active'}`);
    } catch (e) { lines.push(`automation: ⚠️ ${esc(e.message)}`); }

    try {
      const { uid, cfg: uc } = await resolveUser();
      lines.push(`user: ${uid.slice(0, 6)}… (${uc.enabled ? 'enabled' : 'disabled'})`);
      const { client, live } = brokerFor(uc);
      const acct = await client.getAccount();
      const clock = await client.getClock();
      lines.push(`broker: ✅ ${live ? '🔴 LIVE' : 'paper'} equity ${fmtUsd(acct.equity)}`);
      lines.push(`market: ${clock.isOpen ? 'open' : `closed (next ${esc(clock.nextOpen)})`}`);
    } catch (e) { lines.push(`broker: ❌ ${esc(e.message)}`); }

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
      if (!runs.length) lines.push('runs: none recorded');
      for (const r of runs) {
        const when = r.finishedAt?.toDate ? r.finishedAt.toDate().toISOString().replace('T', ' ').slice(0, 16) : '?';
        lines.push(`${r.ok ? '✅' : '❌'} ${esc(r.job)} ${when} placed=${r.placed ?? 0} skipped=${r.skipped ?? 0}`);
      }
    } catch (e) { lines.push(`runs: ⚠️ ${esc(e.message)}`); }
    return lines.join('\n');
  },

  async status() {
    const { uid, cfg: uc } = await resolveUser();
    const { client, live } = brokerFor(uc);
    const [acct, positions] = await Promise.all([client.getAccount(), client.getPositions()]);
    const paused = await isPaused();
    return [
      `<b>Status</b> ${paused ? '⛔ PAUSED' : '✅ active'}`,
      `user ${uid.slice(0, 6)}… · ${live ? '🔴 LIVE' : 'paper'}`,
      `equity ${fmtUsd(acct.equity)} · buying power ${fmtUsd(acct.buyingPower)}`,
      `open positions ${positions.length} / ${uc.maxConcurrentPositions ?? '—'}`,
      `risk ${uc.riskPerTradePct ?? '—'}% · sizing ${esc(uc.sizingMode || 'risk')}`,
      `strategies ${esc((uc.strategies?.length ? uc.strategies : ['all']).join(', '))}`,
      `tiers ${esc((uc.tiers?.length ? uc.tiers : ['all']).join(', '))}`,
      `indexes ${esc((uc.indexes?.length ? uc.indexes : ['all']).join(', '))}`,
    ].join('\n');
  },

  async positions() {
    const { cfg: uc } = await resolveUser();
    const { client } = brokerFor(uc);
    const ps = await client.getPositions();
    if (!ps.length) return 'No open positions.';
    const rows = ps.map(p => {
      const pl = Number(p.unrealizedPl ?? p.unrealized_pl ?? NaN);
      const plpc = Number(p.unrealizedPlpc ?? p.unrealized_plpc ?? NaN) * 100;
      return `${p.symbol} ×${p.qty} @ ${Number(p.avgEntryPrice ?? p.avg_entry_price ?? 0).toFixed(2)} → ${fmtUsd(pl)}${Number.isFinite(plpc) ? ` (${plpc >= 0 ? '+' : ''}${plpc.toFixed(2)}%)` : ''}`;
    });
    return `<b>Positions (${ps.length})</b>\n` + rows.join('\n');
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
    return [
      '<b>P&amp;L</b>',
      `today ${dayPl == null ? '—' : `${fmtUsd(dayPl)} (${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(2)}%)`}`,
      `equity ${fmtUsd(acct.equity)}`,
      closed ? `realized ${fmtUsd(net)} over ${counted} trade(s)` : 'realized — none journalled yet',
      closed ? `record ${wins}W / ${losses}L (${Math.round((wins / closed) * 100)}%)` : '',
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
      const head = `<b>${esc(resolveLogFile().split('/').pop())}</b> · last ${text.split('\n').length} line(s)`
        + (filter ? ` matching <code>${esc(filter)}</code>` : '');
      // Telegram rejects messages over ~4096 chars; keep the NEWEST lines.
      return `${head}\n<pre>${esc(text.slice(-3400))}</pre>`;
    }
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
    if (!bad.length) return '✅ No failed runs in the last 25.';
    return '<b>Recent failures</b>\n' + bad.slice(0, 8).map(r => {
      const when = r.finishedAt?.toDate ? r.finishedAt.toDate().toISOString().replace('T', ' ').slice(0, 16) : '?';
      return `❌ ${esc(r.job)} ${when}\n   ${esc(String(r.error || `${r.errors} error(s)`).slice(0, 180))}`;
    }).join('\n');
  },

  async pause() {
    await db.collection('publicConfig').doc('automation')
      .set({ paused: true, pausedAt: admin.firestore.FieldValue.serverTimestamp(), pausedVia: 'telegram' }, { merge: true });
    return '⛔ Paused. No new entries will be placed by any worker.\nExisting positions and their brackets are untouched — use /flatten to exit.';
  },

  async resume() {
    await db.collection('publicConfig').doc('automation')
      .set({ paused: false, resumedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return '✅ Resumed. Workers will place entries on their next run.';
  },

  // Destructive: requires CONFIRM so a mistap can't liquidate the account.
  async flatten(args) {
    if ((args[0] || '').toUpperCase() !== 'CONFIRM') {
      const { cfg: uc } = await resolveUser();
      const { client, live } = brokerFor(uc);
      const ps = await client.getPositions();
      if (!ps.length) return 'No open positions to flatten.';
      return `⚠️ This closes <b>${ps.length}</b> position(s) on the ${live ? '🔴 LIVE' : 'paper'} account at market and cancels their orders:\n` +
        ps.map(p => `• ${p.symbol} ×${p.qty}`).join('\n') +
        '\n\nSend <code>/flatten CONFIRM</code> to proceed.';
    }
    const { cfg: uc } = await resolveUser();
    const { client } = brokerFor(uc);
    const ps = await client.getPositions();
    if (!ps.length) return 'No open positions to flatten.';
    const done = [], failed = [];
    for (const p of ps) {
      try { await client.closePosition(p.symbol, { cancelOrders: true }); done.push(p.symbol); }
      catch (e) { failed.push(`${p.symbol} (${e.message})`); }
    }
    return `Flatten submitted.\n✅ ${done.join(', ') || 'none'}` + (failed.length ? `\n❌ ${esc(failed.join(', '))}` : '');
  },

  async exclude(args) {
    const [op, tickerRaw] = args;
    const { uid, cfg: uc } = await resolveUser();
    const list = Array.isArray(uc.excludeTickers) ? [...uc.excludeTickers] : [];
    const ref = db.collection('users').doc(uid).collection('automation').doc('config');
    if (!op || op === 'list') return list.length ? `<b>Excluded</b>\n${esc(list.join(', '))}` : 'Exclusion list is empty.';
    const ticker = (tickerRaw || '').toUpperCase();
    if (!ticker) return 'Usage: /exclude add TSLA  |  /exclude remove TSLA  |  /exclude list';
    if (op === 'add') {
      if (list.includes(ticker)) return `${ticker} is already excluded.`;
      list.push(ticker);
      await ref.set({ excludeTickers: list, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return `✅ ${ticker} will never be auto-traded.`;
    }
    if (op === 'remove') {
      const i = list.indexOf(ticker);
      if (i < 0) return `${ticker} is not on the list.`;
      list.splice(i, 1);
      await ref.set({ excludeTickers: list, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return `✅ ${ticker} removed from the exclusion list.`;
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
    if (!field) return `Usage: /set &lt;field&gt; &lt;value&gt;\nSettable: ${[...NUMERIC].join(', ')}`;
    if (!NUMERIC.has(field)) {
      return `❌ '${esc(field)}' is not settable here.\nSettable: ${[...NUMERIC].join(', ')}\nStrategy/tier/index selection is UI-only by design.`;
    }
    const val = Number(rawVal);
    if (!Number.isFinite(val) || val < 0) return `❌ '${esc(rawVal)}' is not a valid number.`;
    const { uid, cfg: uc } = await resolveUser();
    await db.collection('users').doc(uid).collection('automation').doc('config')
      .set({ [field]: val, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return `✅ ${esc(field)}: ${uc[field] ?? '—'} → <b>${val}</b>`;
  },

  async config() {
    return `<b>Runtime config</b> (secrets masked)\n<pre>${esc(describeConfig(cfg))}</pre>`;
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
      return '⚠️ <code>/deploy CONFIRM</code> pulls, runs the tests, and restarts the services in '
        + `${esc(repoDir)}.\nScheduled runs use the code on disk, so this changes what trades next.\n`
        + 'It refuses to run inside the 15:38 ET window.\nUse <code>/deploy check</code> to see what would happen first.';
    }
    try {
      // Generous timeout: npm ci plus the full suite is slower than a git pull.
      const { stdout, stderr } = await execFileAsync(
        'bash', ['scripts/deploy.sh', dry ? '--check' : ''].filter(Boolean),
        { cwd: repoDir, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const out = `${stdout}${stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      return `${dry ? '🔎 Deploy check' : '✅ Deploy'}\n<pre>${esc(out.slice(-3000))}</pre>`;
    } catch (e) {
      const out = `${e.stdout || ''}${e.stderr || e.message}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
      return `❌ Deploy failed — the previous code is still running.\n<pre>${esc(out.slice(-3000))}</pre>`;
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
