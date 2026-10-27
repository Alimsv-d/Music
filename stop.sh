#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -f app.pid ]]; then
  PID="$(<app.pid)"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID"
    for _ in {1..20}; do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  fi
  rm -f app.pid
fi
