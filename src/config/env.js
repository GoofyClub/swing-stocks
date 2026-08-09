// =============================================================================
// env.js — THE single place every runtime setting is declared.
//
// Each variable is declared once, with its type, default, whether it is secret,
// which processes use it, and what it does. Everything else is derived from this
// spec: `loadConfig()` parses and validates, `renderEnvExample()` generates the
// documented .env template, and the Telegram /config command prints it back.
//
// Add a new setting HERE and nowhere else. If a value is read with a bare
// process.env.X somewhere, that is a bug — it will be missing from the template,
// the validator and the docs, which is exactly how a deployment ends up with a
// silently-unset variable.
//
// SECRETS are never printed: describeConfig() and the bot's /config both mask
// them, so a chat transcript or a pasted log can't leak a broker key.
// =============================================================================

const S = 'string', B = 'bool', N = 'number', L = 'list';

// scope: which processes read the value — used to group the generated template.
export const CONFIG_SPEC = [
  // ---- Firebase -----------------------------------------------------------
  { key: 'FIREBASE_PROJECT_ID', type: S, required: true, scope: 'core',
    desc: 'Firebase/Firestore project id that holds signals and user config.' },
  { key: 'FIREBASE_SERVICE_ACCOUNT_FILE', type: S, default: '', scope: 'core',
    desc: 'Path to a service-account key JSON. Preferred over pasting the key inline. Leave empty on GCE to use the VM\'s attached service account (Application Default Credentials).' },
  { key: 'FIREBASE_SERVICE_ACCOUNT_JSON', type: S, default: '', secret: true, scope: 'core',
    desc: 'Raw service-account key JSON. Used by CI (GitHub Secrets). On a VM prefer the _FILE form or ADC — systemd EnvironmentFile mishandles the quotes in this blob.' },

  // ---- Market data --------------------------------------------------------
  { key: 'ALPACA_KEY', type: S, default: '', secret: true, scope: 'data',
    desc: 'Alpaca market-data key. Paper keys work. Strongly recommended: without it bar fetching falls back to keyless endpoints that rate-limit on a full-universe scan.' },
  { key: 'ALPACA_SECRET', type: S, default: '', secret: true, scope: 'data',
    desc: 'Alpaca market-data secret. NOTE: market data only — the keys used to PLACE orders come from each user\'s Firestore automation config, not here.' },
  { key: 'ALPHAVANTAGE_KEY', type: S, default: '', secret: true, scope: 'data', desc: 'Optional fallback data source.' },
  { key: 'FINNHUB_KEY', type: S, default: '', secret: true, scope: 'data', desc: 'Optional fallback data source.' },
  { key: 'FMP_KEY', type: S, default: '', secret: true, scope: 'data', desc: 'Optional. Enables the PEAD / Insider / Analyst strategies, which need fundamentals.' },

  // ---- Execution ----------------------------------------------------------
  { key: 'DRY_RUN', type: B, default: true, scope: 'exec',
    desc: 'TRUE logs intended orders without submitting. Defaults true everywhere — flip to false only after reviewing a dry-run log.' },
  { key: 'ALLOW_LIVE', type: B, default: false, scope: 'exec',
    desc: 'Hard gate for REAL-MONEY orders. A live broker URL alone can never trade real money without this.' },
  { key: 'KILL_SWITCH', type: B, default: false, scope: 'exec',
    desc: 'Abort the run immediately, placing nothing. Per-run; the persistent switch is Firestore publicConfig/automation.paused (Telegram /pause).' },
  { key: 'ONLY_UID', type: S, default: '', scope: 'exec', desc: 'Restrict a run to one user id. Testing only.' },
  { key: 'FORCE_WINDOW', type: B, default: false, scope: 'exec',
    desc: 'Same-day runner only: bypass the 15:35-15:50 ET close-window check so it can be tested at any hour.' },
  { key: 'WATCHLIST_SET', type: S, default: 'core', choices: ['core', 'broad'], scope: 'exec',
    desc: 'Universe to scan. core = 51 curated names (~15s). broad = full S&P universe, 1503 names (~6-7 min). Use broad to match what refresh-signals scans.' },
  { key: 'STRATEGIES', type: L, default: [], scope: 'exec',
    desc: 'Comma list restricting which strategies run. Empty = every strategy the user has enabled.' },
  { key: 'MARKETS', type: L, default: ['US', 'INDIA'], scope: 'exec', desc: 'Markets the refresh cron scans.' },

  // ---- Telegram control bot ----------------------------------------------
  { key: 'TELEGRAM_BOT_TOKEN', type: S, default: '', secret: true, scope: 'bot',
    desc: 'Bot token from @BotFather. Required to run the control bot.' },
  { key: 'TELEGRAM_ALLOWED_CHAT_IDS', type: L, default: [], scope: 'bot',
    desc: 'SECURITY-CRITICAL allow-list of chat ids permitted to issue commands. The bot refuses to start when empty — an open control bot lets anyone who finds it flatten your positions.' },
  { key: 'TELEGRAM_ADMIN_UID', type: S, default: '', scope: 'bot',
    desc: 'Firestore user id the bot reports on and controls. Defaults to the single automation-enabled user when exactly one exists.' },
  { key: 'BOT_POLL_SECONDS', type: N, default: 25, scope: 'bot',
    desc: 'Telegram long-poll timeout. 25s keeps the connection cheap and responsive.' },
  { key: 'REPO_DIR', type: S, default: '', scope: 'bot',
    desc: 'Override the checkout path used by /deploy. Normally unset — the bot detects its own checkout from its file location. Only needed if the bot runs outside the repo it should deploy.' },
  { key: 'DEPLOY_ENABLED', type: B, default: true, scope: 'bot',
    desc: 'Set false to disable Telegram /deploy entirely. It already requires CONFIRM and runs deploy.sh, which is fast-forward-only, tests before restarting, and refuses inside the 15:38 ET window.' },

  // ---- Log dashboard (scripts/dashboard.mjs) ------------------------------
  { key: 'DASHBOARD_USER', type: S, default: '', scope: 'dashboard',
    desc: 'Basic-auth username. Required to run the dashboard — it serves the trading log, so it refuses to start unauthenticated.' },
  { key: 'DASHBOARD_PASSWORD_HASH', type: S, default: '', secret: true, scope: 'dashboard',
    desc: "sha256 hex digest of the password. Generate with: read -rs PW && printf '%s' \"$PW\" | sha256sum && unset PW" },
  { key: 'DASHBOARD_PORT', type: N, default: 8444, scope: 'dashboard',
    desc: 'Listen port. Cannot be shared with another dashboard — one port, one process. ORB uses 8443.' },
  { key: 'DASHBOARD_BIND', type: S, default: '0.0.0.0', scope: 'dashboard',
    desc: 'Bind address. 127.0.0.1 = loopback only, reachable solely through an SSH tunnel. 0.0.0.0 = reachable from other hosts, which needs a firewall rule AND ideally DASHBOARD_CERT_FILE (otherwise the password crosses the network in the clear).' },
  { key: 'DASHBOARD_REFRESH_SEC', type: N, default: 20, scope: 'dashboard',
    desc: 'Auto-refresh interval for the log pane.' },
  { key: 'DASHBOARD_CERT_FILE', type: S, default: '', scope: 'dashboard',
    desc: 'TLS certificate path. Set this AND the key to serve HTTPS — required if you open the port to the internet, or your password and every log line cross it in the clear. Generate: npm run dashboard:cert' },
  { key: 'DASHBOARD_KEY_FILE', type: S, default: '', scope: 'dashboard',
    desc: 'TLS private key path. Must accompany DASHBOARD_CERT_FILE.' },
  { key: 'DASHBOARD_URL', type: S, default: '', scope: 'dashboard',
    desc: 'Override the dashboard link the bot shares. Normally unset — it is derived from the bind address, port and whether a cert is configured, so it cannot drift out of sync. Set this only behind a reverse proxy or a custom domain.' },
  { key: 'SWING_LOG_FILE', type: S, default: '', scope: 'dashboard',
    desc: 'Override the shared log path. Default: <repo>/logs/swing.log — every runner, the bot and deploys append to it.' },
];

const BY_KEY = new Map(CONFIG_SPEC.map(s => [s.key, s]));

function coerce(spec, raw) {
  if (raw == null || raw === '') return spec.default ?? (spec.type === L ? [] : spec.type === B ? false : '');
  switch (spec.type) {
    case B: return String(raw).toLowerCase() === 'true';
    case N: { const n = Number(raw); return Number.isFinite(n) ? n : spec.default; }
    case L: return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    default: return String(raw);
  }
}

// Parse + validate the environment. Throws with EVERY problem at once rather
// than one per run — finding three missing variables three restarts apart is
// how a 15-minute deployment window gets eaten.
export function loadConfig(env = process.env) {
  const out = {}, errors = [];
  for (const spec of CONFIG_SPEC) {
    const val = coerce(spec, env[spec.key]);
    if (spec.required && (val === '' || val == null)) errors.push(`${spec.key} is required — ${spec.desc}`);
    if (spec.choices && val && !spec.choices.includes(val)) {
      errors.push(`${spec.key}='${val}' is not one of: ${spec.choices.join(', ')}`);
    }
    out[spec.key] = val;
  }
  if (errors.length) throw new Error(`Configuration problems:\n  - ${errors.join('\n  - ')}`);
  return out;
}

// Config for display: secrets masked, so this is safe to print into a log or a
// Telegram message.
export function describeConfig(cfg, { scope = null } = {}) {
  const lines = [];
  for (const spec of CONFIG_SPEC) {
    if (scope && spec.scope !== scope) continue;
    const v = cfg[spec.key];
    const shown = spec.secret
      ? (v ? `set (${String(v).length} chars)` : 'unset')
      : (Array.isArray(v) ? (v.length ? v.join(',') : '(empty)') : (v === '' ? '(empty)' : String(v)));
    lines.push(`${spec.key}=${shown}`);
  }
  return lines.join('\n');
}

// Generate the documented .env template from the same spec, so the template can
// never drift from what the code actually reads.
export function renderEnvExample() {
  const groups = {
    core: 'Firebase — required',
    data: 'Market data — ALPACA_* strongly recommended',
    exec: 'Execution behaviour',
    bot:  'Telegram control bot',
    dashboard: 'Log dashboard (scripts/dashboard.mjs)',
  };
  const out = ['# swing-stocks runtime configuration',
    '# Generated from src/config/env.js — the single source of truth.',
    '# Regenerate:  node scripts/print-env-example.mjs > config/swing.env.example',
    ''];
  for (const [scope, title] of Object.entries(groups)) {
    out.push(`# ${'='.repeat(74)}`, `# ${title}`, `# ${'='.repeat(74)}`);
    for (const spec of CONFIG_SPEC.filter(s => s.scope === scope)) {
      for (const line of wrap(spec.desc, 74)) out.push(`# ${line}`);
      if (spec.choices) out.push(`# one of: ${spec.choices.join(' | ')}`);
      const def = Array.isArray(spec.default) ? spec.default.join(',') : spec.default;
      const commented = !spec.required && (def === '' || def == null || spec.secret);
      out.push(`${commented ? '# ' : ''}${spec.key}=${spec.required ? '' : (def ?? '')}`, '');
    }
  }
  return out.join('\n');
}

function wrap(text, width) {
  const words = String(text).split(/\s+/), lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > width) { lines.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}

export function specFor(key) { return BY_KEY.get(key) || null; }
