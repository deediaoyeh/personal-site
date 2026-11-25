#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_content.py — 知識庫內容同步與索引生成器
功能：
1. 若設定環境變數 GOOGLE_WORKSPACE_FEED_URL，自動從你的 Google Workspace (Google Drive / Docs) 拉取最新文章與筆記寫入 content/。
2. 掃描 content/essays、content/notes、content/letters 下所有 .md 檔案的 Frontmatter。
3. 自動產生前端讀取用的 content/manifest.json 與標準訂閱源 rss.xml。
"""

import json
import os
import re
import sys
import urllib.request
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

ROOT_DIR = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT_DIR / "content"

TYPE_DIRS = {
    "essay": CONTENT_DIR / "essays",
    "note": CONTENT_DIR / "notes",
    "letter": CONTENT_DIR / "letters",
}


def sync_from_google_workspace():
    """若設定 GOOGLE_WORKSPACE_FEED_URL，從 Google Apps Script 端點拉取雲端硬碟內容"""
    feed_url = os.environ.get("GOOGLE_WORKSPACE_FEED_URL", "").strip()
    sync_token = os.environ.get("GOOGLE_WORKSPACE_SYNC_TOKEN", "").strip()
    if not feed_url:
        return 0

    sep = "&" if "?" in feed_url else "?"
    url = f"{feed_url}{sep}action=feed"
    if sync_token:
        url += f"&token={sync_token}"

    print(f"正在從 Google Workspace 同步內容⋯")
    req = urllib.request.Request(url, headers={"User-Agent": "WarmCraft-Sync/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    if not data.get("ok"):
        raise RuntimeError(f"Google Workspace 回傳錯誤：{data.get('message')}")

    count = 0
    for doc in data.get("documents", []):
        doc_type = doc.get("type", "note")
        slug = re.sub(r"[^a-zA-Z0-9_-]", "-", doc.get("slug", "")).strip("-")
        markdown = doc.get("markdown", "")
        if not slug or not markdown or doc_type not in TYPE_DIRS:
            continue
        target_dir = TYPE_DIRS[doc_type]
        target_dir.mkdir(parents=True, exist_ok=True)
        target_file = target_dir / f"{slug}.md"
        target_file.write_text(markdown.rstrip() + "\n", encoding="utf-8")
        count += 1

    print(f"已從 Google Workspace 更新 {count} 篇內容檔案。")
    return count


def parse_frontmatter(md_text: str):
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$", md_text)
    if not match:
        return {}, md_text
    raw_meta, body = match.group(1), match.group(2)
    meta = {}
    for line in raw_meta.splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        meta[k.strip()] = v.strip().strip('"').strip("'")
    return meta, body


def estimate_reading_time(text: str) -> str:
    clean = re.sub(r"[#*>`_\-\[\]\(\)]", "", text)
    chars = len(clean.strip())
    minutes = max(1, round(chars / 380))
    return f"{minutes} min"


def build_manifest_and_rss():
    items = []
    for doc_type, folder in TYPE_DIRS.items():
        folder.mkdir(parents=True, exist_ok=True)
        for md_path in sorted(folder.glob("*.md")):
            raw = md_path.read_text(encoding="utf-8")
            meta, body = parse_frontmatter(raw)
            slug = meta.get("slug") or md_path.stem
            tags = [t.strip() for t in meta.get("tags", "").split(",") if t.strip()]
            links = [l.strip() for l in meta.get("links", "").split(",") if l.strip()]

            entry = {
                "title": meta.get("title", slug),
                "slug": slug,
                "type": meta.get("type", doc_type),
                "format": meta.get("format", "markdown"),
                "date": meta.get("date", "2026-01-01"),
                "readingTime": meta.get("readingTime") or estimate_reading_time(body),
                "summary": meta.get("summary", ""),
                "tags": tags,
                "links": links,
                "path": f"./content/{folder.name}/{md_path.name}",
            }
            if "stage" in meta:
                entry["stage"] = meta["stage"]
            if "noteCode" in meta:
                entry["noteCode"] = meta["noteCode"]
            if "issue" in meta:
                try:
                    entry["issue"] = int(meta["issue"])
                except ValueError:
                    entry["issue"] = meta["issue"]

            items.append(entry)

    # 依日期由新到舊排序
    items.sort(key=lambda x: x.get("date", ""), reverse=True)

    manifest = {
        "updatedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "count": len(items),
        "items": items,
    }
    manifest_path = CONTENT_DIR / "manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # 讀取 site.config.js 的最新品牌名稱與簡介，同步更新 RSS 與 index.html 快取版本號
    studio_title = "個人知識庫與電子報"
    studio_desc = "在資訊過載的時代，慢下來拆解複雜問題、累積可複用的思維模型。"
    cfg_path = ROOT_DIR / "site.config.js"
    if cfg_path.exists():
        raw_cfg = cfg_path.read_text(encoding="utf-8")
        m_cfg = re.search(r"window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$", raw_cfg)
        if m_cfg:
            try:
                cfg_obj = json.loads(m_cfg.group(1))
                studio_title = cfg_obj.get("brand", {}).get("studioTitle", studio_title)
                studio_desc = cfg_obj.get("brand", {}).get("tagline", studio_desc)
            except Exception:
                pass

    # 為 index.html 內的靜態設定與樣式加上版本查詢參數，徹底杜絕瀏覽器舊快取
    index_path = ROOT_DIR / "index.html"
    if index_path.exists():
        ver = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        idx_html = index_path.read_text(encoding="utf-8")
        idx_html = re.sub(r"<title>.*?</title>", f"<title>{escape(studio_title)}</title>", idx_html)
        idx_html = re.sub(r'(\./(?:site\.config\.js|theme\.custom\.css|styles\.css|app\.js))(?:\?v=[^"\']+)?', rf"\1?v={ver}", idx_html)
        index_path.write_text(idx_html, encoding="utf-8")

    # 產生 RSS 2.0 訂閱檔
    site_url = os.environ.get("SITE_BASE_URL", "https://deediaoyeh.github.io/personal-site").rstrip("/")
    rss_items = []
    for it in items:
        route_prefix = (
            "essays" if it["type"] == "essay" else "notes" if it["type"] == "note" else "letters"
        )
        link = f"{site_url}/#/{route_prefix}/{it['slug']}"
        rss_items.append(
            f"""    <item>
      <title>{escape(it['title'])}</title>
      <link>{escape(link)}</link>
      <guid>{escape(link)}</guid>
      <pubDate>{escape(it['date'])}</pubDate>
      <description>{escape(it['summary'])}</description>
    </item>"""
        )

    rss_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>{escape(studio_title)}</title>
    <link>{escape(site_url)}</link>
    <description>{escape(studio_desc)}</description>
    <language>zh-TW</language>
{chr(10).join(rss_items)}
  </channel>
</rss>
"""
    (ROOT_DIR / "rss.xml").write_text(rss_xml, encoding="utf-8")
    print(f"索引建置完成：共收錄 {len(items)} 篇內容 → content/manifest.json & rss.xml")


if __name__ == "__main__":
    try:
        sync_from_google_workspace()
        build_manifest_and_rss()
    except Exception as exc:
        print(f"[錯誤] {exc}", file=sys.stderr)
        sys.exit(1)
