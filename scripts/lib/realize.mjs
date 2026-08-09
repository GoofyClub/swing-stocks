// =============================================================================
// Realized-outcome journaling — shared by every runner.
//
// For each CLOSED order that has no realized outcome yet, recover the actual
// exit price and write realized %, R, $ P&L and win/loss onto its journal doc.
// This is what makes the Auto Orders page show real broker results rather than
// the settled-signal proxy, and it is what the re-entry cooldown reads to decide
// which names are cooling off (`realizedWinLoss === 'loss'` + `realizedAt`).
//
// Exit price, in order of trust:
//   1. exitModelPrice — the exit pass already closed it (native/time/trail)
//   2. the filled sell leg of the retained parent order (target or stop)
//
// Alpaca keeps the parent order around after the position is gone, so this
// backfills historical trades too. An order whose exit can't be recovered (a
// manual close outside the journal, say) is left alone and retried next run
// rather than being written with a guessed price.
//
// Long-only, matching the exit model.
// =============================================================================

export async function realizeOutcomes({ db, admin, uid, client, log }) {
  let realized = 0;
  const snap = await db.collection('users').doc(uid).collection('autoOrders')
    .where('status', 'in', ['position_closed', 'exit_submitted']).get();

  for (const d of snap.docs) {
    const o = d.data();
    if (o.realizedWinLoss) continue;                     // already realized
    if ((o.side || 'buy') !== 'buy') continue;           // long-only
    const entry = o.filledAvgPrice ?? o.entry;
    const qty = o.filledQty || o.qty;
    if (entry == null || !qty) continue;

    let exit = null, reason = o.exitReason || null;
    if (o.exitModelPrice != null) {
      exit = Number(o.exitModelPrice);
    } else if (o.brokerOrderId) {
      try {
        const parent = await client.getOrder(o.brokerOrderId, { nested: true });
        const leg = (parent?.legs || []).find(l =>
          (l.side === 'sell') && l.status === 'filled' && l.filled_avg_price != null);
        if (leg) {
          exit = Number(leg.filled_avg_price);
          reason = /stop/i.test(leg.type || '') ? 'stop' : 'target';
        }
      } catch (e) { log(`realize ${o.ticker}: fetch failed ${e.message}`); continue; }
    }
    // Not recoverable yet — leave it for the next run rather than inventing one.
    if (exit == null || !Number.isFinite(exit)) continue;

    const pct = ((exit - entry) / entry) * 100;
    const slPct = (o.sl != null && entry > o.sl) ? ((entry - o.sl) / entry) * 100 : null;
    await d.ref.update({
      realizedExit: exit,
      realizedPct: pct,
      realizedR: slPct ? pct / slPct : null,
      realizedPnl: qty * (exit - entry),
      realizedWinLoss: pct >= 0 ? 'win' : 'loss',
      realizedExitReason: reason,
      realizedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    realized++;
    log(`REALIZED ${o.ticker}: ${pct >= 0 ? 'win' : 'loss'} ${pct.toFixed(2)}%${slPct ? ` ${(pct / slPct).toFixed(2)}R` : ''} exit ${exit} (${reason || 'exit'})`);
  }
  return { realized };
}
