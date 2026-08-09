// =============================================================================
// Render a validation result as a Telegram MESSAGE rather than a pasted
// terminal dump.
//
// The terminal report is built for a wide monospace window: aligned marks,
// section numbers, indented detail. In a chat that arrives as a grey wall you
// have to scroll and squint at, on a phone, usually while something is wrong —
// the worst possible moment for a format that hides the answer among forty
// lines of ✓.
//
// So this inverts the emphasis: problems first and in full, everything healthy
// compressed to one line per section. If nothing is wrong the whole thing fits
// in a glance; if something is, it is the first thing you read.
//
// Telegram caps a message at ~4096 characters and only accepts a small HTML
// subset (b, i, code, pre, a) — anything else is rejected outright, so the
// output is escaped and kept to those tags.
// =============================================================================

const esc = (s) => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const LIMIT = 3900;   // headroom under Telegram's 4096

// Section name → a short label that reads as a status line rather than a header.
const SECTION_LABEL = {
  'Environment': 'Config',
  'Services and timers': 'Services',
  'Firestore': 'Firestore',
  'Accounts': 'Accounts',
  'Market data': 'Market data',
  'Logging and dashboard': 'Logging',
  'Code': 'Code',
};

export function formatValidationMessage(result) {
  if (!result || !Array.isArray(result.sections)) return '❌ Validation produced no result.';

  const { fails = 0, warns = 0, etDate, etTime, quick } = result;
  const out = [];

  // ---- verdict -------------------------------------------------------------
  const verdict = fails
    ? `🔴 <b>${fails} problem${fails > 1 ? 's' : ''}</b>${warns ? ` · ${warns} warning${warns > 1 ? 's' : ''}` : ''}`
    : warns
      ? `🟡 <b>Healthy</b> · ${warns} warning${warns > 1 ? 's' : ''}`
      : '🟢 <b>All checks passed</b>';
  out.push(verdict);
  out.push(`<i>${esc(etDate || '')} ${esc(etTime || '')} ET${quick ? ' · quick' : ''}</i>`);

  // ---- problems, in full ---------------------------------------------------
  // An `info` line immediately after a bad/warn is that finding's explanation,
  // so it travels with it. Dropping it would leave "XOM is not in the journal"
  // with the reason stripped off — the half that tells you what to do.
  const collect = (level) => {
    const rows = [];
    for (const sec of result.sections) {
      for (let i = 0; i < sec.items.length; i++) {
        const it = sec.items[i];
        if (it.level !== level) continue;
        const detail = [];
        for (let j = i + 1; j < sec.items.length && sec.items[j].level === 'info'; j++) {
          detail.push(sec.items[j].message);
        }
        rows.push({ section: sec.title, message: it.message, detail });
      }
    }
    return rows;
  };

  const problems = collect('bad');
  if (problems.length) {
    out.push('');
    out.push('<b>Problems</b>');
    for (const p of problems) {
      out.push(`❌ <b>${esc(SECTION_LABEL[p.section] || p.section)}</b> — ${esc(p.message)}`);
      for (const d of p.detail) out.push(`     <i>${esc(d)}</i>`);
    }
  }

  const warnings = collect('warn');
  if (warnings.length) {
    out.push('');
    out.push('<b>Warnings</b>');
    for (const w of warnings) {
      out.push(`⚠️ ${esc(w.message)}`);
      for (const d of w.detail) out.push(`     <i>${esc(d)}</i>`);
    }
  }

  // ---- everything healthy, one line per section ----------------------------
  const healthy = result.sections
    .filter(sec => sec.items.some(i => i.level === 'ok') && !sec.items.some(i => ['bad', 'warn'].includes(i.level)))
    .map(sec => SECTION_LABEL[sec.title] || sec.title);
  if (healthy.length) {
    out.push('');
    out.push(`✅ <b>OK:</b> ${esc(healthy.join(' · '))}`);
  }

  // ---- the few facts worth surfacing even when green -----------------------
  // Pulled by shape rather than by position: the report's wording changes more
  // often than what these lines are about.
  const allItems = result.sections.flatMap(s => s.items.map(i => i.message));
  const pick = (re) => allItems.find(m => re.test(m));
  const facts = [
    pick(/^paper ·|^🔴 LIVE ·|equity \$/),
    pick(/realized trade\(s\)/),
    pick(/equity snapshot current/),
    pick(/swing-sameday\.timer armed/),
  ].filter(Boolean);
  if (facts.length) {
    out.push('');
    for (const f of facts) out.push(`• ${esc(f)}`);
  }

  let text = out.join('\n');
  if (text.length > LIMIT) {
    // Truncate at a line boundary — a message cut mid-tag is rejected by
    // Telegram entirely, which would turn a long report into no report.
    text = text.slice(0, LIMIT);
    text = text.slice(0, text.lastIndexOf('\n')) + '\n<i>…truncated. Run npm run validate on the VM for the full report.</i>';
  }
  return text;
}
