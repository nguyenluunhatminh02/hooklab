#!/usr/bin/env bash
# Rebuild HookLab backend and (re)start the live :3100 API.
# Safety: every kill is preceded by /proc/<pid>/cwd verification; only the
# backend dist entrypoint rooted in this repo is ever touched. If a previous
# instance already died (crash), we skip the kill and just start a fresh one.
set -euo pipefail

# Resolve the checkout location from this script's own path instead of baking
# in a per-machine absolute path. pwd -P reports the physical path, matching
# what readlink /proc/<pid>/cwd returns below.
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd -P)
BACKEND_DIR="$REPO_DIR/backend"
API_PORT=3100
cd "$BACKEND_DIR"

echo "== npm run build =="
npm run build

# Find OUR backend instance: a node process whose /proc/<pid>/cwd is this repo
# and whose cmdline contains dist/main.js (the hooklab entrypoint). shiptrack
# (PIDs 59279/61896) and /repo/apps/api (PID 128071) live elsewhere — never matched.
PID=""
for p in /proc/[0-9]*/cwd; do
  pid=${p%/cwd}; pid=${pid#/proc/}
  cmd=$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null || true)
  cwd=$(readlink "$p" 2>/dev/null || true)
  if [ "$cwd" = "$BACKEND_DIR" ] && [[ "$cmd" == *"dist/main.js"* ]]; then
    PID=$pid
    break
  fi
done

if [ -n "$PID" ]; then
  echo "== found our backend PID $PID — verify before kill =="
  cwd=$(readlink /proc/$PID/cwd)
  cmd=$(tr '\0' ' ' < /proc/$PID/cmdline)
  echo "cwd=$cwd"
  echo "cmd=$cmd"
  if [ "$cwd" != "$BACKEND_DIR" ]; then
    echo "REFUSING: cwd mismatch"; exit 1
  fi
  echo "== restart =="
  kill "$PID"
  for _ in $(seq 1 30); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "REFUSING: process did not exit"; exit 1
  fi
else
  echo "== no live backend instance found — starting fresh =="
fi

PORT=$API_PORT nohup node dist/main.js > /tmp/hooklab-api.log 2>&1 &
NEW=$!
echo "started new pid $NEW"

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$API_PORT/health" > /dev/null 2>&1; then
    echo "API healthy on :$API_PORT"
    exit 0
  fi
  sleep 0.5
done
echo "API did not become healthy"; tail -30 /tmp/hooklab-api.log; exit 1