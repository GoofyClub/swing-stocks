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
// When the order itself is GONE (404), there is still a second source: the
// account's FILL activities. Fills are not tied to the order ids in this
// journal, so they survive whatever removed the order — and they are what the
// Performance tab already reconstructs round trips from. So a 404 falls back to
// matching this trade against the fill history rather than giving up; only when
// that also finds nothing is the doc marked `realizeUnavailable` and skipped
// from then on, so a doomed request isn't re-issued on every single run.
//
// Long-only, matching the exit model.
// =============================================================================

import { buildRoundTrips } from '../../src/perf/roundTrips.js';

// Bumped whenever recovery gets BETTER. A doc written off by an older version is
// re-examined once by a newer one, so improving the fallback automatically
// rescues everything the previous logic gave up on — without a manual backfill,
// and without re-fetching orders that are still genuinely unrecoverable.
//   1: order fetch only
//   2: + fill-history reconstruction
const REALIZE_RECOVERY_VERSION = 2;

// Recover a closed trade's exit price from the account's FILL history, for when
// the order object is gone. Uses the same FIFO matcher the Performance tab uses,
// so the number here and the number there cannot disagree.
//
// Matching is deliberately conservative. A symbol can have several round trips,
// and attributing the wrong one would write a confidently wrong P&L — worse
// than writing none. So a candidate must match on BOTH:
//   • entry price within 0.5% of the fill we recorded, and
//   • an entry time at or after the entry session
// and if more than one still qualifies, the closest entry price wins. With no
// recorded entry price to check against, we decline rather than guess.
//
// Activities are fetched per-order rather than cached: this path runs only for
// orders whose fetch already 404'd, which is a handful once and then never
// again (the outcome is journaled, so they are not re-examined).
async function exitFromFills({ client, order, log }) {
  const entry = order.filledAvgPrice ?? order.entry;
  if (!(entry > 0) || !order.ticker) return null;
  if (!client.getActivities) return null;

  // Window: from a week before the entry session to now. A swing trade closes
  // well inside that, and a narrower window risks missing the opening fill,
  // which would make the matcher treat the close as an unrelated short.
  const from = order.sessionDate
    ? new Date(new Date(`${order.sessionDate}T00:00:00Z`).getTime() - 7 * 86400_000)
    : new Date(Date.now() - 400 * 86400_000);

  let fills;
  try {
    fills = await client.getActivities({ after: from.toISOString() });
  } catch (e) {
    log(`realize ${order.ticker}: fill-history lookup failed ${e.message}`);
    return null;
  }

  // buildRoundTrips returns { trades, open, skipped } — only CLOSED round trips
  // carry an exit price, so `open` is deliberately ignored here.
  const { trades } = buildRoundTrips(fills);
  const trips = (trades || [])
    .filter(t => t.symbol === String(order.ticker).toUpperCase() && t.side === 'long');
  if (!trips.length) return null;

  const sessionMs = order.sessionDate ? Date.parse(`${order.sessionDate}T00:00:00Z`) : null;
  const candidates = trips.filter(t => {
    const priceClose = Math.abs(t.entryPrice - entry) / entry <= 0.005;
    const afterEntry = sessionMs == null || (t.entryTime && t.entryTime.getTime() >= sessionMs - 86400_000);
    return priceClose && afterEntry;
  });
  if (!candidates.length) return null;

  candidates.sort((a, b) => Math.abs(a.entryPrice - entry) - Math.abs(b.entryPrice - entry));
  return candidates[0];
}

export async function realizeOutcomes({ db, admin, uid, client, log }) {
  let realized = 0, unavailable = 0;
  const snap = await db.collection('users').doc(uid).collection('autoOrders')
    .where('status', 'in', ['position_closed', 'exit_submitted']).get();

  for (const d of snap.docs) {
    const o = d.data();
    if (o.realizedWinLoss) continue;                     // already realized
    // Written off by THIS version of the recovery logic — genuinely nothing
    // more to try. An older stamp falls through and gets one more attempt.
    if (o.realizeUnavailable && (o.realizeUnavailableVersion ?? 1) >= REALIZE_RECOVERY_VERSION) continue;
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
      } catch (e) {
        // A 404 is PERMANENT — the order will not come back, so retrying it on
        // every run forever is pure waste. But it does NOT mean the trade is
        // unknowable: FILL activities are independent of order ids and outlive
        // whatever removed the order (a paper-account reset, an id written
        // under a different account, Alpaca's own order retention). Fall back
        // to reconstructing the round trip from fills — the same source the
        // Performance tab uses — before writing anything off.
        if (e.status !== 404) {
          log(`realize ${o.ticker}: fetch failed ${e.message}`); // transient — retry next run
          continue;
        }
        const rt = await exitFromFills({ client, order: o, log });
        if (rt) {
          exit = rt.exitPrice;
          reason = 'fill_history';
          log(`realize ${o.ticker}: order gone, recovered exit ${exit} from fill history`);
        } else {
          await d.ref.update({
            realizeUnavailable: true,
            realizeUnavailableVersion: REALIZE_RECOVERY_VERSION,
            realizeUnavailableReason: 'order not found at broker and no matching fill history on this account',
            realizeUnavailableAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          unavailable++;
          continue;
        }
      }
    }
    // Not recoverable yet — leave it for the next run rather than inventing one.
    if (exit == null || !Number.isFinite(exit)) continue;

    const pct = ((exit - entry) / entry) * 100;
    const slPct = (o.sl != null && entry > o.sl) ? ((entry - o.sl) / entry) * 100 : null;
    await d.ref.update({
      // A doc rescued on retry must not keep the write-off flag.
      realizeUnavailable: false,
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
  if (unavailable) {
    log(`${unavailable} order(s) no longer exist at this broker account — marked unrecoverable, will not be retried. `
      + 'Order ids are per-account, so this is expected after switching Alpaca accounts.');
  }
  return { realized, unavailable };
}
