#!/usr/bin/env bash
set -euo pipefail

# Pulls latest, rebuilds, restarts the running server. No sudo needed.
#
# Usage: ./redeploy.sh [repo-dir] [port]
#
# Shipping a *release* (a version bump, not a server-internal change): make
# sure npm can already resolve the version this checkout declares before
# running this. `GET /v1/version` is exact-matched against every client, so
# the moment this server answers with a version, every machine that checks
# in tries to install exactly that one.
#
#     npm view @twing/cli@<version> version --prefer-online
#
# Not a 200 from `registry.npmjs.org/@twing/cli/<version>`: npm resolves
# from the full packument, which propagates minutes behind the per-version
# document, and in between an install of that exact version fails ETARGET.
# A client that fails there burns its one version-recovery attempt and then
# denies edits for the 30-minute cooldown (hook/version_recovery.go).
# Confirmed live on the 0.2.30 redeploy, 2026-09-17.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${1:-$(dirname "$SCRIPT_DIR")}"
PORT="${2:-8787}"

cd "$REPO_DIR"
git pull
npm install
npm run build

"$SCRIPT_DIR/stop-server.sh" "$REPO_DIR" || true
"$SCRIPT_DIR/start-server.sh" "$REPO_DIR" "$PORT"
