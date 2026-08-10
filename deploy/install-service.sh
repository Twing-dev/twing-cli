#!/usr/bin/env bash
set -euo pipefail

# Installs (or updates) the twing-serve systemd unit, plus a narrowly
# scoped sudo grant so the service user can restart/stop/check *this one
# unit* without needing general sudo -- redeploys stay self-service without
# widening the account's privileges at all. Safe to re-run: rewrites both
# files and reloads, a no-op if nothing changed.
#
# Usage: sudo ./install-service.sh [repo-dir] [service-user] [port]
#   repo-dir      defaults to this script's own repo checkout
#   service-user  defaults to twingcli
#   port          defaults to 8787
#
# Requires packages/server/dist/main.js to already exist (run `npm install
# && npm run build` as the service user first) -- refuses to install a unit
# that would just crash-loop on a missing build.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${1:-$(dirname "$SCRIPT_DIR")}"
SERVICE_USER="${2:-twingcli}"
PORT="${3:-8787}"
SYSTEMCTL="$(command -v systemctl)"

if [[ $EUID -ne 0 ]]; then
  echo "run this with sudo" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/packages/server/dist/main.js" ]]; then
  echo "no build found at $REPO_DIR/packages/server/dist/main.js" >&2
  echo "run as $SERVICE_USER first: cd $REPO_DIR && npm install && npm run build" >&2
  exit 1
fi

cat > /etc/systemd/system/twing-serve.service <<EOF
[Unit]
Description=twing serve - coordination server
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$REPO_DIR/packages/server
Environment=PORT=$PORT
ExecStart=/usr/bin/env node $REPO_DIR/packages/server/dist/main.js
Restart=on-failure
RestartSec=5

# Defense in depth -- meaningful given this box may run other services too.
# ReadWritePaths carves an exception into ProtectHome/ProtectSystem so the
# service user's own repo checkout (and its build output) stays usable;
# everything else, including every other user's home, stays locked out.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$REPO_DIR
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/sudoers.d/twing-serve-restart <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: $SYSTEMCTL restart twing-serve, $SYSTEMCTL status twing-serve, $SYSTEMCTL stop twing-serve, $SYSTEMCTL start twing-serve
EOF
chmod 440 /etc/sudoers.d/twing-serve-restart
visudo -c -f /etc/sudoers.d/twing-serve-restart

systemctl daemon-reload
systemctl enable --now twing-serve
systemctl status twing-serve --no-pager
