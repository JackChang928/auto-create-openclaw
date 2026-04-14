#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"
PID_FILE="$LOG_DIR/server.pid"
PORT="${PORT:-3210}"

mkdir -p "$LOG_DIR"

existing_pid="$(ss -ltnp | awk -v port=":${PORT}" '$4 ~ port {print $NF}' | sed -E 's/.*pid=([0-9]+).*/\1/' | head -1 || true)"
if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
  echo "[restart-local] stopping pid=$existing_pid on port $PORT"
  kill "$existing_pid"
  for _ in $(seq 1 20); do
    if ! kill -0 "$existing_pid" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if kill -0 "$existing_pid" 2>/dev/null; then
    echo "[restart-local] pid $existing_pid did not exit gracefully; killing"
    kill -9 "$existing_pid"
  fi
fi

cd "$PROJECT_DIR"

echo "[restart-local] starting server.js"
nohup node server.js >>"$LOG_FILE" 2>&1 &
new_pid=$!
echo "$new_pid" > "$PID_FILE"
echo "[restart-local] started pid=$new_pid log=$LOG_FILE"
