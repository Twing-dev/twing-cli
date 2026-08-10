#!/usr/bin/env bash
set -euo pipefail

# Pulls latest, rebuilds, restarts the running service. Run this as the
# service user (twingcli) -- the restart itself uses the narrow sudo grant
# from install-service.sh, not general privileges.
#
# Usage: ./redeploy.sh [repo-dir]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${1:-$(dirname "$SCRIPT_DIR")}"

cd "$REPO_DIR"
git pull
npm install
npm run build
sudo systemctl restart twing-serve
sudo systemctl status twing-serve --no-pager
