#!/bin/zsh
set -e
cd "$(dirname "$0")"

clear
echo "=================================================================="
echo "  ⏪ 書齋網站 · 一鍵回溯還原歷史版本（安全可逆）"
echo "=================================================================="
echo ""
python3 ./scripts/version_manager.py list
echo ""
echo "💡 提示：還原前系統會自動先把「現在的狀態」也備份起來，絕對不會遺失任何資料！"
read "CHOICE?請輸入要還原的【編號數字】（例如 1 或 2，直接按 Enter 取消離開）："
CHOICE=$(echo "$CHOICE" | tr -d '[:space:]')

if [[ -z "$CHOICE" ]]; then
  echo "已取消還原操作。"
  exit 0
fi

echo ""
read "CONFIRM?確定要將網站還原至第 [$CHOICE] 號備份嗎？請輸入 y 確認："
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "已取消還原操作。"
  exit 0
fi

echo ""
python3 ./scripts/version_manager.py restore "$CHOICE"

echo ""
read "PUSH_NOW?是否要立即將還原後的版本同步發佈回線上網站 (GitHub Pages)？(輸入 y 立即同步 / Enter 僅先在本機預覽)："
if [[ "$PUSH_NOW" == "y" || "$PUSH_NOW" == "Y" ]]; then
  python3 ./scripts/sync_cloud.py
fi

echo ""
read "?還原流程完成！按 Enter 鍵關閉視窗..."
