// =============================================================================
// ONE log file for the whole system.
//
// Before this, each piece wrote somewhere different: the same-day runner and the
// morning worker went to their own journald units, the bot to a third, and a
// manual run to the terminal only. Answering "what happened at 15:40?" meant
// three journalctl invocations and mentally interleaving them by timestamp.
//
// Every process now appends to the SAME file, tagged with which one wrote the
// line, so the sequence reads in order:
//
//   2026-08-09T19:38:02.114Z [sameday] scanned 64 candidate signal(s) in 214s
//   2026-08-09T19:38:07.902Z [sameday] PLACED buy 12 ARWR @ market (order abc)
//   2026-08-09T19:41:15.330Z [bot]     /status from 12345
//
// Appends are line-at-a-time with O_APPEND, which the kernel keeps atomic for
// writes below PIPE_BUF — so concurrent writers interleave by LINE, never
// mid-line. Rotation is size-based and done in-process (no logrotate to install):
// at MAX_BYTES the file is renamed to .1 and a fresh one started.
//
// Logging must never take the trading system down: every failure here is
// swallowed. A missing log line is an inconvenience; an exception thrown from
// console.log during order placement is not.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Same resolution order as scripts/setup-vm.sh, so the dashboard, the units and
// a manual run all land on one file without anyone passing a path around.
export function resolveLogFile() {
  if (process.env.SWING_LOG_FILE) return process.env.SWING_LOG_FILE;
  const dir = process.env.SWING_LOG_DIR || path.join(REPO_ROOT, 'logs');
  return path.join(dir, 'swing.log');
}

const MAX_BYTES = Number(process.env.SWING_LOG_MAX_BYTES || 32 * 1024 * 1024);

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    // Single generation kept. Trading logs are for forensics over days, not
    // months — and an unbounded archive on a small VM disk is its own outage.
    fs.renameSync(file, `${file}.1`);
  } catch { /* no file yet, or a racing rotate already moved it */ }
}

// Attach file logging to console.{log,warn,error}. Returns a detach function.
// `tag` identifies the writer: sameday | auto | bot | deploy | refresh.
export function attachFileLog(tag) {
  const file = resolveLogFile();
  let fd = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fd = fs.openSync(file, 'a');
  } catch (e) {
    // Read-only disk, no permission, full volume — keep running on stdout only.
    console.error(`[logfile] cannot open ${file}: ${e.message} — console only`);
    return () => {};
  }

  const pad = tag.padEnd(7);
  const write = (level, parts) => {
    try {
      const text = parts.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
      const prefix = `${new Date().toISOString()} [${pad}]${level ? ` ${level}` : ''} `;
      // Split so a multi-line message stays greppable by timestamp+tag.
      const body = text.split('\n').map(l => prefix + l).join('\n');
      fs.writeSync(fd, body + '\n');
    } catch { /* never let logging break the caller */ }
  };

  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _err = console.error.bind(console);
  console.log = (...a) => { write('', a); _log(...a); };
  console.warn = (...a) => { write('WARN', a); _warn(...a); };
  console.error = (...a) => { write('ERROR', a); _err(...a); };

  return () => {
    console.log = _log; console.warn = _warn; console.error = _err;
    try { fs.closeSync(fd); } catch { /* already gone */ }
  };
}

// Read the last `n` lines without loading the whole file — the dashboard polls
// this every few seconds and the file can be tens of megabytes.
export function tailLog(n = 200, { file = resolveLogFile(), grep = null } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fs.fstatSync(fd).size;
    // Read backwards in chunks until we have enough newlines. When filtering we
    // need a much wider window, since most lines will be discarded.
    const want = grep ? Math.max(n * 40, 2000) : n;
    const CHUNK = 64 * 1024;
    let pos = size, lines = 0, buf = Buffer.alloc(0);
    while (pos > 0 && lines <= want && buf.length < 16 * 1024 * 1024) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const chunk = Buffer.alloc(len);
      fs.readSync(fd, chunk, 0, len, pos);
      buf = Buffer.concat([chunk, buf]);
      lines = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines++;
    }
    let out = buf.toString('utf8').split('\n');
    // The file always ends in a newline, so the split leaves a trailing empty
    // string — it would otherwise eat one slot of the requested line count.
    if (out.length && out[out.length - 1] === '') out.pop();
    if (grep) {
      const re = new RegExp(grep, 'i');
      out = out.filter(l => re.test(l));
    }
    // Drop a leading partial line only when we actually started mid-file.
    if (pos > 0 && out.length) out.shift();
    return out.slice(-n).join('\n');
  } catch {
    return '';
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
