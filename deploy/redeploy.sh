#!/usr/bin/env bash
set -euo pipefail

# Pulls latest, rebuilds, restarts the running server. No sudo needed.
#
# Usage: ./redeploy.sh [repo-dir] [port]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${1:-$(dirname "$SCRIPT_DIR")}"
PORT="${2:-8787}"

cd "$REPO_DIR"
git pull
npm install
npm run build

"$SCRIPT_DIR/stop-server.sh" "$REPO_DIR" || true
"$SCRIPT_DIR/start-server.sh" "$REPO_DIR" "$PORT"
