// =============================================================================
// Exit management — shared by BOTH execution paths (scripts/auto-trade.mjs and
// scripts/same-day-trade.mjs).
//
// The broker's resting legs own the hard stop and, for target-managed
// strategies, the take-profit. This pass adds every exit those legs cannot
// express, by replaying the SAME settlement logic the app uses for W/L verdicts
// (settleSignal) over daily bars since the entry session:
//
//   • native     — RSI2's close > 5-SMA indicator exit
//   • time_stop  — per-strategy max hold
//   • trail      — the trailing stop for trend/breakout strategies
//
// This used to live only in auto-trade.mjs. It cannot: trend entries now ship
// WITHOUT a take_profit leg (see buildBracketOrder), so for those the only exits
// that exist are the hard stop and this pass. A position opened by the same-day
// runner on a box whose morning worker never fires would otherwise ride with no
// managed exit at all — so both runners call this, and running it twice a day is
// harmless (it is idempotent: `exit_submitted` short-circuits).
// =============================================================================

import { settleSignal, entryIndexFor } from '../../src/strategy/normalize.js';
import { modelExitAction } from '../../src/auto/engine.js';

const REASON_TEXT = {
  native: 'indicator exit (close > 5-SMA)',
  trail: 'trailing stop',
  time_stop: 'time stop',
};

export async function manageExits({ db, admin, uid, client, log, dryRun = false, notify = null }) {
  let closed = 0, checked = 0;
  try {
    const filled = await db.collection('users').doc(uid).collection('autoOrders')
      .where('status', 'in', ['filled', 'exit_submitted']).get();
    if (filled.empty) return { checked, closed };

    const livePositions = await client.getPositions();
    for (const d of filled.docs) {
      const data = d.data();
      if ((data.side || 'buy') !== 'buy') continue; // exit model is long-only
      const pos = livePositions.find(p => p.symbol === data.ticker && p.qty > 0);
      if (!pos) {
        // A protective leg, the exit liquidation, or a manual action flattened
        // it — record terminal state and stop re-checking.
        if (!dryRun) await d.ref.update({ status: 'position_closed', positionClosedAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }
      if (data.status === 'exit_submitted') continue; // liquidation working — wait
      if (!data.sessionDate || !data.sl) continue;    // pre-v0.25 docs lack the bucket
      checked++;
      try {
        // Bars from well before the session so indicator exits (5-SMA) have history.
        const startDate = new Date(new Date(data.sessionDate + 'T00:00:00Z').getTime() - 45 * 86400_000).toISOString().slice(0, 10);
        const bars = await client.getDailyBars(data.ticker, { start: startDate });
        const entryIdx = entryIndexFor(bars, null, data.sessionDate);
        const postBars = entryIdx >= 0 ? bars.slice(entryIdx + 1) : [];
        if (!postBars.length) continue;
        // tp:Infinity when the doc has none — that is the normal case for the
        // trailing strategies, and settleTrailing ignores tp entirely anyway.
        // For target strategies it disables only the TP rule, leaving the
        // native/time-stop checks intact.
        const verdict = settleSignal(
          { entry: data.filledAvgPrice || data.entry, tp: data.tp ?? Infinity, sl: data.sl, pendingEntry: false, strategyKey: data.strategyKey },
          postBars, { bars, entryIdx },
        );
        if (!modelExitAction(verdict)) continue; // still open, or tp/sl (broker's job)
        if (dryRun) {
          log(`DRYRUN would EXIT ${data.ticker} (${verdict.exitReason}, model ${verdict.winLoss} @ ${verdict.hitPrice})`);
          continue;
        }
        // NOTE: Alpaca positions are per-symbol — if two strategies hold the same
        // ticker this liquidates both; acceptable given the per-sector/position caps.
        await client.closePosition(data.ticker, { cancelOrders: true });
        await d.ref.update({
          status: 'exit_submitted', exitReason: verdict.exitReason,
          exitModelWinLoss: verdict.winLoss, exitModelPrice: verdict.hitPrice ?? null,
          exitRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        closed++;
        log(`EXIT ${data.ticker}: ${verdict.exitReason} (model ${verdict.winLoss} @ ${verdict.hitPrice}) — position closed, resting legs cancelled`);
        if (notify) {
          await notify(`🔴 <b>EXIT</b> ${data.ticker} × ${pos.qty} — ${REASON_TEXT[verdict.exitReason] || verdict.exitReason} · model ${verdict.winLoss?.toUpperCase()} @ ~${verdict.hitPrice}`);
        }
      } catch (e) {
        log(`exit-check ${data.ticker} failed: ${e.message}`); // stays 'filled' → retried next run
      }
    }
  } catch (e) {
    log(`exit pass failed: ${e.message}`);
  }
  return { checked, closed };
}
