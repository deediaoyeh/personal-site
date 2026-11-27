#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — 個人品牌網站本機伺服器 ＋ 嚴謹雙重認證 (PBKDF2 + TOTP 2FA) 離線編輯工作台後端
100% Python 標準庫實作，支援離線認證、CSRF 防護、防暴力破解、照片與檔案拖曳上傳及 Google Drive 雲端硬碟選檔匯入。
"""

import base64
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT_DIR / "scripts"))
from security import StudioAuthManager  # noqa: E402

CONTENT_DIR = ROOT_DIR / "content"
UPLOADS_DIR = ROOT_DIR / "assets" / "uploads"
CONFIG_JS_PATH = ROOT_DIR / "site.config.js"
THEME_CSS_PATH = ROOT_DIR / "theme.custom.css"
THEME_JSON_PATH = ROOT_DIR / "theme.config.json"

AUTH = StudioAuthManager(ROOT_DIR)
COOKIE_NAME = "__studio_session"

TYPE_TO_FOLDER = {
    "essay": CONTENT_DIR / "essays",
    "note": CONTENT_DIR / "notes",
    "letter": CONTENT_DIR / "letters",
}

ALLOWED_UPLOAD_EXTS = {
    ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif", ".heic",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".key", ".pages", ".numbers", ".odt", ".ods", ".odp",
    ".csv", ".txt", ".md", ".json", ".zip", ".7z", ".rar", ".epub",
    ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".wav",
}
MAX_RESOURCE_UPLOAD_BYTES = 200 * 1024 * 1024  # 200 MB

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif"}
VIDEO_EXTS = {".mp4", ".webm", ".mov"}
AUDIO_EXTS = {".mp3", ".m4a", ".wav"}

PROTECTED_CORE_FILES = {"index.html", "styles.css", "theme.custom.css", "app.js"}
EXCLUDED_STUDIO_FILES = {
    "studio.html",
    "studio.css",
    "studio.js",
    "studio-media.js",
    "studio-cloud-client.js",
    "studio-analytics.js",
}

# =========================================================================
# Content Security Policy (CSP) 嚴謹安全標頭定義
# - script-src 嚴格禁止 unsafe-inline 與 unsafe-eval（認證閘門採用每請求隨機 Nonce）
# - 允許本機與雲端即時同步 API、Google Fonts、以及媒體上傳 blob:/data: 預覽
# =========================================================================
CSP_PUBLIC = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' blob: https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob: https:; "
    "media-src 'self' blob: https:; "
    "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com; "
    "connect-src 'self' https://api.github.com https://raw.githubusercontent.com https://deediao-studio.netlify.app https://script.google.com https://script.googleusercontent.com; "
    "frame-ancestors 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self' https://script.google.com https://script.googleusercontent.com"
)

CSP_STUDIO = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' blob: https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob: https:; "
    "media-src 'self' blob: https:; "
    "frame-src 'self' blob: https://www.youtube.com https://www.youtube-nocookie.com; "
    "connect-src 'self' https://deediao-studio.netlify.app https://raw.githubusercontent.com https://www.googleapis.com https://www.youtube.com https://script.google.com https://script.googleusercontent.com; "
    "frame-ancestors 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)

CSP_API = "default-src 'none'; frame-ancestors 'none'"


def build_auth_gate_csp(nonce: str) -> str:
    return (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )
FORBIDDEN_STATIC_PREFIXES = (
    "/.studio-auth.json",
    "/.studio-jwt.key",
    "/.studio-audit.log",
    "/.sync.env",
    "/.git",
    "/.netlify",
    "/.local-bin",
    "/server.py",
    "/scripts/",
    "/google/",
    "/netlify/",
)

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


# =========================================================================
# 檔案與設定輔助函式
# =========================================================================
def format_size(num_bytes: int) -> str:
    if num_bytes < 1024:
        return f"{num_bytes} B"
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def classify_ext(ext: str) -> str:
    ext = ext.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return "file"


def sanitize_upload_filename(raw_name: str) -> str:
    p = Path(raw_name.strip() or "upload.bin")
    ext = p.suffix.lower()
    stem = re.sub(r"[^\w\u4e00-\u9fa5\-]+", "-", p.stem).strip("-") or "file"
    return f"{stem[:60]}{ext}"


def unique_upload_path(filename: str) -> Path:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    clean = sanitize_upload_filename(filename)
    candidate = UPLOADS_DIR / clean
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    ext = candidate.suffix
    ts = datetime.now().strftime("%H%M%S")
    return UPLOADS_DIR / f"{stem}-{ts}{ext}"


def list_uploaded_media() -> list:
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    items = []
    for f in sorted(UPLOADS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not f.is_file() or f.name.startswith("."):
            continue
        st = f.stat()
        items.append(
            {
                "filename": f.name,
                "url": f"./assets/uploads/{f.name}",
                "size": st.st_size,
                "sizeLabel": format_size(st.st_size),
                "ext": f.suffix.lstrip(".").upper() or "FILE",
                "kind": classify_ext(f.suffix),
                "updatedAt": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
            }
        )
    return items


def find_gdrive_bin() -> str:
    candidates = [
        shutil.which("gdrive"),
        "/Users/deediao/.gemini/antigravity/bin/gdrive",
    ]
    for c in candidates:
        if c and Path(c).exists():
            return c
    return ""


def list_gdrive_items(folder_id: str, query: str, mode: str) -> dict:
    gdrive_bin = find_gdrive_bin()
    if not gdrive_bin:
        return {"ok": False, "message": "本機未偵測到 gdrive CLI 工具，請確認已啟用 Google Drive 外掛。"}

    if query:
        cmd = [gdrive_bin, "readonly", "search", "--name-contains", query, "--max", "40", "--json"]
    elif mode == "recent":
        cmd = [gdrive_bin, "readonly", "recent", "--max", "35", "--json"]
    elif folder_id and folder_id != "root":
        cmd = [gdrive_bin, "readonly", "ls", folder_id, "--max", "60", "--json"]
    else:
        cmd = [gdrive_bin, "readonly", "ls", "--max", "60", "--json"]

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "無法讀取 Google Drive").strip()
        return {"ok": False, "message": f"Google Drive 讀取失敗：{err}"}

    raw_list = json.loads(proc.stdout or "[]") if proc.stdout.strip() else []
    folders = []
    files = []
    for entry in raw_list:
        mime = entry.get("mimeType", "")
        is_folder = mime == "application/vnd.google-apps.folder"
        size_int = int(entry.get("size") or 0)
        item = {
            "id": entry.get("id", ""),
            "name": entry.get("name", ""),
            "mimeType": mime,
            "isFolder": is_folder,
            "size": size_int,
            "sizeLabel": "資料夾" if is_folder else (format_size(size_int) if size_int else "雲端文件"),
            "modifiedTime": (entry.get("modifiedTime") or "")[:10],
            "isImage": mime.startswith("image/"),
        }
        if is_folder:
            folders.append(item)
        else:
            files.append(item)

    return {"ok": True, "items": folders + files}


def import_gdrive_file(file_id: str, name: str, mime_type: str) -> dict:
    gdrive_bin = find_gdrive_bin()
    if not gdrive_bin:
        raise RuntimeError("找不到 gdrive CLI 工具")

    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    # Google 原生文件（Docs / Sheets / Slides）匯出為 PDF 供訪客下載閱讀
    if mime_type.startswith("application/vnd.google-apps."):
        base_name = sanitize_upload_filename(Path(name).stem + ".pdf")
        dest = unique_upload_path(base_name)
        proc = subprocess.run(
            [gdrive_bin, "readonly", "export", file_id, str(dest), "--format", "pdf"],
            capture_output=True,
            text=True,
            timeout=60,
        )
    else:
        ext = Path(name).suffix.lower()
        if not ext:
            guessed = mimetypes.guess_extension(mime_type) or ".bin"
            name = f"{name}{guessed}"
        dest = unique_upload_path(name)
        proc = subprocess.run(
            [gdrive_bin, "readonly", "download", file_id, "--out", str(dest)],
            capture_output=True,
            text=True,
            timeout=90,
        )

    if proc.returncode != 0 or not dest.exists():
        raise RuntimeError((proc.stderr or proc.stdout or "Google Drive 檔案下載失敗").strip())

    st = dest.stat()
    return {
        "ok": True,
        "filename": dest.name,
        "url": f"./assets/uploads/{dest.name}",
        "size": st.st_size,
        "sizeLabel": format_size(st.st_size),
        "ext": dest.suffix.lstrip(".").upper() or "FILE",
        "kind": classify_ext(dest.suffix),
    }


def get_local_github_token() -> str:
    tok = os.environ.get("GITHUB_TOKEN", "").strip() or os.environ.get("GH_TOKEN", "").strip()
    if tok:
        return tok
    try:
        proc = subprocess.run(
            ["git", "credential", "fill"],
            input="protocol=https\nhost=github.com\npath=deediaoyeh/personal-site.git\n\n",
            cwd=str(ROOT_DIR),
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0:
            kv = dict(line.split("=", 1) for line in proc.stdout.splitlines() if "=" in line)
            return kv.get("password", "").strip()
    except Exception:
        pass
    return ""


def upload_large_file_to_github_release(filepath: Path, raw_name: str, mime_type: str = "application/octet-stream") -> dict:
    """將附屬教材直接串流上傳至 GitHub Releases (attached-materials)，支援單檔最高 200 MB（GitHub 上限 2 GB），完全不佔 Git 倉庫體積。"""
    token = get_local_github_token()
    if not token:
        return {}
    rem = get_git_status_summary().get("remoteUrl", "")
    m = re.search(r"github\.com[:/]([^/]+)/([^/.]+)", rem)
    owner, repo = (m.group(1), m.group(2)) if m else ("deediaoyeh", "personal-site")
    tag = "attached-materials"
    headers_json = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    rel_obj = None
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{owner}/{repo}/releases/tags/{tag}", headers=headers_json)
        with urllib.request.urlopen(req, timeout=15) as r:
            rel_obj = json.loads(r.read().decode("utf-8"))
    except Exception:
        create_payload = json.dumps(
            {
                "tag_name": tag,
                "name": "書齋附屬教材與大型講義檔案庫 (Attached Materials)",
                "body": "由書齋編輯工作台自動管理之附屬教材與講義檔案（支援最高 200 MB 單檔，不佔用 Git 倉庫體積）。",
                "draft": False,
                "prerelease": False,
            }
        ).encode("utf-8")
        creq = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repo}/releases",
            data=create_payload,
            headers={**headers_json, "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(creq, timeout=20) as r:
            rel_obj = json.loads(r.read().decode("utf-8"))

    if not rel_obj or not rel_obj.get("id"):
        return {}

    ext = Path(raw_name).suffix.lower()
    stem = re.sub(r"[^\w\u4e00-\u9fa5\-]+", "-", Path(raw_name).stem).strip("-")[:60] or "material"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    asset_name = f"{stem}-{stamp}{ext}"
    size_bytes = filepath.stat().st_size
    up_url = f"https://uploads.github.com/repos/{owner}/{repo}/releases/{rel_obj['id']}/assets?name={urllib.parse.quote(asset_name)}"

    with filepath.open("rb") as bin_stream:
        up_req = urllib.request.Request(
            up_url,
            data=bin_stream,
            headers={
                **headers_json,
                "Content-Type": mime_type or "application/octet-stream",
                "Content-Length": str(size_bytes),
            },
            method="POST",
        )
        with urllib.request.urlopen(up_req, timeout=600) as up_resp:
            asset_data = json.loads(up_resp.read().decode("utf-8"))
            dl_url = asset_data.get("browser_download_url", "")
            if dl_url:
                return {
                    "label": raw_name,
                    "url": dl_url,
                    "downloadUrl": dl_url,
                    "sizeLabel": format_size(size_bytes),
                    "ext": ext.lstrip(".").upper() or "FILE",
                }
    return {}


def read_private_sync_token() -> str:
    val = os.environ.get("GOOGLE_WORKSPACE_SYNC_TOKEN", "").strip()
    if val:
        return val
    env_file = ROOT_DIR / ".sync.env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("GOOGLE_WORKSPACE_SYNC_TOKEN="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def call_newsletter_hub_secure(action_name: str, extra: dict) -> dict:
    cfg = read_site_config()
    script_url = (cfg.get("newsletter", {}) or {}).get("googleScriptUrl", "").strip()
    if not script_url:
        return {"ok": False, "message": "尚未綁定 Google Apps Script 網址"}
    sync_token = read_private_sync_token()
    if not sync_token:
        return {"ok": False, "message": "本機 .sync.env 尚未設定 GOOGLE_WORKSPACE_SYNC_TOKEN 同步保護金鑰"}
    body_obj = {"action": action_name, "token": sync_token, **extra}
    payload = json.dumps(body_obj).encode("utf-8")
    req = urllib.request.Request(
        script_url,
        data=payload,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def push_newsletter_draft_secure(issue: str, subject: str, content: str) -> dict:
    return call_newsletter_hub_secure("save_draft", {"issue": issue, "subject": subject, "content": content})


def read_private_analytics_key() -> str:
    val = os.environ.get("STUDIO_ANALYTICS_KEY", "").strip()
    if val:
        return val
    env_file = ROOT_DIR / ".sync.env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("STUDIO_ANALYTICS_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def fetch_owner_analytics_summary() -> dict:
    cfg = read_site_config()
    script_url = (cfg.get("newsletter", {}) or {}).get("googleScriptUrl", "").strip()
    if not script_url:
        return {"ok": False, "message": "尚未於「電子報與同步」綁定 Google Apps Script 網址"}
    key = read_private_analytics_key()
    if not key:
        return {"ok": False, "message": "本機尚未設定 STUDIO_ANALYTICS_KEY 私密讀取金鑰"}

    payload = json.dumps({"action": "analytics_summary", "analyticsKey": key}).encode("utf-8")
    req = urllib.request.Request(
        script_url,
        data=payload,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode("utf-8"))


def send_test_analytics_ping() -> dict:
    cfg = read_site_config()
    script_url = (cfg.get("newsletter", {}) or {}).get("googleScriptUrl", "").strip()
    if not script_url:
        return {"ok": False, "message": "尚未綁定 Google Apps Script 網址"}
    payload = json.dumps(
        {
            "action": "pageview",
            "route": "#/",
            "title": "首頁 · 書齋總覽（工作台連線驗證）",
            "pageType": "首頁",
            "visitorHash": "owner-verify",
            "referrer": "站長儀表板測試",
            "device": "desktop",
            "host": "deediaoyeh.github.io",
            "dwellSec": 85,
            "visitId": f"verify-{int(datetime.now().timestamp())}",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        script_url,
        data=payload,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def read_site_config() -> dict:
    if not CONFIG_JS_PATH.exists():
        return {}
    raw = CONFIG_JS_PATH.read_text(encoding="utf-8")
    match = re.search(r"window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$", raw)
    if not match:
        return {}
    js_obj = match.group(1)
    try:
        return json.loads(js_obj)
    except json.JSONDecodeError:
        cleaned_lines = [re.sub(r"(?<!:)//.*$", "", l) for l in js_obj.splitlines()]
        cleaned = "\n".join(cleaned_lines)
        cleaned = re.sub(r'([{,]\s*)([a-zA-Z_]\w*)\s*:', r'\1"\2":', cleaned)
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
    rebuild_manifest()


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
        "title", "slug", "type", "format", "noteCode", "stage",
        "issue", "date", "readingTime", "tags", "links",
        "resourceLabel", "resourceUrl", "resources", "summary",
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
    env = os.environ.copy()
    gitconfig = Path.home() / ".gitconfig"
    try:
        if gitconfig.exists():
            gitconfig.read_bytes()
    except PermissionError:
        env["GIT_CONFIG_GLOBAL"] = "/dev/null"

    remote_url = ""
    try:
        rem = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=str(ROOT_DIR), env=env, capture_output=True, text=True, timeout=5,
        )
        if rem.returncode == 0:
            remote_url = rem.stdout.strip()
    except Exception:
        pass

    try:
        res = subprocess.run(
            ["git", "status", "--short"],
            cwd=str(ROOT_DIR), env=env, capture_output=True, text=True, timeout=5,
        )
        if res.returncode == 0:
            lines = [l for l in res.stdout.splitlines() if l.strip()]
            return {"initialized": True, "changedCount": len(lines), "files": lines[:20], "remoteUrl": remote_url}
    except Exception:
        pass
    return {"initialized": False, "changedCount": 0, "files": [], "remoteUrl": remote_url}


def resolve_safe_web_path(rel_path: str) -> Path:
    clean = rel_path.strip().lstrip("/")
    if not clean or ".." in clean or clean in EXCLUDED_STUDIO_FILES or clean.startswith("."):
        raise ValueError("不允許存取此檔案路徑")
    full = (ROOT_DIR / clean).resolve()
    if ROOT_DIR != full and ROOT_DIR not in full.parents:
        raise ValueError("路徑超出專案目錄範圍")
    if full.suffix.lower() not in {".html", ".css", ".js"}:
        raise ValueError("僅支援編輯 .html、.css 或 .js 網頁檔案")
    return full


def list_editable_web_files() -> list:
    items = []
    core_order = [
        ("index.html", "網站主骨架 HTML"),
        ("styles.css", "靜謐書齋主樣式 CSS"),
        ("theme.custom.css", "視覺微調覆寫 CSS"),
    ]
    seen = set()
    for fname, label in core_order:
        if (ROOT_DIR / fname).exists():
            items.append({"path": fname, "label": label, "isCore": True})
            seen.add(fname)

    for p in sorted(ROOT_DIR.glob("*.html")):
        if p.name not in seen and p.name not in EXCLUDED_STUDIO_FILES:
            items.append({"path": p.name, "label": "獨立 HTML 頁面", "isCore": False})
            seen.add(p.name)

    pages_dir = ROOT_DIR / "pages"
    if pages_dir.exists():
        for p in sorted(pages_dir.glob("*.html")):
            items.append({"path": f"pages/{p.name}", "label": "獨立 HTML 子頁", "isCore": False})

    return items


# =========================================================================
# 嚴謹雙重認證閘門頁面 (未通過認證前絕不載入 studio.html / studio.js)
# =========================================================================
def build_auth_gate_html(nonce: str) -> str:
    configured = AUTH.is_configured()
    setup_data = None if configured else AUTH.prepare_initial_setup("Deediao")

    if not configured:
        form_html = f"""
        <span class="gate-kicker">FIRST-TIME SECURITY VAULT SETUP · 首次啟用雙重驗證</span>
        <h1 class="gate-title">建立工作台嚴謹認證金鑰</h1>
        <p class="gate-desc">為保護網站管理權限，首次進入請設定高強度主密碼（PBKDF2-SHA256 六十萬次雜湊），並綁定手機或 Mac 驗證器 App（RFC 6238 TOTP 六位數動態驗證碼，斷網離線亦可驗證）。</p>

        <div class="totp-setup-box">
          <div class="qr-frame">{setup_data['qrSvg']}</div>
          <div class="totp-info">
            <div class="step-tag">步驟 1：掃描 QR Code 或手動輸入密鑰</div>
            <p>請使用 Google Authenticator、1Password、Authy 或 iPhone／Mac 內建「密碼」App 掃描左側條碼（本條碼於本機離線運算產生，密鑰絕不外傳）。</p>
            <div class="secret-code-box">手動密鑰：<code>{setup_data['secret']}</code></div>
            <a href="{setup_data['otpauthUri']}" class="otp-uri-link">在 Mac「密碼」App 直接開啟綁定 →</a>
          </div>
        </div>

        <form id="setup-form" class="gate-form" autocomplete="off">
          <div class="gate-field">
            <label for="setup-pw">步驟 2：設定主管理密碼（至少 10 碼，需含英文與數字/符號）</label>
            <div class="pw-wrap">
              <input type="password" id="setup-pw" required minlength="10" placeholder="輸入高強度主管理密碼⋯" spellcheck="false" autocapitalize="off" />
              <button type="button" class="pw-toggle" data-toggle-pw="setup-pw">顯示密碼</button>
            </div>
          </div>
          <div class="gate-field">
            <label for="setup-pw2">再次確認主管理密碼</label>
            <div class="pw-wrap">
              <input type="password" id="setup-pw2" required minlength="10" placeholder="再次輸入相同主密碼⋯" spellcheck="false" autocapitalize="off" />
              <button type="button" class="pw-toggle" data-toggle-pw="setup-pw2">顯示密碼</button>
            </div>
          </div>
          <label class="gate-field">
            <span>步驟 3：輸入驗證器 App 顯示的 6 位數動態驗證碼</span>
            <input type="text" id="setup-totp" inputmode="numeric" pattern="[0-9 ]*" maxlength="8" required placeholder="例如 123456" class="code-input" />
          </label>
          <div id="gate-error" class="gate-error" role="alert"></div>
          <button type="submit" id="gate-submit" class="gate-btn">完成安全綁定並產生緊急恢復碼</button>
        </form>

        <div id="recovery-modal" class="recovery-box" hidden>
          <h2>✓ 雙重驗證已啟用 — 請立即保存緊急恢復碼</h2>
          <p>若未來遺失手機驗證器，可使用以下任一組單次恢復碼登入（每組使用一次即自動失效，系統僅存雜湊值，關閉後無法再次查看）：</p>
          <pre id="recovery-codes-text" class="recovery-pre"></pre>
          <div style="display:flex; gap:10px; margin-top:14px;">
            <button type="button" id="copy-recovery-btn" class="gate-btn-outline">複製恢復碼</button>
            <button type="button" id="enter-studio-btn" class="gate-btn">我已妥善保存，進入工作台 →</button>
          </div>
        </div>
        """
    else:
        form_html = """
        <span class="gate-kicker">AUTHENTICATION REQUIRED · 嚴謹雙重驗證閘門</span>
        <h1 class="gate-title">書齋離線編輯工作台</h1>
        <p class="gate-desc">此區域受雙重密碼學驗證保護（PBKDF2-SHA256 ＋ TOTP 動態驗證碼）。連續驗證失敗 5 次將自動鎖定 15 分鐘。</p>

        <form id="login-form" class="gate-form" autocomplete="off">
          <div class="gate-field">
            <label for="login-pw">第一因素：主管理密碼 (Master Passphrase)</label>
            <div class="pw-wrap">
              <input type="password" id="login-pw" required autofocus placeholder="輸入主管理密碼⋯" spellcheck="false" autocapitalize="off" />
              <button type="button" class="pw-toggle" data-toggle-pw="login-pw">顯示密碼</button>
            </div>
          </div>
          <label class="gate-field">
            <span>第二因素：6 位數動態驗證碼（或單次緊急恢復碼）</span>
            <input type="text" id="login-2fa" required placeholder="6 位數驗證碼 或 XXXX-XXXX-XXXX" class="code-input" />
          </label>
          <div id="gate-error" class="gate-error" role="alert"></div>
          <button type="submit" id="gate-submit" class="gate-btn">驗證身分並解鎖工作台</button>
        </form>
        <div style="margin-top:20px; font-size:0.82rem; color:#857f73;">
          <a href="./" style="color:inherit; border-bottom:1px solid #857f73;">← 返回公開網站首頁</a>
        </div>
        """

    return f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>安全驗證 · 書齋編輯工作台</title>
  <style>
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 32px 20px; background: #f5f2eb; color: #1d1c19;
      font-family: "Inter", "Noto Sans TC", "PingFang TC", sans-serif; line-height: 1.7;
    }}
    .gate-card {{
      width: 100%; max-width: 580px; background: #faf8f4; border: 1px solid rgba(29,28,25,0.28); padding: 40px 44px;
    }}
    .gate-kicker {{
      display: block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.73rem; letter-spacing: 0.12em; color: #6e5039; margin-bottom: 10px;
    }}
    .gate-title {{
      font-family: "Newsreader", "Noto Serif TC", "Songti TC", Georgia, serif;
      font-size: 1.7rem; font-weight: 500; margin: 0 0 10px;
    }}
    .gate-desc {{ margin: 0 0 24px; font-size: 0.9rem; color: #534f46; }}
    .totp-setup-box {{
      display: grid; grid-template-columns: 188px 1fr; gap: 20px; align-items: center;
      padding: 18px; background: #ece7dd; border: 1px solid rgba(29,28,25,0.16); margin-bottom: 22px;
    }}
    .qr-frame {{ display: flex; align-items: center; justify-content: center; background: #faf8f4; padding: 2px; border: 1px solid rgba(29,28,25,0.15); }}
    .totp-info p {{ margin: 6px 0 10px; font-size: 0.82rem; color: #534f46; line-height: 1.6; }}
    .step-tag {{ font-size: 0.8rem; font-weight: 600; }}
    .secret-code-box {{ font-size: 0.78rem; background: #faf8f4; padding: 6px 8px; border: 1px solid rgba(29,28,25,0.15); word-break: break-all; margin-bottom: 8px; }}
    .otp-uri-link {{ font-size: 0.8rem; color: #6e5039; text-decoration: none; border-bottom: 1px solid #6e5039; }}
    .gate-form {{ display: flex; flex-direction: column; gap: 14px; }}
    .gate-field {{ display: flex; flex-direction: column; gap: 5px; font-size: 0.82rem; color: #534f46; }}
    .gate-field input {{
      padding: 10px 12px; font-size: 0.95rem; background: #f5f2eb; border: 1px solid rgba(29,28,25,0.3);
      border-radius: 2px; color: #1d1c19; outline: none; font-family: inherit;
    }}
    .gate-field input:focus {{ border-color: #6e5039; }}
    .pw-wrap {{ position: relative; display: flex; align-items: center; width: 100%; }}
    .pw-wrap input {{ width: 100%; padding-right: 84px; }}
    .pw-toggle {{
      position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
      background: #faf8f4; border: 1px solid rgba(29,28,25,0.24); color: #534f46;
      font-size: 0.75rem; padding: 4px 9px; border-radius: 2px; cursor: pointer; font-family: inherit;
    }}
    .pw-toggle:hover {{ border-color: #6e5039; color: #1d1c19; }}
    .pw-toggle.is-showing {{ background: rgba(110,80,57,0.12); border-color: #6e5039; color: #6e5039; font-weight: 500; }}
    .code-input {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace !important; letter-spacing: 0.14em; font-size: 1.05rem !important; }}
    .gate-error {{ color: #9e3f33; font-size: 0.84rem; min-height: 1.2em; }}
    .gate-btn {{
      padding: 12px 18px; background: #1d1c19; color: #f5f2eb; border: 1px solid #1d1c19;
      border-radius: 2px; font-size: 0.92rem; font-weight: 500; cursor: pointer; font-family: inherit;
    }}
    .gate-btn:hover {{ opacity: 0.88; }}
    .gate-btn-outline {{
      padding: 10px 16px; background: transparent; color: #1d1c19; border: 1px solid rgba(29,28,25,0.35);
      border-radius: 2px; font-size: 0.88rem; cursor: pointer; font-family: inherit;
    }}
    .recovery-box {{ margin-top: 16px; padding: 20px; background: #ece7dd; border: 1px solid #485643; }}
    .recovery-box h2 {{ font-size: 1.1rem; margin: 0 0 8px; color: #485643; }}
    .recovery-box p {{ font-size: 0.84rem; margin: 0 0 12px; color: #534f46; }}
    .recovery-pre {{ background: #faf8f4; padding: 14px; border: 1px solid rgba(29,28,25,0.16); font-size: 0.9rem; letter-spacing: 0.08em; margin: 0; }}
    @media (max-width: 600px) {{ .totp-setup-box {{ grid-template-columns: 1fr; }} .gate-card {{ padding: 28px 22px; }} }}
  </style>
</head>
<body>
  <main class="gate-card">
    {form_html}
  </main>
  <script nonce="{nonce}">
    (function() {{
      document.querySelectorAll("[data-toggle-pw]").forEach((btn) => {{
        btn.addEventListener("click", () => {{
          const inp = document.getElementById(btn.getAttribute("data-toggle-pw"));
          if (!inp) return;
          const show = inp.type === "password";
          inp.type = show ? "text" : "password";
          btn.textContent = show ? "隱藏密碼" : "顯示密碼";
          btn.classList.toggle("is-showing", show);
          inp.focus();
        }});
      }});
      const errEl = document.getElementById("gate-error");
      const setupForm = document.getElementById("setup-form");
      if (setupForm) {{
        setupForm.addEventListener("submit", async (e) => {{
          e.preventDefault();
          errEl.textContent = "";
          const pw = document.getElementById("setup-pw").value;
          const pw2 = document.getElementById("setup-pw2").value;
          const totp = document.getElementById("setup-totp").value.trim();
          if (pw !== pw2) {{
            errEl.textContent = "兩次輸入的主管理密碼不一致。";
            return;
          }}
          const btn = document.getElementById("gate-submit");
          btn.disabled = true;
          try {{
            const res = await fetch("/api/auth/setup", {{
              method: "POST",
              headers: {{ "Content-Type": "application/json" }},
              body: JSON.stringify({{ password: pw, totpCode: totp }})
            }});
            const data = await res.json();
            if (!data.ok) throw new Error(data.message || "設定失敗");
            setupForm.hidden = true;
            document.querySelector(".totp-setup-box").hidden = true;
            const recModal = document.getElementById("recovery-modal");
            const codesText = (data.recoveryCodes || []).join("\\n");
            document.getElementById("recovery-codes-text").textContent = codesText;
            recModal.hidden = false;
            document.getElementById("copy-recovery-btn").onclick = () => {{
              navigator.clipboard.writeText(codesText);
              document.getElementById("copy-recovery-btn").textContent = "✓ 已複製到剪貼簿";
            }};
            document.getElementById("enter-studio-btn").onclick = () => window.location.reload();
          }} catch (err) {{
            errEl.textContent = err.message;
            btn.disabled = false;
          }}
        }});
      }}

      const loginForm = document.getElementById("login-form");
      if (loginForm) {{
        loginForm.addEventListener("submit", async (e) => {{
          e.preventDefault();
          errEl.textContent = "";
          const btn = document.getElementById("gate-submit");
          btn.disabled = true;
          try {{
            const res = await fetch("/api/auth/login", {{
              method: "POST",
              headers: {{ "Content-Type": "application/json" }},
              body: JSON.stringify({{
                password: document.getElementById("login-pw").value,
                secondFactor: document.getElementById("login-2fa").value
              }})
            }});
            const data = await res.json();
            if (!data.ok) throw new Error(data.message || "驗證失敗");
            window.location.reload();
          }} catch (err) {{
            errEl.textContent = err.message;
            btn.disabled = false;
          }}
        }});
      }}
    }})();
  </script>
</body>
</html>"""


# =========================================================================
# HTTP Handler
# =========================================================================
class StudioHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def end_headers(self):
        if (
            self.path.startswith("/api/")
            or self.path.startswith("/studio")
            or self.path.endswith((".json", ".js", ".css", ".md"))
        ):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")

        custom_csp = getattr(self, "_custom_csp", None)
        if custom_csp:
            self.send_header("Content-Security-Policy", custom_csp)
            self._custom_csp = None
        elif self.path.startswith("/api/"):
            self.send_header("Content-Security-Policy", CSP_API)
        elif self.path.startswith("/studio"):
            self.send_header("Content-Security-Policy", CSP_STUDIO)
        else:
            self.send_header("Content-Security-Policy", CSP_PUBLIC)

        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def _client_ip(self) -> str:
        return self.client_address[0] if self.client_address else "unknown"

    def _check_allowed_host(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].lower()
        return host in ("localhost", "127.0.0.1", "::1")

    def _get_session_token(self) -> str:
        raw_cookie = self.headers.get("Cookie")
        if not raw_cookie:
            return ""
        c = SimpleCookie()
        c.load(raw_cookie)
        return c[COOKIE_NAME].value if COOKIE_NAME in c else ""

    def _require_auth(self, require_csrf: bool = False):
        if not self._check_allowed_host():
            self._send_json({"ok": False, "message": "拒絕非本機 Host 存取"}, HTTPStatus.FORBIDDEN)
            return None
        token = self._get_session_token()
        csrf_hdr = self.headers.get("X-Studio-CSRF", "")
        sess = AUTH.validate_session(token, csrf_header=csrf_hdr, require_csrf=require_csrf)
        if not sess:
            status = HTTPStatus.FORBIDDEN if (require_csrf and token in AUTH.sessions) else HTTPStatus.UNAUTHORIZED
            msg = "安全憑證已逾時或未通過雙重驗證，請重新登入。" if status == HTTPStatus.UNAUTHORIZED else "CSRF 安全權杖驗證失敗。"
            self._send_json({"ok": False, "authRequired": True, "message": msg}, status)
            return None
        return sess

    def _send_json(self, payload: dict, status=HTTPStatus.OK, extra_headers: list = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers:
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html_str: str, status=HTTPStatus.OK):
        body = html_str.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 60 * 1024 * 1024:
            raise ValueError("上傳檔案超過 60MB 限制")
        raw = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        return json.loads(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        clean_path = parsed.path

        # 1. 阻擋敏感設定與後端原始碼直接靜態下載
        if any(clean_path == p or clean_path.startswith(p) for p in FORBIDDEN_STATIC_PREFIXES):
            self._send_html("403 Forbidden", HTTPStatus.FORBIDDEN)
            return

        # 2. 認證狀態查詢
        if clean_path == "/api/auth/status":
            sess = AUTH.validate_session(self._get_session_token())
            self._send_json(
                {
                    "ok": True,
                    "configured": AUTH.is_configured(),
                    "authenticated": bool(sess),
                    "csrfToken": sess["csrf"] if sess else "",
                }
            )
            return

        # 3. 保護工作台靜態資源 (/studio.html, /studio.js, /studio.css)
        if clean_path in ("/studio.html", "/studio"):
            if not self._check_allowed_host():
                self._send_html("403 Forbidden", HTTPStatus.FORBIDDEN)
                return
            sess = AUTH.validate_session(self._get_session_token())
            if not sess:
                nonce = secrets.token_urlsafe(16)
                self._custom_csp = build_auth_gate_csp(nonce)
                self._send_html(build_auth_gate_html(nonce), HTTPStatus.OK)
                return
            if clean_path == "/studio":
                self.path = "/studio.html"
            super().do_GET()
            return

        if clean_path in ("/studio.js", "/studio.css", "/studio-media.js", "/studio-cloud-client.js", "/studio-analytics.js"):
            sess = AUTH.validate_session(self._get_session_token())
            if not sess:
                self._send_html("401 Unauthorized", HTTPStatus.UNAUTHORIZED)
                return
            super().do_GET()
            return

        # 4. 保護所有 /api/studio/* 讀取端點
        if clean_path.startswith("/api/studio/"):
            sess = self._require_auth(require_csrf=False)
            if not sess:
                return

            if clean_path == "/api/studio/bootstrap":
                manifest_path = CONTENT_DIR / "manifest.json"
                if not manifest_path.exists():
                    rebuild_manifest()
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                self._send_json(
                    {
                        "ok": True,
                        "csrfToken": sess["csrf"],
                        "config": read_site_config(),
                        "theme": read_theme_config(),
                        "manifest": manifest,
                        "webFiles": list_editable_web_files(),
                        "media": list_uploaded_media(),
                        "git": get_git_status_summary(),
                    }
                )
                return

            if clean_path == "/api/studio/media":
                self._send_json({"ok": True, "media": list_uploaded_media()})
                return

            if clean_path == "/api/studio/analytics":
                try:
                    summary = fetch_owner_analytics_summary()
                    self._send_json(summary, HTTPStatus.OK if summary.get("ok") else HTTPStatus.BAD_REQUEST)
                except Exception as exc:
                    self._send_json({"ok": False, "message": f"讀取雲端點閱統計失敗：{exc}"}, HTTPStatus.BAD_GATEWAY)
                return

            if clean_path == "/api/studio/newsletter/records":
                try:
                    rec_res = call_newsletter_hub_secure("newsletter_records", {})
                    self._send_json(rec_res, HTTPStatus.OK if rec_res.get("ok") else HTTPStatus.BAD_REQUEST)
                except Exception as exc:
                    self._send_json({"ok": False, "message": f"讀取電子報派送紀錄失敗：{exc}"}, HTTPStatus.BAD_GATEWAY)
                return

            if clean_path == "/api/studio/gdrive/list":
                qs = parse_qs(parsed.query)
                folder_id = (qs.get("folderId") or ["root"])[0]
                query = (qs.get("query") or [""])[0].strip()
                mode = (qs.get("mode") or ["folder"])[0]
                res = list_gdrive_items(folder_id, query, mode)
                self._send_json(res, HTTPStatus.OK if res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/web-files":
                self._send_json({"ok": True, "webFiles": list_editable_web_files()})
                return

            if clean_path == "/api/studio/web-file":
                qs = parse_qs(parsed.query)
                rel_path = (qs.get("path") or [""])[0]
                try:
                    target = resolve_safe_web_path(rel_path)
                    if not target.exists():
                        self._send_json({"ok": False, "message": "找不到指定網頁檔"}, HTTPStatus.NOT_FOUND)
                        return
                    self._send_json(
                        {
                            "ok": True,
                            "path": rel_path,
                            "content": target.read_text(encoding="utf-8"),
                            "isCore": rel_path in PROTECTED_CORE_FILES,
                        }
                    )
                except ValueError as exc:
                    self._send_json({"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/item":
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

            self._send_json({"ok": False, "message": "未知的 API 路徑"}, HTTPStatus.NOT_FOUND)
            return

        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        clean_path = parsed.path

        if not self._check_allowed_host():
            self._send_json({"ok": False, "message": "拒絕非本機 Host 存取"}, HTTPStatus.FORBIDDEN)
            return

        try:
            # ── 支援單檔最高 200 MB 之二進位串流上傳（本機離線模式備援）──────
            if clean_path == "/api/studio/resources/upload-local-stream":
                sess = self._require_auth(require_csrf=True)
                if not sess:
                    return
                qs = parse_qs(parsed.query)
                raw_name = (qs.get("name") or ["material.bin"])[0]
                ext = Path(raw_name).suffix.lower()
                if ext and ext not in ALLOWED_UPLOAD_EXTS:
                    self._send_json({"ok": False, "message": f"不支援上傳 {ext} 格式檔案"}, HTTPStatus.BAD_REQUEST)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_RESOURCE_UPLOAD_BYTES:
                    self._send_json({"ok": False, "message": "單一檔案大小須介於 1 Byte 至 200 MB 之間"}, HTTPStatus.BAD_REQUEST)
                    return
                dest = unique_upload_path(raw_name)
                remaining = length
                with dest.open("wb") as out_f:
                    while remaining > 0:
                        chunk = self.rfile.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        out_f.write(chunk)
                        remaining -= len(chunk)
                st = dest.stat()
                mime_hdr = self.headers.get("Content-Type", "application/octet-stream")
                # 只要連網可用（或檔案超過 15 MB），優先直傳 GitHub Releases 教材庫（最高支援 200 MB+，完全不佔 Git 倉庫體積，讀者全球 CDN 高速下載）
                if st.st_size > 15 * 1024 * 1024:
                    try:
                        rel_res = upload_large_file_to_github_release(dest, raw_name, mime_hdr)
                        if rel_res and rel_res.get("url"):
                            dest.unlink(missing_ok=True)
                            self._send_json({"ok": True, "resource": rel_res})
                            return
                    except Exception:
                        pass

                self._send_json(
                    {
                        "ok": True,
                        "resource": {
                            "label": raw_name,
                            "url": f"./assets/uploads/{dest.name}",
                            "sizeLabel": format_size(st.st_size),
                            "ext": ext.lstrip(".").upper() or "FILE",
                        },
                    }
                )
                return

            data = self._read_json_body()

            # ── 認證相關端點 ─────────────────────────────────────────────
            if clean_path == "/api/auth/setup":
                result = AUTH.complete_initial_setup(
                    data.get("password", ""),
                    data.get("totpCode", ""),
                    self._client_ip(),
                )
                # 背景自動將加密雜湊（不含明文密碼）同步至 Netlify 雲端環境變數，使 GitHub 主站與 Netlify 備份站工作台同步啟用 2FA
                try:
                    subprocess.Popen(
                        [sys.executable, str(ROOT_DIR / "scripts" / "sync_auth_to_netlify.py")],
                        cwd=str(ROOT_DIR),
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                    )
                except Exception:
                    pass
                sess = result["session"]
                cookie_val = f"{COOKIE_NAME}={sess['token']}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200"
                self._send_json(
                    {"ok": True, "recoveryCodes": result["recoveryCodes"], "csrfToken": sess["csrf"]},
                    HTTPStatus.OK,
                    extra_headers=[("Set-Cookie", cookie_val)],
                )
                return

            if clean_path == "/api/auth/login":
                sess = AUTH.verify_login(
                    data.get("password", ""),
                    data.get("secondFactor", ""),
                    self._client_ip(),
                )
                cookie_val = f"{COOKIE_NAME}={sess['token']}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200"
                self._send_json(
                    {"ok": True, "csrfToken": sess["csrf"]},
                    HTTPStatus.OK,
                    extra_headers=[("Set-Cookie", cookie_val)],
                )
                return

            if clean_path == "/api/auth/logout":
                AUTH.logout(self._get_session_token(), self._client_ip())
                clear_cookie = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
                self._send_json({"ok": True}, HTTPStatus.OK, extra_headers=[("Set-Cookie", clear_cookie)])
                return

            # ── 以下所有 /api/studio/* 寫入端點皆強制要求 Session + CSRF ──
            sess = self._require_auth(require_csrf=True)
            if not sess:
                return

            if clean_path == "/api/studio/upload":
                raw_name = data.get("filename", "upload.bin")
                ext = Path(raw_name).suffix.lower()
                if ext not in ALLOWED_UPLOAD_EXTS:
                    self._send_json(
                        {"ok": False, "message": f"基於安全限制，不支援上傳 {ext or '無副檔名'} 類型檔案。"},
                        HTTPStatus.BAD_REQUEST,
                    )
                    return
                b64_str = data.get("dataBase64", "")
                if "," in b64_str and b64_str.startswith("data:"):
                    b64_str = b64_str.split(",", 1)[1]
                raw_bytes = base64.b64decode(b64_str)
                dest = unique_upload_path(raw_name)
                dest.write_bytes(raw_bytes)
                st = dest.stat()
                self._send_json(
                    {
                        "ok": True,
                        "filename": dest.name,
                        "url": f"./assets/uploads/{dest.name}",
                        "size": st.st_size,
                        "sizeLabel": format_size(st.st_size),
                        "ext": dest.suffix.lstrip(".").upper() or "FILE",
                        "kind": classify_ext(dest.suffix),
                        "media": list_uploaded_media(),
                        "git": get_git_status_summary(),
                    }
                )
                return

            if clean_path == "/api/studio/gdrive/import":
                file_id = data.get("fileId", "").strip()
                name = data.get("name", "drive-file").strip()
                mime_type = data.get("mimeType", "").strip()
                if not file_id:
                    self._send_json({"ok": False, "message": "缺少 Google Drive 檔案 ID"}, HTTPStatus.BAD_REQUEST)
                    return
                imported = import_gdrive_file(file_id, name, mime_type)
                imported["media"] = list_uploaded_media()
                imported["git"] = get_git_status_summary()
                self._send_json(imported)
                return

            if clean_path == "/api/studio/config":
                write_site_config(data.get("config", {}))
                self._send_json({"ok": True, "git": get_git_status_summary()})
                return

            if clean_path == "/api/studio/theme":
                write_theme_config(data.get("theme", {}))
                self._send_json({"ok": True, "theme": read_theme_config(), "git": get_git_status_summary()})
                return

            if clean_path == "/api/studio/item":
                meta = data.get("meta", {})
                body = data.get("body", "")
                old_slug = data.get("originalSlug", "").strip()
                old_type = data.get("originalType", "").strip()

                doc_type = meta.get("type", "essay")
                raw_slug = meta.get("slug", "").strip()
                slug = re.sub(r"[^a-zA-Z0-9_-]", "-", raw_slug).strip("-")
                if not slug:
                    self._send_json({"ok": False, "message": "請填寫英文網址代稱 (Slug)"}, HTTPStatus.BAD_REQUEST)
                    return

                meta["slug"] = slug
                meta["type"] = doc_type
                folder = TYPE_TO_FOLDER.get(doc_type)
                if not folder:
                    self._send_json({"ok": False, "message": "不支援的內容類型"}, HTTPStatus.BAD_REQUEST)
                    return

                folder.mkdir(parents=True, exist_ok=True)
                target_path = folder / f"{slug}.md"

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
                    {"ok": True, "slug": slug, "type": doc_type, "manifest": manifest, "git": get_git_status_summary()}
                )
                return

            if clean_path == "/api/studio/web-file":
                rel_path = data.get("path", "").strip()
                content = data.get("content", "")
                target = resolve_safe_web_path(rel_path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
                self._send_json(
                    {"ok": True, "path": rel_path, "webFiles": list_editable_web_files(), "git": get_git_status_summary()}
                )
                return

            if clean_path == "/api/studio/git-remote":
                remote_url = data.get("remoteUrl", "").strip()
                if not remote_url:
                    self._send_json({"ok": False, "message": "請輸入有效的 GitHub 倉庫網址"}, HTTPStatus.BAD_REQUEST)
                    return
                check = subprocess.run(["git", "remote", "get-url", "origin"], cwd=str(ROOT_DIR), capture_output=True)
                if check.returncode == 0:
                    subprocess.run(["git", "remote", "set-url", "origin", remote_url], cwd=str(ROOT_DIR), check=True)
                else:
                    subprocess.run(["git", "remote", "add", "origin", remote_url], cwd=str(ROOT_DIR), check=True)
                self._send_json({"ok": True, "git": get_git_status_summary()})
                return

            if clean_path == "/api/studio/sync":
                sync_script = ROOT_DIR / "scripts" / "sync_cloud.py"
                qs = parse_qs(parsed.query)
                cmd = [sys.executable, str(sync_script)]
                if (qs.get("fast") or ["0"])[0] == "1":
                    cmd.append("--fast")
                res = subprocess.run(
                    cmd,
                    cwd=str(ROOT_DIR),
                    capture_output=True,
                    text=True,
                    timeout=150,
                )
                self._send_json(
                    {
                        "ok": res.returncode == 0,
                        "output": (res.stdout + "\n" + res.stderr).strip(),
                        "git": get_git_status_summary(),
                    }
                )
                return

            if clean_path == "/api/studio/analytics/test-ping":
                ping_res = send_test_analytics_ping()
                self._send_json(ping_res, HTTPStatus.OK if ping_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/newsletter/push-draft":
                draft_res = push_newsletter_draft_secure(
                    str(data.get("issue", "01")),
                    str(data.get("subject", "")),
                    str(data.get("content", "")),
                )
                self._send_json(draft_res, HTTPStatus.OK if draft_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/newsletter/test-send":
                cfg = read_site_config()
                default_email = (cfg.get("brand", {}) or {}).get("email", "")
                test_res = call_newsletter_hub_secure(
                    "send_test_newsletter",
                    {
                        "issue": str(data.get("issue", "01")),
                        "subject": str(data.get("subject", "")),
                        "content": str(data.get("content", "")),
                        "toEmail": str(data.get("toEmail") or default_email),
                    },
                )
                self._send_json(test_res, HTTPStatus.OK if test_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/newsletter/send-live":
                live_res = call_newsletter_hub_secure(
                    "send_live_newsletter",
                    {
                        "issue": str(data.get("issue", "01")),
                        "subject": str(data.get("subject", "")),
                        "content": str(data.get("content", "")),
                        "createdAt": str(data.get("createdAt", "")),
                    },
                )
                self._send_json(live_res, HTTPStatus.OK if live_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/newsletter/schedule":
                sched_res = call_newsletter_hub_secure(
                    "schedule_newsletter",
                    {
                        "issue": str(data.get("issue", "01")),
                        "subject": str(data.get("subject", "")),
                        "content": str(data.get("content", "")),
                        "scheduledAt": str(data.get("scheduledAt", "")),
                        "slug": str(data.get("slug", "")),
                        "rawMd": str(data.get("rawMd", "")),
                    },
                )
                self._send_json(sched_res, HTTPStatus.OK if sched_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/newsletter/cancel-schedule":
                cancel_res = call_newsletter_hub_secure(
                    "cancel_newsletter_schedule",
                    {
                        "rowNumber": int(data.get("rowNumber", 0)),
                        "issue": str(data.get("issue", "")),
                    },
                )
                self._send_json(cancel_res, HTTPStatus.OK if cancel_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/resources/init-upload":
                init_res = call_newsletter_hub_secure(
                    "resource_init_upload",
                    {
                        "filename": str(data.get("filename", "")),
                        "mimeType": str(data.get("mimeType", "application/octet-stream")),
                        "sizeBytes": int(data.get("sizeBytes", 0)),
                        "origin": str(data.get("origin") or f"http://{self.headers.get('Host', 'localhost:8788')}"),
                    },
                )
                self._send_json(init_res, HTTPStatus.OK if init_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/resources/finalize-upload":
                fin_res = call_newsletter_hub_secure(
                    "resource_finalize_upload",
                    {
                        "fileId": str(data.get("fileId", "")),
                        "displayLabel": str(data.get("displayLabel", "")),
                        "sizeBytes": int(data.get("sizeBytes", 0)),
                    },
                )
                self._send_json(fin_res, HTTPStatus.OK if fin_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            if clean_path == "/api/studio/resources/upload-release-asset":
                rel_res = call_newsletter_hub_secure(
                    "resource_upload_release_asset",
                    {
                        "filename": str(data.get("filename", "")),
                        "displayLabel": str(data.get("displayLabel", "")),
                        "mimeType": str(data.get("mimeType", "application/octet-stream")),
                        "dataBase64": str(data.get("dataBase64", "")),
                    },
                )
                self._send_json(rel_res, HTTPStatus.OK if rel_res.get("ok") else HTTPStatus.BAD_REQUEST)
                return

            self._send_json({"ok": False, "message": "未知的 API 路徑"}, HTTPStatus.NOT_FOUND)
        except PermissionError as exc:
            self._send_json({"ok": False, "message": str(exc)}, HTTPStatus.UNAUTHORIZED)
        except ValueError as exc:
            self._send_json({"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            self._send_json({"ok": False, "message": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self):
        parsed = urlparse(self.path)
        sess = self._require_auth(require_csrf=True)
        if not sess:
            return

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

        if parsed.path == "/api/studio/web-file":
            qs = parse_qs(parsed.query)
            rel_path = (qs.get("path") or [""])[0]
            if rel_path in PROTECTED_CORE_FILES:
                self._send_json({"ok": False, "message": "系統核心檔案不可刪除"}, HTTPStatus.BAD_REQUEST)
                return
            try:
                target = resolve_safe_web_path(rel_path)
                if target.exists():
                    target.unlink()
                self._send_json(
                    {"ok": True, "webFiles": list_editable_web_files(), "git": get_git_status_summary()}
                )
            except ValueError as exc:
                self._send_json({"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
            return

        self._send_json({"ok": False, "message": "未知的 API 路徑"}, HTTPStatus.NOT_FOUND)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_newsletter_scheduler_watcher():
    import threading
    import time

    def _loop():
        while True:
            time.sleep(90)
            try:
                cfg = read_site_config()
                script_url = (cfg.get("newsletter", {}) or {}).get("googleScriptUrl", "").strip()
                if script_url:
                    req = urllib.request.Request(
                        script_url,
                        data=json.dumps({"action": "tick_scheduled_newsletters"}).encode("utf-8"),
                        headers={"Content-Type": "text/plain;charset=utf-8"},
                        method="POST",
                    )
                    urllib.request.urlopen(req, timeout=20).read()
            except Exception:
                pass

    t = threading.Thread(target=_loop, daemon=True)
    t.start()


def main():
    port = int(os.environ.get("PORT", "8788"))
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    gitkeep = UPLOADS_DIR / ".gitkeep"
    if not gitkeep.exists():
        gitkeep.write_text("", encoding="utf-8")

    if not THEME_JSON_PATH.exists():
        write_theme_config(DEFAULT_THEME)
    rebuild_manifest()
    start_newsletter_scheduler_watcher()

    server = ReusableThreadingHTTPServer(("127.0.0.1", port), StudioHandler)
    print(f"書齋本機服務已啟動（僅綁定本機 127.0.0.1）：")
    print(f"  • 前台網站預覽：http://localhost:{port}/")
    print(f"  • 受雙重驗證保護之編輯工作台：http://localhost:{port}/studio.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n伺服器已關閉。")


if __name__ == "__main__":
    main()
