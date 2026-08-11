#!/usr/bin/env node
// =============================================================================
// validate.mjs — one command that checks the whole system end to end.
//
//   npm run validate            full check
//   npm run validate -- --quick skip the test suite and bar fetching
//   ONLY_UID=<uid> npm run validate
//
// STRICTLY READ-ONLY. It places no orders, cancels nothing, liquidates nothing,
// and writes nothing to Firestore. A health check for a trading system that can
// change state is not a health check — you would hesitate to run it when you
// most need to.
//
// It goes beyond "is the process up". The valuable part is the CROSS-CHECKS
// between what the broker holds and what the journal believes, because that is
// where silent damage lives:
//
//   • a broker position with no journal doc has NO MANAGED EXIT — the exit pass
//     iterates the journal, so an untracked position rides on its hard stop
//     alone, indefinitely
//   • a journal doc stuck at 'submitted' means reconciliation is not running,
//     which also hides the position from exit management
//   • a closed trade with no realized outcome blinds the re-entry cooldown,
//     which reads exactly that field
//   • a stale equity snapshot means the drawdown peak has frozen, and a frozen
//     peak makes the measured drawdown look SMALLER than it is — silently
//     disabling the halt, in the unsafe direction
//
// Exit code 0 = healthy (warnings allowed), 1 = something needs attention.
// =============================================================================

import './lib/load-env.mjs';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initFirestore } from '../src/config/firebaseAdmin.js';
import { createAlpacaClient, resolveAlpacaBaseUrl, isLiveBaseUrl } from '../src/broker/alpaca.js';
import { marketClock, REENTRY_COOLDOWN_DAYS } from '../src/auto/engine.js';
import { resolveLogFile } from './lib/logfile.mjs';
import { resolveConfigFile } from './lib/load-env.mjs';
import { analyzeJournal, analyzeEquityFreshness } from '../src/auto/integrity.js';
import { isQuotaError } from './lib/alert.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const ONLY_UID = process.env.ONLY_UID || null;

// --json emits a structured result instead of the terminal report, so callers
// (the Telegram bot) can render it their own way rather than pasting a wall of
// fixed-width text into a chat.
const JSON_OUT = process.argv.includes('--json');

let fails = 0, warns = 0;
const RESULT = { sections: [], startedAt: new Date().toISOString() };
let section = null;

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[1m', x: '\x1b[0m' };
const emit = (level, message) => {
  if (section) section.items.push({ level, message });
  if (JSON_OUT) return;
  const mark = level === 'ok' ? `${C.g}✓${C.x}` : level === 'warn' ? `${C.y}!${C.x}`
    : level === 'bad' ? `${C.r}✗${C.x}` : ' ';
  console.log(level === 'info' ? `    ${message}` : `  ${mark} ${message}`);
};
const ok = (m) => emit('ok', m);
const warn = (m) => { warns++; emit('warn', m); };
const bad = (m) => { fails++; emit('bad', m); };
const info = (m) => emit('info', m);
const hdr = (m) => {
  section = { title: m.replace(/^\d+\.\s*/, '').trim(), items: [] };
  RESULT.sections.push(section);
  if (!JSON_OUT) console.log(`\n${C.b}${m}${C.x}`);
};

const sh = async (cmd, args) => {
  try { return (await execFileAsync(cmd, args, { timeout: 15000 })).stdout.trim(); }
  catch (e) { return String(e.stdout || '').trim(); }
};
const daysAgo = (d) => (Date.now() - d.getTime()) / 86400_000;
const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);

// ---- 1. environment ---------------------------------------------------------
async function checkEnvironment() {
  hdr('1. Environment');
  const major = Number(process.versions.node.split('.')[0]);
  major >= 18 ? ok(`node ${process.version}`) : bad(`node ${process.version} too old (need >= 18)`);

  const cfgFile = resolveConfigFile();
  if (!cfgFile) bad('no swing.env found — every credential is missing');
  else {
    ok(`config ${cfgFile}`);
    try {
      const mode = (fs.statSync(cfgFile).mode & 0o777).toString(8);
      mode === '600' ? ok(`permissions ${mode}`)
        : warn(`permissions ${mode} — holds broker keys and a bot token; chmod 600 ${cfgFile}`);
    } catch { /* unreadable is caught elsewhere */ }
  }

  for (const k of ['FIREBASE_PROJECT_ID']) {
    process.env[k] ? ok(`${k}=${process.env[k]}`) : bad(`${k} is not set`);
  }
  process.env.ALPACA_KEY ? ok('ALPACA_KEY set (market data)')
    : warn('ALPACA_KEY unset — keyless bar endpoints rate-limit on the broad universe');

  const dry = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const live = String(process.env.ALLOW_LIVE ?? 'false').toLowerCase() === 'true';
  info(`DRY_RUN=${dry}  ALLOW_LIVE=${live}  WATCHLIST_SET=${process.env.WATCHLIST_SET || 'core'}`);
  return { dry, live };
}

// ---- 2. services ------------------------------------------------------------
async function checkServices() {
  hdr('2. Services and timers');
  if (!(await sh('which', ['systemctl']))) { warn('systemctl unavailable — not a systemd host, skipping'); return; }

  for (const [unit, what] of [
    ['swing-sameday.timer', 'entries 15:38 ET'],
    ['swing-maintenance.timer', 'reconcile/exits/realize/equity 09:45 + 16:15 ET'],
  ]) {
    const state = await sh('systemctl', ['is-active', unit]);
    if (state === 'active') {
      const row = (await sh('systemctl', ['list-timers', '--no-pager', unit]))
        .split('\n').find(l => l.includes(unit)) || '';
      ok(`${unit} armed — next ${row.trim().split(/\s{2,}/)[0] || '?'} (${what})`);
    } else {
      bad(`${unit} is ${state || 'not installed'} — ${what} is NOT running. ./scripts/setup-vm.sh --units`);
    }
  }

  for (const [unit, required] of [['swing-bot.service', false], ['swing-dashboard.service', false]]) {
    const state = await sh('systemctl', ['is-active', unit]);
    if (state === 'active') ok(`${unit} running`);
    else if (required) bad(`${unit} is ${state}`);
    else warn(`${unit} is ${state || 'not installed'}`);
  }

  // A unit pointing at a config that has moved starts with an EMPTY environment,
  // and the resulting error names a variable rather than the path.
  const cfgFile = resolveConfigFile();
  for (const unit of ['swing-bot.service', 'swing-sameday.service', 'swing-maintenance.service', 'swing-dashboard.service']) {
    const raw = await sh('systemctl', ['show', '-p', 'EnvironmentFiles', '--value', unit]);
    if (!raw) continue;
    const file = raw.replace(/ \(ignore_errors=.*$/, '').trim();
    if (cfgFile && file && file !== cfgFile) {
      bad(`${unit} reads ${file}, but the config is at ${cfgFile} — it will start with NO variables`);
    }
  }
}

// ---- 3. Firestore -----------------------------------------------------------
async function checkFirestore() {
  hdr('3. Firestore');
  let db;
  try {
    db = initFirestore({ log: () => {} });
    await db.collection('publicConfig').doc('automation').get();
    ok('reachable');
  } catch (e) {
    if (isQuotaError(e)) {
      bad('QUOTA EXHAUSTED — the free-tier daily read allowance is spent');
      info('Any runner firing before the reset (midnight Pacific) will abort: no reconciliation,');
      info('no managed exits, no realized P&L, and the drawdown peak stops updating.');
      info('Open positions keep their broker stops. Blaze plan removes this failure class.');
    } else {
      bad(`unreachable: ${e.message.split('\n')[0]}`);
    }
    return null;
  }

  try {
    const paused = (await db.collection('publicConfig').doc('automation').get()).data()?.paused === true;
    paused ? warn('automation is PAUSED — no new entries will be placed (Telegram /resume)') : ok('automation not paused');
  } catch { /* non-fatal */ }

  // Recent worker runs, newest first — is anything actually executing?
  try {
    const snap = await db.collection('cronRuns').orderBy('createdAt', 'desc').limit(20).get();
    const runs = snap.docs.map(d => d.data());
    const seen = new Map();
    for (const r of runs) if (!seen.has(r.job)) seen.set(r.job, r);
    if (!seen.size) warn('no worker runs recorded yet');
    // What a stale or failed job actually costs. Trading no longer depends on
    // the signal refresh — the same-day runner scans in-process — so a failure
    // there is a stale WEB APP, not a stopped trading system. Saying so stops a
    // red line reading as "my money is at risk" when it isn't.
    const AFFECTS = {
      maintenance: 'reconciliation, exits, realized P&L and the drawdown ratchet — TRADING-CRITICAL',
      sameday: 'entries at the close — TRADING-CRITICAL',
      refresh: 'Live Signals and History in the web app only; the same-day runner scans in-process and does not read these',
      'auto-trade': 'the legacy morning path, now manual-only',
      universe: 'S&P index membership, refreshed weekly',
    };
    for (const [job, r] of seen) {
      const when = toDate(r.finishedAt) || toDate(r.createdAt);
      const age = when ? daysAgo(when) : null;
      const stamp = when ? when.toISOString().replace('T', ' ').slice(0, 16) : '?';
      const affects = AFFECTS[job] || AFFECTS[Object.keys(AFFECTS).find(k => job.startsWith(k))] || null;
      if (r.ok === false) {
        bad(`${job}: last run ${stamp} FAILED`);
        if (r.error) info(String(r.error).split('\n')[0].slice(0, 200));
        if (affects) info(`affects: ${affects}`);
      } else if (age != null && age > 4) {
        warn(`${job}: last ${stamp} — ${age.toFixed(1)}d ago`);
        if (affects) info(`affects: ${affects}`);
      } else ok(`${job}: last ${stamp}`);
    }
  } catch (e) { warn(`cronRuns unreadable: ${e.message.split('\n')[0]}`); }

  return db;
}

// ---- 4. accounts, broker, and journal integrity -----------------------------
async function checkAccounts(db, { dry, live: allowLive }) {
  hdr('4. Accounts');
  let configs = [];
  try {
    const snap = await db.collectionGroup('automation').get();
    snap.forEach(d => {
      if (d.id !== 'config') return;
      const c = d.data();
      const uid = d.ref.parent.parent?.id;
      if (!uid || (ONLY_UID && uid !== ONLY_UID)) return;
      configs.push({ uid, cfg: c });
    });
  } catch (e) { bad(`cannot read automation configs: ${e.message.split('\n')[0]}`); return; }

  const enabled = configs.filter(c => c.cfg.enabled === true);
  if (!enabled.length) { bad('no automation-enabled account — nothing will ever trade'); return; }
  ok(`${enabled.length} enabled account(s) of ${configs.length}`);

  for (const { uid, cfg } of enabled) {
    hdr(`   Account ${uid.slice(0, 6)}…`);
    if (cfg.broker !== 'alpaca') { warn(`broker '${cfg.broker}' unsupported`); continue; }
    if (!cfg.apiKey || !cfg.apiSecret) { bad('no broker API credentials'); continue; }

    const baseUrl = resolveAlpacaBaseUrl(cfg);
    const isLive = isLiveBaseUrl(baseUrl);
    const client = createAlpacaClient({ baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });

    let account, positions, clock;
    try {
      [account, positions, clock] = await Promise.all([client.getAccount(), client.getPositions(), client.getClock()]);
    } catch (e) { bad(`broker unreachable: ${e.message.split('\n')[0]}`); continue; }

    ok(`${isLive ? '🔴 LIVE' : 'paper'} · equity $${account.equity.toFixed(0)} · buying power $${account.buyingPower.toFixed(0)} · ${positions.length} position(s)`);
    if (account.status && account.status !== 'ACTIVE') bad(`account status is ${account.status}`);
    if (isLive && !allowLive) warn('LIVE broker URL but ALLOW_LIVE=false — this account is blocked from trading');
    if (isLive && allowLive && !dry) warn('REAL MONEY IS ARMED (live URL + ALLOW_LIVE + DRY_RUN=false)');
    info(`market ${clock.isOpen ? 'open' : `closed, next open ${String(clock.nextOpen).slice(0, 16)}`}`);

    await checkJournalIntegrity(db, uid, positions, { dry });
    await checkEquityFreshness(db, uid);
  }
}

// The cross-checks. Everything above confirms components are alive; this asks
// whether they AGREE with each other. The rules themselves are pure and unit
// tested in tests/integrity.mjs — this function only fetches and prints.
async function checkJournalIntegrity(db, uid, positions, { dry }) {
  // Bounded: reading the whole journal on every /validate is an unbounded cost
  // against a metered allowance, and every integrity rule only looks at open
  // docs or recently-closed ones anyway.
  let docs;
  const since = new Date(Date.now() - 45 * 86400_000);
  try {
    const col = db.collection('users').doc(uid).collection('autoOrders');
    let snap;
    try { snap = await col.where('createdAt', '>=', since).get(); }
    catch { snap = await col.get(); }   // composite index missing — fall back
    docs = snap.docs.map(d => d.data());
  } catch (e) { warn(`autoOrders unreadable: ${e.message.split('\n')[0]}`); return; }
  if (!docs.length) { info('journal empty — nothing has been placed yet'); return; }

  const { findings, stats } = analyzeJournal({
    docs, positions, dryRun: dry, cooldownDays: REENTRY_COOLDOWN_DAYS,
  });

  for (const f of findings) {
    const line = `${f.message}${f.symbols.length ? `: ${f.symbols.slice(0, 6).join(', ')}${f.symbols.length > 6 ? `, +${f.symbols.length - 6} more` : ''}` : ''}`;
    f.severity === 'error' ? bad(line) : warn(line);
    if (f.detail) info(f.detail);
  }
  if (!findings.length && positions.length) ok(`all ${positions.length} position(s) tracked and consistent with the journal`);
  else if (!findings.length) ok('journal consistent with the broker');

  if (stats.writtenOff) info(`${stats.writtenOff} trade(s) written off as unrecoverable (REALIZE_RETRY=true to re-examine)`);
  if (stats.realized) {
    ok(`${stats.realized} realized trade(s) · ${(stats.winRate * 100).toFixed(0)}% win · net $${stats.netPnl.toFixed(0)}`);
  }
}

async function checkEquityFreshness(db, uid) {
  try {
    const snap = await db.collection('users').doc(uid).collection('autoEquity')
      .orderBy('date', 'desc').limit(1).get();
    const last = snap.empty ? null : snap.docs[0].data();
    const v = analyzeEquityFreshness({ lastSnapshotDate: last?.date ?? null });
    if (v.severity === 'error') bad(v.message);
    else if (v.severity === 'warn') warn(v.message);
    else ok(`equity snapshot current (${last.date}, peak $${Number(last.peak || 0).toFixed(0)}, dd ${Number(last.drawdownPct || 0).toFixed(1)}%)`);
  } catch (e) { warn(`autoEquity unreadable: ${e.message.split('\n')[0]}`); }
}

// ---- 5. market data ---------------------------------------------------------
async function checkMarketData() {
  hdr('5. Market data');
  if (QUICK) { info('skipped (--quick)'); return; }
  const key = process.env.ALPACA_KEY, secret = process.env.ALPACA_SECRET;
  if (!key || !secret) { warn('no ALPACA_KEY/SECRET — cannot verify bar fetching'); return; }
  try {
    const client = createAlpacaClient({ baseUrl: 'https://paper-api.alpaca.markets', apiKey: key, apiSecret: secret });
    const start = new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10);
    const bars = await client.getDailyBars('AAPL', { start });
    if (bars.length >= 15) ok(`bars OK (AAPL, ${bars.length} daily bars, last ${bars[bars.length - 1].date})`);
    else bad(`only ${bars.length} bars for AAPL — the scan cannot compute indicators`);
  } catch (e) { bad(`bar fetch failed: ${e.message.split('\n')[0]}`); }
}

// ---- 6. logging + dashboard -------------------------------------------------
async function checkLogging() {
  hdr('6. Logging and dashboard');
  const file = resolveLogFile();
  try {
    const st = fs.statSync(file);
    const age = daysAgo(st.mtime);
    const size = (st.size / 1048576).toFixed(1);
    if (age > 3) warn(`${file} last written ${age.toFixed(1)}d ago (${size} MB) — nothing has run recently`);
    else ok(`${file} (${size} MB, last write ${age < 1 / 24 ? 'under an hour' : `${age.toFixed(1)}d`} ago)`);
  } catch { warn(`${file} does not exist yet — no runner has logged`); }

  const port = Number(process.env.DASHBOARD_PORT || 8444);
  const listen = (await sh('ss', ['-ltn'])).split('\n').find(l => l.includes(`:${port} `));
  if (!listen) warn(`nothing listening on ${port} — dashboard not running`);
  else if (/127\.0\.0\.1:/.test(listen)) info(`dashboard on ${port}: loopback only (tunnel required)`);
  else ok(`dashboard on ${port}: ${process.env.DASHBOARD_CERT_FILE ? 'HTTPS' : 'PLAIN HTTP'}, reachable from other hosts`);
  if (listen && !/127\.0\.0\.1:/.test(listen) && !process.env.DASHBOARD_CERT_FILE) {
    warn('dashboard exposed over plain HTTP — password and log lines cross the network in the clear (npm run dashboard:cert -- --apply)');
  }
}

// ---- 7. code ----------------------------------------------------------------
async function checkCode() {
  hdr('7. Code');
  const head = await sh('git', ['-C', REPO, 'log', '-1', '--pretty=%h %s (%cr)']);
  if (head) ok(`HEAD ${head}`);
  const dirty = await sh('git', ['-C', REPO, 'status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    // One message per line, not a message containing newlines — an embedded
    // newline breaks every renderer downstream (the Telegram formatter treats
    // one item as one line).
    warn(`working tree has ${dirty.split('\n').length} uncommitted change(s) — deploy.sh will refuse`);
    for (const l of dirty.split('\n').slice(0, 5)) info(l.trim());
  }
  await sh('git', ['-C', REPO, 'fetch', '--quiet', 'origin']);
  const branch = await sh('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const behind = await sh('git', ['-C', REPO, 'rev-list', '--count', `HEAD..origin/${branch}`]);
  if (behind && behind !== '0') warn(`${behind} commit(s) behind origin/${branch} — ./scripts/deploy.sh`);
  else if (behind === '0') ok(`up to date with origin/${branch}`);

  if (QUICK) { info('test suite skipped (--quick)'); return; }
  try {
    const { stdout } = await execFileAsync('npm', ['test'], { cwd: REPO, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 });
    const total = [...stdout.matchAll(/PASS (\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    const failed = [...stdout.matchAll(/FAIL (\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    failed ? bad(`test suite: ${failed} failing assertion(s)`) : ok(`test suite green (${total} assertions)`);
  } catch (e) {
    bad('test suite FAILED — deploy.sh will refuse to restart anything');
    const out = String(e.stdout || e.message);
    info(out.split('\n').filter(l => l.includes('✗')).slice(0, 5).join('\n    ') || out.slice(-300));
  }
}

// ---- main -------------------------------------------------------------------
async function main() {
  const c = marketClock();
  RESULT.etDate = c.date;
  RESULT.etTime = `${String(Math.floor(c.minutes / 60)).padStart(2, '0')}:${String(c.minutes % 60).padStart(2, '0')}`;
  RESULT.quick = QUICK;
  if (!JSON_OUT) {
    console.log(`${C.b}Swing system validation${C.x}  —  ${c.date} ${RESULT.etTime} ET${QUICK ? '  (quick)' : ''}`);
    console.log('Read-only: places no orders, cancels nothing, writes nothing.');
  }

  const env = await checkEnvironment();
  await checkServices();
  const db = await checkFirestore();
  if (db) await checkAccounts(db, env);
  await checkMarketData();
  await checkLogging();
  await checkCode();

  RESULT.fails = fails;
  RESULT.warns = warns;
  RESULT.ok = fails === 0;
  if (JSON_OUT) {
    // stdout is the machine channel here — nothing else may be written to it.
    process.stdout.write(JSON.stringify(RESULT));
  } else {
    hdr('Summary');
    if (fails) {
      console.log(`  ${C.r}✗ ${fails} problem(s)${C.x}${warns ? `, ${warns} warning(s)` : ''} — resolve the ✗ items above.`);
    } else if (warns) {
      console.log(`  ${C.y}! healthy, with ${warns} warning(s)${C.x} — review, none are blocking.`);
    } else {
      console.log(`  ${C.g}✓ all checks passed${C.x}`);
    }
  }
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('validation crashed:', e); process.exit(1); });
