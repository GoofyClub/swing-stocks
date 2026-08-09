// =============================================================================
// Telegram message primitives, shared by every formatter.
//
// Telegram accepts a small HTML subset (b, i, u, s, a, code, pre) and REJECTS
// THE WHOLE MESSAGE on anything else or on unbalanced tags — so a stray '<' in
// a log line does not garble the output, it deletes it. Everything user- or
// tool-derived goes through esc(). Length is capped at 4096 the same way.
//
// These live in one place because the failure modes are shared: every formatter
// that escapes by hand eventually forgets one, and every one that truncates by
// hand eventually cuts mid-tag.
// =============================================================================

export const TG_LIMIT = 4096;
const SAFE = 3900;   // headroom for a footer appended after formatting

export const esc = (s) => String(s ?? '')
  .replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Strip terminal colour codes. Tool output written for a terminal is full of
// them, and they render as literal garbage in a chat.
export const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');

export const b = (s) => `<b>${esc(s)}</b>`;
export const i = (s) => `<i>${esc(s)}</i>`;
export const code = (s) => `<code>${esc(s)}</code>`;

// Status marks, consistent across every command so they read the same way.
export const MARK = { ok: '✓', warn: '⚠️', bad: '❌', info: ' ', pending: '⏳' };

// A "label: value" line. Values are escaped; labels are trusted (ours).
export const kv = (label, value) => `${label}: ${esc(value)}`;

// Fit text to Telegram's limit, cutting at a LINE boundary. A message cut
// mid-tag is rejected outright, which turns a long report into no report — far
// worse than a short one.
export function fit(text, { limit = SAFE, note = '…truncated' } = {}) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const at = cut.lastIndexOf('\n');
  return (at > 0 ? cut.slice(0, at) : cut) + `\n${i(note)}`;
}

// Wrap tool output in <pre>, trimmed to fit and with colour codes removed.
// Keeps the END, because the useful part of a failing command's output — the
// error — is at the bottom.
export function pre(text, { limit = 3000 } = {}) {
  const clean = stripAnsi(String(text ?? '')).trim();
  if (!clean) return '';
  const body = clean.length > limit ? clean.slice(-limit) : clean;
  return `<pre>${esc(body)}</pre>`;
}
