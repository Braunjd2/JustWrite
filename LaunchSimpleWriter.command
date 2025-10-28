#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required to run SimpleWriter."
  echo "Download it from https://nodejs.org/ and try again."
  read -r -p "Press Enter to exit..." _
  exit 1
fi

PORT=${PORT:-5173}

echo "Starting SimpleWriter on http://localhost:${PORT}"
node server.js &
SERVER_PID=$!

cleanup() {
  if ps -p "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

sleep 1

if command -v open >/dev/null 2>&1; then
  open "http://localhost:${PORT}"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:${PORT}" >/dev/null 2>&1 &
else
  echo "Open http://localhost:${PORT} in your browser."
fi

echo "Press Ctrl+C to stop SimpleWriter."
wait "$SERVER_PID"
