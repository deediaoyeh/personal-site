#!/bin/zsh
set -e
cd "$(dirname "$0")"

echo "正在執行全站索引重建與雲端同步（Google Drive + Git + Netlify）⋯"
python3 ./scripts/sync_cloud.py
echo "同步程序執行完畢。"
