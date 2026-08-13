#!/usr/bin/env node
// =============================================================================
// maintenance.mjs — everything the trading system must do that is NOT placing
// an entry. Runs on the VM, on a timer.
//
// The system used to be split: entries fired on the VM at 15:38 ET, while order
// reconciliation, exit management, realized-P&L journaling and the equity/
// drawdown snapshot all ran in GitHub Actions. That was two schedulers with two
// code copies and two failure modes, and GitHub's scheduled runs on this repo
// land 2-3 hours late, get cancelled outright, or fail to allocate a runner at
// all. Losing them meant:
//
//   • orders stuck at 'submitted' forever → the exit pass never saw them
//   • no realized outcomes → the Auto Orders page and the re-entry cooldown
//     both went blind (the cooldown reads realizedWinLoss)
//   • a frozen drawdown peak → the halt that stops the bleeding stops firing
//
// None of that is optional, so it lives here now, next to the money.
//
//   ROUTINE   reconcile order status → manage exits → realize outcomes →
//             snapshot equity
//
// Every step is idempotent: a doubled run books nothing twice, and a missed run
// is caught by the next one. That is deliberate — it means the timer can fire
// often and nothing depends on any single firing succeeding.
//
//   DRY_RUN=true    inspect only; no cancels, no liquidations, no writes to the
//                   broker (Firestore status refreshes still happen — they only
//                   copy what the broker already says)
//   ONLY_UID=<uid>  restrict to one account
//
// Scheduled twice a day by scripts/setup-vm.sh:
//   09:45 ET — catch overnight fills and gap stop-outs before the day starts
//   16:15 ET — after the close, once the day's protective legs have settled
// =============================================================================

// Load swing-config/swing.env before anything reads process.env. systemd
// supplies these via EnvironmentFile; a manual `npm run` does not.
import './lib/load-env.mjs';
import admin from 'firebase-admin';
import { initFirestore } from '../src/config/firebaseAdmin.js';
import { createAlpacaClient, resolveAlpacaBaseUrl, isLiveBaseUrl } from '../src/broker/alpaca.js';
import { marketClock } from '../src/auto/engine.js';
import { manageExits } from './lib/exit-pass.mjs';
import { reconcileOrders } from './lib/reconcile.mjs';
import { realizeOutcomes } from './lib/realize.mjs';
import { snapshotEquity } from './lib/equity.mjs';
import { attachFileLog } from './lib/logfile.mjs';
import { alertOperator, isQuotaError, quotaAlertText } from './lib/alert.mjs';
import { makeNotifier } from './lib/notify.mjs';
import { formatDailySummary } from './lib/format-summary.mjs';
import { installReadMeter, readCount, readSummary } from './lib/firestore-meter.mjs';

attachFileLog('maint');

const DRY_RUN = String(process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const ONLY_UID = process.env.ONLY_UID || null;
const ALLOW_LIVE = String(process.env.ALLOW_LIVE ?? 'false').toLowerCase() === 'true';
// Re-examine trades previously written off as unrecoverable. One-off, for after
// the broker-side cause has been fixed.
const REALIZE_RETRY = String(process.env.REALIZE_RETRY ?? 'false').toLowerCase() === 'true';
// Send the daily summary. Defaults to ON only for the after-close run — the
// morning pass has nothing to summarise. SUMMARY=true forces it for testing.
const SUMMARY = String(process.env.SUMMARY ?? '').toLowerCase() === 'true'
  || (process.env.SUMMARY == null && marketClock().minutes >= 16 * 60);

const RUN_LOG = [];
{
  const _log = console.log.bind(console), _warn = console.warn.bind(console), _err = console.error.bind(console);
  const push = (s) => { RUN_LOG.push(s); if (RUN_LOG.length > 150) RUN_LOG.shift(); };
  console.log = (...a) => { push(a.map(String).join(' ')); _log(...a); };
  console.warn = (...a) => { push('WARN ' + a.map(String).join(' ')); _warn(...a); };
  console.error = (...a) => { push('ERROR ' + a.map(String).join(' ')); _err(...a); };
}

async function loadEnabledConfigs(db) {
  let snap;
  try {
    snap = await db.collectionGroup('automation').where('enabled', '==', true).get();
  } catch (e) {
    if (e.code === 9 || /index/i.test(e.message || '')) {
      console.warn(`[maint] automation.enabled index missing — scanning all automation docs. (${e.message})`);
      snap = await db.collectionGroup('automation').get();
    } else { throw e; }
  }
  const out = [];
  snap.forEach(doc => {
    if (doc.id !== 'config') return;
    const cfg = doc.data();
    if (cfg.enabled !== true) return;
    const uid = doc.ref.parent.parent?.id;
    if (!uid) return;
    if (ONLY_UID && uid !== ONLY_UID) return;
    out.push({ uid, cfg });
  });
  return out;
}



// Everything that closed or opened TODAY, from the journal, plus what is still
// held. Bounded to today's docs so the summary costs a handful of reads rather
// than a scan of the whole journal.
async function sendDailySummary({ db, uid, client, account, dd, notify, log, positions }) {
  const today = marketClock().date;
  const startOfDay = new Date(`${today}T00:00:00Z`);
  // Generous window: an ET date spans two UTC dates, so a day boundary in the
  // wrong direction would silently drop the morning's trades.
  const since = new Date(startOfDay.getTime() - 12 * 3600_000);

  let docs = [];
  try {
    const snap = await db.collection('users').doc(uid).collection('autoOrders')
      .where('createdAt', '>=', since).get();
    docs = snap.docs.map(d => d.data());
  } catch (e) { log(`summary: journal read failed (${e.message.split('\n')[0]})`); }

  // Closed today = realized today, whatever session it was opened in. The
  // realizedAt stamp is what makes a trade "today's result".
  let closedToday = [];
  try {
    const snap = await db.collection('users').doc(uid).collection('autoOrders')
      .where('realizedAt', '>=', since).get();
    closedToday = snap.docs.map(d => d.data());
  } catch (e) { log(`summary: realized read failed (${e.message.split('\n')[0]})`); }

  const opened = docs
    .filter(o => ['submitted', 'filled', 'partially_filled'].includes(o.status))
    .map(o => ({ ticker: o.ticker, qty: o.filledQty || o.qty, entry: o.filledAvgPrice ?? o.entry }));

  const held = positions ?? await client.getPositions().catch(() => []);

  const problems = [];
  if (dd?.halted) problems.push('Drawdown halt is active — no new entries will be placed.');

  const text = formatDailySummary({
    label: process.env.BOT_LABEL || 'Swing',
    date: today,
    equity: account.equity,
    dayPl: account.lastEquity > 0 ? account.equity - account.lastEquity : null,
    dayPlPct: account.lastEquity > 0 ? ((account.equity - account.lastEquity) / account.lastEquity) * 100 : null,
    opened,
    closed: closedToday,
    held,
    drawdownPct: dd?.drawdownPct ?? null,
    halted: !!dd?.halted,
    problems,
    dryRun: DRY_RUN,
    footer: readSummary(),
  });
  const sent = await notify(text);
  log(`daily summary ${sent ? 'sent' : 'NOT sent (no Telegram target configured)'}`);
}

// The session bucket an entry order is allowed to belong to. Anything older is
// stale. Derived from the broker's own calendar so weekends and holidays are
// handled — a Monday run must treat Friday's entries as current, not stale.
async function currentSessionDate(client, now = new Date()) {
  try {
    const clock = await client.getClock();
    const today = marketClock(now).date;
    // While the market is open, today IS the current session. Once it has
    // closed, orders placed today are still this session's until the next open.
    if (clock.isOpen) return today;
    const start = new Date(now.getTime() - 10 * 86400_000).toISOString().slice(0, 10);
    const cal = await client.getCalendar(start, today);
    const sessions = cal.map(c => c.date).filter(d => d <= today);
    return sessions.length ? sessions[sessions.length - 1] : today;
  } catch { return null; }   // null disables the stale sweep rather than guessing
}

async function processUser(db, uid, cfg) {
  const log = (msg) => console.log(`[maint][${uid.slice(0, 6)}] ${msg}`);

  if (cfg.broker !== 'alpaca') { log(`broker '${cfg.broker}' not supported — skipping`); return null; }
  if (!cfg.apiKey || !cfg.apiSecret) { log('no broker API credentials — skipping'); return null; }

  const baseUrl = resolveAlpacaBaseUrl(cfg);
  const live = isLiveBaseUrl(baseUrl);
  // Same hard live gate the entry paths use. Maintenance can CANCEL and
  // LIQUIDATE, so it is every bit as capable of moving real money as an entry.
  if (live && !ALLOW_LIVE && !DRY_RUN) {
    log(`LIVE broker URL (${baseUrl}) but ALLOW_LIVE is not set — skipping for real-money safety.`);
    return null;
  }
  const client = createAlpacaClient({ baseUrl, apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });
  const notify = makeNotifier({ db, uid, log });

  let account;
  try { account = await client.getAccount(); }
  catch (e) { log(`broker connect failed: ${e.message} — skipping`); return null; }

  log(`mode=${live ? 'live' : 'paper'} equity=${account.equity.toFixed(0)} dryRun=${DRY_RUN}`);

  // 1. Reconcile first: the exit pass looks at 'filled' docs, so a status that
  //    is still 'submitted' would hide a position that needs managing.
  const session = DRY_RUN ? null : await currentSessionDate(client);
  const rec = await reconcileOrders({
    db, admin, uid, client, log,
    currentSession: DRY_RUN ? null : session,
    notify,
  });
  if (rec.refreshed || rec.expired) log(`reconcile: ${rec.refreshed} refreshed, ${rec.filled} newly filled, ${rec.expired} stale entries cancelled`);

  // 2. Exits. Same shared pass the entry runners use.
  const ex = await manageExits({ db, admin, uid, client, log, dryRun: DRY_RUN, notify });
  if (ex.checked) log(`exits: ${ex.checked} checked, ${ex.closed} closed`);

  // 3. Realize outcomes for anything now closed. Runs in dry-run TOO, on
  //    purpose: it is read-only at the broker (it fetches the retained order to
  //    read its filled leg) and it only ever books trades that a real run
  //    already marked closed. Skipping it under dry-run meant a box left at
  //    DRY_RUN=true — the safe, recommended default while validating — never
  //    booked a single realized outcome, which silently blanks the Auto Orders
  //    page AND blinds the re-entry cooldown, since that reads realizedWinLoss.
  //    Dry-run should mean "place and cancel nothing", not "record nothing".
  let realized = 0, unavailable = 0;
  try { ({ realized, unavailable } = await realizeOutcomes({ db, admin, uid, client, log, retryUnavailable: REALIZE_RETRY })); }
  catch (e) { log(`realize outcomes failed: ${e.message}`); }

  // 4. Equity + drawdown ratchet. Always — the peak must not go stale, and a
  //    snapshot writes nothing to the broker so dry-run can do it safely.
  let dd = null;
  try {
    dd = await snapshotEquity({ db, admin, uid, equity: account.equity, cfg });
    if (dd.halted) {
      log(`DRAWDOWN HALT ACTIVE: -${dd.drawdownPct.toFixed(1)}% from peak $${dd.peak.toFixed(0)} (>= ${cfg.maxDrawdownHaltPct}%) — entries blocked`);
      await notify(`⛔ <b>DRAWDOWN HALT</b> -${dd.drawdownPct.toFixed(1)}% from peak ${dd.peak.toFixed(0)} — no new entries`);
    }
  } catch (e) { log(`equity snapshot failed: ${e.message}`); }

  // 5. The daily summary — after the close only. Sent from the 16:15 ET run so
  //    it reports a settled day, and skipped in the morning pass where "today"
  //    has barely started.
  if (SUMMARY) {
    try { await sendDailySummary({ db, uid, client, account, dd, notify, log, positions: null }); }
    catch (e) { log(`daily summary failed: ${e.message}`); }
  }

  return { refreshed: rec.refreshed, expired: rec.expired, closed: ex.closed, realized, unavailable, halted: !!dd?.halted };
}

async function recordRun(db, { startedAt, users, totals, errors, error }) {
  try {
    const finishedAt = Date.now();
    await db.collection('cronRuns').add({
      job: 'maintenance',
      dryRun: DRY_RUN,
      startedAt: admin.firestore.Timestamp.fromMillis(startedAt),
      finishedAt: admin.firestore.Timestamp.fromMillis(finishedAt),
      durationMs: finishedAt - startedAt,
      ok: !error,
      trigger: process.env.GITHUB_EVENT_NAME || 'timer',
      users: users ?? 0,
      ...totals,
      errors: errors ?? 0,
      error: error ? String(error) : null,
      logs: RUN_LOG.slice(-90),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) { console.warn('[maint] recordRun failed', e.message); }
}

async function main() {
  const db = initFirestore({ log: (m) => console.log(`[maint] ${m}`) });
  installReadMeter(db);
  const startedAt = Date.now();
  console.log(`[maint] start dryRun=${DRY_RUN}${ONLY_UID ? ` onlyUid=${ONLY_UID}` : ''} ET=${marketClock().date} ${Math.floor(marketClock().minutes / 60)}:${String(marketClock().minutes % 60).padStart(2, '0')}`);

  // NOTE: no global-pause check here, deliberately. `paused` stops new ENTRIES.
  // Reconciling, exiting and booking outcomes on positions you already hold must
  // continue while paused — pausing is not the same as abandoning open risk.
  const configs = await loadEnabledConfigs(db);
  console.log(`[maint] ${configs.length} account(s) with automation enabled`);

  const totals = { refreshed: 0, expired: 0, closed: 0, realized: 0, unavailable: 0 };
  let errors = 0;
  for (const { uid, cfg } of configs) {
    try {
      const r = await processUser(db, uid, cfg);
      if (r) for (const k of Object.keys(totals)) totals[k] += r[k] || 0;
    } catch (e) {
      errors++;
      console.error(`[maint][${uid.slice(0, 6)}] fatal: ${e.message}`);
    }
  }
  console.log(`[maint] complete — ${totals.refreshed} reconciled, ${totals.expired} expired, ${totals.closed} exits, `
    + `${totals.realized} realized${totals.unavailable ? `, ${totals.unavailable} unrecoverable` : ''}, ${errors} error(s)`);
  console.log(`[maint] ${readSummary()}`);
  await recordRun(db, { startedAt, users: configs.length, totals, errors });
}

// A run that aborts here has skipped reconciliation, exits, realization and the
// drawdown ratchet. Dying with only a log line makes that indistinguishable from
// a quiet, healthy day — which is how the most dangerous failure in this system
// stays invisible. Alert through the env-configured Telegram credentials, which
// need no Firestore and so survive the failure that is most likely to cause this.
main().catch(async (e) => {
  console.error('[maint] fatal', e);
  try {
    await alertOperator(isQuotaError(e)
      ? quotaAlertText('The 09:45/16:15 ET maintenance run')
      : `🔴 <b>Maintenance run failed</b>\n<i>${String(e.message || e).slice(0, 300)}</i>\n\n`
        + 'Exits, reconciliation and the drawdown ratchet did not run this pass. '
        + 'Open positions still have their broker stops.');
  } catch { /* alerting must never mask the original failure */ }
  process.exit(1);
});
