#!/usr/bin/env bash
# Smoke test browser-router: tự bật Chrome headless + chạy scripts/smoke-browser.ts
set -euo pipefail

CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${SMOKE_CDP_PORT:-9333}"
PROFILE="$(mktemp -d)"

"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --remote-debugging-port="$PORT" --user-data-dir="$PROFILE" about:blank >/dev/null 2>&1 &
CHROME_PID=$!
trap 'kill "$CHROME_PID" 2>/dev/null || true; rm -rf "$PROFILE"' EXIT

READY=0
for _ in $(seq 1 60); do
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "FAIL: Chrome thoát sớm trước khi mở cổng CDP $PORT" >&2
    exit 1
  fi
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.25
done
if [ "$READY" -ne 1 ]; then
  echo "FAIL: Chrome CDP không sẵn sàng sau 15s trên cổng $PORT" >&2
  exit 1
fi

SMOKE_CDP="http://127.0.0.1:$PORT" npx tsx scripts/smoke-browser.ts
