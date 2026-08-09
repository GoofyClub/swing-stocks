#!/usr/bin/env bash
# =============================================================================
# setup-vm.sh — provision this box to run the swing traders.
#
# IDEMPOTENT: safe to re-run. It never overwrites an existing config file, and
# every step checks before acting. Re-run it after a git pull to refresh the
# systemd units.
#
# It does NOT do the two things that need your Google account rather than the
# VM's (granting Firestore IAM, setting the cloud-platform scope) — those must
# run from Cloud Shell, and the script prints the exact commands with your real
# values substituted.
#
#   ./scripts/setup-vm.sh                 # interactive
#   ./scripts/setup-vm.sh --check         # verify only, change nothing
#   ./scripts/setup-vm.sh --units         # (re)install systemd units only
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Where swing.env lives. Resolved, not assumed — an existing config is FOUND
# rather than shadowed by a fresh empty one, because a stale EnvironmentFile
# path is a silent killer: systemd starts the unit with no variables at all and
# the bot dies on "TELEGRAM_BOT_TOKEN is required" in a restart loop.
# Order: explicit override → inside the repo → beside the repo → legacy $HOME.
if [[ -n "${SWING_CONFIG_DIR:-}" ]]; then
  CONFIG_DIR="$SWING_CONFIG_DIR"
elif [[ -f "$REPO_DIR/swing-config/swing.env" ]]; then
  CONFIG_DIR="$REPO_DIR/swing-config"
elif [[ -f "$(dirname "$REPO_DIR")/swing-config/swing.env" ]]; then
  CONFIG_DIR="$(dirname "$REPO_DIR")/swing-config"
elif [[ -f "$HOME/swing-config/swing.env" ]]; then
  CONFIG_DIR="$HOME/swing-config"
else
  CONFIG_DIR="$REPO_DIR/swing-config"   # new installs: keep it with the code
fi
ENV_FILE="$CONFIG_DIR/swing.env"
RUN_USER="$(id -un)"
NODE_BIN="$(command -v node || true)"

MODE="full"
[[ "${1:-}" == "--check" ]] && MODE="check"
[[ "${1:-}" == "--units" ]] && MODE="units"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

FAILED=0

# ---- 1. prerequisites -------------------------------------------------------
hdr "1. Prerequisites"
if [[ -z "$NODE_BIN" ]]; then
  bad "node not found. Install:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  FAILED=1
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if (( NODE_MAJOR < 18 )); then bad "node $NODE_MAJOR too old (need >= 18)"; FAILED=1
  else ok "node $(node -v) at $NODE_BIN"; fi
fi
command -v git >/dev/null && ok "git $(git --version | awk '{print $3}')" || { bad "git not found"; FAILED=1; }

# ---- 2. dependencies --------------------------------------------------------
hdr "2. Dependencies"
if [[ "$MODE" == "check" ]]; then
  [[ -d "$REPO_DIR/node_modules" ]] && ok "node_modules present" || { warn "node_modules missing — run npm ci"; FAILED=1; }
else
  if [[ ! -d "$REPO_DIR/node_modules" ]] || [[ "$REPO_DIR/package-lock.json" -nt "$REPO_DIR/node_modules" ]]; then
    echo "  installing (npm ci)…"
    ( cd "$REPO_DIR" && npm ci --silent ) && ok "dependencies installed" || { bad "npm ci failed"; FAILED=1; }
  else
    ok "dependencies up to date"
  fi
fi

# ---- 3. config --------------------------------------------------------------
hdr "3. Configuration"
mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"
if [[ -f "$ENV_FILE" ]]; then
  ok "using $ENV_FILE (left untouched)"
elif [[ "$MODE" == "check" ]]; then
  bad "$ENV_FILE missing"; FAILED=1
else
  # Seed from the generated template so every documented setting is present.
  node "$REPO_DIR/scripts/print-env-example.mjs" > "$ENV_FILE" 2>/dev/null \
    || cp "$REPO_DIR/config/swing.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "created $ENV_FILE from the template"
  warn "EDIT IT before continuing — FIREBASE_PROJECT_ID at minimum:  nano $ENV_FILE"
fi
[[ -f "$ENV_FILE" ]] && { chmod 600 "$ENV_FILE"; set -a; . "$ENV_FILE" 2>/dev/null; set +a; }

if [[ -n "${FIREBASE_PROJECT_ID:-}" ]]; then ok "FIREBASE_PROJECT_ID=$FIREBASE_PROJECT_ID"
else bad "FIREBASE_PROJECT_ID not set in $ENV_FILE"; FAILED=1; fi
[[ -n "${ALPACA_KEY:-}" ]] && ok "ALPACA_KEY set (market data)" \
  || warn "ALPACA_KEY unset — keyless endpoints rate-limit on the 1503-name broad universe"
ok "WATCHLIST_SET=${WATCHLIST_SET:-core}$([[ "${WATCHLIST_SET:-core}" == core ]] && echo '  (51 names; set broad to match refresh-signals)')"
ok "DRY_RUN=${DRY_RUN:-true}$([[ "${DRY_RUN:-true}" == true ]] && echo '  (simulating — nothing submitted)')"

# ---- 4. Google Cloud auth ---------------------------------------------------
hdr "4. Google Cloud credentials"
SA_EMAIL="$(curl -s -m 3 -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email 2>/dev/null || true)"
if [[ -z "$SA_EMAIL" ]]; then
  warn "not a GCE VM (no metadata server) — set FIREBASE_SERVICE_ACCOUNT_FILE in $ENV_FILE"
else
  ok "service account: $SA_EMAIL"
  SCOPES="$(curl -s -m 3 -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/scopes 2>/dev/null || true)"
  if grep -q 'cloud-platform' <<<"$SCOPES"; then
    ok "cloud-platform scope present"
  else
    bad "cloud-platform scope MISSING — Firestore will fail with 'Could not load the default credentials'"
    FAILED=1
    cat <<EOF

  Fix from CLOUD SHELL (not this VM — the VM cannot grant itself permissions).
  The instance must be STOPPED to change scopes, so do this outside market hours:

    gcloud compute instances stop $(hostname) --zone=YOUR_ZONE
    gcloud compute instances set-service-account $(hostname) \\
      --zone=YOUR_ZONE --service-account=$SA_EMAIL --scopes=cloud-platform
    gcloud compute instances start $(hostname) --zone=YOUR_ZONE
EOF
  fi
  cat <<EOF

  Firestore access must be granted ON THE FIREBASE PROJECT (often not this VM's
  project). From Cloud Shell:

    gcloud projects add-iam-policy-binding ${FIREBASE_PROJECT_ID:-YOUR_FIREBASE_PROJECT} \\
      --member="serviceAccount:$SA_EMAIL" --role="roles/datastore.user"
EOF
fi

# ---- 5. connectivity --------------------------------------------------------
hdr "5. Connectivity"
if [[ -n "${FIREBASE_PROJECT_ID:-}" ]] && [[ -d "$REPO_DIR/node_modules" ]]; then
  if ( cd "$REPO_DIR" && node -e "
      import('./src/config/firebaseAdmin.js').then(async m => {
        const db = m.initFirestore();
        await db.collection('publicConfig').doc('automation').get();
        console.log('  firestore reachable');
      }).catch(e => { console.error('  ' + e.message); process.exit(1); });
    " 2>&1 | sed 's/^/ /'); then
    ok "Firestore reachable"
  else
    bad "Firestore unreachable — see the message above and section 4"
    FAILED=1
  fi
else
  warn "skipped (needs FIREBASE_PROJECT_ID and node_modules)"
fi

# ---- 6. systemd units -------------------------------------------------------
hdr "6. systemd units"
install_units() {
  sudo tee /etc/systemd/system/swing-sameday.service >/dev/null <<EOF
[Unit]
Description=Swing same-day (trade-the-close) execution
After=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN scripts/same-day-trade.mjs
EOF

  # 15:38 for the broad universe (~6 min scan); 15:42 is fine for core.
  local FIRE_AT="15:38"
  [[ "${WATCHLIST_SET:-core}" == "core" ]] && FIRE_AT="15:42"
  sudo tee /etc/systemd/system/swing-sameday.timer >/dev/null <<EOF
[Unit]
Description=Fire the same-day runner before the US close

[Timer]
# Timezone is part of OnCalendar, so DST is handled. A fixed UTC cron would
# drift an hour twice a year — fatal for a 15-minute window.
OnCalendar=Mon-Fri $FIRE_AT America/New_York
Persistent=false

[Install]
WantedBy=timers.target
EOF

  sudo tee /etc/systemd/system/swing-bot.service >/dev/null <<EOF
[Unit]
Description=Swing Telegram control bot
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN scripts/telegram-bot.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
  # Maintenance: reconcile → exits → realize → equity. This is what GitHub
  # Actions used to do on a schedule; it is now VM-owned, because a missed run
  # leaves orders stuck at 'submitted', positions with no managed exit, and a
  # frozen drawdown peak that silently disables the halt.
  sudo tee /etc/systemd/system/swing-maintenance.service >/dev/null <<EOF
[Unit]
Description=Swing maintenance (reconcile, exits, realize, equity)
After=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN scripts/maintenance.mjs
EOF

  sudo tee /etc/systemd/system/swing-maintenance.timer >/dev/null <<EOF
[Unit]
Description=Fire swing maintenance morning and after the close

[Timer]
# 09:45 ET — catch overnight fills and gap stop-outs before the day starts.
# 16:15 ET — after the close, once the day's protective legs have settled.
# Timezone is part of OnCalendar so DST is handled; a fixed UTC cron would
# drift an hour twice a year.
OnCalendar=Mon-Fri 09:45 America/New_York
OnCalendar=Mon-Fri 16:15 America/New_York
# Unlike the entry timer, a MISSED maintenance run should still happen — a
# reboot at 16:10 must not skip the day's reconciliation. Every step is
# idempotent, so a late catch-up run is safe.
Persistent=true

[Install]
WantedBy=timers.target
EOF

  sudo tee /etc/systemd/system/swing-dashboard.service >/dev/null <<EOF
[Unit]
Description=Swing automation log dashboard
After=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$REPO_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN scripts/dashboard.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  ok "units written (fires $FIRE_AT ET, watchlist=${WATCHLIST_SET:-core})"
}

# A unit pointing at a config file that has MOVED starts with an empty
# environment and the service dies on "X is required" — with a message that
# blames the missing variable, never the path. Compare explicitly.
check_unit_env() {
  local unit="$1" want="$2" have
  have="$(systemctl show -p EnvironmentFiles --value "$unit" 2>/dev/null | sed 's/ (ignore_errors=.*//')"
  [[ -z "$have" ]] && return 0
  if [[ "$have" != "$want" ]]; then
    bad "$unit reads $have but the config is at $want"
    warn "fix with:  ./scripts/setup-vm.sh --units && sudo systemctl restart ${unit%.service}"
    FAILED=1
  else
    ok "$unit → $want"
  fi
}

if [[ "$MODE" == "check" ]]; then
  systemctl list-unit-files swing-sameday.timer >/dev/null 2>&1 \
    && ok "swing-sameday.timer installed" || warn "swing-sameday.timer not installed"
  systemctl list-unit-files swing-maintenance.timer >/dev/null 2>&1 \
    && ok "swing-maintenance.timer installed" \
    || { bad "swing-maintenance.timer NOT installed — reconciliation, exits and the drawdown ratchet are not running anywhere"; FAILED=1; }
  systemctl list-unit-files swing-bot.service >/dev/null 2>&1 \
    && ok "swing-bot.service installed" || warn "swing-bot.service not installed"
  check_unit_env swing-bot.service "$ENV_FILE"
  check_unit_env swing-sameday.service "$ENV_FILE"
  check_unit_env swing-maintenance.service "$ENV_FILE"
else
  if command -v sudo >/dev/null; then
    install_units
    sudo systemctl enable --now swing-sameday.timer >/dev/null 2>&1 && ok "same-day timer enabled (entries 15:38 ET)" || warn "could not enable same-day timer"
    sudo systemctl enable --now swing-maintenance.timer >/dev/null 2>&1 && ok "maintenance timer enabled (09:45 + 16:15 ET)" || warn "could not enable maintenance timer"
    if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_ALLOWED_CHAT_IDS:-}" ]]; then
      sudo systemctl enable --now swing-bot >/dev/null 2>&1 && ok "telegram bot enabled" || warn "could not enable bot"
    else
      warn "telegram bot NOT enabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_IDS, then: sudo systemctl enable --now swing-bot"
    fi
    if [[ -n "${DASHBOARD_USER:-}" && -n "${DASHBOARD_PASSWORD_HASH:-}" ]]; then
      sudo systemctl enable --now swing-dashboard >/dev/null 2>&1 \
        && ok "dashboard enabled on port ${DASHBOARD_PORT:-8444}" || warn "could not enable dashboard"
    else
      warn "dashboard NOT enabled — set DASHBOARD_USER and DASHBOARD_PASSWORD_HASH, then: sudo systemctl enable --now swing-dashboard"
      warn "  hash a password:  read -rs PW && printf '%s' \"\$PW\" | sha256sum && unset PW"
    fi
  else
    warn "sudo unavailable — install units manually (see docs/setup.md)"
  fi
fi

# ---- summary ----------------------------------------------------------------
hdr "Summary"
if (( FAILED )); then
  bad "setup incomplete — resolve the ✗ items above, then re-run"
else
  ok "setup looks good"
fi
cat <<EOF

Next:
  1. Dry run now (bypasses the time window, submits nothing):
       cd $REPO_DIR && set -a && . $ENV_FILE && set +a
       FORCE_WINDOW=true DRY_RUN=true npm run auto:sameday
  2. Confirm the schedule:      systemctl list-timers 'swing-*'
       swing-sameday      15:38 ET  entries + exits
       swing-maintenance  09:45 + 16:15 ET  reconcile, exits, realize, equity
  3. Inspect a run afterwards:  tail -100 $REPO_DIR/logs/swing.log
  4. Trading limits are in Firestore, not this box:
       npm run config                            # show
       npm run config maxConcurrentPositions 8   # change

Going live is a separate, staged decision — see docs/going-live.md.
EOF
exit $FAILED
