// =============================================================================
// Render a validation result as a Telegram MESSAGE.
//
// Shows EVERY check, grouped by section, the way a report should read — you
// want to see what was verified, not just what broke. An all-green report that
// lists nothing is indistinguishable from a check that did not run.
//
// Problems are restated at the top when there are any, so the answer is the
// first thing read on a phone; the per-section detail follows.
//
// Telegram caps a message at ~4096 characters and accepts only a small HTML
// subset (b, i, code, pre, a) — anything else is rejected outright, so output is
// escaped, limited to those tags, and degraded progressively rather than cut:
// first the passing lines are compressed, and only then is the text truncated,
// always at a line boundary so markup can never be severed mid-tag.
// =============================================================================

import { esc, fit } from './tg.mjs';

const LIMIT = 3900;   // headroom under Telegram's 4096

const MARK = { ok: '✓', warn: '⚠️', bad: '❌' };

// A subject icon per section, so the eye can jump to the area it cares about
// without reading the words. Matched by prefix — the per-account sections are
// titled "Account NPRKnT…", which no fixed key would cover.
const SECTION_ICON = [
  [/^Environment/, '⚙️'],
  [/^Services/, '⏱'],
  [/^Firestore/, '🗄'],
  [/^Account\b/, '👤'],
  [/^Accounts/, '💼'],
  [/^Market data/, '📈'],
  [/^Logging/, '📄'],
  [/^Code/, '🧩'],
];
const iconFor = (title) => (SECTION_ICON.find(([re]) => re.test(title)) || [, '•'])[1];

// A section's own verdict, so the heading itself carries the status rather than
// making you scan its lines for a red mark.
const statusDot = (items) => items.some(i => i.level === 'bad') ? '🔴'
  : items.some(i => i.level === 'warn') ? '🟡' : '🟢';

// Facts worth repeating in the footer even when everything is green. Matched by
// shape, since the report's wording changes more often than its subjects do.
const FOOTER_PATTERNS = [
  /^paper ·|^🔴 LIVE ·/,
  /realized trade\(s\)/,
  /equity snapshot current/,
];

function renderSections(result, { compressOk = false } = {}) {
  const out = [];
  for (const sec of result.sections) {
    if (!sec.items.length) continue;
    const problems = sec.items.filter(i => ['bad', 'warn'].includes(i.level));

    // In compressed mode a wholly-healthy section collapses to a count. This is
    // the first thing sacrificed when the message is too long, because "5 checks
    // passed" loses far less than dropping a failure would.
    const heading = `${statusDot(sec.items)} ${iconFor(sec.title)} <b>${esc(sec.title)}</b>`;

    if (compressOk && !problems.length) {
      const n = sec.items.filter(i => i.level === 'ok').length;
      if (n) out.push(`\n${heading}\n  ✓ ${n} check${n > 1 ? 's' : ''} passed`);
      continue;
    }

    out.push(`\n${heading}`);
    for (const it of sec.items) {
      if (it.level === 'info') out.push(`     <i>${esc(it.message)}</i>`);
      else out.push(`  ${MARK[it.level] || '·'} ${esc(it.message)}`);
    }
  }
  return out;
}

export function formatValidationMessage(result) {
  if (!result || !Array.isArray(result.sections)) return '❌ Validation produced no result.';

  const { fails = 0, warns = 0, etDate, etTime, quick } = result;

  const header = [];
  header.push(fails
    ? `🔴 <b>${fails} problem${fails > 1 ? 's' : ''}</b>${warns ? ` · ${warns} warning${warns > 1 ? 's' : ''}` : ''}`
    : warns
      ? `🟡 <b>Healthy</b> · ${warns} warning${warns > 1 ? 's' : ''}`
      : '🟢 <b>All checks passed</b>');
  header.push(`<i>${esc(etDate || '')} ${esc(etTime || '')} ET${quick ? ' · quick' : ''}</i>`);

  // Problems restated up front. Worth the duplication: on a phone the section
  // detail can be several screens down, and a failure you have to scroll to
  // find is a failure you can miss.
  if (fails) {
    header.push('');
    for (const sec of result.sections) {
      for (let i = 0; i < sec.items.length; i++) {
        if (sec.items[i].level !== 'bad') continue;
        header.push(`❌ <b>${esc(sec.title)}</b> — ${esc(sec.items[i].message)}`);
        for (let j = i + 1; j < sec.items.length && sec.items[j].level === 'info'; j++) {
          header.push(`     <i>${esc(sec.items[j].message)}</i>`);
        }
      }
    }
  }

  const footer = [];
  const allOk = result.sections.flatMap(s => s.items).filter(i => i.level === 'ok').map(i => i.message);
  const facts = FOOTER_PATTERNS.map(re => allOk.find(m => re.test(m))).filter(Boolean);
  if (facts.length) {
    footer.push('');
    for (const f of facts) footer.push(`• ${esc(f)}`);
  }

  // The footer repeats facts that the full sections already show, so it only
  // earns its place once those sections have been compressed away.
  const build = (opts) => [
    ...header,
    ...renderSections(result, opts),
    ...(opts.compressOk ? footer : []),
  ].join('\n');

  let text = build({});
  if (text.length > LIMIT) text = build({ compressOk: true });
  return fit(text, { limit: LIMIT, note: '…truncated. Run npm run validate on the VM for the full report.' });
}
