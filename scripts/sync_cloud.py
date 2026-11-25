#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_cloud.py — 連網時一鍵將離線編輯成果同步至 Google Workspace (Drive) + GitHub 主站 + Netlify 備份站
"""

import json
import os
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT_DIR / "content"

# 已建立之 Google Drive 資料夾對應 ID (deediao@gmail.com / PersonalSite-Vault)
DRIVE_FOLDERS = {
    "root": "1n_ZQELr2H9f1Zre0rmntedtvyrohcGxS",
    "essays": "1wWS7-UFucygkzaz237ppzJDiB3207TIT",
    "notes": "1fv4vDPgjNKhPqSvZtYrdm9AC47bbkwOB",
    "letters": "1dDJ53xY7N7bCSNSkRLHub82WJ7d9kqPQ",
}


def load_env_file():
    env_path = ROOT_DIR / ".sync.env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def sync_to_gdrive_cli(logs: list):
    gdrive_bin = shutil.which("gdrive")
    if not gdrive_bin:
        logs.append("• 略過 gdrive CLI 雲端硬碟直傳（本機未偵測到 gdrive 指令，改由 GitHub Actions 或本機雲端硬碟資料夾同步）")
        return

    logs.append("• 正在同步最新 Markdown 文章至 Google Drive (PersonalSite-Vault)⋯")
    synced_count = 0
    for sub in ("essays", "notes", "letters"):
        folder_id = DRIVE_FOLDERS[sub]
        local_dir = CONTENT_DIR / sub
        if not local_dir.exists():
            continue

        # 查詢目前雲端資料夾內既有檔案，決定 update 或 upload
        ls_proc = subprocess.run(
            [gdrive_bin, "readonly", "ls", folder_id, "--json"],
            capture_output=True,
            text=True,
        )
        remote_map = {}
        if ls_proc.returncode == 0 and ls_proc.stdout.strip():
            try:
                for entry in json.loads(ls_proc.stdout):
                    remote_map[entry.get("name")] = entry.get("id")
            except Exception:
                pass

        for md_file in sorted(local_dir.glob("*.md")):
            if md_file.name in remote_map:
                subprocess.run(
                    [gdrive_bin, "mutate", "update", remote_map[md_file.name], str(md_file)],
                    capture_output=True,
                    text=True,
                )
            else:
                subprocess.run(
                    [gdrive_bin, "mutate", "upload", str(md_file), "--parent", folder_id],
                    capture_output=True,
                    text=True,
                )
            synced_count += 1

    logs.append(f"  ✓ 已同步 {synced_count} 篇 Markdown 檔案至 Google Drive。")


def sync_git_and_netlify(logs: list):
    subprocess.run(
        [sys.executable, str(ROOT_DIR / "scripts" / "build_content.py")],
        cwd=str(ROOT_DIR),
        check=True,
    )
    logs.append("• 已重新產生 content/manifest.json 與 rss.xml。")

    git_dir = ROOT_DIR / ".git"
    if git_dir.exists():
        env = os.environ.copy()
        local_bin = ROOT_DIR / ".local-bin"
        if local_bin.exists():
            env["PATH"] = f"{local_bin}:{env.get('PATH', '')}"

        subprocess.run(["git", "add", "."], cwd=str(ROOT_DIR), env=env, check=True)
        diff = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(ROOT_DIR), env=env)
        if diff.returncode != 0:
            ts = datetime.now().strftime("%Y-%m-%d %H:%M")
            subprocess.run(
                ["git", "commit", "-m", f"studio: update site & content ({ts})"],
                cwd=str(ROOT_DIR),
                env=env,
                check=True,
            )
            logs.append("  ✓ 已建立本機 Git 版本紀錄 (commit)。")

        remote = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=str(ROOT_DIR),
            env=env,
            capture_output=True,
            text=True,
        )
        if remote.returncode == 0 and remote.stdout.strip():
            subprocess.run(
                ["git", "pull", "--no-rebase", "-X", "ours", "--no-edit", "origin", "main"],
                cwd=str(ROOT_DIR),
                env=env,
                capture_output=True,
                text=True,
            )
            push = subprocess.run(
                ["git", "push", "origin", "main"],
                cwd=str(ROOT_DIR),
                env=env,
                capture_output=True,
                text=True,
            )
            if push.returncode == 0:
                logs.append("  ✓ 已推送至 GitHub 主站（Netlify 備份站將自動跟隨部署）。")
            else:
                logs.append(f"  ! GitHub 推送尚未完成：{push.stderr.strip()}")
        else:
            logs.append("  • 本機 Git 已存檔（綁定 GitHub 遠端 origin 後即可自動推送主站與 Netlify 備份站）。")

    hook_url = os.environ.get("NETLIFY_BUILD_HOOK_URL", "").strip()
    if hook_url:
        req = urllib.request.Request(hook_url, data=b"{}", method="POST")
        with urllib.request.urlopen(req, timeout=15):
            pass
        logs.append("  ✓ 已觸發 Netlify 備份站 Build Hook。")


def main():
    load_env_file()
    logs = []
    sync_git_and_netlify(logs)
    sync_to_gdrive_cli(logs)
    print("\n".join(logs))


if __name__ == "__main__":
    main()
