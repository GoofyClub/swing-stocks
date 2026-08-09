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
#
# Then add the printed lines to swing-config/swing.env and restart the service.
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
HOST="${1:-}"
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

cat <<EOF

Certificate written for $HOST (valid $DAYS days).

Add to $CONFIG_DIR/swing.env:

  DASHBOARD_BIND=0.0.0.0
  DASHBOARD_CERT_FILE=$CERT
  DASHBOARD_KEY_FILE=$KEY

Then:

  sudo systemctl restart swing-dashboard
  # browse to https://$HOST:${DASHBOARD_PORT:-8444}   (note HTTPS)

Your browser will warn that the certificate is not trusted — expected for a
self-signed cert. The connection is still encrypted. Proceed once and it is
remembered.

Do not forget the firewall rule, ideally scoped to your own IP:

  gcloud compute firewall-rules create swing-dashboard \\
    --allow=tcp:${DASHBOARD_PORT:-8444} --source-ranges=YOUR.IP.HERE/32 \\
    --target-tags=swing-dashboard --description="Swing log dashboard"
  gcloud compute instances add-tags \$(hostname) --zone=YOUR_ZONE --tags=swing-dashboard

EOF
