#!/usr/bin/env bash
# =============================================================================
# deploy.sh — pull the latest code onto the VM and restart what needs it.
#
#   ./scripts/deploy.sh              # pull, install, verify, restart if changed
#   ./scripts/deploy.sh --check      # verify only; change nothing
#   ./scripts/deploy.sh --force      # restart the services even with no changes
#
# Design rules, all of them learned the hard way:
#
#   1. FAST-FORWARD ONLY. A merge commit created unattended on a trading box is
#      a code path nobody has read. If the pull can't fast-forward, stop and say
#      so — a human resolves it.
#
#   2. VERIFY BEFORE RESTART. New code is syntax-checked and the test suite runs
#      BEFORE anything is restarted. A box that fails to start at 15:38 doesn't
#      trade; catching it here means the OLD code keeps running instead.
#
#   3. NEVER RESTART MID-SESSION. The same-day runner fires in a 15-minute
#      window. Restarting the timer while its service is mid-run kills an
#      in-flight order pass. Deploys inside the window are refused unless forced.
#
#   4. THE BOT RESTARTS ITSELF, DETACHED. When invoked from Telegram's /deploy
#      this script is a CHILD of swing-bot.service; `systemctl restart swing-bot`
#      would kill its own parent — taking this script down mid-deploy, so the
#      reply never arrives and the restart may not complete. The bot restart is
#      handed to `systemd-run` as a transient unit outside our cgroup instead.
#
#   5. RESTART ONLY WHAT CHANGED. Comparing the diff against each service's file
#      set keeps a docs-only deploy from bouncing a live process.
# =============================================================================
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR" || exit 1

MODE="deploy"
[[ "${1:-}" == "--check" ]] && MODE="check"
[[ "${1:-}" == "--force" ]] && MODE="force"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }

# Mirror everything into the shared log, so a Telegram-triggered deploy shows up
# in /log next to the trades it changed.
LOG_FILE="${SWING_LOG_FILE:-$REPO_DIR/logs/swing.log}"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
logline() { printf '%s [deploy ] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$*" >>"$LOG_FILE" 2>/dev/null; }

fail() { bad "$*"; logline "FAILED: $*"; exit 1; }

logline "deploy started (mode=$MODE) by $(id -un)"

# ---- 1. safety: not mid-session ---------------------------------------------
hdr "1. Timing"
ET_MIN=$(TZ=America/New_York date +'%H %M' | awk '{print $1*60+$2}')
ET_DOW=$(TZ=America/New_York date +%u)
# 15:30–16:05 ET on a weekday: the same-day runner's window plus a margin.
if (( ET_DOW <= 5 && ET_MIN >= 930 && ET_MIN <= 965 )); then
  if [[ "$MODE" == "force" ]]; then
    warn "inside the 15:38 ET execution window — proceeding because --force"
  elif [[ "$MODE" == "check" ]]; then
    warn "inside the 15:38 ET execution window (check mode, nothing will change)"
  else
    fail "inside the 15:38 ET execution window — refusing to restart mid-run. Retry after 16:05 ET, or use --force."
  fi
else
  ok "outside the execution window ($(TZ=America/New_York date +'%a %H:%M') ET)"
fi

# ---- 2. pull -----------------------------------------------------------------
hdr "2. Source"
BEFORE="$(git rev-parse HEAD 2>/dev/null)" || fail "not a git checkout: $REPO_DIR"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "working tree has uncommitted changes — refusing to pull over them:
$(git status --short --untracked-files=no | head -10)"
fi

if [[ "$MODE" == "check" ]]; then
  git fetch --quiet origin "$BRANCH" 2>/dev/null
  BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo '?')"
  ok "on $BRANCH at ${BEFORE:0:8}; $BEHIND commit(s) behind origin"
else
  # Retry the network step: a transient DNS/proxy blip should not need a human.
  PULLED=0
  for delay in 0 2 4 8; do
    (( delay )) && sleep "$delay"
    if PULL_OUT="$(git pull --ff-only origin "$BRANCH" 2>&1)"; then PULLED=1; break; fi
    warn "git pull failed, retrying in ${delay}s…"
  done
  (( PULLED )) || fail "git pull --ff-only failed:
$PULL_OUT
If the branch has diverged, resolve it by hand — this script will not merge."
  ok "$(echo "$PULL_OUT" | tail -1)"
fi
AFTER="$(git rev-parse HEAD)"
CHANGED="$(git diff --name-only "$BEFORE" "$AFTER" 2>/dev/null)"
ok "HEAD $(git log -1 --pretty='%h %s')"

if [[ "$BEFORE" == "$AFTER" && "$MODE" == "deploy" ]]; then
  ok "already up to date — nothing to restart (use --force to bounce anyway)"
  logline "no changes at ${AFTER:0:8}; nothing restarted"
  exit 0
fi

# ---- 3. dependencies ---------------------------------------------------------
hdr "3. Dependencies"
if [[ "$MODE" == "check" ]]; then
  [[ -d node_modules ]] && ok "node_modules present" || warn "node_modules missing"
elif grep -q '^package-lock\.json$\|^package\.json$' <<<"$CHANGED" || [[ ! -d node_modules ]]; then
  echo "  npm ci…"
  npm ci --silent || fail "npm ci failed — dependencies are inconsistent, NOT restarting"
  ok "dependencies installed"
else
  ok "lockfile unchanged — skipping npm ci"
fi

# ---- 4. verify BEFORE restarting --------------------------------------------
hdr "4. Verification"
for f in scripts/*.mjs scripts/lib/*.mjs; do
  node --check "$f" >/dev/null 2>&1 || fail "syntax error in $f — NOT restarting"
done
ok "all scripts parse"

if npm test >/tmp/swing-deploy-test.$$ 2>&1; then
  ok "test suite passed ($(grep -ho 'PASS [0-9]*' /tmp/swing-deploy-test.$$ | awk '{s+=$2} END {print s}') assertions)"
  rm -f /tmp/swing-deploy-test.$$
else
  bad "TEST SUITE FAILED — not restarting; the previous code keeps running"
  tail -25 /tmp/swing-deploy-test.$$
  logline "FAILED: test suite red at ${AFTER:0:8}"
  rm -f /tmp/swing-deploy-test.$$
  exit 1
fi

if [[ "$MODE" == "check" ]]; then
  hdr "Summary"; ok "check passed — run without --check to apply"; exit 0
fi

# ---- 5. restart only what changed -------------------------------------------
hdr "5. Services"
# A service is restarted when its own files changed, when a shared module it
# imports changed, or when --force. Everything imports src/, so a src/ change
# touches both; that is correct, not over-broad.
touched() { [[ "$MODE" == "force" ]] && return 0; grep -qE "$1" <<<"$CHANGED"; }

BOT_CHANGED=0;   touched '^(scripts/telegram-bot\.mjs|scripts/lib/|src/)' && BOT_CHANGED=1
UNITS_CHANGED=0; touched '^scripts/setup-vm\.sh$' && UNITS_CHANGED=1

if (( UNITS_CHANGED )); then
  warn "setup-vm.sh changed — refreshing systemd units"
  ./scripts/setup-vm.sh --units >/dev/null 2>&1 && ok "units reinstalled" || warn "unit refresh failed (run ./scripts/setup-vm.sh --units by hand)"
fi

# The same-day runner is a oneshot fired by a timer: there is no daemon to
# restart. The next firing picks the new code up on its own.
if systemctl is-active --quiet swing-sameday.service 2>/dev/null; then
  warn "swing-sameday.service is RUNNING right now — leaving it alone; the new code applies from the next firing"
else
  ok "swing-sameday: oneshot, next firing uses the new code ($(systemctl list-timers --no-pager swing-sameday.timer 2>/dev/null | awk 'NR==2 {print $1, $2, $3}'))"
fi

if (( BOT_CHANGED )); then
  if ! systemctl list-unit-files swing-bot.service >/dev/null 2>&1; then
    warn "swing-bot.service not installed — skipping"
  # RULE 4: when Telegram's /deploy ran this, we are inside swing-bot's cgroup.
  # Restarting it directly kills this script. Hand the restart to a transient
  # unit so it survives our own death, and return immediately.
  elif systemctl status swing-bot.service 2>/dev/null | grep -q "$$"; then
    systemd-run --unit="swing-bot-redeploy-$$" --on-active=3s \
      systemctl restart swing-bot.service >/dev/null 2>&1 \
      && ok "bot restart scheduled in 3s (detached — this deploy is running inside it)" \
      || warn "could not schedule detached restart; run: sudo systemctl restart swing-bot"
  else
    sudo systemctl restart swing-bot.service 2>/dev/null \
      && ok "swing-bot restarted" \
      || warn "could not restart swing-bot (needs sudo?) — run: sudo systemctl restart swing-bot"
  fi
else
  ok "swing-bot: no relevant changes, left running"
fi

if systemctl list-unit-files swing-dashboard.service >/dev/null 2>&1; then
  if touched '^scripts/(dashboard\.mjs|lib/)'; then
    sudo systemctl restart swing-dashboard.service 2>/dev/null && ok "swing-dashboard restarted" || warn "could not restart swing-dashboard"
  else
    ok "swing-dashboard: no relevant changes"
  fi
fi

# ---- summary -----------------------------------------------------------------
hdr "Summary"
ok "deployed ${BEFORE:0:8} → ${AFTER:0:8}"
echo "  $(wc -l <<<"$CHANGED") file(s) changed:"
head -12 <<<"$CHANGED" | sed 's/^/    /'
logline "deployed ${BEFORE:0:8} -> ${AFTER:0:8} ($(wc -l <<<"$CHANGED") files)"
