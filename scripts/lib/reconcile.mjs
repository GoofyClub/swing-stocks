// =============================================================================
// Order reconciliation — refresh the status of submitted-but-not-terminal orders
// against the broker, and kill entries that have gone stale.
//
// Two jobs:
//
//   1. STATUS REFRESH. The journal records what we submitted; only the broker
//      knows what happened. Without this pass an order sits at 'submitted'
//      forever, so the exit pass never sees it (it looks at 'filled') and the
//      realized-outcome pass never books it.
//
//   2. STALE-ENTRY SWEEP. Entry orders are GTC so their protective legs survive
//      overnight — but that also means an unfilled entry limit from an earlier
//      session can fill days later, at a price the signal no longer justifies.
//      Strict one-session freshness: an entry from a session that is no longer
//      current, with ZERO fills, is cancelled. A partial fill is left alone —
//      we are in the position, and cancelling would strand it unprotected.
//
// `currentSession` is the session bucket entries are allowed to be from. Pass
// null to skip the sweep entirely (a maintenance run that only wants statuses
// refreshed should not be deciding what counts as stale).
// =============================================================================

const TERMINAL = ['filled', 'canceled', 'expired', 'rejected', 'done_for_day'];

export async function reconcileOrders({ db, admin, uid, client, log, currentSession = null, notify = null }) {
  let refreshed = 0, expired = 0, filled = 0;
  const open = await db.collection('users').doc(uid).collection('autoOrders')
    .where('status', '==', 'submitted').get();

  for (const d of open.docs) {
    const data = d.data();
    if (!data.brokerOrderId) continue;
    try {
      const o = await client.getOrder(data.brokerOrderId);
      if (!o?.status) continue;
      const filledQty = Number(o.filled_qty || 0);
      const terminal = TERMINAL.includes(o.status);

      if (!terminal && filledQty === 0 && currentSession && data.sessionDate && data.sessionDate !== currentSession) {
        try {
          await client.cancelOrder(data.brokerOrderId);
          await d.ref.update({ status: 'expired', expiredAt: admin.firestore.FieldValue.serverTimestamp() });
          expired++;
          log(`EXPIRED stale unfilled entry ${data.ticker} (session ${data.sessionDate}, current ${currentSession})`);
        } catch (e) { log(`cancel stale ${data.ticker} failed: ${e.message}`); }
        continue;
      }

      if (o.status !== 'new') {
        await d.ref.update({
          status: o.status,
          filledQty,
          filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null,
          reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        refreshed++;
        if (o.status === 'filled') {
          filled++;
          if (notify) await notify(`🔵 <b>FILLED</b> ${data.ticker} ${data.qty} @ ${o.filled_avg_price || data.entry}`);
        }
      }
    } catch (e) { log(`reconcile ${data.ticker} failed: ${e.message}`); }
  }
  return { refreshed, expired, filled };
}
