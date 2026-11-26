#!/bin/zsh
set -e
cd "$(dirname "$0")"

clear
echo "=================================================================="
echo "  ✨ 書齋網站 · 一鍵產生 Google 雲端後台專屬程式碼（免改程式版）"
echo "=================================================================="
echo ""
echo "這個小工具會自動幫你產生高強度安全密碼，並組合出專屬你的雲端程式碼。"
echo "你只需要回答下面 3 個簡單問題（直接按 Enter 可略過或使用預設值）："
echo ""

read "GH_OWNER?1️⃣ 請輸入你的 GitHub 英文帳號名稱（例如 wangming）："
GH_OWNER=$(echo "$GH_OWNER" | tr -d '[:space:]')

echo ""
echo "💡 提示：打開你的 Google 雲端硬碟資料夾，複製瀏覽器網址列整串貼進來即可，系統會自動擷取 ID！"
read "DRIVE_INPUT?2️⃣ 請貼上你的 Google 雲端硬碟資料夾網址（若還沒建，直接按 Enter 略過）："
DRIVE_INPUT=$(echo "$DRIVE_INPUT" | tr -d '[:space:]')

echo ""
echo "💡 提示：若你想在外面用 iPad 或別台電腦直接登入網頁改文章，可貼上 GitHub 通行證（ghp_ 或 github_pat_ 開頭）；"
echo "   若平常都在這台電腦打字，直接按 Enter 略過即可！"
read "GH_PAT?3️⃣ （選填）GitHub 個人存取權杖："
GH_PAT=$(echo "$GH_PAT" | tr -d '[:space:]')

GH_OWNER="$GH_OWNER" DRIVE_INPUT="$DRIVE_INPUT" GH_PAT="$GH_PAT" python3 - <<'PY'
import hashlib
import json
import os
import re
import secrets
import subprocess
from pathlib import Path

root = Path.cwd()
cfg_path = root / "site.config.js"
template_path = root / "google" / "google-workspace-hub.gs"
env_path = root / ".sync.env"
auth_path = root / ".studio-auth.json"
jwt_path = root / ".studio-jwt.key"

# 讀取 site.config.js 內的品牌名稱
brand_name = "個人知識庫"
newsletter_title = "雙週電子報"
if cfg_path.exists():
    raw_cfg = cfg_path.read_text(encoding="utf-8")
    m = re.search(r"window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$", raw_cfg)
    if m:
        try:
            cfg = json.loads(m.group(1))
            brand_name = cfg.get("brand", {}).get("name") or brand_name
            newsletter_title = cfg.get("newsletter", {}).get("title") or f"《{brand_name}》電子報"
        except Exception:
            pass

gh_owner = os.environ.get("GH_OWNER", "").strip() or "請填入你的GitHub英文帳號"
site_url = f"https://{gh_owner}.github.io/personal-site"

drive_raw = os.environ.get("DRIVE_INPUT", "").strip()
m_folder = re.search(r"/folders/([a-zA-Z0-9_-]+)", drive_raw)
drive_id = m_folder.group(1) if m_folder else drive_raw

gh_pat = os.environ.get("GH_PAT", "").strip()

# 讀取或自動建立 .sync.env 內的兩把安全金鑰（絕不覆蓋既有金鑰）
env_map = {}
if env_path.exists():
    for line in env_path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if s and not s.startswith("#") and "=" in s:
            k, v = s.split("=", 1)
            env_map[k.strip()] = v.strip().strip('"').strip("'")

sync_token = env_map.get("GOOGLE_WORKSPACE_SYNC_TOKEN") or secrets.token_hex(24)
analytics_key = env_map.get("STUDIO_ANALYTICS_KEY") or secrets.token_hex(24)
env_map["GOOGLE_WORKSPACE_SYNC_TOKEN"] = sync_token
env_map["STUDIO_ANALYTICS_KEY"] = analytics_key
if gh_owner and "請填入" not in gh_owner:
    env_map["SITE_BASE_URL"] = site_url

env_lines = [
    "# 本機私密同步與點閱金鑰（系統自動產生，請勿外流）",
    f'GOOGLE_WORKSPACE_FEED_URL="{env_map.get("GOOGLE_WORKSPACE_FEED_URL", "")}"',
    f'GOOGLE_WORKSPACE_SYNC_TOKEN="{sync_token}"',
    f'STUDIO_ANALYTICS_KEY="{analytics_key}"',
    f'GOOGLE_DRIVE_LOCAL_DIR="{env_map.get("GOOGLE_DRIVE_LOCAL_DIR", "")}"',
    f'SITE_BASE_URL="{env_map.get("SITE_BASE_URL", site_url)}"',
]
env_path.write_text("\n".join(env_lines) + "\n", encoding="utf-8")
os.chmod(env_path, 0o600)

# 讀取本機雙重驗證雜湊（若使用者已完成第 1 步掃碼設定）
salt_hex = ""
verifier_hex = ""
totp_secret = ""
recovery_hashes = ""
if auth_path.exists():
    try:
        vault = json.loads(auth_path.read_text(encoding="utf-8"))
        salt_hex = vault.get("saltHex", "")
        dk_hex = vault.get("passwordHashHex", "").strip().lower()
        if dk_hex:
            verifier_hex = hashlib.sha256(("studio-v1:" + dk_hex).encode("utf-8")).hexdigest()
        totp_secret = vault.get("totpSecret", "")
        recovery_hashes = ",".join(vault.get("recoveryCodeHashes", []))
    except Exception:
        pass

if jwt_path.exists():
    jwt_secret = jwt_path.read_text(encoding="utf-8").strip()
else:
    jwt_secret = secrets.token_hex(32)
    jwt_path.write_text(jwt_secret, encoding="utf-8")
    os.chmod(jwt_path, 0o600)

gs = template_path.read_text(encoding="utf-8")

def replace_field(code: str, key: str, val: str) -> str:
    escaped = val.replace("\\", "\\\\").replace('"', '\\"')
    return re.sub(rf'({key}\s*:\s*)"[^"]*"', lambda _: f'{key}: "{escaped}"', code, count=1)

gs = replace_field(gs, "SENDER_NAME", brand_name)
gs = replace_field(gs, "NEWSLETTER_TITLE", newsletter_title)
gs = replace_field(gs, "SITE_URL", site_url)
gs = replace_field(gs, "MIRROR_URL", site_url)
gs = replace_field(gs, "DRIVE_CONTENT_FOLDER_ID", drive_id)
gs = replace_field(gs, "SYNC_TOKEN", sync_token)
gs = replace_field(gs, "ANALYTICS_READ_KEY", analytics_key)
gs = replace_field(gs, "GITHUB_OWNER", gh_owner)
gs = replace_field(gs, "GITHUB_REPO", "personal-site")
gs = replace_field(gs, "GITHUB_PAT", gh_pat)
gs = replace_field(gs, "STUDIO_SALT_HEX", salt_hex)
gs = replace_field(gs, "STUDIO_VERIFIER_HEX", verifier_hex)
gs = replace_field(gs, "STUDIO_TOTP_SECRET", totp_secret)
gs = replace_field(gs, "STUDIO_RECOVERY_HASHES", recovery_hashes)
gs = replace_field(gs, "STUDIO_JWT_SECRET", jwt_secret)

out_file = Path.home() / "Desktop" / "請貼入Google試算表AppsScript的程式碼.txt"
out_file.write_text(gs, encoding="utf-8")

try:
    subprocess.run(["pbcopy"], input=gs.encode("utf-8"), check=True)
    copied = True
except Exception:
    copied = False

print("")
print("==================================================================")
print("🎉 專屬雲端程式碼產生完成！")
if copied:
    print("✅ 已經自動幫你「複製到剪貼簿」了！")
    print("👉 現在請直接切換到 Google 試算表的 Apps Script 網頁，")
    print("   把原本那幾行字刪掉，直接按 Command + V（貼上）再按儲存即可！")
print(f"📄 同時也在你的「桌面」存了一份備份檔：{out_file.name}")
print("⚠️ 提醒：這份桌面檔案內含你的專屬防護金鑰，貼上到 Google 後即可把桌面的 .txt 檔丟進垃圾桶。")
if not verifier_hex:
    print("💡 備註：偵測到你尚未執行 start-studio.command 設定密碼與手機驗證碼，")
    print("   建議先點兩下 start-studio.command 完成掃碼後，再重新執行一次本工具喔！")
print("==================================================================")
PY

echo ""
read "?按 Enter 鍵關閉視窗..."
