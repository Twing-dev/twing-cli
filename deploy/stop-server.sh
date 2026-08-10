#!/usr/bin/env bash
set -euo pipefail

# Stops the twing serve process started by start-server.sh.
#
# Usage: ./stop-server.sh [repo-dir]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${1:-$(dirname "$SCRIPT_DIR")}"
PID_FILE="$REPO_DIR/twing-serve.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "no pid file at $PID_FILE -- not running, or was started another way" >&2
  exit 1
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "stopped (pid $PID)"
else
  echo "pid $PID not running (stale pid file)"
fi
rm -f "$PID_FILE"
