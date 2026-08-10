#!/usr/bin/env bash
set -euo pipefail

# Starts twing serve detached from the current shell (survives SSH logout),
# with stdout/stderr captured to a log file. No sudo needed -- runs
# entirely as whatever user invokes it.
#
# Usage: ./start-server.sh [repo-dir] [port]
#   repo-dir  defaults to this script's own repo checkout
#   port      defaults to 8787

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${1:-$(dirname "$SCRIPT_DIR")}"
PORT="${2:-8787}"
LOG_FILE="$REPO_DIR/twing-serve.log"
PID_FILE="$REPO_DIR/twing-serve.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "already running (pid $(cat "$PID_FILE")) -- run stop-server.sh first" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/packages/server/dist/main.js" ]]; then
  echo "no build found at $REPO_DIR/packages/server/dist/main.js" >&2
  echo "run first: cd $REPO_DIR && npm install && npm run build" >&2
  exit 1
fi

cd "$REPO_DIR"
PORT="$PORT" nohup node packages/server/dist/main.js >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
disown

sleep 1
if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "failed to start -- check $LOG_FILE" >&2
  exit 1
fi

echo "started (pid $(cat "$PID_FILE")), listening on port $PORT"
echo "logs: tail -f $LOG_FILE"
