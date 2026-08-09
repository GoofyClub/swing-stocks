// =============================================================================
// Journal-vs-broker integrity analysis. PURE — no I/O, so every rule is unit
// tested (tests/integrity.mjs) rather than only exercised against a live account.
//
// Checking that services are up proves very little. What matters is whether the
// broker and the order journal AGREE, because that is where silent damage lives:
// each finding below corresponds to a way the system can look healthy while a
// position is unprotected or a safety mechanism has quietly stopped working.
//
// Severity is deliberate, not decorative:
//   'error' — something is unprotected or a safety mechanism is off RIGHT NOW
//   'warn'  — degraded, or normal-but-transient; worth reading, not alarming
// =============================================================================

const DAY_MS = 86400_000;
const toDate = (v) => (v?.toDate ? v.toDate() : v ? new Date(v) : null);
const ageDays = (v, now) => { const d = toDate(v); return d ? (now - d.getTime()) / DAY_MS : null; };

// Statuses that mean "we believe a position is open at the broker".
const OPEN_STATUSES = ['filled', 'exit_submitted'];
const CLOSED_STATUSES = ['position_closed', 'exit_submitted'];

export function analyzeJournal({
  docs = [],
  positions = [],
  now = Date.now(),
  dryRun = false,
  cooldownDays = 3,
  stuckSubmittedDays = 1.5,
  unrealizedDays = 1,
} = {}) {
  const findings = [];
  const add = (severity, code, message, detail = null, symbols = []) =>
    findings.push({ severity, code, message, detail, symbols });

  const tracked = new Set(docs.filter(o => OPEN_STATUSES.includes(o.status)).map(o => o.ticker));
  const held = new Set(positions.map(p => p.symbol));

  // ---- untracked positions -------------------------------------------------
  // The exit pass iterates the JOURNAL. A position with no journal doc is never
  // evaluated for a native / time / trailing exit, so it rides on its hard stop
  // alone, indefinitely. This is the most serious thing this function can find.
  const untracked = positions.filter(p => !tracked.has(p.symbol)).map(p => p.symbol);
  if (untracked.length) {
    // Say what the journal DOES believe about each one. "Untracked" has several
    // very different causes, and the next question is always the same:
    //   • no doc at all      → opened outside the system, or a journal write failed
    //   • doc says closed    → the system exited it and the broker did not, or it
    //                          was re-bought manually afterwards
    //   • doc says error/expired → the order was thought dead but actually filled
    // Each needs a different response, so guessing between them wastes a round.
    const detail = untracked.map(sym => {
      const related = docs.filter(o => o.ticker === sym);
      if (!related.length) return `${sym}: no journal doc at all`;
      const states = related
        .map(o => `${o.status}${o.realizedWinLoss ? `/${o.realizedWinLoss}` : ''}`)
        .join(', ');
      return `${sym}: journal says ${states}`;
    }).join('; ');
    add('error', 'untracked_position',
      `${untracked.length} broker position(s) are not in the journal`,
      `${detail}. These have NO managed exit — only their hard stop.`,
      untracked);
  }

  // ---- ghost fills ---------------------------------------------------------
  // Normal for a few minutes after an exit; persistent means the maintenance
  // pass is not running to mark them closed.
  const ghosts = docs.filter(o => o.status === 'filled' && !held.has(o.ticker)).map(o => o.ticker);
  if (ghosts.length) {
    add('warn', 'ghost_fill',
      `${ghosts.length} journal doc(s) say 'filled' but the broker holds nothing`,
      'Expected briefly after an exit. Persistent means the maintenance pass is not reconciling.',
      ghosts);
  }

  // ---- stuck submitted -----------------------------------------------------
  // 'submitted' is meant to be transient. While it persists the doc is invisible
  // to exit management, which only looks at filled/exit_submitted.
  const stuck = docs.filter(o => {
    if (o.status !== 'submitted') return false;
    const age = ageDays(o.createdAt, now);
    return age != null && age > stuckSubmittedDays;
  }).map(o => o.ticker);
  if (stuck.length) {
    add('error', 'stuck_submitted',
      `${stuck.length} order(s) stuck at 'submitted' for over ${stuckSubmittedDays}d`,
      'Reconciliation is not running. These are invisible to exit management, and any that filled are unmanaged.',
      stuck);
  }

  // ---- closed but never realized ------------------------------------------
  // The re-entry cooldown reads realizedWinLoss. Without it, a name that just
  // stopped out is eligible to be re-bought immediately.
  const unrealized = docs.filter(o => {
    if (!CLOSED_STATUSES.includes(o.status)) return false;
    if (o.realizedWinLoss || o.realizeUnavailable) return false;
    const age = ageDays(o.positionClosedAt ?? o.exitRequestedAt ?? o.createdAt, now);
    return age != null && age > unrealizedDays;
  }).map(o => o.ticker);
  if (unrealized.length) {
    add('warn', 'unrealized_close',
      `${unrealized.length} closed trade(s) have no realized outcome after ${unrealizedDays}d`,
      `The ${cooldownDays}d re-entry cooldown reads realizedWinLoss, so these names are not cooling off.`,
      unrealized);
  }

  // ---- dry-run holding real risk ------------------------------------------
  if (dryRun && positions.length) {
    add('warn', 'dryrun_with_positions',
      `DRY_RUN=true while holding ${positions.length} position(s)`,
      'Exits are simulated, so these ride on their hard stop only. There is no separate switch for exits.',
      positions.map(p => p.symbol));
  }

  // ---- duplicate open docs per symbol -------------------------------------
  // Alpaca positions are per-symbol, so two open journal docs for one ticker
  // means an exit on either liquidates the whole position — and the sizing math
  // assumed otherwise.
  const openCount = new Map();
  for (const o of docs) {
    if (!OPEN_STATUSES.includes(o.status)) continue;
    openCount.set(o.ticker, (openCount.get(o.ticker) || 0) + 1);
  }
  const dupes = [...openCount.entries()].filter(([, n]) => n > 1).map(([t]) => t);
  if (dupes.length) {
    add('warn', 'duplicate_open',
      `${dupes.length} symbol(s) have more than one open journal doc`,
      'Broker positions are per-symbol: exiting one doc liquidates the whole holding, which the position sizing did not assume.',
      dupes);
  }

  // ---- summary stats -------------------------------------------------------
  const realized = docs.filter(o => o.realizedWinLoss);
  const wins = realized.filter(o => o.realizedWinLoss === 'win').length;
  const stats = {
    total: docs.length,
    positions: positions.length,
    tracked: [...tracked].filter(t => held.has(t)).length,
    realized: realized.length,
    wins,
    winRate: realized.length ? wins / realized.length : null,
    netPnl: realized.reduce((s, o) => s + (Number(o.realizedPnl) || 0), 0),
    writtenOff: docs.filter(o => o.realizeUnavailable).length,
  };

  return {
    findings,
    stats,
    ok: !findings.some(f => f.severity === 'error'),
  };
}

// Is the persisted drawdown peak still being updated? It is a RATCHET, not a
// recomputation — if snapshots stop, it freezes, and a frozen peak makes the
// measured drawdown look SMALLER than reality. The halt then stops firing, in
// the unsafe direction and without any visible symptom.
export function analyzeEquityFreshness({ lastSnapshotDate = null, now = Date.now(), staleDays = 4 } = {}) {
  if (!lastSnapshotDate) {
    return { severity: 'warn', code: 'no_equity_snapshot', ageDays: null,
      message: 'No equity snapshot has ever been written — the drawdown peak does not exist yet.' };
  }
  const age = (now - Date.parse(`${lastSnapshotDate}T00:00:00Z`)) / DAY_MS;
  if (age > staleDays) {
    return { severity: 'error', code: 'stale_equity_snapshot', ageDays: age,
      message: `Equity snapshot is ${age.toFixed(0)}d old — the drawdown peak is frozen, so the halt is effectively disabled.` };
  }
  return { severity: 'ok', code: 'equity_current', ageDays: age, message: null };
}
