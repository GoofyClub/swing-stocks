// =============================================================================
// Journal-vs-broker integrity rules.
//
// These decide whether `npm run validate` says "all clear". A false clear is
// worse than no check at all — it is an explicit assurance that an unprotected
// position does not exist. So each rule is pinned here, in both directions:
// it fires when it should, and stays quiet when it shouldn't.
//
// Run with:  node tests/integrity.mjs
// =============================================================================

import { analyzeJournal, analyzeEquityFreshness } from '../src/auto/integrity.js';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

const NOW = Date.parse('2026-08-09T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400_000);
const has = (r, code) => r.findings.some(f => f.code === code);
const find = (r, code) => r.findings.find(f => f.code === code);
const pos = (symbol, qty = 10) => ({ symbol, qty });

console.log('\n--- untracked positions (the serious one) ---');
{
  // The exit pass iterates the JOURNAL. A position it has no doc for is never
  // evaluated for a native / time / trailing exit — it rides on its hard stop
  // alone, indefinitely. This must be an error, never a warning.
  const r = analyzeJournal({
    docs: [{ ticker: 'AAA', status: 'filled' }],
    positions: [pos('AAA'), pos('ZZZ')],
    now: NOW,
  });
  t('flags a position with no journal doc', has(r, 'untracked_position'));
  t('names the symbol', find(r, 'untracked_position').symbols.includes('ZZZ'));
  t('is an error, not a warning', find(r, 'untracked_position').severity === 'error');
  t('marks the whole analysis not-ok', r.ok === false);
  t('does not flag the tracked one', !find(r, 'untracked_position').symbols.includes('AAA'));
}
{
  const r = analyzeJournal({
    docs: [{ ticker: 'AAA', status: 'filled' }, { ticker: 'BBB', status: 'exit_submitted' }],
    positions: [pos('AAA'), pos('BBB')],
    now: NOW,
  });
  t('exit_submitted counts as tracked', !has(r, 'untracked_position'));
  t('a fully consistent journal is ok', r.ok === true);
}
{
  // A doc that is closed does NOT make a live position tracked — that pairing
  // is exactly the dangerous case (journal thinks it's done, broker disagrees).
  const r = analyzeJournal({
    docs: [{ ticker: 'AAA', status: 'position_closed' }],
    positions: [pos('AAA')],
    now: NOW,
  });
  t('a closed doc does not cover a live position', has(r, 'untracked_position'));
}

console.log('\n--- untracked positions: the detail must name the cause ---');
{
  // "Untracked" has several causes needing different responses, so the finding
  // has to say which. Guessing between them is what wastes a debugging round.
  const noDoc = analyzeJournal({ docs: [], positions: [pos('XOM')], now: NOW });
  t('no doc at all is stated explicitly', /XOM: no journal doc at all/.test(find(noDoc, 'untracked_position').detail));

  const closedDoc = analyzeJournal({
    docs: [{ ticker: 'XOM', status: 'position_closed', realizedWinLoss: 'win' }],
    positions: [pos('XOM')], now: NOW,
  });
  t('a closed doc is reported with its status',
    /XOM: journal says position_closed\/win/.test(find(closedDoc, 'untracked_position').detail));

  const errDoc = analyzeJournal({
    docs: [{ ticker: 'XOM', status: 'error' }], positions: [pos('XOM')], now: NOW,
  });
  t("an 'error' doc is reported — the order was thought dead but filled",
    /XOM: journal says error/.test(find(errDoc, 'untracked_position').detail));

  t('the detail still states the consequence',
    /NO managed exit/.test(find(noDoc, 'untracked_position').detail));
}

console.log('\n--- ghost fills ---');
{
  const r = analyzeJournal({
    docs: [{ ticker: 'AAA', status: 'filled' }],
    positions: [],
    now: NOW,
  });
  t("flags 'filled' with no broker position", has(r, 'ghost_fill'));
  t('only a warning — normal right after an exit', find(r, 'ghost_fill').severity === 'warn');
  t('does not block the all-clear on its own', r.ok === true);
}

console.log('\n--- stuck submitted ---');
{
  const r = analyzeJournal({
    docs: [
      { ticker: 'OLD', status: 'submitted', createdAt: daysAgo(3) },
      { ticker: 'NEW', status: 'submitted', createdAt: daysAgo(0.2) },
    ],
    positions: [],
    now: NOW,
  });
  t('flags an order stuck at submitted', has(r, 'stuck_submitted'));
  t('is an error — reconciliation is not running', find(r, 'stuck_submitted').severity === 'error');
  t('only the OLD one', find(r, 'stuck_submitted').symbols.join() === 'OLD');
  t("a fresh 'submitted' is not flagged", !find(r, 'stuck_submitted').symbols.includes('NEW'));
}
{
  // No timestamp at all must not be treated as infinitely old — guessing would
  // produce a permanent false error on legacy docs.
  const r = analyzeJournal({ docs: [{ ticker: 'X', status: 'submitted' }], positions: [], now: NOW });
  t('a doc with no createdAt is not flagged', !has(r, 'stuck_submitted'));
}

console.log('\n--- closed but never realized ---');
{
  const r = analyzeJournal({
    docs: [
      { ticker: 'DONE', status: 'position_closed', positionClosedAt: daysAgo(5), realizedWinLoss: 'win' },
      { ticker: 'LOST', status: 'position_closed', positionClosedAt: daysAgo(5) },
      { ticker: 'FRESH', status: 'position_closed', positionClosedAt: daysAgo(0.1) },
      { ticker: 'GONE', status: 'position_closed', positionClosedAt: daysAgo(9), realizeUnavailable: true },
    ],
    positions: [],
    now: NOW,
  });
  const f = find(r, 'unrealized_close');
  t('flags a closed trade with no realized outcome', !!f);
  t('names only the unrealized one', f.symbols.join() === 'LOST');
  t('an already-realized trade is not flagged', !f.symbols.includes('DONE'));
  t('a just-closed trade is given time', !f.symbols.includes('FRESH'));
  t('one written off as unrecoverable is not re-flagged', !f.symbols.includes('GONE'));
  t('the detail explains the cooldown consequence', /cooldown/i.test(f.detail));
  t('counts the write-off in stats', r.stats.writtenOff === 1);
}

console.log('\n--- dry-run while holding real risk ---');
{
  const r = analyzeJournal({
    docs: [{ ticker: 'AAA', status: 'filled' }],
    positions: [pos('AAA')],
    dryRun: true, now: NOW,
  });
  t('warns that exits are simulated', has(r, 'dryrun_with_positions'));
  const r2 = analyzeJournal({ docs: [], positions: [], dryRun: true, now: NOW });
  t('silent when dry-run holds nothing', !has(r2, 'dryrun_with_positions'));
  const r3 = analyzeJournal({
    docs: [{ ticker: 'AAA', status: 'filled' }], positions: [pos('AAA')], dryRun: false, now: NOW,
  });
  t('silent when not in dry-run', !has(r3, 'dryrun_with_positions'));
}

console.log('\n--- duplicate open docs for one symbol ---');
{
  // Broker positions are per-symbol: exiting one doc liquidates the lot.
  const r = analyzeJournal({
    docs: [
      { ticker: 'AAA', status: 'filled' },
      { ticker: 'AAA', status: 'filled' },
      { ticker: 'BBB', status: 'filled' },
    ],
    positions: [pos('AAA'), pos('BBB')],
    now: NOW,
  });
  t('flags two open docs for one symbol', has(r, 'duplicate_open'));
  t('names the duplicated symbol only', find(r, 'duplicate_open').symbols.join() === 'AAA');
  const r2 = analyzeJournal({
    docs: [{ ticker: 'AAA', status: 'position_closed' }, { ticker: 'AAA', status: 'filled' }],
    positions: [pos('AAA')], now: NOW,
  });
  t('a closed doc plus an open one is not a duplicate', !has(r2, 'duplicate_open'));
}

console.log('\n--- stats ---');
{
  const r = analyzeJournal({
    docs: [
      { ticker: 'A', status: 'position_closed', realizedWinLoss: 'win', realizedPnl: 120 },
      { ticker: 'B', status: 'position_closed', realizedWinLoss: 'loss', realizedPnl: -50 },
      { ticker: 'C', status: 'position_closed', realizedWinLoss: 'win', realizedPnl: 30 },
      { ticker: 'D', status: 'filled' },
    ],
    positions: [pos('D')],
    now: NOW,
  });
  t('counts realized trades', r.stats.realized === 3);
  t('win rate is 2/3', Math.abs(r.stats.winRate - 2 / 3) < 1e-9);
  t('net P&L sums', r.stats.netPnl === 100);
  t('counts open positions', r.stats.positions === 1);
  t('no findings on a healthy journal', r.ok === true);
}
{
  // Empty everything must not divide by zero or claim a problem.
  const r = analyzeJournal({});
  t('empty input is ok', r.ok === true && r.findings.length === 0);
  t('win rate is null, not NaN', r.stats.winRate === null);
  t('net P&L is 0', r.stats.netPnl === 0);
}
{
  // A non-numeric realizedPnl must not poison the total with NaN.
  const r = analyzeJournal({
    docs: [
      { ticker: 'A', status: 'position_closed', realizedWinLoss: 'win', realizedPnl: 50 },
      { ticker: 'B', status: 'position_closed', realizedWinLoss: 'win', realizedPnl: 'oops' },
    ],
    positions: [], now: NOW,
  });
  t('a bad P&L value does not produce NaN', r.stats.netPnl === 50);
}

console.log('\n--- equity snapshot freshness (the silent one) ---');
{
  // The peak is a persisted ratchet. If snapshots stop it freezes, which makes
  // the measured drawdown look SMALLER than reality — the halt stops firing,
  // with no visible symptom. That has to be an error.
  const stale = analyzeEquityFreshness({ lastSnapshotDate: '2026-07-20', now: NOW });
  t('a 20d-old snapshot is an error', stale.severity === 'error');
  t('the message names the consequence', /halt/i.test(stale.message));

  const fresh = analyzeEquityFreshness({ lastSnapshotDate: '2026-08-08', now: NOW });
  t('yesterday is fine', fresh.severity === 'ok');

  // A long weekend must not read as a failure.
  const weekend = analyzeEquityFreshness({ lastSnapshotDate: '2026-08-06', now: NOW });
  t('a 3-day gap is tolerated', weekend.severity === 'ok');

  const never = analyzeEquityFreshness({ lastSnapshotDate: null, now: NOW });
  t('never-written is a warning, not an error', never.severity === 'warn');
  t('and says the peak does not exist', /peak/i.test(never.message));
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
