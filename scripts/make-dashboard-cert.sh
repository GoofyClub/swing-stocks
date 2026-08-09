#!/usr/bin/env bash
# =============================================================================
# make-dashboard-cert.sh — self-signed TLS cert for the log dashboard.
#
# For when you want to reach the dashboard directly at https://<vm-ip>:8444
# rather than through an SSH tunnel. Without TLS, basic-auth credentials and
# every log line — tickers, sizes, account activity — cross the internet in the
# clear, readable by anything between your browser and the VM.
#
# A self-signed cert encrypts the connection just as well as a purchased one.
# What it does NOT do is prove the host is yours, so the browser shows a warning
# the first time. That warning is about IDENTITY, not secrecy — and for a host
# whose IP you typed in yourself, clicking through is reasonable.
#
#   ./scripts/make-dashboard-cert.sh                 # cert for this VM's external IP
#   ./scripts/make-dashboard-cert.sh 34.23.154.110   # or name the IP/host yourself
#   ./scripts/make-dashboard-cert.sh --apply         # also write swing.env for me
#
# Without --apply it prints the settings and leaves swing.env alone. With it,
# the three settings are written in place — because generating a cert and then
# forgetting to change DASHBOARD_BIND leaves the service on loopback, which from
# outside is indistinguishable from a firewall problem and sends you hunting in
# the wrong place.
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${SWING_CONFIG_DIR:-$REPO_DIR/swing-config}"
CERT="$CONFIG_DIR/dashboard-cert.pem"
KEY="$CONFIG_DIR/dashboard-key.pem"
DAYS=825   # the maximum most browsers will accept for a leaf certificate

command -v openssl >/dev/null || { echo "openssl not found: sudo apt-get install -y openssl"; exit 1; }

# Default to the VM's external IP from the GCE metadata server, so the cert
# actually matches the address you will type.
APPLY=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--apply" ]]; then APPLY=1; else ARGS+=("$a"); fi
done

HOST="${ARGS[0]:-}"
if [[ -z "$HOST" ]]; then
  HOST="$(curl -s -m 3 -H 'Metadata-Flavor: Google' \
    'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' 2>/dev/null || true)"
fi
[[ -z "$HOST" ]] && { echo "Could not detect an external IP. Pass one: $0 <ip-or-hostname>"; exit 1; }

mkdir -p "$CONFIG_DIR" && chmod 700 "$CONFIG_DIR"

# subjectAltName is what browsers actually check — a bare CN has been ignored
# for years, and a cert without a matching SAN is rejected outright rather than
# merely warned about. IPs go in as IP:, names as DNS:.
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SAN="IP:$HOST"; else SAN="DNS:$HOST"; fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$KEY" -out "$CERT" -days "$DAYS" \
  -subj "/CN=$HOST" -addext "subjectAltName=$SAN" 2>/dev/null

chmod 600 "$KEY"
chmod 644 "$CERT"

ENV_FILE="$CONFIG_DIR/swing.env"

# Set KEY=VALUE in swing.env: replace an existing (even commented-out) line so
# the file keeps one authoritative entry per key, otherwise append. A duplicate
# key would be a coin-flip depending on read order, which is not something to
# leave in a config that decides whether a port is exposed.
set_env() {
  local key="$1" val="$2"
  [[ -f "$ENV_FILE" ]] || { touch "$ENV_FILE"; chmod 600 "$ENV_FILE"; }
  if grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE"; then
    # Escape for sed's replacement: & and the delimiter.
    local esc; esc="$(printf '%s' "$val" | sed -e 's/[&|]/\\&/g')"
    sed -i -E "s|^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?${key}=.*|${key}=${esc}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

if (( APPLY )); then
  # Back up first — this edits a file holding broker keys and a bot token.
  cp -p "$ENV_FILE" "$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
  set_env DASHBOARD_BIND 0.0.0.0
  set_env DASHBOARD_CERT_FILE "$CERT"
  set_env DASHBOARD_KEY_FILE "$KEY"
  chmod 600 "$ENV_FILE"

  cat <<EOF

Certificate written for $HOST (valid $DAYS days), and $ENV_FILE updated:

  DASHBOARD_BIND=0.0.0.0
  DASHBOARD_CERT_FILE=$CERT
  DASHBOARD_KEY_FILE=$KEY

Now:

  sudo systemctl restart swing-dashboard
  ss -ltn | grep ${DASHBOARD_PORT:-8444}      # want 0.0.0.0:${DASHBOARD_PORT:-8444}, not 127.0.0.1

Then browse to  https://$HOST:${DASHBOARD_PORT:-8444}   (HTTPS, not http)

The browser will warn that the certificate is untrusted — expected for a
self-signed cert. The connection is still encrypted. Accept once.

EOF
else
  cat <<EOF

Certificate written for $HOST (valid $DAYS days).

Add to $ENV_FILE — note DASHBOARD_BIND must change from 127.0.0.1, or the
service stays on loopback and the browser will time out:

  DASHBOARD_BIND=0.0.0.0
  DASHBOARD_CERT_FILE=$CERT
  DASHBOARD_KEY_FILE=$KEY

Or re-run with --apply to have those written for you. Then:

  sudo systemctl restart swing-dashboard
  ss -ltn | grep ${DASHBOARD_PORT:-8444}      # want 0.0.0.0:${DASHBOARD_PORT:-8444}

Then browse to  https://$HOST:${DASHBOARD_PORT:-8444}   (HTTPS, not http)

EOF
fi

cat <<EOF
Firewall, if not already open. Scope it to your own IP — an open port is found
by scanners within hours:

  curl -s ifconfig.me      # your public IP

  gcloud compute firewall-rules create swing-dashboard \\
    --allow=tcp:${DASHBOARD_PORT:-8444} --source-ranges=YOUR.IP/32 \\
    --target-tags=swing-dashboard

  gcloud compute instances add-tags $(hostname) --zone=YOUR_ZONE --tags=swing-dashboard

A --target-tags rule matches NOTHING until the instance carries that tag, and
the symptom is a timeout. This instance currently has:
  $(curl -s -m 3 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/tags 2>/dev/null || echo '(could not read tags)')

EOF
