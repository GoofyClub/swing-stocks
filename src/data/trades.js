// =============================================================================
// User-trade Firestore helpers: enter, remove, list, and enrich with the
// latest status/winLoss from the source shared signal so My Trades shows live
// outcomes without duplicating settlement logic on the client.
// =============================================================================

import {
  collection, doc, getDoc, setDoc, deleteDoc, getDocs,
  query, where, limit, serverTimestamp,
} from 'firebase/firestore';
import { initFirebase } from './firebase.js';

// Trade ID is deterministically derived from the signal ID. This prevents
// double-entering the same signal (Firestore set merges idempotently).
export function tradeIdFor(signal) {
  // Signal docs are written by the cron at /marketData/{date}/signals/{ticker_strategy_date}
  // and that ID is captured at .id when we read them. Use that directly.
  return signal.id;
}

// Adjusted TP/SL when the user overrides the entry price. We preserve the
// R-multiple (distance to TP and SL) of the original signal so the trade has
// the same risk/reward shape.
function shiftEnvelopeForOverride(signal, overrideEntry) {
  if (overrideEntry == null || !Number.isFinite(overrideEntry) || overrideEntry <= 0) {
    return { entry: signal.entryPrice, tp: signal.tpPrice, sl: signal.slPrice };
  }
  const delta = overrideEntry - signal.entryPrice;
  return {
    entry: overrideEntry,
    tp:    signal.tpPrice != null ? signal.tpPrice + delta : null,
    sl:    signal.slPrice != null ? signal.slPrice + delta : null,
  };
}

export async function enterTrade({ signal, notes, overrideEntryPrice }) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const auth = (await import('firebase/auth')).getAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');

  const tradeId = tradeIdFor(signal);
  const ref = doc(db, 'users', user.uid, 'enteredTrades', tradeId);

  const env = shiftEnvelopeForOverride(signal, overrideEntryPrice);

  await setDoc(ref, {
    signalId:     signal.id,
    signalDate:   (signal.signalTs || '').slice(0, 10),
    // Copy the descriptive fields so My Trades renders without a second read.
    ticker:       signal.ticker,
    name:         signal.name || null,
    sector:       signal.sector || null,
    market:       signal.market || null,
    strategy:     signal.strategy || null,
    strategyKey:  signal.strategyKey || null,
    side:         signal.side || 'buy',
    // The trade's own envelope (may differ from signal if user overrode entry).
    entryPrice:           env.entry,
    tpPrice:              env.tp,
    slPrice:              env.sl,
    overrideEntryPrice:   overrideEntryPrice != null ? overrideEntryPrice : null,
    // Free-text user note.
    notes:        (notes || '').slice(0, 500),
    enteredAt:    serverTimestamp(),
    status:       'open',
    winLoss:      null,
  }, { merge: false });

  return tradeId;
}

export async function removeTrade(tradeId) {
  const { db, ok } = initFirebase();
  if (!ok) throw new Error('Firebase not configured.');
  const auth = (await import('firebase/auth')).getAuth();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in required.');
  await deleteDoc(doc(db, 'users', user.uid, 'enteredTrades', tradeId));
}

// Returns a Set<string> of trade IDs already entered by the current user.
// Cheap O(N) read where N = number of entered trades. Caller can use it to
// mark the ★ as filled on Signal History rows.
export async function loadEnteredTradeIds() {
  const { db, ok } = initFirebase();
  if (!ok) return new Set();
  const auth = (await import('firebase/auth')).getAuth();
  const user = auth.currentUser;
  if (!user) return new Set();
  try {
    const snap = await getDocs(collection(db, 'users', user.uid, 'enteredTrades'));
    return new Set(snap.docs.map(d => d.id));
  } catch (e) {
    console.warn('[trades] loadEnteredTradeIds failed', e.message);
    return new Set();
  }
}

// Full read of entered trades, enriched with the latest currentPrice/status/winLoss
// from the source shared signal. If the trade has an `overrideEntryPrice`, we
// recompute the P/L against the override so the displayed % matches the user's
// actual fill. Settlement (WIN/LOSS) is mirrored from the source signal because
// the cron is the authoritative settler; we never re-derive that on the client.
export async function loadMyTrades() {
  const { db, ok } = initFirebase();
  if (!ok) return [];
  const auth = (await import('firebase/auth')).getAuth();
  const user = auth.currentUser;
  if (!user) return [];

  const tradesSnap = await getDocs(collection(db, 'users', user.uid, 'enteredTrades'));
  if (tradesSnap.empty) return [];

  const trades = tradesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Concurrent signal lookups — small fan-out, capped by `limit` chunks of 8.
  const enriched = await Promise.all(trades.map(async (t) => {
    if (!t.signalDate || !t.signalId) return t;
    try {
      const sigRef = doc(db, 'marketData', t.signalDate, 'signals', t.signalId);
      const sigSnap = await getDoc(sigRef);
      if (!sigSnap.exists()) return t;
      const sig = sigSnap.data();
      const cur = sig.currentPrice ?? null;
      // Unrealized % uses the user's effective entry (override or signal entry).
      const eff = t.entryPrice;
      const unrealized = (cur != null && eff) ? ((cur - eff) / eff) * 100 : null;
      // If the source signal has been settled, mirror its verdict — but compute
      // realizedPct against the user's override entry and own TP/SL because the
      // signal's hitPrice corresponds to *its* TP/SL, not the shifted ones.
      let realizedPct = null, status = 'open', winLoss = null;
      if (sig.status === 'closed') {
        status = 'closed';
        winLoss = sig.winLoss;
        // If no override, the trade's TP/SL are the signal's — use hitPrice directly.
        if (t.overrideEntryPrice == null) {
          realizedPct = sig.hitPrice != null ? ((sig.hitPrice - eff) / eff) * 100 : null;
        } else {
          // With override, settle against the trade's own TP/SL: WIN means the
          // shifted TP is hit, LOSS the shifted SL. Approximate using current
          // price band — exact settlement would need bars; for v0.2 we report
          // the signal's winLoss but recompute % vs the user's TP/SL.
          realizedPct = winLoss === 'win'
            ? (t.tpPrice != null ? ((t.tpPrice - eff) / eff) * 100 : null)
            : (t.slPrice != null ? ((t.slPrice - eff) / eff) * 100 : null);
        }
      }
      return { ...t, currentPrice: cur, unrealizedPct: unrealized, realizedPct, status, winLoss };
    } catch (e) {
      console.warn('[trades] enrich failed for', t.id, e.message);
      return t;
    }
  }));

  // Newest entered first.
  enriched.sort((a, b) => {
    const at = a.enteredAt?.toMillis ? a.enteredAt.toMillis() : 0;
    const bt = b.enteredAt?.toMillis ? b.enteredAt.toMillis() : 0;
    return bt - at;
  });

  return enriched;
}
