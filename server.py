#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — 個人品牌網站本機伺服器 ＋ 離線編輯工作台後端 (100% Python 標準庫，零外部依賴，完全支援離線運作)

提供 API：
- GET  /api/studio/bootstrap      → 讀取 site.config.js、theme.custom.css、manifest.json 與環境狀態
- POST /api/studio/config         → 儲存網站門面、關於頁、電子報等全域設定 (寫入 site.config.js)
- POST /api/studio/theme          → 儲存網站視覺色彩、字級與版面寬度設定 (寫入 theme.custom.css + theme.json)
- GET  /api/studio/item?type=&slug= → 讀取單篇 Markdown 的結構化欄位與內文
- POST /api/studio/item           → 新增或更新長文 / 筆記 / 電子報 (.md)，並自動重建 manifest.json 與 rss.xml
- DELETE /api/studio/item         → 刪除指定文章並自動重建索引
- POST /api/studio/sync           → 連網時手動觸發同步（同步至 Google Drive + Git commit/push + Netlify Hook）
"""

import json
import os
import re
import subprocess
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT_DIR = Path(__file__).resolve().parent
CONTENT_DIR = ROOT_DIR / "content"
CONFIG_JS_PATH = ROOT_DIR / "site.config.js"
THEME_CSS_PATH = ROOT_DIR / "theme.custom.css"
THEME_JSON_PATH = ROOT_DIR / "theme.config.json"

TYPE_TO_FOLDER = {
    "essay": CONTENT_DIR / "essays",
    "note": CONTENT_DIR / "notes",
    "letter": CONTENT_DIR / "letters",
}

DEFAULT_THEME = {
    "preset": "warm-paper",
    "bgPaper": "#f5f2eb",
    "bgSubtle": "#ece7dd",
    "bgElevated": "#faf8f4",
    "inkPrimary": "#1d1c19",
    "inkSecondary": "#534f46",
    "inkMuted": "#857f73",
    "accent": "#6e5039",
    "accentMoss": "#485643",
    "fontSize": 16,
    "lineHeight": 1.8,
    "maxWidth": 980,
}


def read_site_config() -> dict:
    if not CONFIG_JS_PATH.exists():
        return {}
    raw = CONFIG_JS_PATH.read_text(encoding="utf-8")
    # 擷取 window.SITE_CONFIG = { ... };
    match = re.search(r"window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$", raw)
    if not match:
        return {}
    js_obj = match.group(1)
    # 若已是合法 JSON 直接解析，否則透過簡易轉換處理未加引號的 key 與單行註解
    try:
        return json.loads(js_obj)
    except json.JSONDecodeError:
        cleaned_lines = []
        for line in js_obj.splitlines():
            # 移除非網址內的 // 註解
            line_no_comment = re.sub(r"(?<!:)//.*$", "", line)
            cleaned_lines.append(line_no_comment)
        cleaned = "\n".join(cleaned_lines)
        # 為未加引號的屬性名稱補上雙引號
        cleaned = re.sub(r'(?m)^(\s*)([a-zA-Z_]\w*)\s*:', r'\1"\2":', cleaned)
        # 移除結尾多餘逗號
        cleaned = re.sub(r",(\s*[}\]])", r"\1", cleaned)
        return json.loads(cleaned)


def write_site_config(data: dict):
    formatted = json.dumps(data, ensure_ascii=False, indent=2)
    content = (
        "/**\n"
        " * 網站全域設定檔 (site.config.js)\n"
        " * 可透過離線編輯工作台 (http://localhost:8788/studio.html) 視覺化修改，或直接編輯此檔案。\n"
        " */\n"
        f"window.SITE_CONFIG = {formatted};\n"
    )
    CONFIG_JS_PATH.write_text(content, encoding="utf-8")


def read_theme_config() -> dict:
    if THEME_JSON_PATH.exists():
        try:
            merged = dict(DEFAULT_THEME)
            merged.update(json.loads(THEME_JSON_PATH.read_text(encoding="utf-8")))
            return merged
        except Exception:
            pass
    return dict(DEFAULT_THEME)


def write_theme_config(theme: dict):
    merged = dict(DEFAULT_THEME)
    merged.update(theme)
    THEME_JSON_PATH.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    css = f"""/* 由「書齋離線編輯工作台 (studio.html)」自動產生與管理 */
:root,
[data-theme="paper"] {{
  --bg-paper: {merged['bgPaper']};
  --bg-subtle: {merged['bgSubtle']};
  --bg-elevated: {merged['bgElevated']};
  --ink-primary: {merged['inkPrimary']};
  --ink-secondary: {merged['inkSecondary']};
  --ink-muted: {merged['inkMuted']};
  --accent: {merged['accent']};
  --accent-hover: {merged['inkPrimary']};
  --accent-moss: {merged['accentMoss']};
}}

body {{
  font-size: {int(merged['fontSize'])}px;
  line-height: {float(merged['lineHeight'])};
}}

.site-shell {{
  max-width: {int(merged['maxWidth'])}px;
}}
"""
    THEME_CSS_PATH.write_text(css, encoding="utf-8")


def parse_markdown_file(md_path: Path):
    raw = md_path.read_text(encoding="utf-8")
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$", raw)
    if not match:
        return {}, raw
    meta = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta, match.group(2)


def compose_markdown(meta: dict, body: str) -> str:
    ordered_keys = [
        "title",
        "slug",
        "type",
        "noteCode",
        "stage",
        "issue",
        "date",
        "readingTime",
        "tags",
        "links",
        "summary",
    ]
    lines = ["---"]
    for k in ordered_keys:
        val = meta.get(k)
        if val is not None and str(val).strip() != "":
            clean_val = str(val).replace("\n", " ").strip()
            lines.append(f"{k}: {clean_val}")
    lines.append("---")
    lines.append("")
    lines.append(body.rstrip())
    lines.append("")
    return "\n".join(lines)


def rebuild_manifest():
    subprocess.run(
        [sys.executable, str(ROOT_DIR / "scripts" / "build_content.py")],
        cwd=str(ROOT_DIR),
        check=True,
    )


def get_git_status_summary():
    try:
        res = subprocess.run(
            ["git", "status", "--short"],
            cwd=str(ROOT_DIR),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0:
            lines = [l for l in res.stdout.splitlines() if l.strip()]
            return {"initialized": True, "changedCount": len(lines), "files": lines[:20]}
    except Exception:
        pass
    return {"initialized": False, "changedCount": 0, "files": []}


class StudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        # 確保編輯後預覽不會讀到舊快取
        if self.path.startswith("/api/") or self.path.endswith((".json", ".js", ".css", ".md")):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def _send_json(self, payload: dict, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        return json.loads(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/studio/bootstrap":
            manifest_path = CONTENT_DIR / "manifest.json"
            if not manifest_path.exists():
                rebuild_manifest()
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self._send_json(
                {
                    "ok": True,
                    "config": read_site_config(),
                    "theme": read_theme_config(),
                    "manifest": manifest,
                    "git": get_git_status_summary(),
                }
            )
            return

        if parsed.path == "/api/studio/item":
            qs = parse_qs(parsed.query)
            doc_type = (qs.get("type") or ["essay"])[0]
            slug = (qs.get("slug") or [""])[0]
            folder = TYPE_TO_FOLDER.get(doc_type)
            if not folder or not slug:
                self._send_json({"ok": False, "message": "缺少 type 或 slug 參數"}, HTTPStatus.BAD_REQUEST)
                return
            md_path = folder / f"{slug}.md"
            if not md_path.exists():
                self._send_json({"ok": False, "message": "找不到該篇檔案"}, HTTPStatus.NOT_FOUND)
                return
            meta, body = parse_markdown_file(md_path)
            self._send_json({"ok": True, "meta": meta, "body": body})
            return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            data = self._read_json_body()

            if parsed.path == "/api/studio/config":
                write_site_config(data.get("config", {}))
                self._send_json({"ok": True, "git": get_git_status_summary()})
                return

            if parsed.path == "/api/studio/theme":
                write_theme_config(data.get("theme", {}))
                self._send_json({"ok": True, "theme": read_theme_config(), "git": get_git_status_summary()})
                return

            if parsed.path == "/api/studio/item":
                meta = data.get("meta", {})
                body = data.get("body", "")
                old_slug = data.get("originalSlug", "").strip()
                old_type = data.get("originalType", "").strip()

                doc_type = meta.get("type", "essay")
                raw_slug = meta.get("slug", "").strip()
                slug = re.sub(r"[^a-zA-Z0-9_-]", "-", raw_slug).strip("-")
                if not slug:
                    self._send_json({"ok": False, "message": "請填寫英文網址代稱 (Slug)，例如 my-first-note"}, HTTPStatus.BAD_REQUEST)
                    return

                meta["slug"] = slug
                meta["type"] = doc_type
                folder = TYPE_TO_FOLDER.get(doc_type)
                if not folder:
                    self._send_json({"ok": False, "message": "不支援的內容類型"}, HTTPStatus.BAD_REQUEST)
                    return

                folder.mkdir(parents=True, exist_ok=True)
                target_path = folder / f"{slug}.md"

                # 若修改了 slug 或變更了分類，移除舊檔
                if old_slug and (old_slug != slug or (old_type and old_type != doc_type)):
                    prev_folder = TYPE_TO_FOLDER.get(old_type or doc_type)
                    if prev_folder:
                        old_file = prev_folder / f"{old_slug}.md"
                        if old_file.exists():
                            old_file.unlink()

                target_path.write_text(compose_markdown(meta, body), encoding="utf-8")
                rebuild_manifest()
                manifest = json.loads((CONTENT_DIR / "manifest.json").read_text(encoding="utf-8"))
                self._send_json(
                    {
                        "ok": True,
                        "slug": slug,
                        "type": doc_type,
                        "manifest": manifest,
                        "git": get_git_status_summary(),
                    }
                )
                return

            if parsed.path == "/api/studio/sync":
                sync_script = ROOT_DIR / "scripts" / "sync_cloud.py"
                res = subprocess.run(
                    [sys.executable, str(sync_script)],
                    cwd=str(ROOT_DIR),
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                self._send_json(
                    {
                        "ok": res.returncode == 0,
                        "output": (res.stdout + "\n" + res.stderr).strip(),
                        "git": get_git_status_summary(),
                    }
                )
                return

            self._send_json({"ok": False, "message": "未知的 API 路徑"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._send_json({"ok": False, "message": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/studio/item":
            qs = parse_qs(parsed.query)
            doc_type = (qs.get("type") or [""])[0]
            slug = (qs.get("slug") or [""])[0]
            folder = TYPE_TO_FOLDER.get(doc_type)
            if folder and slug:
                target = folder / f"{slug}.md"
                if target.exists():
                    target.unlink()
                    rebuild_manifest()
            manifest = json.loads((CONTENT_DIR / "manifest.json").read_text(encoding="utf-8"))
            self._send_json({"ok": True, "manifest": manifest, "git": get_git_status_summary()})
            return
        self._send_json({"ok": False, "message": "未知的 API 路徑"}, HTTPStatus.NOT_FOUND)


def main():
    port = int(os.environ.get("PORT", "8788"))
    # 確保首次啟動時已有 theme.config.json 與最新 manifest
    if not THEME_JSON_PATH.exists():
        write_theme_config(DEFAULT_THEME)
    rebuild_manifest()

    server = ThreadingHTTPServer(("127.0.0.1", port), StudioHandler)
    print(f"澄觀書齋本機服務已啟動：")
    print(f"  • 前台網站預覽：http://localhost:{port}/")
    print(f"  • 離線編輯工作台：http://localhost:{port}/studio.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n伺服器已關閉。")


if __name__ == "__main__":
    main()
