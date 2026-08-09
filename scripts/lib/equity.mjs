// =============================================================================
// Equity snapshot + drawdown state.
//
// Two things depend on this running every session:
//
//   • the equity curve on the Automation page reads /users/{uid}/autoEquity/{date}
//   • the drawdown halt compares today's equity against a persisted high-water
//     mark in /users/{uid}/automation/state
//
// The peak is a RATCHET stored in Firestore, not something recomputed from a
// window — if the snapshot stops being written, the peak freezes at whatever it
// last saw. A frozen peak makes the drawdown look smaller than it is, so the
// halt that is supposed to stop the bleeding silently stops firing. That is why
// this moved out of the GitHub worker: it must run wherever the trading runs.
// =============================================================================

import { drawdownHalted } from '../../src/auto/engine.js';

const dayKey = (now = new Date()) => now.toISOString().slice(0, 10);

export async function snapshotEquity({ db, admin, uid, equity, cfg, now = new Date() }) {
  const stateRef = db.collection('users').doc(uid).collection('automation').doc('state');
  const prevPeak = (await stateRef.get().then(s => (s.exists ? s.data().peakEquity : 0)).catch(() => 0)) || 0;
  const dd = drawdownHalted({ equity, peakEquity: prevPeak, maxDrawdownHaltPct: cfg.maxDrawdownHaltPct });

  await stateRef.set({
    peakEquity: dd.peak,
    lastEquity: equity,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await db.collection('users').doc(uid).collection('autoEquity').doc(dayKey(now)).set({
    date: dayKey(now),
    equity,
    peak: dd.peak,
    drawdownPct: dd.drawdownPct,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });

  return dd;
}
