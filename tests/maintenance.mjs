// =============================================================================
// Post-trade pipeline self-test: reconciliation, realized-outcome journaling,
// and the equity/drawdown ratchet.
//
// These three ran in GitHub Actions until the loop moved onto the VM. They are
// the least visible parts of the system and the most costly to get wrong — a
// mis-booked realized outcome feeds the re-entry cooldown, and a broken equity
// ratchet silently disables the drawdown halt. So they get pinned here against
// fake Firestore and broker doubles, with no network.
//
// Run with:  node tests/maintenance.mjs
// =============================================================================

import { reconcileOrders } from '../scripts/lib/reconcile.mjs';
import { realizeOutcomes } from '../scripts/lib/realize.mjs';
import { snapshotEquity } from '../scripts/lib/equity.mjs';
import { loadEnvFile } from '../scripts/lib/load-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

// ---- doubles ----------------------------------------------------------------
const admin = { firestore: { FieldValue: { serverTimestamp: () => '@ts' } } };
const logs = [];
const log = (m) => logs.push(m);

// A Firestore stand-in that records writes. `docs` is the collection contents;
// `where()` filters are applied in memory the way Firestore would.
function fakeDb(collections = {}) {
  const writes = [];
  const makeDocRef = (path, data) => ({
    ref: {
      update: async (patch) => { writes.push({ path, op: 'update', patch }); Object.assign(data, patch); },
      set: async (patch, opts) => { writes.push({ path, op: 'set', patch, opts }); Object.assign(data, patch); },
    },
    data: () => data,
    exists: data != null,
    id: path,
  });
  const collection = (name) => ({
    doc: (id) => ({
      collection: (sub) => collection(`${name}/${id}/${sub}`),
      get: async () => makeDocRef(`${name}/${id}`, collections[`${name}/${id}`] ?? null),
      set: async (patch, opts) => { writes.push({ path: `${name}/${id}`, op: 'set', patch, opts }); },
      ref: { update: async (patch) => writes.push({ path: `${name}/${id}`, op: 'update', patch }) },
    }),
    where: (field, op, val) => ({
      get: async () => {
        const rows = collections[name] || [];
        const keep = rows.filter(r => (op === 'in' ? val.includes(r[field]) : r[field] === val));
        return { empty: !keep.length, docs: keep.map((r, i) => makeDocRef(`${name}[${i}]`, r)) };
      },
    }),
  });
  return { collection, writes };
}

const patchFor = (db, re) => db.writes.filter(w => re.test(w.path)).map(w => w.patch);

console.log('\n--- reconcileOrders: status refresh ---');
{
  const rows = [{ ticker: 'AAA', qty: 5, brokerOrderId: 'o1', status: 'submitted', sessionDate: '2026-08-07', entry: 100 }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = {
    getOrder: async () => ({ status: 'filled', filled_qty: '5', filled_avg_price: '101.25' }),
    cancelOrder: async () => { throw new Error('should not cancel a filled order'); },
  };
  const notified = [];
  const r = await reconcileOrders({ db, admin, uid: 'u1', client, log, currentSession: '2026-08-07', notify: async (t) => notified.push(t) });
  const p = patchFor(db, /autoOrders/)[0];
  t('refreshes to the broker status', p.status === 'filled');
  t('records filled qty as a number', p.filledQty === 5);
  t('records the average fill price', p.filledAvgPrice === 101.25);
  t('counts the refresh', r.refreshed === 1 && r.filled === 1);
  t('notifies on a fill', notified.length === 1 && /FILLED/.test(notified[0]));
}

console.log('\n--- reconcileOrders: stale-entry sweep ---');
{
  // Unfilled entry from a PRIOR session: a GTC order that could still fill days
  // later at a price the signal no longer justifies. Must be cancelled.
  const rows = [{ ticker: 'OLD', qty: 5, brokerOrderId: 'o2', status: 'submitted', sessionDate: '2026-08-01' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  let cancelled = null;
  const client = {
    getOrder: async () => ({ status: 'new', filled_qty: '0' }),
    cancelOrder: async (id) => { cancelled = id; },
  };
  const r = await reconcileOrders({ db, admin, uid: 'u1', client, log, currentSession: '2026-08-07' });
  t('cancels a stale unfilled entry', cancelled === 'o2');
  t('marks it expired', patchFor(db, /autoOrders/)[0].status === 'expired');
  t('counts the expiry', r.expired === 1);
}
{
  // PARTIALLY filled from a prior session: we are IN the position. Cancelling
  // the parent would strand it, so it must be left alone.
  const rows = [{ ticker: 'PART', qty: 5, brokerOrderId: 'o3', status: 'submitted', sessionDate: '2026-08-01' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  let cancelled = null;
  const client = {
    getOrder: async () => ({ status: 'partially_filled', filled_qty: '2', filled_avg_price: '50' }),
    cancelOrder: async (id) => { cancelled = id; },
  };
  await reconcileOrders({ db, admin, uid: 'u1', client, log, currentSession: '2026-08-07' });
  t('does NOT cancel a partially-filled stale entry', cancelled === null);
  t('still refreshes its status', patchFor(db, /autoOrders/)[0].status === 'partially_filled');
}
{
  // Same session — not stale, whatever its fill state.
  const rows = [{ ticker: 'TODAY', qty: 5, brokerOrderId: 'o4', status: 'submitted', sessionDate: '2026-08-07' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  let cancelled = null;
  const client = { getOrder: async () => ({ status: 'new', filled_qty: '0' }), cancelOrder: async (id) => { cancelled = id; } };
  await reconcileOrders({ db, admin, uid: 'u1', client, log, currentSession: '2026-08-07' });
  t("does not cancel the CURRENT session's unfilled entry", cancelled === null);
  t("writes nothing for a still-'new' order", patchFor(db, /autoOrders/).length === 0);
}
{
  // currentSession null (couldn't reach the calendar) must DISABLE the sweep,
  // never treat everything as stale and cancel the book.
  const rows = [{ ticker: 'X', qty: 5, brokerOrderId: 'o5', status: 'submitted', sessionDate: '2026-01-01' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  let cancelled = null;
  const client = { getOrder: async () => ({ status: 'new', filled_qty: '0' }), cancelOrder: async (id) => { cancelled = id; } };
  await reconcileOrders({ db, admin, uid: 'u1', client, log, currentSession: null });
  t('unknown current session disables the sweep (fails safe)', cancelled === null);
}
{
  // A broker error on one order must not abort the whole pass.
  const rows = [
    { ticker: 'BAD', qty: 1, brokerOrderId: 'e1', status: 'submitted', sessionDate: '2026-08-07' },
    { ticker: 'GOOD', qty: 1, brokerOrderId: 'g1', status: 'submitted', sessionDate: '2026-08-07' },
  ];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = {
    getOrder: async (id) => { if (id === 'e1') throw new Error('boom'); return { status: 'filled', filled_qty: '1', filled_avg_price: '10' }; },
    cancelOrder: async () => {},
  };
  const r = await reconcileOrders({ db, admin, uid: 'u1', client, log, currentSession: '2026-08-07' });
  t('one failing order does not abort the pass', r.refreshed === 1);
}

console.log('\n--- realizeOutcomes ---');
{
  // Model exit (native / time_stop / trail): the price is already journaled.
  const rows = [{
    ticker: 'WIN', side: 'buy', status: 'exit_submitted', qty: 10, filledQty: 10,
    filledAvgPrice: 100, sl: 95, exitModelPrice: 106, exitReason: 'native',
  }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client: {}, log });
  const p = patchFor(db, /autoOrders/)[0];
  t('books a win', p.realizedWinLoss === 'win');
  t('realized % is exit vs FILL price', Math.abs(p.realizedPct - 6) < 1e-9);
  // Risk was 100→95 = 5%; a +6% move is 1.2R.
  t('R is measured against the placed stop', Math.abs(p.realizedR - 1.2) < 1e-9);
  t('P&L is qty × (exit − entry)', p.realizedPnl === 60);
  t('keeps the model exit reason', p.realizedExitReason === 'native');
}
{
  // No model price: recover the filled sell leg from the retained parent.
  const rows = [{ ticker: 'STOPPED', side: 'buy', status: 'position_closed', qty: 10, filledQty: 10, filledAvgPrice: 100, sl: 95, brokerOrderId: 'p1' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = {
    getOrder: async () => ({ legs: [
      { side: 'sell', type: 'limit', status: 'canceled', filled_avg_price: null },
      { side: 'sell', type: 'stop', status: 'filled', filled_avg_price: '95' },
    ] }),
  };
  await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  const p = patchFor(db, /autoOrders/)[0];
  t('recovers the exit from the filled leg', p.realizedExit === 95);
  t('books a loss', p.realizedWinLoss === 'loss');
  t('labels a stop-leg exit as "stop"', p.realizedExitReason === 'stop');
  t('loss is exactly -1R at the stop', Math.abs(p.realizedR + 1) < 1e-9);
}
{
  // Idempotency + guards: already-realized, short, and unrecoverable rows are
  // all left untouched. Re-running must never double-book.
  const rows = [
    { ticker: 'DONE', side: 'buy', status: 'position_closed', qty: 1, filledAvgPrice: 10, realizedWinLoss: 'win' },
    { ticker: 'SHORT', side: 'sell', status: 'position_closed', qty: 1, filledAvgPrice: 10 },
    { ticker: 'NOEXIT', side: 'buy', status: 'position_closed', qty: 1, filledAvgPrice: 10, brokerOrderId: 'x' },
  ];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = { getOrder: async () => ({ legs: [] }) };  // exit not recoverable
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  t('writes nothing on a re-run', db.writes.length === 0);
  t('realized count is zero', r.realized === 0);
}
{
  // A trailing-strategy exit has NO take-profit leg. Realization must still
  // work from the model price — this is the common case now.
  const rows = [{ ticker: 'TREND', side: 'buy', status: 'exit_submitted', qty: 4, filledQty: 4, filledAvgPrice: 50, sl: 45, exitModelPrice: 68, exitReason: 'trail' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const p = (await realizeOutcomes({ db, admin, uid: 'u1', client: {}, log }), patchFor(db, /autoOrders/)[0]);
  t('trailing exit realizes without a TP leg', p.realizedWinLoss === 'win' && p.realizedPnl === 72);
  t('trailing exit reason is preserved', p.realizedExitReason === 'trail');
}

console.log('\n--- realizeOutcomes: a vanished order is permanent, not transient ---');
{
  // Order ids are PER-ACCOUNT. Point the automation config at a different
  // Alpaca account (second paper account, or paper -> live) and every id in the
  // journal becomes unresolvable. Retrying re-issues the same doomed request on
  // every run forever, which is what showed up as four "order not found" lines
  // on each maintenance pass.
  const rows = [{ ticker: 'GONE', side: 'buy', status: 'position_closed', qty: 2, filledAvgPrice: 10, sl: 9, brokerOrderId: 'dead' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  let calls = 0;
  const client = {
    getOrder: async () => { calls++; const e = new Error('order not found'); e.status = 404; throw e; },
  };
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  const p = patchFor(db, /autoOrders/)[0];
  t('a 404 with no fill history marks the doc unrecoverable', p.realizeUnavailable === true);
  t('the reason is recorded', /fill history/i.test(p.realizeUnavailableReason || ''));
  t('the recovery version is stamped', p.realizeUnavailableVersion >= 2);
  t('it is counted separately from realized', r.unavailable === 1 && r.realized === 0);
  t('no realized outcome is invented', p.realizedWinLoss === undefined);

  // The whole point: a second pass must not call the broker again.
  await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  t('a marked doc is never re-fetched', calls === 1);
}

console.log('\n--- realizeOutcomes: recovering a vanished order from fill history ---');
{
  // Fills are independent of order ids, so they survive whatever removed the
  // order. This is the same source the Performance tab reconstructs from —
  // which is exactly why a trade could show there while realization gave up.
  const fills = (sym, t1, p1, q1, t2, p2) => ([
    { symbol: sym, side: 'buy',  qty: String(q1), price: String(p1), transaction_time: t1 },
    { symbol: sym, side: 'sell', qty: String(q1), price: String(p2), transaction_time: t2 },
  ]);
  const rows = [{
    ticker: 'BNL', side: 'buy', status: 'position_closed', qty: 10, filledQty: 10,
    filledAvgPrice: 100, sl: 95, brokerOrderId: 'dead', sessionDate: '2026-08-03',
  }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = {
    getOrder: async () => { const e = new Error('order not found'); e.status = 404; throw e; },
    getActivities: async () => fills('BNL', '2026-08-03T19:45:00Z', 100, 10, '2026-08-06T14:00:00Z', 107),
  };
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  const p = patchFor(db, /autoOrders/)[0];
  t('recovers the exit from fills instead of giving up', p.realizedExit === 107);
  t('books it as a win', p.realizedWinLoss === 'win');
  t('P&L matches qty × (exit − entry)', p.realizedPnl === 70);
  t('labels the source', p.realizedExitReason === 'fill_history');
  t('counts as realized, not unavailable', r.realized === 1 && r.unavailable === 0);
  t('clears any write-off flag', p.realizeUnavailable === false);
}
{
  // A previous version wrote this off. The bumped recovery version must give it
  // ONE more attempt — otherwise improving the fallback rescues nothing already
  // marked, and a manual backfill would be needed every time it improves.
  const rows = [{
    ticker: 'CZR', side: 'buy', status: 'position_closed', qty: 4, filledQty: 4,
    filledAvgPrice: 50, sl: 47, brokerOrderId: 'dead', sessionDate: '2026-08-03',
    realizeUnavailable: true, realizeUnavailableVersion: 1,
  }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = {
    getOrder: async () => { const e = new Error('order not found'); e.status = 404; throw e; },
    getActivities: async () => ([
      { symbol: 'CZR', side: 'buy',  qty: '4', price: '50', transaction_time: '2026-08-03T19:45:00Z' },
      { symbol: 'CZR', side: 'sell', qty: '4', price: '48', transaction_time: '2026-08-05T14:00:00Z' },
    ]),
  };
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  t('an older write-off is retried by a newer recovery version', r.realized === 1);
  t('and books the real loss', patchFor(db, /autoOrders/)[0].realizedWinLoss === 'loss');
}
{
  // Mis-attribution is worse than no attribution: a confidently wrong P&L feeds
  // the cooldown and the Auto Orders page. A round trip whose entry price does
  // not match must NOT be claimed.
  const rows = [{
    ticker: 'DUK', side: 'buy', status: 'position_closed', qty: 5, filledQty: 5,
    filledAvgPrice: 100, sl: 95, brokerOrderId: 'dead', sessionDate: '2026-08-03',
  }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = {
    getOrder: async () => { const e = new Error('order not found'); e.status = 404; throw e; },
    // A real DUK round trip, but from a completely different entry price.
    getActivities: async () => ([
      { symbol: 'DUK', side: 'buy',  qty: '5', price: '70', transaction_time: '2026-08-03T19:45:00Z' },
      { symbol: 'DUK', side: 'sell', qty: '5', price: '75', transaction_time: '2026-08-05T14:00:00Z' },
    ]),
  };
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  t('a mismatched entry price is not claimed', r.realized === 0 && r.unavailable === 1);
}
{
  // Several round trips in the same name: the one matching our entry wins.
  const rows = [{
    ticker: 'WRB', side: 'buy', status: 'position_closed', qty: 2, filledQty: 2,
    filledAvgPrice: 60, sl: 57, brokerOrderId: 'dead', sessionDate: '2026-08-03',
  }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = {
    getOrder: async () => { const e = new Error('order not found'); e.status = 404; throw e; },
    getActivities: async () => ([
      { symbol: 'WRB', side: 'buy',  qty: '2', price: '40', transaction_time: '2026-08-03T15:00:00Z' },
      { symbol: 'WRB', side: 'sell', qty: '2', price: '44', transaction_time: '2026-08-03T18:00:00Z' },
      { symbol: 'WRB', side: 'buy',  qty: '2', price: '60', transaction_time: '2026-08-03T19:45:00Z' },
      { symbol: 'WRB', side: 'sell', qty: '2', price: '63', transaction_time: '2026-08-06T14:00:00Z' },
    ]),
  };
  await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  const p = patchFor(db, /autoOrders/)[0];
  t('picks the round trip matching our entry price', p.realizedExit === 63);
  t('not the unrelated earlier trade in the same name', p.realizedExit !== 44);
}
{
  // A client with no getActivities (older adapter, or a test double) must
  // degrade to the write-off rather than throwing.
  const rows = [{ ticker: 'OLD', side: 'buy', status: 'position_closed', qty: 1, filledAvgPrice: 10, sl: 9, brokerOrderId: 'dead' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  const client = { getOrder: async () => { const e = new Error('gone'); e.status = 404; throw e; } };
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  t('a client without getActivities degrades safely', r.unavailable === 1);
}
{
  // A TRANSIENT failure must still be retried — marking a 500 as permanent
  // would discard a recoverable outcome on one bad afternoon.
  const rows = [{ ticker: 'FLAKY', side: 'buy', status: 'position_closed', qty: 2, filledAvgPrice: 10, sl: 9, brokerOrderId: 'x' }];
  const db = fakeDb({ 'users/u1/autoOrders': rows });
  let calls = 0;
  const client = { getOrder: async () => { calls++; const e = new Error('server error'); e.status = 500; throw e; } };
  const r = await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  t('a 500 is NOT marked unrecoverable', r.unavailable === 0 && db.writes.length === 0);
  await realizeOutcomes({ db, admin, uid: 'u1', client, log });
  t('a transient failure is retried next run', calls === 2);
}

console.log('\n--- snapshotEquity: the drawdown ratchet ---');
{
  const db = fakeDb({ 'users/u1/automation/state': { peakEquity: 10000 } });
  const dd = await snapshotEquity({ db, admin, uid: 'u1', equity: 9000, cfg: { maxDrawdownHaltPct: 15 } });
  t('peak is carried forward, not reset to today', dd.peak === 10000);
  t('drawdown measured from the peak', Math.abs(dd.drawdownPct - 10) < 1e-9);
  t('10% drawdown does not halt at a 15% limit', dd.halted === false);
  const eq = db.writes.find(w => /autoEquity/.test(w.path));
  t('writes a dated equity snapshot', !!eq && eq.patch.equity === 9000);
  t('snapshot carries the peak', eq.patch.peak === 10000);
}
{
  const db = fakeDb({ 'users/u1/automation/state': { peakEquity: 10000 } });
  const dd = await snapshotEquity({ db, admin, uid: 'u1', equity: 8000, cfg: { maxDrawdownHaltPct: 15 } });
  t('20% drawdown halts at a 15% limit', dd.halted === true);
}
{
  // New high-water mark: the ratchet must move UP.
  const db = fakeDb({ 'users/u1/automation/state': { peakEquity: 10000 } });
  const dd = await snapshotEquity({ db, admin, uid: 'u1', equity: 12000, cfg: { maxDrawdownHaltPct: 15 } });
  t('a new high raises the peak', dd.peak === 12000);
  const state = db.writes.find(w => /automation\/state/.test(w.path));
  t('the raised peak is persisted', state.patch.peakEquity === 12000);
  t('state write merges (never clobbers the doc)', state.opts?.merge === true);
}
{
  // No prior state (a fresh account) must not divide by zero or halt instantly.
  const db = fakeDb({});
  const dd = await snapshotEquity({ db, admin, uid: 'u1', equity: 5000, cfg: { maxDrawdownHaltPct: 15 } });
  t('a fresh account seeds the peak from today', dd.peak === 5000);
  t('a fresh account is not halted', dd.halted === false);
  t('drawdown is a finite number', Number.isFinite(dd.drawdownPct));
}

console.log('\n--- loadEnvFile: manual runs must see the same config as systemd ---');
{
  // The bug this prevents: systemd applies EnvironmentFile=, an interactive
  // shell does not, so `npm run auto:maintenance` died on "FIREBASE_PROJECT_ID
  // must be set" while the identical systemd unit worked. Same file, same code,
  // opposite result — which reads as a broken config rather than a missing
  // `set -a && . swing.env`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swing-env-'));
  const file = path.join(dir, 'swing.env');
  fs.writeFileSync(file, [
    '# a comment',
    '',
    'FIREBASE_PROJECT_ID=proj-123',
    'export ALPACA_KEY="quoted-value"',
    "ALPACA_SECRET='single-quoted'",
    'DRY_RUN=false',
    'ALREADY_SET=from-file',
    'not a valid line',
    '=novalue',
    'EMPTY_VALUE=',
    'WITH_EQUALS=a=b=c',
  ].join('\n'));

  const env = { ALREADY_SET: 'from-shell' };
  const r = loadEnvFile({ file, env });

  t('reads the file it was given', r.file === file);
  t('plain KEY=VALUE loads', env.FIREBASE_PROJECT_ID === 'proj-123');
  t('strips the "export " prefix bash allows', env.ALPACA_KEY === 'quoted-value');
  t('strips double quotes', !/"/.test(env.ALPACA_KEY || ''));
  t('strips single quotes', env.ALPACA_SECRET === 'single-quoted');
  t('keeps "=" inside a value', env.WITH_EQUALS === 'a=b=c');
  t('comments and junk lines are ignored', env['not a valid line'] === undefined);
  t('a nameless key is ignored', env[''] === undefined);
  t('an empty value still loads as empty', env.EMPTY_VALUE === '');

  // PRECEDENCE is the whole contract: an existing value always wins, so
  // `DRY_RUN=true npm run ...` overrides the file and systemd (which has already
  // exported everything) is never fought with.
  t('an existing environment value is NOT overwritten', env.ALREADY_SET === 'from-shell');
  t('counts the skip', r.skipped === 1);
  t('counts what it loaded', r.loaded > 0);

  // Re-running re-applies only the keys whose value is empty. An empty variable
  // is deliberately treated as UNSET so a stray `export ALPACA_KEY=` in a shell
  // profile cannot shadow the real value in the config file — a blank key would
  // otherwise fail authentication with a message about credentials rather than
  // about the shell. Everything with a real value is left alone.
  const before = { ...env };
  const again = loadEnvFile({ file, env });
  t('a second load re-applies only empty-valued keys', again.loaded === 1);
  t('no real value is disturbed by re-loading',
    Object.entries(before).every(([k, v]) => v === '' || env[k] === v));
  t('an empty env value does not shadow the file', env.EMPTY_VALUE === '');

  // A missing file must be silent, not fatal: a box configured purely through
  // systemd or CI secrets has no swing.env at all and is perfectly valid.
  const none = loadEnvFile({ file: path.join(dir, 'nope.env'), env: {} });
  t('a missing file is not an error', none.loaded === 0 && none.file === null);

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
