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

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
