// =============================================================================
// Trade notifications — entries, exits, fills, the daily summary.
//
// Replaces two divergent copies. maintenance.mjs looked for
// `telegramToken` / `telegramChatId`; same-day-trade.mjs looked for
// `telegramEnabled` / `telegramBotToken` / `telegramChatId`. Whichever shape
// the config document actually had, at most one runner could ever send — which
// is why entry and exit alerts were silently missing.
//
// Two sources, tried in order:
//   1. the per-user config in Firestore (either historical field shape)
//   2. TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHAT_IDS from swing.env
//
// The env fallback matters for more than convenience: it needs no Firestore
// read, so alerts keep working during exactly the failures most worth hearing
// about — a quota exhaustion, an outage, a permissions problem.
//
// Never throws. A notification that can fail a trading run is worse than a
// missed notification.
// =============================================================================

import { sendTelegram } from '../../src/data/telegram.js';

// Cached per user for the lifetime of a run: the runners send several messages
// per pass, and re-reading the config doc each time is a read per message.
const cache = new Map();

async function resolveTargets(db, uid, env) {
  if (cache.has(uid)) return cache.get(uid);

  const targets = [];
  try {
    const snap = await db.collection('users').doc(uid).collection('notifications').doc('config').get();
    const n = snap.exists ? snap.data() : null;
    // Accept both historical field shapes. `telegramEnabled` gates only when
    // explicitly false — an absent flag with a token present means "configured".
    const token = n?.telegramBotToken || n?.telegramToken;
    const chat = n?.telegramChatId;
    if (token && chat && n.telegramEnabled !== false) targets.push({ token, chat, via: 'firestore' });
  } catch {
    // Unreadable config is exactly when the env fallback earns its place.
  }

  if (!targets.length) {
    const token = env.TELEGRAM_BOT_TOKEN;
    const ids = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const chat of ids) targets.push({ token, chat, via: 'env' });
    if (!token) targets.length = 0;
  }

  cache.set(uid, targets);
  return targets;
}

export function makeNotifier({ db, uid, log = () => {}, env = process.env, enabled = true }) {
  return async function notify(text) {
    if (!enabled || !text) return false;
    let sent = false;
    try {
      const targets = await resolveTargets(db, uid, env);
      if (!targets.length) return false;
      for (const t of targets) {
        try { await sendTelegram(t.token, t.chat, text); sent = true; }
        catch (e) { log(`telegram send failed (${t.via}): ${e.message}`); }
      }
    } catch (e) { log(`notify failed: ${e.message}`); }
    return sent;
  };
}

export function resetNotifyCache() { cache.clear(); }
