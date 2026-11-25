#!/bin/zsh
set -e
cd "$(dirname "$0")"

PORT=8788
echo "正在啟動低調走過網站與離線編輯服務：http://localhost:${PORT}"
(sleep 0.6 && open "http://localhost:${PORT}") &
PORT="${PORT}" python3 ./server.py
