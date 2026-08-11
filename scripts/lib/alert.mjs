// =============================================================================
// Operator alert of last resort.
//
// The per-user notify() path reads the Telegram token out of Firestore — which
// is useless for the failures that matter most, because the thing that just
// broke is often Firestore itself. A run that dies on RESOURCE_EXHAUSTED cannot
// then read a token to tell you it died.
//
// So this reads TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_CHAT_IDS straight from the
// environment (swing.env) and needs nothing else to work. It is for the small
// set of events where silence is the real danger:
//
//   • a runner aborting before it managed exits or reconciled fills
//   • Firestore quota exhaustion, which skips those silently and leaves the
//     drawdown ratchet frozen
//
// Never throws. An alert that can fail the run it is reporting on is worse than
// no alert.
// =============================================================================

import { sendTelegram } from '../../src/data/telegram.js';

export async function alertOperator(text, { env = process.env } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const ids = String(env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!token || !ids.length) return false;
  let sent = false;
  for (const id of ids) {
    try { await sendTelegram(token, id, text); sent = true; }
    catch (e) { console.error(`[alert] send to ${id} failed: ${e.message}`); }
  }
  return sent;
}

// Firestore's daily free-tier quota is exhausted — distinct from a transient
// error, because it does NOT clear on retry: the allowance resets at midnight
// Pacific. Retrying within the same day just burns the run.
export function isQuotaError(e) {
  return e?.code === 8 || /RESOURCE_EXHAUSTED|Quota exceeded/i.test(String(e?.message || ''));
}

// What a quota kill actually costs, stated plainly. The failure is dangerous
// precisely because it looks like a boring infrastructure hiccup.
export function quotaAlertText(job) {
  return [
    '🔴 <b>Firestore quota exhausted</b>',
    `<i>${job} aborted</i>`,
    '',
    'This run did NOT:',
    '  • reconcile the day\'s fills',
    '  • apply managed exits (native / time stop / trailing)',
    '  • book realized outcomes',
    '  • update the drawdown peak',
    '',
    'Open positions are still protected by their broker stops, but the model '
      + 'exits did not run. The drawdown peak is now stale, which makes measured '
      + 'drawdown look smaller than it is.',
    '',
    'The daily allowance resets at midnight Pacific. To stop this recurring, '
      + 'move the Firebase project to the Blaze plan — at this volume it is cents '
      + 'per day and removes the whole failure class.',
  ].join('\n');
}
