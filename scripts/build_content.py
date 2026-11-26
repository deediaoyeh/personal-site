#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_content.py — 靜態知識庫索引、全文檢索摘要、社群預覽導頁 (Open Graph)、Sitemap 與 RSS 建置器

功能：
1. 若設定了 GOOGLE_WORKSPACE_FEED_URL，可自動從 Google Workspace 拉取最新內容寫入 content/
2. 掃描 content/{essays,notes,letters}/*.md，解析 YAML Frontmatter 並擷取純文字全文檢索欄位 (searchText)
3. 自動輸出：
   - content/manifest.json（含全文檢索索引，零額外請求）
   - s/<slug>.html（每篇文章獨立的 Open Graph 社群預覽卡與 SEO 導頁，LINE / FB 貼網址自動顯示專屬標題與摘要）
   - assets/og-card.png（書齋溫潤紙感預設社群分享封面圖 1200x630）
   - sitemap.xml & robots.txt（供 Google 搜尋引擎完整收錄單篇文章）
   - rss.xml（RSS 2.0 訂閱源）
"""

import argparse
import json
import os
import re
import shutil
import struct
import sys
import urllib.request
import zlib
from datetime import datetime
from html import escape
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT_DIR / "content"
SHARE_DIR = ROOT_DIR / "s"
TYPE_DIRS = {
    "essay": CONTENT_DIR / "essays",
    "note": CONTENT_DIR / "notes",
    "letter": CONTENT_DIR / "letters",
}


def sync_from_google_workspace():
    feed_url = os.environ.get("GOOGLE_WORKSPACE_FEED_URL", "").strip()
    token = os.environ.get("GOOGLE_WORKSPACE_SYNC_TOKEN", "").strip()
    if not feed_url:
        return

    sep = "&" if "?" in feed_url else "?"
    url = f"{feed_url}{sep}action=feed&token={token}"
    print("正在向 Google Workspace 儲存空間檢查最新內容⋯")

    req = urllib.request.Request(url, headers={"User-Agent": "WarmCraft-SiteBuilder/1.2"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    if not payload.get("ok"):
        raise RuntimeError(f"Google Workspace 同步回應錯誤: {payload}")

    synced = 0
    for item in payload.get("items", []):
        doc_type = item.get("type", "note")
        slug = re.sub(r"[^a-zA-Z0-9_-]", "-", item.get("slug", "")).strip("-")
        markdown = item.get("markdown", "")
        if doc_type in TYPE_DIRS and slug and markdown:
            target_dir = TYPE_DIRS[doc_type]
            target_dir.mkdir(parents=True, exist_ok=True)
            (target_dir / f"{slug}.md").write_text(markdown, encoding="utf-8")
            synced += 1

    print(f"已從 Google Workspace 同步更新 {synced} 篇內容。")


def parse_frontmatter(raw: str):
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$", raw.strip())
    if not match:
        return {}, raw

    meta = {}
    for line in match.group(1).splitlines():
        idx = line.find(":")
        if idx == -1:
            continue
        key = line[:idx].strip()
        val = line[idx + 1 :].strip().strip("\"'")
        meta[key] = val
    return meta, match.group(2)


def strip_to_plain_text(body: str) -> str:
    txt = re.sub(r"<script[\s\S]*?</script>", " ", body, flags=re.I)
    txt = re.sub(r"<style[\s\S]*?</style>", " ", txt, flags=re.I)
    txt = re.sub(r"<[^>]+>", " ", txt)
    txt = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r" \1 ", txt)
    txt = re.sub(r"\[([^\]]+)\]\([^)]+\)", r" \1 ", txt)
    txt = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", lambda m: f" {m.group(2) or m.group(1)} ", txt)
    txt = re.sub(r"https?://\S+", " ", txt)
    txt = re.sub(r"[#*>`~_\-|]", " ", txt)
    txt = re.sub(r"\s+", " ", txt).strip()
    return txt[:5000]


def estimate_reading_time(text: str) -> str:
    clean = re.sub(r"[#*>`_\-\[\]\(\)]", "", text)
    chars = len(clean.strip())
    minutes = max(1, round(chars / 380))
    return f"{minutes} min"


def ensure_og_card_png():
    """以純標準庫產生溫潤書齋紙感 1200x630 PNG 社群分享底圖（無須安裝 Pillow，GitHub Actions 與本機皆可執行）"""
    assets_dir = ROOT_DIR / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)
    out_png = assets_dir / "og-card.png"
    if out_png.exists() and out_png.stat().st_size > 1000:
        return

    width, height = 1200, 630
    bg = (245, 242, 235)       # #f5f2eb 溫潤書頁紙色
    border = (110, 80, 57)     # #6e5039 書齋琥珀棕外框線
    moss = (72, 86, 67)        # #485643 常青雙細線

    rows = []
    for y in range(height):
        row = bytearray([0])  # Filter type 0 (None)
        in_outer_border = (36 <= y <= 39 or height - 40 <= y <= height - 37)
        in_inner_rule = (52 == y or height - 53 == y)
        in_accent_bar = (288 <= y <= 293)
        for x in range(width):
            if (in_outer_border and 36 <= x <= width - 37) or (
                (36 <= x <= 39 or width - 40 <= x <= width - 37) and 36 <= y <= height - 37
            ):
                row.extend(border)
            elif (in_inner_rule and 52 <= x <= width - 53) or (
                (52 == x or width - 53 == x) and 52 <= y <= height - 53
            ):
                row.extend(moss)
            elif in_accent_bar and 520 <= x <= 680:
                row.extend(border)
            else:
                row.extend(bg)
        rows.append(bytes(row))

    raw_data = b"".join(rows)
    compressed = zlib.compress(raw_data, level=9)

    def png_chunk(chunk_type: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack("!I", len(data)) + chunk_type + data + struct.pack("!I", crc)

    ihdr = struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png_bytes = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", compressed)
        + png_chunk(b"IEND", b"")
    )
    out_png.write_bytes(png_bytes)


def build_share_pages_and_sitemap(items: list, site_url: str, brand_name: str, studio_title: str, studio_desc: str):
    ensure_og_card_png()
    if SHARE_DIR.exists():
        shutil.rmtree(SHARE_DIR)
    SHARE_DIR.mkdir(parents=True, exist_ok=True)

    og_img_url = f"{site_url}/assets/og-card.png"
    type_labels = {"essay": "長文 · Essay", "note": "筆記 · Note", "letter": "電子報 · Letter"}
    sitemap_urls = [
        f"  <url>\n    <loc>{escape(site_url + '/')}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>"
    ]

    for it in items:
        slug = re.sub(r"[^a-zA-Z0-9_-]", "-", it["slug"]).strip("-")
        if not slug:
            continue
        route_prefix = "essays" if it["type"] == "essay" else "notes" if it["type"] == "note" else "letters"
        target_hash_rel = f"../#/{route_prefix}/{slug}"
        share_page_url = f"{site_url}/s/{slug}.html"
        title_full = f"{it['title']} · {brand_name}"
        desc_text = (it.get("summary") or it.get("searchText", "")[:140] or studio_desc).strip()
        meta_desc = f"{desc_text}（{type_labels.get(it['type'], '文章')} · {it.get('readingTime', '')}）"
        snippet_preview = (it.get("searchText") or desc_text)[:320]

        share_html = f"""<!DOCTYPE html>
<html lang="zh-Hant" data-target-route="{escape(target_hash_rel)}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; object-src 'none'; base-uri 'self'" />
  <title>{escape(title_full)}</title>
  <meta name="description" content="{escape(meta_desc)}" />
  <link rel="canonical" href="{escape(share_page_url)}" />
  <meta property="og:site_name" content="{escape(studio_title)}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="{escape(it['title'])}" />
  <meta property="og:description" content="{escape(meta_desc)}" />
  <meta property="og:url" content="{escape(share_page_url)}" />
  <meta property="og:image" content="{escape(og_img_url)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="{escape(it['title'])}" />
  <meta name="twitter:description" content="{escape(meta_desc)}" />
  <meta name="twitter:image" content="{escape(og_img_url)}" />
  <meta http-equiv="refresh" content="0; url={escape(target_hash_rel)}" />
  <script src="../share-redirect.js"></script>
</head>
<body style="font-family:Georgia,serif;background:#f5f2eb;color:#1d1c19;max-width:680px;margin:60px auto;padding:24px;line-height:1.8;">
  <article>
    <p style="font-size:0.85rem;color:#6e5039;">{escape(brand_name)} · {escape(it.get('date', ''))} · {escape(it.get('readingTime', ''))}</p>
    <h1 style="font-weight:500;font-size:1.7rem;margin:8px 0 14px;">{escape(it['title'])}</h1>
    <p style="color:#534f46;">{escape(desc_text)}</p>
    <p style="font-size:0.92rem;color:#534f46;">{escape(snippet_preview)}</p>
    <p><a href="{escape(target_hash_rel)}" style="color:#6e5039;">進入完整閱讀頁面 →</a></p>
  </article>
</body>
</html>
"""
        (SHARE_DIR / f"{slug}.html").write_text(share_html, encoding="utf-8")
        lastmod = it.get("date", "")
        lastmod_tag = f"\n    <lastmod>{escape(lastmod)}</lastmod>" if re.match(r"^\d{4}-\d{2}-\d{2}$", lastmod) else ""
        sitemap_urls.append(
            f"  <url>\n    <loc>{escape(share_page_url)}</loc>{lastmod_tag}\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>"
        )

    sitemap_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "\n".join(sitemap_urls)
        + "\n</urlset>\n"
    )
    (ROOT_DIR / "sitemap.xml").write_text(sitemap_xml, encoding="utf-8")
    (ROOT_DIR / "robots.txt").write_text(
        f"User-agent: *\nAllow: /\nDisallow: /studio.html\nSitemap: {site_url}/sitemap.xml\n",
        encoding="utf-8",
    )


def build_manifest_and_rss():
    items = []
    for doc_type, folder in TYPE_DIRS.items():
        folder.mkdir(parents=True, exist_ok=True)
        for md_path in sorted(folder.glob("*.md")):
            raw = md_path.read_text(encoding="utf-8")
            meta, body = parse_frontmatter(raw)
            slug = meta.get("slug") or md_path.stem
            tags = [t.strip() for t in re.split(r"[,，、]+", meta.get("tags", "")) if t.strip()]
            links = [l.strip() for l in re.split(r"[,，、]+", meta.get("links", "")) if l.strip()]
            plain_text = strip_to_plain_text(body)

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
                "searchText": plain_text,
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

    studio_title = "個人知識庫與電子報"
    studio_desc = "這裡是一座持續生長的個人知識庫。"
    brand_name = "低調走過"
    brand_latin = "Deediao"
    cfg_path = ROOT_DIR / "site.config.js"
    if cfg_path.exists():
        raw_cfg = cfg_path.read_text(encoding="utf-8")
        m_cfg = re.search(r"window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$", raw_cfg)
        if m_cfg:
            try:
                cfg_obj = json.loads(m_cfg.group(1))
                brand_obj = cfg_obj.get("brand", {})
                studio_title = brand_obj.get("studioTitle", studio_title)
                studio_desc = brand_obj.get("tagline", studio_desc)
                brand_name = brand_obj.get("name", brand_name)
                brand_latin = brand_obj.get("latinName", brand_latin)
            except Exception:
                pass

    site_url = os.environ.get("SITE_BASE_URL", "https://deediaoyeh.github.io/personal-site").rstrip("/")

    # 產生每篇文章的社群預覽卡導頁 (s/<slug>.html)、og-card.png、sitemap.xml 與 robots.txt
    build_share_pages_and_sitemap(items, site_url, brand_name, studio_title, studio_desc)

    index_path = ROOT_DIR / "index.html"
    if index_path.exists():
        ver = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        idx_html = index_path.read_text(encoding="utf-8")
        idx_html = re.sub(r"<title>.*?</title>", f"<title>{escape(studio_title)}</title>", idx_html)
        idx_html = re.sub(
            r'(<meta\s+name="description"\s+content=")[^"]*(")',
            rf"\g<1>{escape(studio_desc)}\2",
            idx_html,
        )
        idx_html = re.sub(
            r'(<meta\s+property="og:site_name"\s+content=")[^"]*(")',
            rf"\g<1>{escape(studio_title)}\2",
            idx_html,
        )
        idx_html = re.sub(
            r'(<meta\s+property="og:title"\s+content=")[^"]*(")',
            rf"\g<1>{escape(studio_title)}\2",
            idx_html,
        )
        idx_html = re.sub(
            r'(<meta\s+property="og:description"\s+content=")[^"]*(")',
            rf"\g<1>{escape(studio_desc)}\2",
            idx_html,
        )
        idx_html = re.sub(
            r'(<meta\s+property="og:image"\s+content=")[^"]*(")',
            rf"\g<1>{escape(site_url + '/assets/og-card.png')}\2",
            idx_html,
        )
        idx_html = re.sub(
            r'(<span[^>]*id="brand-name"[^>]*>).*?(</span>)',
            rf"\g<1>{escape(brand_name)}\2",
            idx_html,
        )
        idx_html = re.sub(
            r'(<span[^>]*id="brand-latin"[^>]*>).*?(</span>)',
            rf"\g<1>{escape(brand_latin)}\2",
            idx_html,
        )
        idx_html = re.sub(
            r'(\./(?:site\.config\.js|qrcode\.js|theme\.custom\.css|styles\.css|app\.js))(?:\?v=[^"\']+)?',
            rf"\1?v={ver}",
            idx_html,
        )
        index_path.write_text(idx_html, encoding="utf-8")

    studio_path = ROOT_DIR / "studio.html"
    if studio_path.exists():
        ver = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        site_ver = (
            (ROOT_DIR / "VERSION").read_text(encoding="utf-8").strip()
            if (ROOT_DIR / "VERSION").exists()
            else "v1.0.0"
        )
        st_html = studio_path.read_text(encoding="utf-8")
        st_html = re.sub(
            r'(<span[^>]*id="studio-version-badge"[^>]*>).*?(</span>)',
            rf"\g<1>{escape(site_ver)}\2",
            st_html,
        )
        st_html = re.sub(
            r'(<strong[^>]*id="display-site-version"[^>]*>).*?(</strong>)',
            rf"\g<1>{escape(site_ver)}\2",
            st_html,
        )
        st_html = re.sub(
            r'(\./(?:site\.config\.js|styles\.css|theme\.custom\.css|studio\.css|studio-cloud-client\.js|studio\.js|studio-media\.js|studio-analytics\.js))(?:\?v=[^"\']+)?',
            rf"\1?v={ver}",
            st_html,
        )
        studio_path.write_text(st_html, encoding="utf-8")

    rss_items = []
    for it in items:
        link = f"{site_url}/s/{it['slug']}.html"
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
    print(f"索引建置完成：共收錄 {len(items)} 篇內容 → content/manifest.json、s/*.html、sitemap.xml & rss.xml")


def bundle_public_site(dest_name: str):
    """打包公開網站與受雲端雙重驗證保護之前端工作台介面（嚴格排除本機 server.py / scripts / 私密金鑰檔）"""
    dest = (ROOT_DIR / dest_name).resolve()
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True, exist_ok=True)

    for html_file in ROOT_DIR.glob("*.html"):
        shutil.copy2(html_file, dest / html_file.name)

    for static_name in (
        "VERSION",
        "styles.css",
        "theme.custom.css",
        "site.config.js",
        "qrcode.js",
        "share-redirect.js",
        "app.js",
        "rss.xml",
        "sitemap.xml",
        "robots.txt",
        "studio.css",
        "studio-cloud-client.js",
        "studio.js",
        "studio-media.js",
        "studio-analytics.js",
    ):
        src = ROOT_DIR / static_name
        if src.exists():
            shutil.copy2(src, dest / static_name)

    for folder_name in ("content", "assets", "pages", "s"):
        src_dir = ROOT_DIR / folder_name
        if src_dir.exists():
            shutil.copytree(src_dir, dest / folder_name)

    print(f"公開發佈套件已產生至：{dest_name}/（含社群預覽導頁、全文檢索與雲端 2FA 工作台前端）")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle-public", default="", help="輸出排除編輯器的乾淨公開目錄")
    args = parser.parse_args()
    try:
        sync_from_google_workspace()
        build_manifest_and_rss()
        if args.bundle_public:
            bundle_public_site(args.bundle_public)
    except Exception as exc:
        print(f"[錯誤] {exc}", file=sys.stderr)
        sys.exit(1)
