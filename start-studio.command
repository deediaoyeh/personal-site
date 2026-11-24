#!/bin/zsh
set -e
cd "$(dirname "$0")"

PORT=8788
echo "正在啟動書齋離線編輯工作台：http://localhost:${PORT}/studio.html"
if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://localhost:${PORT}/studio.html"
else
  (sleep 0.6 && open "http://localhost:${PORT}/studio.html") &
  PORT="${PORT}" python3 ./server.py
fi
