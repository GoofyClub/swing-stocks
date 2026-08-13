// =============================================================================
// Trade notifications and the daily summary.
//
// The bug these pin: the two runners read DIFFERENT field names out of the same
// config document (`telegramToken` vs `telegramBotToken`), so at most one could
// ever send. Entry and exit alerts were silently absent for weeks and nothing
// reported it, because a notification that doesn't arrive looks exactly like a
// day with nothing to say.
//
// Run with:  node tests/notify.mjs
// =============================================================================

import { makeNotifier, resetNotifyCache } from '../scripts/lib/notify.mjs';
import { formatDailySummary } from '../scripts/lib/format-summary.mjs';
import { TG_LIMIT } from '../scripts/lib/tg.mjs';
import { installReadMeter, readCount, readSummary, resetReadMeter } from '../scripts/lib/firestore-meter.mjs';

let pass = 0, fail = 0;
function t(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else      { fail++; console.error('  ✗', name); }
}

// A Firestore stand-in returning one notifications/config doc.
const dbWith = (data, { throws = false } = {}) => ({
  collection: () => ({
    doc: () => ({
      collection: () => ({
        doc: () => ({
          get: async () => {
            if (throws) throw new Error('RESOURCE_EXHAUSTED');
            return { exists: data != null, data: () => data };
          },
        }),
      }),
    }),
  }),
});

// Capture sends by stubbing global fetch, which sendTelegram uses.
function captureSends(fn) {
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), body: JSON.parse(opts?.body || '{}') });
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' };
  };
  return fn(sent).finally(() => { globalThis.fetch = orig; });
}

console.log('\n--- both historical field shapes must work ---');
{
  // This is the actual defect. Whichever shape the doc had, one runner was mute.
  await captureSends(async (sent) => {
    resetNotifyCache();
    const n = makeNotifier({ db: dbWith({ telegramToken: 'T1', telegramChatId: '99' }), uid: 'u1', env: {} });
    t('maintenance-era field names send', await n('hello') === true);
    t('to the right chat', sent[0]?.body?.chat_id === '99');
  });
  await captureSends(async (sent) => {
    resetNotifyCache();
    const n = makeNotifier({ db: dbWith({ telegramEnabled: true, telegramBotToken: 'T2', telegramChatId: '77' }), uid: 'u2', env: {} });
    t('same-day-era field names send', await n('hello') === true);
    t('to the right chat', sent[0]?.body?.chat_id === '77');
  });
}

console.log('\n--- the env fallback ---');
{
  // Matters beyond convenience: it needs no Firestore read, so alerts survive
  // exactly the failures most worth hearing about.
  await captureSends(async (sent) => {
    resetNotifyCache();
    const n = makeNotifier({
      db: dbWith(null), uid: 'u3',
      env: { TELEGRAM_BOT_TOKEN: 'ENV', TELEGRAM_ALLOWED_CHAT_IDS: '11,22' },
    });
    t('no Firestore config falls back to env', await n('hi') === true);
    t('reaches every allowed chat', sent.length === 2);
  });
  await captureSends(async () => {
    resetNotifyCache();
    const n = makeNotifier({
      db: dbWith(null, { throws: true }), uid: 'u4',
      env: { TELEGRAM_BOT_TOKEN: 'ENV', TELEGRAM_ALLOWED_CHAT_IDS: '11' },
    });
    t('an unreadable config still sends via env', await n('hi') === true);
  });
  await captureSends(async () => {
    resetNotifyCache();
    const n = makeNotifier({ db: dbWith(null), uid: 'u5', env: {} });
    t('no target anywhere returns false rather than throwing', await n('hi') === false);
  });
}

console.log('\n--- notifications must never break a trading run ---');
{
  resetNotifyCache();
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  const n = makeNotifier({ db: dbWith({ telegramToken: 'T', telegramChatId: '1' }), uid: 'u6', env: {} });
  let threw = false;
  try { await n('x'); } catch { threw = true; }
  globalThis.fetch = orig;
  t('a send failure does not throw', threw === false);
}
{
  // telegramEnabled:false is an explicit opt-out and must be honoured.
  await captureSends(async (sent) => {
    resetNotifyCache();
    const n = makeNotifier({
      db: dbWith({ telegramEnabled: false, telegramBotToken: 'T', telegramChatId: '1' }),
      uid: 'u7', env: {},
    });
    await n('x');
    t('an explicit opt-out is respected', sent.length === 0);
  });
}

console.log('\n--- the daily summary ---');
{
  const base = {
    label: 'Swing', date: '2026-08-12', equity: 5081, dayPl: -9.2, dayPlPct: -0.18,
  };
  const full = formatDailySummary({
    ...base,
    opened: [{ ticker: 'AAPL', qty: 12, entry: 210.5 }],
    closed: [
      { ticker: 'PSX', realizedPct: 2.88, realizedR: 1.35, realizedPnl: 58.2, realizedWinLoss: 'win', realizedExitReason: 'target' },
      { ticker: 'O', realizedPct: -1.86, realizedR: -1, realizedPnl: -31.4, realizedWinLoss: 'loss', realizedExitReason: 'stop' },
    ],
    held: [{ symbol: 'PM', qty: 8, unrealizedPl: 14.3 }],
  });
  t('names the day', full.includes('2026-08-12'));
  t('leads with equity and the day move', full.includes('5081.00') && full.includes('-0.18%'));
  t('lists what closed', full.includes('PSX') && full.includes('1.35R'));
  t('shows the exit reason', full.includes('target') && full.includes('stop'));
  t('nets the closed trades', full.includes('26.80'));
  t('counts the record', full.includes('1W / 1L'));
  t('lists what opened', full.includes('AAPL'));
  t('lists what is held overnight', full.includes('PM'));

  // The important case: a day where nothing happened must NOT look like a day
  // where nothing RAN. That ambiguity is what hid three dead sessions.
  const quiet = formatDailySummary({ ...base, scanned: 64, skipped: 64 });
  t('an empty day says why nothing opened', /64 candidates scanned, 64 filtered out/.test(quiet));
  t('and says it is flat', /Held overnight<\/b> — flat/.test(quiet));

  const halted = formatDailySummary({ ...base, halted: true, drawdownPct: 18.4 });
  t('a drawdown halt is stated prominently', /DRAWDOWN HALT ACTIVE/.test(halted));
  t('with the number', halted.includes('18.4%'));

  const withProblem = formatDailySummary({ ...base, problems: ['Firestore quota exhausted'] });
  t('problems appear before the trade detail',
    withProblem.indexOf('quota exhausted') < withProblem.indexOf('Opened'));

  t('dry-run is labelled', formatDailySummary({ ...base, dryRun: true }).includes('DRY RUN'));

  // Telegram safety, same contract as every other formatter.
  const many = formatDailySummary({
    ...base,
    closed: Array.from({ length: 300 }, (_, n) => ({
      ticker: `TICKER${n}`, realizedPct: 1, realizedR: 1, realizedPnl: 1, realizedWinLoss: 'win', realizedExitReason: 'target',
    })),
  });
  t('a huge day stays within the Telegram limit', many.length <= TG_LIMIT);
  const tags = (many.match(/<b>/g) || []).length - (many.match(/<\/b>/g) || []).length;
  t('tags stay balanced after truncation', tags === 0);
  t('a hostile ticker cannot inject markup',
    !/<script>/.test(formatDailySummary({ ...base, held: [{ symbol: '<script>x</script>', qty: 1, unrealizedPl: 0 }] })));
}

console.log('\n--- the read meter ---');
{
  // Operating on the free tier means operating near a hard limit that silently
  // stops trading. The counter is what makes that budgetable rather than a
  // surprise, so it must count the way BILLING does: one read per document, and
  // one for a query that matches nothing.
  class Q { constructor(n) { this.n = n; } limit() { return this; } where() { return this; }
    async get() { return { size: this.n, docs: new Array(this.n) }; } }
  class D { async get() { return { exists: true }; } }
  const q = new Q(7), empty = new Q(0), d = new D();
  const db = { collection: () => ({ limit: () => q, doc: () => d, where: () => q }) };

  resetReadMeter();
  installReadMeter(db);
  await db.collection('x').limit(1).get();
  t('counts one read per document returned', readCount() === 7);
  await db.collection('x').doc('y').get();
  t('counts a document fetch as one', readCount() === 8);
  await empty.get();
  t('an empty query still bills one', readCount() === 9);

  t('the summary names the ceiling', /50,000\/day/.test(readSummary()));
  t('and the share used', /%/.test(readSummary()));

  resetReadMeter();
  t('reset clears it', readCount() === 0);

  // Counting must never be able to break a run.
  class Broken { async get() { return null; } }
  const bad = new Broken();
  const db2 = { collection: () => ({ limit: () => bad, doc: () => bad, where: () => bad }) };
  installReadMeter(db2);
  let threw = false;
  try { await bad.get(); } catch { threw = true; }
  t('a malformed result does not throw', threw === false);

  // A result must pass through untouched — the meter observes, never alters.
  const passthrough = await q.get();
  t('the query result is returned unchanged', passthrough.size === 7);
}

console.log(`\n=============================================`);
console.log(`PASS ${pass} · FAIL ${fail}`);
console.log(`=============================================`);
if (fail) process.exit(1);
