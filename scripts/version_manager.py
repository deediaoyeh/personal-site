#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
version_manager.py — 網站變更前自動打包備份、語意化版本編號遞增與一鍵回溯還原工具

核心職責：
1. pre-backup : 在任何程式碼、版面或文章變動「之前」，先將整份網站（含私密金鑰與設定）完整壓縮備份至 ../backups/personal-site/
2. release    : 變動完成後遞增版本號 (patch / minor / major)，同步更新 VERSION、VERSION_HISTORY.md、studio.html 版本徽章，並留存發佈備份與 Git Tag
3. list       : 列出所有可回溯的歷史備份點（由新到舊編號）
4. restore    : 回溯還原前先自動備份當下狀態，再將指定版本完整還原回工作目錄
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
BACKUP_DIR = ROOT_DIR.parent / "backups" / "personal-site"
MANIFEST_FILE = BACKUP_DIR / "backup_manifest.json"
VERSION_FILE = ROOT_DIR / "VERSION"
HISTORY_FILE = ROOT_DIR / "VERSION_HISTORY.md"
MAX_BACKUPS = 60

EXCLUDE_DIRS_AND_FILES = {
    ".git",
    "dist_public",
    "__pycache__",
    ".DS_Store",
    ".local-bin",
}


def ensure_backup_vault():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(BACKUP_DIR.parent, 0o700)
        os.chmod(BACKUP_DIR, 0o700)
    except OSError:
        pass


def get_current_version() -> str:
    if VERSION_FILE.exists():
        v = VERSION_FILE.read_text(encoding="utf-8").strip()
        if re.match(r"^v?\d+\.\d+\.\d+$", v):
            return v if v.startswith("v") else f"v{v}"
    return "v1.0.0"


def bump_semver(ver: str, part: str = "patch") -> str:
    clean = ver.lstrip("v")
    major, minor, patch = [int(x) for x in clean.split(".")]
    if part == "major":
        major += 1
        minor = 0
        patch = 0
    elif part == "minor":
        minor += 1
        patch = 0
    else:
        patch += 1
    return f"v{major}.{minor}.{patch}"


def get_git_head_short() -> str:
    try:
        proc = subprocess.run(
            ["git", "-C", str(ROOT_DIR), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
    except Exception:
        pass
    return "untracked"


def load_manifest() -> list:
    ensure_backup_vault()
    entries = []
    if MANIFEST_FILE.exists():
        try:
            entries = json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
        except Exception:
            entries = []

    known_files = set()
    deduped = []
    for e in entries:
        fn = e.get("filename")
        if fn and fn not in known_files:
            known_files.add(fn)
            deduped.append(e)
    entries = deduped
    for zp in sorted(BACKUP_DIR.glob("backup-*.zip")):
        if zp.name not in known_files:
            m = re.match(r"^backup-(v\d+\.\d+\.\d+)-(\d{8}-\d{6})-(.+)\.zip$", zp.name)
            ver = m.group(1) if m else "v1.0.0"
            ts_raw = m.group(2) if m else datetime.fromtimestamp(zp.stat().st_mtime).strftime("%Y%m%d-%H%M%S")
            kind = m.group(3) if m else "snapshot"
            entries.append(
                {
                    "filename": zp.name,
                    "version": ver,
                    "createdAt": f"{ts_raw[:4]}-{ts_raw[4:6]}-{ts_raw[6:8]} {ts_raw[9:11]}:{ts_raw[11:13]}:{ts_raw[13:15]}",
                    "kind": kind,
                    "sizeBytes": zp.stat().st_size,
                    "gitCommit": "",
                    "note": "初始穩定基準備份" if "baseline" in kind else kind,
                }
            )

    entries = [e for e in entries if (BACKUP_DIR / e["filename"]).exists()]
    entries.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
    save_manifest(entries)
    return entries


def save_manifest(entries: list):
    ensure_backup_vault()
    MANIFEST_FILE.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(MANIFEST_FILE, 0o600)
    except OSError:
        pass


def prune_old_backups(entries: list) -> list:
    if len(entries) <= MAX_BACKUPS:
        return entries
    # 永遠保留最舊的 baseline 備份，其餘超過上限者移除最舊檔
    keep = []
    removable = []
    for e in entries:
        if "baseline" in e.get("filename", ""):
            keep.append(e)
        else:
            removable.append(e)
    while len(keep) + len(removable) > MAX_BACKUPS and removable:
        oldest = removable.pop()
        zp = BACKUP_DIR / oldest["filename"]
        if zp.exists():
            try:
                zp.unlink()
            except OSError:
                pass
    merged = keep + removable
    merged.sort(key=lambda x: x.get("createdAt", ""), reverse=True)
    return merged


def sync_version_into_html(version_str: str):
    studio_path = ROOT_DIR / "studio.html"
    if not studio_path.exists():
        return
    html = studio_path.read_text(encoding="utf-8")
    html = re.sub(
        r'(<span[^>]*id="studio-version-badge"[^>]*>).*?(</span>)',
        rf"\g<1>{version_str}\2",
        html,
    )
    html = re.sub(
        r'(<strong[^>]*id="display-site-version"[^>]*>).*?(</strong>)',
        rf"\g<1>{version_str}\2",
        html,
    )
    studio_path.write_text(html, encoding="utf-8")


def create_backup_archive(kind: str, note: str, version_override: str = "") -> dict:
    ensure_backup_vault()
    ver = version_override or get_current_version()
    now = datetime.now()
    ts_slug = now.strftime("%Y%m%d-%H%M%S")
    ts_human = now.strftime("%Y-%m-%d %H:%M:%S")
    safe_kind = re.sub(r"[^a-zA-Z0-9_-]", "-", kind).strip("-") or "snapshot"
    zip_name = f"backup-{ver}-{ts_slug}-{safe_kind}.zip"
    out_zip = BACKUP_DIR / zip_name

    with tempfile.TemporaryDirectory() as tmpdir:
        stage_dir = Path(tmpdir) / "personal-site"
        shutil.copytree(
            ROOT_DIR,
            stage_dir,
            ignore=lambda d, names: [
                n for n in names if n in EXCLUDE_DIRS_AND_FILES or n.endswith(".pyc")
            ],
        )
        subprocess.run(
            ["ditto", "-c", "-k", "--keepParent", str(stage_dir), str(out_zip)],
            check=True,
        )

    try:
        os.chmod(out_zip, 0o600)
    except OSError:
        pass

    record = {
        "filename": zip_name,
        "version": ver,
        "createdAt": ts_human,
        "kind": safe_kind,
        "sizeBytes": out_zip.stat().st_size,
        "gitCommit": get_git_head_short(),
        "note": note.strip() or safe_kind,
    }
    entries = [e for e in load_manifest() if e.get("filename") != zip_name]
    entries.insert(0, record)
    entries = prune_old_backups(entries)
    save_manifest(entries)
    return record


def prepend_version_history(new_ver: str, note: str, backup_filename: str, commit_ref: str = ""):
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    block = (
        f"## {new_ver} — {now_str}\n"
        f"- **變更摘要**：{note.strip() or '例行內容與系統更新'}\n"
        f"- **對應完整備份檔**：`{backup_filename}`\n"
        + (f"- **Git 標籤 / Commit**：`{new_ver}` (`{commit_ref}`)\n" if commit_ref else f"- **Git 標籤**：`{new_ver}`\n")
        + "\n"
    )

    if HISTORY_FILE.exists():
        raw = HISTORY_FILE.read_text(encoding="utf-8")
        marker = "---\n\n"
        if marker in raw:
            head, tail = raw.split(marker, 1)
            updated = head + marker + block + tail
        else:
            updated = raw.rstrip() + "\n\n" + block
    else:
        updated = (
            "# 站台版本與備份回溯紀錄 (VERSION HISTORY)\n\n"
            "> 每次變動前皆自動建立完整備份，隨時可回溯還原。\n\n---\n\n"
            + block
        )
    HISTORY_FILE.write_text(updated, encoding="utf-8")


def release_new_version(bump: str, note: str, create_git_tag: bool = False) -> tuple:
    old_ver = get_current_version()
    new_ver = bump_semver(old_ver, bump)
    VERSION_FILE.write_text(new_ver + "\n", encoding="utf-8")
    sync_version_into_html(new_ver)

    snap = create_backup_archive("release", note, version_override=new_ver)
    prepend_version_history(new_ver, note, snap["filename"], snap.get("gitCommit", ""))

    if create_git_tag and (ROOT_DIR / ".git").exists():
        env = os.environ.copy()
        try:
            gitconfig = Path.home() / ".gitconfig"
            if gitconfig.exists():
                gitconfig.read_bytes()
        except PermissionError:
            env["GIT_CONFIG_GLOBAL"] = "/dev/null"
        subprocess.run(["git", "-C", str(ROOT_DIR), "tag", "-f", new_ver], env=env, check=False)

    return new_ver, snap


def restore_from_backup(selector: str) -> dict:
    entries = load_manifest()
    if not entries:
        raise RuntimeError("目前尚無任何備份檔案可供還原。")

    chosen = None
    if selector.isdigit():
        idx = int(selector) - 1
        if 0 <= idx < len(entries):
            chosen = entries[idx]
    else:
        for e in entries:
            if e["filename"] == selector or e["version"] == selector:
                chosen = e
                break

    if not chosen:
        raise RuntimeError(f"找不到指定的備份項目：{selector}")

    zip_path = BACKUP_DIR / chosen["filename"]
    if not zip_path.exists():
        raise RuntimeError(f"備份壓縮檔不存在：{zip_path}")

    # 還原前先對目前狀態做一次緊急保護備份，確保還原操作本身也可逆
    safety = create_backup_archive(
        "before-rollback",
        f"回溯至 {chosen['version']} ({chosen['filename']}) 前之自動保護備份",
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(["ditto", "-x", "-k", str(zip_path), tmpdir], check=True)
        extracted_root = Path(tmpdir) / "personal-site"
        if not extracted_root.exists():
            raise RuntimeError("備份檔結構異常，找不到 personal-site 目錄")

        # 清除目前工作目錄內非保留項目，再完整拷貝備份內容回來（保留 .git 與 .local-bin）
        keep_live = {".git", ".local-bin"}
        for item in ROOT_DIR.iterdir():
            if item.name in keep_live:
                continue
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink()

        for item in extracted_root.iterdir():
            if item.name in keep_live:
                continue
            dest = ROOT_DIR / item.name
            if item.is_dir():
                shutil.copytree(item, dest)
            else:
                shutil.copy2(item, dest)

    # 重新建置索引確保一致
    build_script = ROOT_DIR / "scripts" / "build_content.py"
    if build_script.exists():
        subprocess.run(
            [sys.executable, str(build_script)],
            cwd=str(ROOT_DIR),
            env={**os.environ, "GOOGLE_WORKSPACE_FEED_URL": ""},
            capture_output=True,
        )

    return {"restored": chosen, "safetyBackup": safety}


def format_size(num_bytes: int) -> str:
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f} KB"
    return f"{num_bytes / (1024 * 1024):.2f} MB"


def main():
    parser = argparse.ArgumentParser(description="站台版本編號與變更前備份回溯管理")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_pre = sub.add_parser("pre-backup", help="變動前建立完整打包備份")
    p_pre.add_argument("--note", default="變更前自動備份", help="備份原因說明")

    p_rel = sub.add_parser("release", help="遞增版本號並記錄變更歷史與備份")
    p_rel.add_argument("--bump", choices=["patch", "minor", "major"], default="patch")
    p_rel.add_argument("--note", required=True, help="本次版本更新內容說明")
    p_rel.add_argument("--tag", action="store_true", help="同時建立或更新 Git tag")

    sub.add_parser("list", help="列出所有可回溯備份清單")

    p_res = sub.add_parser("restore", help="還原至指定編號或版本之備份")
    p_res.add_argument("target", help="清單編號 (如 1, 2) 或版本號 (如 v1.0.0) 或檔名")

    args = parser.parse_args()

    if args.cmd == "pre-backup":
        rec = create_backup_archive("pre-change", args.note)
        print(f"✅ 已完成變動前備份：[{rec['version']}] {rec['filename']} ({format_size(rec['sizeBytes'])})")
        print(f"   備份位置：{BACKUP_DIR / rec['filename']}")

    elif args.cmd == "release":
        new_ver, rec = release_new_version(args.bump, args.note, create_git_tag=args.tag)
        print(f"🎉 已建立新版本號：{new_ver}")
        print(f"   說明：{args.note}")
        print(f"   發佈備份：{BACKUP_DIR / rec['filename']} ({format_size(rec['sizeBytes'])})")

    elif args.cmd == "list":
        cur = get_current_version()
        entries = load_manifest()
        print(f"目前站台版本：{cur}（共保存 {len(entries)} 份完整回溯備份）")
        print("-" * 78)
        for idx, e in enumerate(entries, 1):
            kind_label = (
                "變動前備份"
                if "pre-change" in e["kind"]
                else "正式版快照"
                if "release" in e["kind"]
                else "回溯前保護"
                if "before-rollback" in e["kind"]
                else e["kind"]
            )
            print(
                f" [{idx:2d}] {e['version']:<8} | {e['createdAt']} | {kind_label:<6} | {format_size(e['sizeBytes']):>8} | {e['note']}"
            )
            print(f"      檔名：{e['filename']}")

    elif args.cmd == "restore":
        res = restore_from_backup(args.target)
        chosen = res["restored"]
        safety = res["safetyBackup"]
        print(f"✅ 已成功回溯還原至：{chosen['version']} ({chosen['createdAt']} — {chosen['note']})")
        print(f"🛡️ 還原前的狀態也已自動保護備份為：{safety['filename']}（萬一想取消回溯也能隨時切回來）")


if __name__ == "__main__":
    main()
