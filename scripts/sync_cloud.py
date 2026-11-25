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


def build_git_env() -> dict:
    env = os.environ.copy()
    local_bin = ROOT_DIR / ".local-bin"
    extra_paths = [str(local_bin), "/Users/deediao/.gemini/antigravity/bin", "/usr/local/bin", "/opt/homebrew/bin"]
    env["PATH"] = ":".join(extra_paths + [env.get("PATH", "")])
    # 若受限環境無法讀取 ~/.gitconfig，自動降級使用專案內 .git/config 設定，避免 exit status 128
    gitconfig = Path.home() / ".gitconfig"
    try:
        if gitconfig.exists():
            gitconfig.read_bytes()
    except PermissionError:
        env["GIT_CONFIG_GLOBAL"] = "/dev/null"
    return env


def sync_to_gdrive_cli(logs: list):
    gdrive_bin = shutil.which("gdrive") or "/Users/deediao/.gemini/antigravity/bin/gdrive"
    if not Path(gdrive_bin).exists():
        logs.append("• 略過 gdrive CLI 雲端硬碟直傳（改由 GitHub Actions 排程同步）")
        return

    logs.append("• 正在同步最新 Markdown 內容至 Google Drive (PersonalSite-Vault)⋯")
    synced_count = 0
    removed_count = 0

    for sub in ("essays", "notes", "letters"):
        folder_id = DRIVE_FOLDERS[sub]
        local_dir = CONTENT_DIR / sub
        local_dir.mkdir(parents=True, exist_ok=True)
        local_files = {p.name: p for p in sorted(local_dir.glob("*.md"))}

        ls_proc = subprocess.run(
            [gdrive_bin, "readonly", "ls", folder_id, "--json"],
            capture_output=True,
            text=True,
        )
        remote_map = {}
        if ls_proc.returncode == 0 and ls_proc.stdout.strip():
            try:
                for entry in json.loads(ls_proc.stdout):
                    if entry.get("name", "").endswith(".md"):
                        remote_map[entry["name"]] = entry["id"]
            except Exception:
                pass

        # 上傳或更新本機現有文章
        for fname, md_file in local_files.items():
            if fname in remote_map:
                subprocess.run(
                    [gdrive_bin, "mutate", "update", remote_map[fname], str(md_file)],
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

        # 若本機已刪除該篇文章，將雲端對應舊檔移至垃圾桶保持一致
        for rname, rid in remote_map.items():
            if rname not in local_files:
                subprocess.run(
                    [gdrive_bin, "mutate", "trash", rid],
                    capture_output=True,
                    text=True,
                )
                removed_count += 1

    logs.append(f"  ✓ Google Drive 同步完成（更新/上傳 {synced_count} 篇，清理舊檔 {removed_count} 篇）。")


def sync_git_and_netlify(logs: list):
    env = build_git_env()

    subprocess.run(
        [sys.executable, str(ROOT_DIR / "scripts" / "build_content.py")],
        cwd=str(ROOT_DIR),
        env=env,
        check=True,
    )
    logs.append("• 已重新產生 content/manifest.json 與 rss.xml。")

    git_dir = ROOT_DIR / ".git"
    if git_dir.exists():
        subprocess.run(["git", "add", "-A"], cwd=str(ROOT_DIR), env=env, check=True)
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
            # 先 fetch 並以本機版本優先合併，避免遠端自動時間戳衝突
            subprocess.run(["git", "fetch", "origin", "main"], cwd=str(ROOT_DIR), env=env, capture_output=True)
            merge = subprocess.run(
                ["git", "merge", "-X", "ours", "--no-edit", "origin/main"],
                cwd=str(ROOT_DIR),
                env=env,
                capture_output=True,
                text=True,
            )
            if merge.returncode == 0:
                subprocess.run(
                    [sys.executable, str(ROOT_DIR / "scripts" / "build_content.py")],
                    cwd=str(ROOT_DIR),
                    env=env,
                    check=True,
                )
                subprocess.run(["git", "add", "-A"], cwd=str(ROOT_DIR), env=env, check=True)
                if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(ROOT_DIR), env=env).returncode != 0:
                    subprocess.run(
                        ["git", "commit", "-m", "chore: rebuild manifest after remote merge"],
                        cwd=str(ROOT_DIR),
                        env=env,
                        check=True,
                    )

            push = subprocess.run(
                ["git", "push", "origin", "main"],
                cwd=str(ROOT_DIR),
                env=env,
                capture_output=True,
                text=True,
            )
            if push.returncode == 0:
                logs.append("  ✓ 已成功推送至 GitHub 主站（GitHub Pages 約 30 秒內自動更新完成）！")
            else:
                logs.append(f"  ! GitHub 推送失敗：{push.stderr.strip()}")

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
