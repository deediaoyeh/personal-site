#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sync_auth_to_netlify.py — 將本機建立的雙重驗證金鑰雜湊（絕不含明文密碼）自動同步寫入 Netlify 加密環境變數，
使 GitHub Pages 主站 (deediaoyeh.github.io/personal-site/studio.html) 與 Netlify 備份站 (deediao-studio.netlify.app/studio.html)
立即啟用完全相同的 PBKDF2-SHA256 + TOTP 雙重驗證保護！
"""

import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
AUTH_FILE = ROOT_DIR / ".studio-auth.json"
SITE_ID = "eb87f73c-c435-4e6a-82b5-1e649fa2543b"


def build_env() -> dict:
    env = os.environ.copy()
    paths = [
        str(ROOT_DIR / ".local-bin"),
        "/Users/deediao/.gemini/antigravity/brain/9216d818-64fe-430b-b9e4-7cbc8b4ff98b/scratch/node-v22.14.0-darwin-arm64/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        env.get("PATH", ""),
    ]
    env["PATH"] = ":".join(paths)
    return env


def upsert_secret_env(env_key: str, env_val: str, run_env: dict):
    subprocess.run(
        [
            "netlify",
            "env:set",
            env_key,
            env_val,
            "--secret",
            "--force",
        ],
        cwd=str(ROOT_DIR),
        env=run_env,
        check=True,
        capture_output=True,
    )


def main():
    run_env = build_env()

    # 1. 確保雲端具備 GitHub 寫入憑證與 JWT 簽章密鑰
    gh_tok = subprocess.run(
        ["gh", "auth", "token"], cwd=str(ROOT_DIR), env=run_env, capture_output=True, text=True
    )
    if gh_tok.returncode == 0 and gh_tok.stdout.strip():
        upsert_secret_env("STUDIO_GITHUB_PAT", gh_tok.stdout.strip(), run_env)

    jwt_secret_file = ROOT_DIR / ".studio-jwt.key"
    if jwt_secret_file.exists():
        jwt_secret = jwt_secret_file.read_text(encoding="utf-8").strip()
    else:
        jwt_secret = secrets.token_hex(32)
        jwt_secret_file.write_text(jwt_secret, encoding="utf-8")
        os.chmod(jwt_secret_file, 0o600)
    upsert_secret_env("STUDIO_JWT_SECRET", jwt_secret, run_env)

    # 2. 若已完成雙重驗證綁定 (.studio-auth.json)，同步 PBKDF2 雜湊、鹽值與 TOTP 密鑰至雲端
    if AUTH_FILE.exists():
        vault = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
        upsert_secret_env("STUDIO_PW_SALT", vault["saltHex"], run_env)
        upsert_secret_env("STUDIO_PW_HASH", vault["passwordHashHex"], run_env)
        upsert_secret_env("STUDIO_TOTP_SECRET", vault["totpSecret"], run_env)
        upsert_secret_env("STUDIO_RECOVERY_HASHES", ",".join(vault.get("recoveryCodeHashes", [])), run_env)

        # 觸發 Netlify 重新發佈使最新環境變數立即生效（Netlify Functions 環境變數隨每次部署凍結生效）
        subprocess.run(
            [
                "netlify",
                "api",
                "createSiteBuild",
                "--data",
                json.dumps({"site_id": SITE_ID, "body": {"clear_cache": False}}),
            ],
            cwd=str(ROOT_DIR),
            env=run_env,
            capture_output=True,
        )
        print("✓ 已將雙重驗證加密雜湊同步至雲端環境，並觸發線上驗證閘門更新！")
    else:
        print("✓ 已預置雲端 GitHub 寫入與 JWT 簽章金鑰（待本機完成首次掃碼綁定即自動啟用線上登入）。")


if __name__ == "__main__":
    main()
