#!/bin/zsh
set -e
cd "$(dirname "$0")"

echo "=================================================================="
echo "  📦 正在為你打包「去識別化乾淨分享版」懶人包..."
echo "  （不會動到你原本的任何文章、設定或私密金鑰！）"
echo "=================================================================="

python3 - <<'PY'
import json
import os
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

src_root = Path.cwd()
out_zip = src_root.parent / "個人知識庫網站_零基礎快速上線懶人包.zip"

EXCLUDE_NAMES = {
    ".git",
    ".netlify",
    ".local-bin",
    ".DS_Store",
    ".sync.env",
    ".studio-auth.json",
    ".studio-jwt.key",
    ".studio-audit.log",
    "__pycache__",
    "dist_public",
}

with tempfile.TemporaryDirectory() as tmpdir:
    stage_dir = Path(tmpdir) / "personal-site"
    shutil.copytree(
        src_root,
        stage_dir,
        ignore=lambda d, names: [n for n in names if n in EXCLUDE_NAMES or n.endswith(".pyc")],
    )

    # 1. 重設分享包內的 site.config.js 為乾淨的新手預設範本（不外洩站主個人信箱與雲端網址）
    clean_config = {
        "brand": {
            "name": "我的數位書齋",
            "latinName": "My Studio",
            "studioTitle": "我的數位書齋 · Field Notes & Essays",
            "tagline": "這是一座持續成長的個人知識庫。",
            "role": "寫作者・獨立思考者",
            "location": "Taiwan",
            "since": "2026",
            "email": "yourname@gmail.com",
        },
        "intro": {
            "greeting": "歡迎來到我的數位書齋。",
            "lead": "這裡記錄我的長文思考（Essays）、日常閱讀筆記（Notes），以及定期寄出的電子報。",
            "currentlyExploring": ["閱讀筆記", "專題研究", "生活觀察"],
        },
        "newsletter": {
            "title": "《我的數位書齋》電子報",
            "frequency": "不定期寄出",
            "promise": "整理近期寫下的核心長文與閱讀卡片，安靜寄到你的信箱。不發廣告，隨時可一鍵退訂。",
            "inputPlaceholder": "輸入你的常用 Email 信箱",
            "buttonText": "訂閱電子報",
            "googleScriptUrl": "",
        },
        "about": {
            "headline": "把零碎的想法，慢慢整理成值得留存的文字",
            "paragraphs": ["你可以在「網站品牌設定」中隨時修改這段自我介紹。"],
            "principles": [],
            "nowUpdated": "2026 年",
            "nowItems": [
                {"label": "正在研究", "text": "在工作台修改你的近期關注主題"},
                {"label": "正在閱讀", "text": "在工作台填寫你最近在讀的書"},
            ],
            "workAndProjects": [],
        },
        "links": [
            {"label": "Email", "url": "mailto:yourname@gmail.com"},
            {"label": "RSS 訂閱", "url": "./rss.xml"},
        ],
    }
    (stage_dir / "site.config.js").write_text(
        "/**\n * 網站全域設定檔 (site.config.js)\n * 點兩下 start-studio.command 即可在畫面中直接修改，無須手動改程式碼！\n */\nwindow.SITE_CONFIG = "
        + json.dumps(clean_config, ensure_ascii=False, indent=2)
        + ";\n",
        encoding="utf-8",
    )

    # 2. 清空分享包內 google-workspace-hub.gs 的站主個人帳號與資料夾 ID
    gs_path = stage_dir / "google" / "google-workspace-hub.gs"
    if gs_path.exists():
        gs = gs_path.read_text(encoding="utf-8")
        replacements = {
            "SENDER_NAME": "我的數位書齋",
            "NEWSLETTER_TITLE": "《我的數位書齋》電子報",
            "SITE_URL": "https://你的GitHub帳號.github.io/personal-site",
            "MIRROR_URL": "https://你的GitHub帳號.github.io/personal-site",
            "DRIVE_CONTENT_FOLDER_ID": "",
            "GITHUB_OWNER": "",
            "GITHUB_REPO": "personal-site",
        }
        for k, v in replacements.items():
            gs = re.sub(rf'({k}\s*:\s*)"[^"]*"', lambda _, k=k, v=v: f'{k}: "{v}"', gs, count=1)
        gs_path.write_text(gs, encoding="utf-8")

    # 3. 移除站主個人上傳附件與個人文章，改放各 1 篇乾淨的範例文章供新手參考排版
    uploads_dir = stage_dir / "assets" / "uploads"
    if uploads_dir.exists():
        shutil.rmtree(uploads_dir)
    uploads_dir.mkdir(parents=True, exist_ok=True)

    for sub in ("essays", "notes", "letters"):
        d = stage_dir / "content" / sub
        if d.exists():
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)

    (stage_dir / "content" / "essays" / "welcome-essay.md").write_text(
        """---
title: 第一篇長文範例：歡迎來到我的數位書齋
date: 2026-11-26
tags: 寫作, 知識管理
summary: 這是一篇範例長文。打開工作台即可直接修改或刪除這篇文章，換上你自己的思考紀錄。
---

## 寫給自己的第一篇長文

恭喜你成功啟動了自己的知識庫網站！

在這個編輯器裡，你可以像平常打字一樣分段、列點：

- 貼上 **YouTube 網址**（獨立一行），前台就會自動變成精美的影片播放卡。
- 輸入過的主題標籤，下次寫新文章時可以直接點選套用。
- 右側會自動根據你的小標題產生閱讀目錄。
""",
        encoding="utf-8",
    )

    (stage_dir / "content" / "notes" / "welcome-note.md").write_text(
        """---
title: 第一則卡片筆記範例
date: 2026-11-26
stage: seedling
noteCode: N-01
tags: 閱讀摘錄, 靈感
summary: 尚未定型的短篇想法、讀書摘錄或課堂靈感，都可以放在「筆記」區隨時累積。
---

長文需要時間醞釀，但日常閃過的一句話或一段讀書心得，花三分鐘就能記成一張卡片筆記。
""",
        encoding="utf-8",
    )

    # 重新建置乾淨分享包的 manifest.json 與 rss.xml
    import subprocess
    subprocess.run(
        ["python3", str(stage_dir / "scripts" / "build_content.py")],
        cwd=str(stage_dir),
        env={**os.environ, "SITE_BASE_URL": "https://example.github.io/personal-site"},
        check=True,
        capture_output=True,
    )

    # 使用 macOS 原生 ditto 壓縮為 ZIP（完整保留中文檔名編碼與 .command 雙擊執行權限）
    if out_zip.exists():
        out_zip.unlink()
    subprocess.run(
        ["ditto", "-c", "-k", "--keepParent", str(stage_dir), str(out_zip)],
        check=True,
    )

print(f"✅ 打包完成！乾淨分享包已儲存於：\n   {out_zip}")
print("🔒 已自動排除你的所有私密金鑰（.sync.env / .studio-auth.json）、個人文章與上傳檔案，可直接安心傳給朋友！")
PY

echo ""
read "?按 Enter 鍵關閉視窗..."
