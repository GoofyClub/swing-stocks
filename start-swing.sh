#!/usr/bin/env bash
# Linux/macOS first-run assistant. Re-running preserves configuration and state.
set -euo pipefail
cd "$(dirname "$0")"
export SWING_UID="$(id -u)" SWING_GID="$(id -g)"
mkdir -p data
printf '%s\n' 'Stop the old SWING installation before starting this one. Use the same dedicated paper account.'
docker compose version >/dev/null
docker compose build
docker compose run --rm --no-deps swing python3 packaging/configure.py
docker compose up -d --wait
printf '%s\n' 'Local dashboard: http://127.0.0.1:8444' 'Verify /healthcheck, /positions and /config in Telegram. Starts paused and DRY_RUN=true; see PC-INSTALL.md.'
