#!/bin/zsh
set -e
cd "$(dirname "$0")"

clear
echo "=================================================================="
echo "  🛡️ 書齋網站 · 手動建立完整備份與新版本編號"
echo "=================================================================="
echo ""
python3 ./scripts/version_manager.py list | head -n 10
echo ""
read "NOTE?請輸入這次備份或改版的簡短說明（直接按 Enter 則填「手動備份快照」）："
NOTE=${NOTE:-手動備份快照}

read "DO_BUMP?是否同時推進一個小版本號？(輸入 y 推進版本號 / 直接按 Enter 僅打包備份)："
if [[ "$DO_BUMP" == "y" || "$DO_BUMP" == "Y" ]]; then
  python3 ./scripts/version_manager.py release --bump patch --note "$NOTE" --tag
else
  python3 ./scripts/version_manager.py pre-backup --note "$NOTE"
fi

echo ""
read "?按 Enter 鍵關閉視窗..."
