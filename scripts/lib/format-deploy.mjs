// =============================================================================
// Render deploy.sh output as a Telegram MESSAGE.
//
// deploy.sh writes for a terminal: ANSI colours, "1. Timing" headings, aligned
// ✓/!/✗ marks. Pasted into a chat that arrives as a grey monospace block with
// escape codes in it, on a phone, right after you changed what trades next —
// the moment you most want to know at a glance whether it worked.
//
// So the output is parsed back into structure and re-rendered: a verdict line
// first, then what actually happened. The parser is deliberately forgiving —
// anything it does not recognise is passed through as a plain line, so a change
// to deploy.sh degrades the formatting rather than losing information.
// =============================================================================

import { esc, b, i, stripAnsi, fit } from './tg.mjs';

const MARK = { '✓': '✓', '!': '⚠️', '✗': '❌' };

// deploy.sh's own section headings, mapped to what they mean for a reader who
// is not looking at the script.
const SECTION_NOTE = {
  Timing: 'execution-window guard',
  Source: 'fast-forward pull',
  Dependencies: 'npm ci',
  Verification: 'syntax + full test suite',
  Services: 'restarts',
};

export function parseDeployOutput(raw) {
  const sections = [];
  let current = null;
  for (const line of stripAnsi(String(raw ?? '')).split('\n')) {
    if (!line.trim()) continue;

    const head = line.match(/^(?:\d+\.\s+)?([A-Z][A-Za-z ]+)$/);
    if (head && !line.startsWith(' ')) {
      current = { title: head[1].trim(), items: [] };
      sections.push(current);
      continue;
    }

    const item = line.match(/^\s+([✓!✗])\s+(.*)$/);
    if (item) {
      if (!current) { current = { title: '', items: [] }; sections.push(current); }
      current.items.push({ level: MARK[item[1]] ? item[1] : '✓', message: item[2].trim() });
      continue;
    }

    // Anything unrecognised is still kept, in an untitled section if need be.
    // deploy.sh will change; dropping output it no longer recognises would lose
    // the record of a deploy, which is worse than formatting it plainly.
    if (!current) { current = { title: '', items: [] }; sections.push(current); }
    current.items.push({ level: null, message: line.trim() });
  }
  return sections;
}

export function formatDeployMessage(raw, { label = 'Swing', ok = true, check = false } = {}) {
  const sections = parseDeployOutput(raw);
  const all = sections.flatMap(s => s.items);
  const failed = all.filter(x => x.level === '✗');
  const warned = all.filter(x => x.level === '!');

  // What actually changed — the one fact worth putting in the first two lines.
  const deployed = all.find(x => /^deployed [0-9a-f]{6,}/.test(x.message));
  const upToDate = all.some(x => /already up to date/i.test(x.message));
  const head = all.find(x => /^HEAD /.test(x.message));
  const tests = all.find(x => /test suite passed/i.test(x.message));

  const out = [];
  if (!ok || failed.length) {
    out.push(`❌ ${b(label)} deploy failed — the previous code is still running`);
  } else if (check) {
    out.push(`🔎 ${b(label)} deploy check — nothing was changed`);
  } else if (upToDate && !deployed) {
    out.push(`✅ ${b(label)} already up to date — nothing restarted`);
  } else {
    out.push(`🚀 ${b(label)} deployed`);
  }

  if (head) out.push(i(head.message));
  if (deployed) out.push(`• ${esc(deployed.message)}`);
  if (tests) out.push(`• ${esc(tests.message)}`);

  // Failures in full and up front: on a deploy they are the entire message.
  if (failed.length) {
    out.push('');
    for (const f of failed) out.push(`❌ ${esc(f.message)}`);
  }
  if (warned.length) {
    out.push('');
    for (const w of warned) out.push(`⚠️ ${esc(w.message)}`);
  }

  // Then the step-by-step, so it is clear what ran and what was skipped.
  for (const sec of sections) {
    if (!sec.items.length) continue;
    if (/^summary$/i.test(sec.title)) continue;      // already said above
    const note = SECTION_NOTE[sec.title];
    out.push('');
    out.push(`${b(sec.title)}${note ? ` ${i(`— ${note}`)}` : ''}`);
    for (const it of sec.items) {
      if (it.level === null) out.push(`     ${i(it.message)}`);
      else out.push(`  ${MARK[it.level]} ${esc(it.message)}`);
    }
  }

  if (!sections.length) out.push(i('(no output)'));
  return fit(out.join('\n'));
}
