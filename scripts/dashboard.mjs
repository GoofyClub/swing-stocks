#!/usr/bin/env node
// =============================================================================
// dashboard.mjs — web view of the swing automation, modelled on the ORB one.
//
// Its main job is THE LOG: one page that shows the single shared log file
// (scripts/lib/logfile.mjs) live, without an SSH session. Around it sit the
// facts you want in the same glance — is the timer armed, what does the broker
// hold, what did today's run place, when did it last run.
//
//   http://<vm>:8444/           dashboard (auto-refreshes)
//   http://<vm>:8444/log        raw log text (curl-friendly)
//   http://<vm>:8444/healthz    liveness, no auth — for uptime checks
//
// ── PORT ────────────────────────────────────────────────────────────────────
// It CANNOT share the ORB dashboard's port: one listening socket belongs to one
// process, and a second bind gets EADDRINUSE. Default 8444 (ORB uses 8443).
// To serve both from one address, put a reverse proxy in front and route by
// path — the port is the thing that cannot be shared, not the hostname.
//
// ── SECURITY ────────────────────────────────────────────────────────────────
// The log contains ticker, size and account activity, so auth is mandatory: it
// REFUSES TO START without DASHBOARD_USER + DASHBOARD_PASSWORD_HASH, the same
// stance the Telegram bot takes on its allow-list. Credentials are compared in
// constant time and repeated failures lock the source IP out.
//
// Three ways to reach it, in descending order of safety:
//
//   1. TUNNEL — DASHBOARD_BIND=127.0.0.1, then from your LAPTOP (not the VM):
//        gcloud compute ssh INSTANCE --zone=ZONE -- -L 8444:localhost:8444
//      Nothing is exposed; the port is not open at all.
//   2. DIRECT OVER HTTPS — set DASHBOARD_CERT_FILE + DASHBOARD_KEY_FILE
//      (npm run dashboard:cert) and open https://<vm-ip>:8444. Self-signed, so
//      the browser warns once about identity; the traffic is still encrypted.
//   3. DIRECT OVER HTTP — works, and sends your password plus every log line
//      across the internet in base64. Only sane behind a firewall rule scoped
//      to your own source IP, and even then it is the weakest option.
//
// Generate the password hash:
//   read -rs PW && printf '%s' "$PW" | sha256sum && unset PW
// =============================================================================

// Load swing-config/swing.env before anything reads process.env. systemd
// supplies these via EnvironmentFile; a manual `npm run` does not.
import './lib/load-env.mjs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tailLog, resolveLogFile } from './lib/logfile.mjs';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.DASHBOARD_PORT || 8444);
const BIND = process.env.DASHBOARD_BIND || '0.0.0.0';
// Optional TLS. Reaching the dashboard directly over the internet means the
// basic-auth credentials — and every log line — cross the network in the clear
// unless this is set. A self-signed cert still encrypts the connection; the
// browser warning is about IDENTITY (nobody vouches that this host is yours),
// not about the encryption, and clicking through is reasonable for a host whose
// IP you typed yourself. Generate one with:
//   npm run dashboard:cert
const CERT_FILE = process.env.DASHBOARD_CERT_FILE || '';
const KEY_FILE = process.env.DASHBOARD_KEY_FILE || '';
const USER = process.env.DASHBOARD_USER || '';
const PW_HASH = (process.env.DASHBOARD_PASSWORD_HASH || '').trim().toLowerCase();
const REFRESH_SEC = Number(process.env.DASHBOARD_REFRESH_SEC || 20);
const MAX_FAILS = Number(process.env.DASHBOARD_MAX_FAILS || 8);
const LOCKOUT_SEC = Number(process.env.DASHBOARD_LOCKOUT_SEC || 300);
const LOG_FILE = resolveLogFile();
const START = Date.now();

if (!USER || !PW_HASH) {
  console.error(
    'DASHBOARD_USER and DASHBOARD_PASSWORD_HASH are required — refusing to serve\n' +
    'the trading log unauthenticated.\n\n' +
    "  read -rs PW && printf '%s' \"$PW\" | sha256sum && unset PW\n");
  process.exit(1);
}
if (PW_HASH.length !== 64) {
  console.error(`DASHBOARD_PASSWORD_HASH must be a 64-char sha256 hex digest (got ${PW_HASH.length}).`);
  process.exit(1);
}

// ---- secret redaction -------------------------------------------------------
// If a secret ever reaches a log line, it must not leave this process. Values
// are read once at startup and only ever used to search-and-replace.
const SECRET_VALUES = ['ALPACA_KEY', 'ALPACA_SECRET', 'ALPACA_API_KEY', 'ALPACA_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN', 'DASHBOARD_PASSWORD_HASH', 'FIREBASE_SERVICE_ACCOUNT_JSON']
  .map(k => process.env[k]).filter(v => v && v.length >= 6);
const SECRET_PATTERNS = [
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,   // telegram bot token
  /\b(?:PK|SK)[A-Z0-9]{16,}\b/g,        // alpaca-style key ids
  /"private_key"\s*:\s*"[^"]+"/g,       // a service-account blob in a stack trace
];
function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const v of SECRET_VALUES) out = out.split(v).join('[REDACTED]');
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- auth -------------------------------------------------------------------
const fails = new Map(); // ip → { count, until }

function lockedOut(ip) {
  const f = fails.get(ip);
  return !!(f && f.until > Date.now());
}
function recordFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= MAX_FAILS) { f.count = 0; f.until = Date.now() + LOCKOUT_SEC * 1000; }
  fails.set(ip, f);
}

function checkAuth(header) {
  if (!header || !header.startsWith('Basic ')) return false;
  let user = '', password = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    user = i < 0 ? decoded : decoded.slice(0, i);
    password = i < 0 ? '' : decoded.slice(i + 1);
  } catch { return false; }
  const got = crypto.createHash('sha256').update(password).digest('hex');
  // Constant-time on BOTH halves. timingSafeEqual throws on length mismatch, so
  // hash the username too — that makes both comparands fixed-length.
  const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(hash(user), hash(USER))
      && crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(PW_HASH, 'hex'));
}

// ---- system facts -----------------------------------------------------------
async function sh(cmd, args) {
  try { return (await execFileAsync(cmd, args, { timeout: 5000 })).stdout.trim(); }
  catch (e) { return String(e.stdout || e.message || '').trim(); }
}

async function systemStatus() {
  const [timers, sameday, bot, head] = await Promise.all([
    sh('systemctl', ['list-timers', '--no-pager', '--all', 'swing-*.timer']),
    sh('systemctl', ['is-active', 'swing-sameday.service']),
    sh('systemctl', ['is-active', 'swing-bot.service']),
    sh('git', ['-C', process.cwd(), 'log', '-1', '--pretty=%h %s (%cr)']),
  ]);
  // "NEXT LEFT LAST PASSED UNIT ACTIVATES" — take each timer's data row. BOTH
  // timers are reported: a disarmed maintenance timer looks like nothing is
  // wrong right up until a position is riding unmanaged.
  const nextFor = (unit) => {
    const row = timers.split('\n').find(l => l.includes(unit)) || '';
    return row.trim().split(/\s{2,}/)[0] || 'NOT SCHEDULED';
  };
  return {
    next: nextFor('swing-sameday.timer'),
    nextMaint: nextFor('swing-maintenance.timer'),
    sameday: sameday || 'unknown',
    bot: bot || 'unknown',
    head,
  };
}

function logStats() {
  try {
    const st = fs.statSync(LOG_FILE);
    return { size: st.size, mtime: st.mtime };
  } catch { return null; }
}

// Counts that answer "did it do anything today?" straight from the log, so the
// dashboard needs no Firestore reads (which are a metered, exhaustible resource
// — a page that polls every 20s must not spend them).
function todayCounts() {
  const text = tailLog(4000);
  const today = new Date().toISOString().slice(0, 10);
  const lines = text.split('\n').filter(l => l.startsWith(today));
  const count = (re) => lines.filter(l => re.test(l)).length;
  return {
    lines: lines.length,
    placed: count(/\bPLACED\b/),
    exits: count(/\bEXIT\b/),
    skipped: count(/\bskip /),
    errors: count(/\bERROR\b/),
    dryrun: count(/\bDRYRUN\b/),
  };
}

// ---- page -------------------------------------------------------------------
const CSS = `
:root{--bg:#0f1116;--card:#171a21;--line:#262b36;--fg:#e6e9ef;--dim:#8b94a7;--ok:#37d67a;--bad:#ff5c5c;--warn:#ffb020;--accent:#5b9dff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;padding:14px 18px;border-bottom:1px solid var(--line);background:var(--card);position:sticky;top:0;z-index:5}
h1{font-size:16px;margin:0;letter-spacing:.3px}
.dim{color:var(--dim)}
.wrap{padding:18px;max-width:1400px;margin:0 auto}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .k{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim)}
.card .v{font-size:20px;font-weight:600;margin-top:4px;word-break:break-word}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
.toolbar input,.toolbar select{background:#0c0e13;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 9px;font:inherit}
.toolbar input[type=text]{min-width:220px}
.toolbar button,.toolbar a.btn{background:#232834;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 12px;cursor:pointer;font:inherit;text-decoration:none}
.toolbar button:hover,.toolbar a.btn:hover{border-color:var(--accent)}
pre#log{background:#0b0d12;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;max-height:70vh;
  white-space:pre-wrap;word-break:break-word;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.l-err{color:var(--bad)}.l-warn{color:var(--warn)}.l-placed{color:var(--ok);font-weight:600}
.l-exit{color:#ff9ad1;font-weight:600}.l-skip{color:var(--dim)}.l-tag{color:var(--accent)}
footer{padding:10px 18px;color:var(--dim);font-size:12px;border-top:1px solid var(--line)}
`;

const JS = (refreshSec) => `
const logEl = document.getElementById('log');
const grepEl = document.getElementById('grep');
const linesEl = document.getElementById('lines');
const autoEl = document.getElementById('auto');
const stampEl = document.getElementById('stamp');
let pinned = true;

// Keep the pane pinned to the newest line unless the reader has scrolled up to
// look at something — silently yanking them back to the bottom mid-read is the
// single most annoying thing a live log view can do.
logEl.addEventListener('scroll', () => {
  pinned = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
});

function paint(text) {
  const html = text.split('\\n').map(line => {
    const e = line.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    let cls = '';
    if (/\\bERROR\\b|\\bFAILED\\b/.test(line)) cls = 'l-err';
    else if (/\\bWARN\\b/.test(line)) cls = 'l-warn';
    else if (/\\bPLACED\\b/.test(line)) cls = 'l-placed';
    else if (/\\bEXIT\\b/.test(line)) cls = 'l-exit';
    else if (/\\bskip /.test(line)) cls = 'l-skip';
    const tagged = e.replace(/(\\[[a-z ]{1,8}\\])/, '<span class="l-tag">$1</span>');
    return cls ? '<span class="' + cls + '">' + tagged + '</span>' : tagged;
  }).join('\\n');
  logEl.innerHTML = html;
  if (pinned) logEl.scrollTop = logEl.scrollHeight;
}

async function refresh() {
  const q = new URLSearchParams({ n: linesEl.value, grep: grepEl.value });
  try {
    const r = await fetch('/log?' + q, { headers: { 'Accept': 'text/plain' } });
    paint(await r.text());
    stampEl.textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    stampEl.textContent = 'update failed: ' + e.message;
  }
}

document.getElementById('go').onclick = refresh;
grepEl.addEventListener('keydown', e => { if (e.key === 'Enter') refresh(); });
linesEl.onchange = refresh;
setInterval(() => { if (autoEl.checked) refresh(); }, ${refreshSec} * 1000);
refresh();
`;

function renderPage({ sys, stats, counts }) {
  const uptime = Math.floor((Date.now() - START) / 1000);
  const upStr = uptime < 3600 ? `${Math.floor(uptime / 60)}m` : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
  const svc = (s) => s === 'active' ? '<span class="ok">active</span>'
    : s === 'inactive' ? '<span class="dim">idle</span>'
    : `<span class="bad">${esc(s)}</span>`;
  const sizeMb = stats ? (stats.size / 1048576).toFixed(1) + ' MB' : '—';
  const lastWrite = stats ? new Date(stats.mtime).toLocaleString() : 'no log yet';

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swing Automation</title><style>${CSS}</style></head><body>
<header>
  <h1>Swing Automation</h1>
  <span class="dim">${esc(sys.head || '')}</span>
  <span class="dim" style="margin-left:auto">dashboard up ${upStr}</span>
</header>
<div class="wrap">
  <div class="cards">
    <div class="card"><div class="k">Next entry run</div><div class="v">${esc(sys.next)}</div></div>
    <div class="card"><div class="k">Next maintenance</div><div class="v ${sys.nextMaint === 'NOT SCHEDULED' ? 'bad' : ''}">${esc(sys.nextMaint)}</div></div>
    <div class="card"><div class="k">Runner</div><div class="v">${svc(sys.sameday)}</div></div>
    <div class="card"><div class="k">Telegram bot</div><div class="v">${svc(sys.bot)}</div></div>
    <div class="card"><div class="k">Placed today</div><div class="v ${counts.placed ? 'ok' : ''}">${counts.placed}</div></div>
    <div class="card"><div class="k">Exits today</div><div class="v">${counts.exits}</div></div>
    <div class="card"><div class="k">Errors today</div><div class="v ${counts.errors ? 'bad' : 'ok'}">${counts.errors}</div></div>
    <div class="card"><div class="k">Skips today</div><div class="v dim">${counts.skipped}</div></div>
    <div class="card"><div class="k">Log file</div><div class="v" style="font-size:14px">${sizeMb}<br><span class="dim" style="font-size:11px">${esc(lastWrite)}</span></div></div>
  </div>

  <div class="toolbar">
    <input type="text" id="grep" placeholder="filter (regex) — e.g. PLACED|EXIT|ERROR">
    <select id="lines">
      <option value="200">200 lines</option>
      <option value="500" selected>500 lines</option>
      <option value="2000">2000 lines</option>
      <option value="10000">10000 lines</option>
    </select>
    <button id="go">Refresh</button>
    <label class="dim"><input type="checkbox" id="auto" checked> auto (${REFRESH_SEC}s)</label>
    <a class="btn" href="/log?n=5000" target="_blank">raw</a>
    <span class="dim" id="stamp"></span>
  </div>
  <pre id="log">loading…</pre>
</div>
<footer>${esc(LOG_FILE)} · all runners, the bot and deploys write here</footer>
<script>${JS(REFRESH_SEC)}</script>
</body></html>`;
}

// ---- server -----------------------------------------------------------------
const handler = async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  const url = new URL(req.url, 'http://localhost');

  // Liveness needs no credentials — an uptime checker should not hold them, and
  // this leaks nothing beyond "the process is running".
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok uptime=${Math.floor((Date.now() - START) / 1000)}s\n`);
  }

  if (lockedOut(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(LOCKOUT_SEC) });
    return res.end('too many failed attempts\n');
  }
  if (!checkAuth(req.headers.authorization)) {
    recordFail(ip);
    console.warn(`[dashboard] auth failure from ${ip}`);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Swing Automation", charset="UTF-8"' });
    return res.end('unauthorized\n');
  }
  fails.delete(ip);

  try {
    if (url.pathname === '/log') {
      const n = Math.min(Math.max(Number(url.searchParams.get('n')) || 500, 1), 20000);
      const grepRaw = (url.searchParams.get('grep') || '').trim();
      // A user-supplied regex runs in this process; cap the length and reject
      // anything that won't compile rather than handing it to the engine.
      let grep = null;
      if (grepRaw) {
        if (grepRaw.length > 200) throw new Error('filter too long');
        try { new RegExp(grepRaw); grep = grepRaw; }
        catch { throw new Error(`invalid regex: ${grepRaw}`); }
      }
      const text = redact(tailLog(n, { grep })) || '(no log yet)';
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(text);
    }

    if (url.pathname === '/') {
      const [sys, counts] = await Promise.all([systemStatus(), Promise.resolve(todayCounts())]);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(renderPage({ sys, stats: logStats(), counts }));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(redact(String(e.message)) + '\n');
  }
};

// HTTPS when a cert is configured, plain HTTP otherwise. The TLS handshake
// happens per-connection in the worker, not in the accept loop — a client that
// completes the TCP connection and then sends nothing must not be able to wedge
// the listener, and on any reachable port scanners produce exactly that traffic.
let server, scheme;
if (CERT_FILE && KEY_FILE) {
  try {
    server = https.createServer({ cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }, handler);
    scheme = 'https';
  } catch (e) {
    console.error(`[dashboard] cannot read TLS cert/key: ${e.message}`);
    console.error('[dashboard] refusing to fall back to plain HTTP — that would silently downgrade a connection you asked to encrypt.');
    process.exit(1);
  }
} else {
  server = http.createServer(handler);
  scheme = 'http';
}

// A client that opens a socket and sends nothing must not hold a slot forever.
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 15_000;
// The stdlib default backlog fills from background scanning alone; once full the
// kernel drops SYNs silently and the service looks "active" while nothing loads.
server.listen(PORT, BIND, 128, () => {
  console.log(`[dashboard] listening on ${scheme}://${BIND}:${PORT} (log: ${LOG_FILE})`);
  // State the reachability consequence outright. Binding to loopback and then
  // debugging the firewall for an hour is an easy trap: from outside, a
  // loopback-only listener and a blocked port look identical — both time out.
  if (BIND === '127.0.0.1') {
    console.log('[dashboard] LOOPBACK ONLY — not reachable from other hosts, whatever the firewall says.');
    console.log('[dashboard] Reach it with an SSH tunnel from your laptop:');
    console.log(`[dashboard]   gcloud compute ssh INSTANCE --zone=ZONE -- -L ${PORT}:localhost:${PORT}`);
    console.log(`[dashboard] For direct browser access instead, set DASHBOARD_BIND=0.0.0.0 (and ideally`);
    console.log('[dashboard] DASHBOARD_CERT_FILE/DASHBOARD_KEY_FILE — see npm run dashboard:cert).');
  } else if (scheme === 'http') {
    console.warn('[dashboard] reachable from other hosts over PLAIN HTTP — your password and every');
    console.warn('[dashboard] log line cross the network unencrypted. Either restrict the firewall to');
    console.warn('[dashboard] your own IP, or set DASHBOARD_CERT_FILE/DASHBOARD_KEY_FILE (npm run dashboard:cert).');
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[dashboard] port ${PORT} is already taken (the ORB dashboard, perhaps). ` +
      'One port serves one process — set DASHBOARD_PORT to a free one.');
    process.exit(1);
  }
  if (e.code === 'EACCES') {
    console.error(`[dashboard] not permitted to bind port ${PORT} (ports below 1024 need root). Pick a higher DASHBOARD_PORT.`);
    process.exit(1);
  }
  console.error(`[dashboard] ${e.message}`);
});
