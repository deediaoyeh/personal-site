#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
security.py — 書齋離線工作台嚴謹認證核心模組 (100% Python 標準庫，完全支援斷網離線運作)

安全規格：
1. 主密碼雜湊：PBKDF2-HMAC-SHA256 (600,000 次迭代 + 32-byte 密碼學隨機鹽值，hmac.compare_digest 常數時間比對)
2. 第二因素 (2FA)：標準 RFC 6238 TOTP (HMAC-SHA1, 6 位數, 30 秒週期, 容許 ±1 時窗誤差)
3. 緊急恢復碼：8 組單次使用恢復碼（僅儲存 SHA-256 雜湊，使用後立即註銷）
4. 離線 QR Code：內建純 Python GF(256) Reed-Solomon QR Code SVG 產生器，密鑰絕不傳送至任何外部伺服器
5. 階段與防禦：HttpOnly + SameSite=Strict Cookie、每階段獨立 CSRF Token、5 次失敗鎖定 15 分鐘、閒置 2 小時自動登出、安全稽核日誌
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

PBKDF2_ITERATIONS = 600_000
SESSION_IDLE_TIMEOUT = 2 * 3600      # 閒置 2 小時自動鎖定
SESSION_MAX_LIFETIME = 12 * 3600     # 最長 12 小時強制重新驗證
MAX_FAILED_ATTEMPTS = 5              # 10 分鐘內最多允許 5 次錯誤
FAILURE_WINDOW_SEC = 600
LOCKOUT_DURATION_SEC = 900           # 鎖定 15 分鐘


class StudioAuthManager:
    def __init__(self, root_dir: Path):
        self.root_dir = root_dir
        self.auth_file = root_dir / ".studio-auth.json"
        self.audit_file = root_dir / ".studio-audit.log"
        self.sessions = {}          # token -> {csrf, created_at, last_seen, ip}
        self.failed_attempts = {}   # ip -> [timestamps]
        self.lockouts = {}          # ip -> unlock_timestamp
        self.pending_setup = None   # {totp_secret, created_at}

    # ── 稽核日誌 ───────────────────────────────────────────────────────────
    def audit(self, event: str, ip: str, detail: str = ""):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        line = f"[{ts}] ip={ip} event={event} {detail}\n"
        try:
            with open(self.audit_file, "a", encoding="utf-8") as f:
                f.write(line)
            os.chmod(self.audit_file, 0o600)
        except Exception:
            pass

    # ── 狀態檢查 ───────────────────────────────────────────────────────────
    def is_configured(self) -> bool:
        return self.auth_file.exists()

    def _load_vault(self) -> dict:
        return json.loads(self.auth_file.read_text(encoding="utf-8"))

    def _save_vault(self, data: dict):
        self.auth_file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(self.auth_file, 0o600)

    # ── 防暴力破解鎖定檢查 ─────────────────────────────────────────────────
    def check_lockout(self, ip: str) -> int:
        now = time.time()
        unlock_at = self.lockouts.get(ip, 0)
        if unlock_at > now:
            return int(unlock_at - now)
        if ip in self.lockouts:
            del self.lockouts[ip]
        return 0

    def record_failure(self, ip: str, reason: str):
        now = time.time()
        history = [t for t in self.failed_attempts.get(ip, []) if now - t < FAILURE_WINDOW_SEC]
        history.append(now)
        self.failed_attempts[ip] = history
        self.audit("AUTH_FAIL", ip, f"reason={reason} count={len(history)}")
        if len(history) >= MAX_FAILED_ATTEMPTS:
            self.lockouts[ip] = now + LOCKOUT_DURATION_SEC
            self.failed_attempts[ip] = []
            self.audit("ACCOUNT_LOCKOUT", ip, f"duration={LOCKOUT_DURATION_SEC}s")

    def clear_failures(self, ip: str):
        self.failed_attempts.pop(ip, None)
        self.lockouts.pop(ip, None)

    # ── 首次啟用精靈 (產生 TOTP 密鑰與離線 QR SVG) ─────────────────────────
    def prepare_initial_setup(self, account_label: str = "Deediao") -> dict:
        if self.is_configured():
            raise RuntimeError("安全金庫已完成初始化，無法重複建立。")
        if not self.pending_setup or time.time() - self.pending_setup["created_at"] > 1800:
            raw_secret = secrets.token_bytes(20)
            b32_secret = base64.b32encode(raw_secret).decode("ascii").rstrip("=")
            self.pending_setup = {"totp_secret": b32_secret, "created_at": time.time()}

        secret = self.pending_setup["totp_secret"]
        issuer = "DeediaoStudio"
        otpauth_uri = (
            f"otpauth://totp/{quote(issuer)}:{quote(account_label)}"
            f"?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits=6&period=30"
        )
        qr_svg = generate_qr_svg(otpauth_uri)
        return {
            "secret": secret,
            "otpauthUri": otpauth_uri,
            "qrSvg": qr_svg,
        }

    def complete_initial_setup(self, password: str, totp_code: str, ip: str) -> dict:
        if self.is_configured():
            raise ValueError("安全認證已設定完成。")
        if not self.pending_setup:
            raise ValueError("請重新整理頁面以產生新的雙重驗證密鑰。")

        validate_password_strength(password)
        secret = self.pending_setup["totp_secret"]
        if not verify_totp(secret, totp_code):
            self.record_failure(ip, "setup_totp_mismatch")
            raise ValueError("六位數動態驗證碼不正確，請確認驗證器 App 時間同步後重試。")

        salt = secrets.token_bytes(32)
        pw_hash = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)

        # 產生 6 組高強度單次緊急恢復碼
        recovery_plain = []
        recovery_hashes = []
        for _ in range(6):
            code = f"{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}-{secrets.token_hex(2).upper()}"
            recovery_plain.append(code)
            recovery_hashes.append(hashlib.sha256(code.encode("utf-8")).hexdigest())

        vault = {
            "version": 1,
            "createdAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "kdf": "pbkdf2_hmac_sha256",
            "iterations": PBKDF2_ITERATIONS,
            "saltHex": salt.hex(),
            "passwordHashHex": pw_hash.hex(),
            "totpSecret": secret,
            "recoveryCodeHashes": recovery_hashes,
        }
        self._save_vault(vault)
        self.pending_setup = None
        self.clear_failures(ip)
        self.audit("VAULT_INITIALIZED", ip, "2FA=TOTP")
        session = self._create_session(ip)
        return {"session": session, "recoveryCodes": recovery_plain}

    # ── 登入驗證 (主密碼 + TOTP 或 單次恢復碼) ─────────────────────────────
    def verify_login(self, password: str, second_factor: str, ip: str) -> dict:
        rem_lock = self.check_lockout(ip)
        if rem_lock > 0:
            raise PermissionError(f"嘗試失敗次數過多，系統已暫時鎖定，請於 {rem_lock} 秒後再試。")

        if not self.is_configured():
            raise ValueError("尚未初始化工作台安全設定。")

        vault = self._load_vault()
        salt = bytes.fromhex(vault["saltHex"])
        expected_hash = bytes.fromhex(vault["passwordHashHex"])
        iters = int(vault.get("iterations", PBKDF2_ITERATIONS))
        actual_hash = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), salt, iters)

        if not hmac.compare_digest(actual_hash, expected_hash):
            self.record_failure(ip, "bad_password")
            raise PermissionError("主密碼或動態驗證碼不正確。")

        code_clean = (second_factor or "").strip().upper()
        totp_ok = verify_totp(vault["totpSecret"], code_clean)
        used_recovery = False

        if not totp_ok:
            # 檢查是否為單次緊急恢復碼
            candidate_hash = hashlib.sha256(code_clean.encode("utf-8")).hexdigest()
            matched_idx = -1
            for idx, saved_h in enumerate(vault.get("recoveryCodeHashes", [])):
                if hmac.compare_digest(candidate_hash, saved_h):
                    matched_idx = idx
                    break
            if matched_idx >= 0:
                vault["recoveryCodeHashes"].pop(matched_idx)
                self._save_vault(vault)
                used_recovery = True
            else:
                self.record_failure(ip, "bad_2fa")
                raise PermissionError("主密碼或動態驗證碼不正確。")

        self.clear_failures(ip)
        self.audit("LOGIN_SUCCESS", ip, "via=recovery_code" if used_recovery else "via=totp")
        return self._create_session(ip)

    # ── 階段管理與 CSRF 驗證 ──────────────────────────────────────────────
    def _create_session(self, ip: str) -> dict:
        now = time.time()
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_hex(32)
        self.sessions[token] = {
            "csrf": csrf,
            "created_at": now,
            "last_seen": now,
            "ip": ip,
        }
        return {"token": token, "csrf": csrf}

    def validate_session(self, token: str, csrf_header: str = None, require_csrf: bool = False):
        if not token or token not in self.sessions:
            return None
        sess = self.sessions[token]
        now = time.time()
        if now - sess["created_at"] > SESSION_MAX_LIFETIME or now - sess["last_seen"] > SESSION_IDLE_TIMEOUT:
            self.sessions.pop(token, None)
            return None
        if require_csrf:
            if not csrf_header or not hmac.compare_digest(csrf_header, sess["csrf"]):
                return None
        sess["last_seen"] = now
        return sess

    def logout(self, token: str, ip: str):
        if token and token in self.sessions:
            self.sessions.pop(token, None)
            self.audit("LOGOUT", ip)


# =========================================================================
# 密碼強度與 RFC 6238 TOTP 實作
# =========================================================================
def validate_password_strength(pw: str):
    if not pw or len(pw) < 10:
        raise ValueError("主密碼長度至少需 10 個字元。")
    has_letter = any(c.isalpha() for c in pw)
    has_digit_or_sym = any(not c.isalpha() for c in pw)
    if not (has_letter and has_digit_or_sym):
        raise ValueError("主密碼需同時包含英文字母與數字（或符號）以確保強度。")


def _totp_at(b32_secret: str, counter: int) -> str:
    padded = b32_secret.upper().replace(" ", "")
    rem = len(padded) % 8
    if rem:
        padded += "=" * (8 - rem)
    key = base64.b32decode(padded, casefold=True)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = (struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code_int:06d}"


def verify_totp(b32_secret: str, user_code: str) -> bool:
    clean = "".join(ch for ch in (user_code or "") if ch.isdigit())
    if len(clean) != 6:
        return False
    step = int(time.time() // 30)
    for delta in (-1, 0, 1):
        if hmac.compare_digest(_totp_at(b32_secret, step + delta), clean):
            return True
    return False


# =========================================================================
# 純 Python 離線 QR Code SVG 產生器 (ISO/IEC 18004 Byte Mode, ECC Level L)
# 支援至 Version 6 (最高 134 bytes，足以編碼標準 otpauth:// URI)
# =========================================================================
# (version: (total_codewords, ec_codewords_per_block, num_blocks, alignment_centers))
_QR_VERSIONS = {
    3: (70, 15, 1, [6, 22]),
    4: (100, 20, 1, [6, 26]),
    5: (134, 26, 1, [6, 30]),
    6: (172, 18, 2, [6, 34]),
    7: (196, 20, 2, [6, 22, 38]),
}

_GF_EXP = [0] * 512
_GF_LOG = [0] * 256
_x = 1
for _i in range(255):
    _GF_EXP[_i] = _x
    _GF_LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _GF_EXP[_i] = _GF_EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator_poly(nsym: int) -> list:
    g = [1]
    for i in range(nsym):
        nxt = [0] * (len(g) + 1)
        factor = _GF_EXP[i]
        for j, val in enumerate(g):
            nxt[j] ^= val
            nxt[j + 1] ^= _gf_mul(val, factor)
        g = nxt
    return g


def _rs_encode(data_bytes: list, nsym: int) -> list:
    gen = _rs_generator_poly(nsym)
    res = list(data_bytes) + [0] * nsym
    for i in range(len(data_bytes)):
        coef = res[i]
        if coef != 0:
            for j in range(1, len(gen)):
                res[i + j] ^= _gf_mul(gen[j], coef)
    return res[len(data_bytes) :]


def generate_qr_svg(text: str) -> str:
    payload = text.encode("utf-8")
    ver = None
    for v, (total_cw, ec_cw, blocks, _) in sorted(_QR_VERSIONS.items()):
        data_cap = total_cw - ec_cw * blocks
        if len(payload) + 3 <= data_cap:
            ver = v
            break
    if ver is None:
        return ""

    total_cw, ec_cw, blocks, align = _QR_VERSIONS[ver]
    data_cap = total_cw - ec_cw * blocks

    bits = []
    def push_bits(val, length):
        for b in range(length - 1, -1, -1):
            bits.append((val >> b) & 1)

    push_bits(0b0100, 4)
    push_bits(len(payload), 8)
    for byte in payload:
        push_bits(byte, 8)
    for _ in range(min(4, data_cap * 8 - len(bits))):
        bits.append(0)
    while len(bits) % 8 != 0:
        bits.append(0)

    codewords = [int("".join(str(b) for b in bits[i : i + 8]), 2) for i in range(0, len(bits), 8)]
    pad_bytes = [0xEC, 0x11]
    idx = 0
    while len(codewords) < data_cap:
        codewords.append(pad_bytes[idx % 2])
        idx += 1

    # 分塊與交錯
    block_size = data_cap // blocks
    data_blocks = []
    ec_blocks = []
    pos = 0
    for b in range(blocks):
        extra = 1 if b >= blocks - (data_cap % blocks) and (data_cap % blocks) != 0 else 0
        blk = codewords[pos : pos + block_size + extra]
        pos += len(blk)
        data_blocks.append(blk)
        ec_blocks.append(_rs_encode(blk, ec_cw))

    final_cw = []
    max_dlen = max(len(b) for b in data_blocks)
    for i in range(max_dlen):
        for b in data_blocks:
            if i < len(b):
                final_cw.append(b[i])
    for i in range(ec_cw):
        for eb in ec_blocks:
            final_cw.append(eb[i])

    size = 17 + 4 * ver
    grid = [[None] * size for _ in range(size)]
    reserved = [[False] * size for _ in range(size)]

    def set_mod(r, c, val, res=True):
        if 0 <= r < size and 0 <= c < size:
            grid[r][c] = bool(val)
            if res:
                reserved[r][c] = True

    def place_finder(top, left):
        for r in range(-1, 8):
            for c in range(-1, 8):
                rr, cc = top + r, left + c
                if 0 <= rr < size and 0 <= cc < size:
                    in_outer = 0 <= r <= 6 and 0 <= c <= 6 and (r in (0, 6) or c in (0, 6))
                    in_inner = 2 <= r <= 4 and 2 <= c <= 4
                    set_mod(rr, cc, in_outer or in_inner, True)

    place_finder(0, 0)
    place_finder(0, size - 7)
    place_finder(size - 7, 0)

    for i in range(8, size - 8):
        set_mod(6, i, i % 2 == 0, True)
        set_mod(i, 6, i % 2 == 0, True)

    for r in align:
        for c in align:
            if (r < 9 and c < 9) or (r < 9 and c > size - 10) or (r > size - 10 and c < 9):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    val = max(abs(dr), abs(dc)) in (0, 2)
                    set_mod(r + dr, c + dc, val, True)

    # 保留格式資訊區與暗模組
    for i in range(9):
        if not reserved[8][i]:
            reserved[8][i] = True
        if not reserved[i][8]:
            reserved[i][8] = True
    for i in range(8):
        reserved[8][size - 1 - i] = True
        reserved[size - 1 - i][8] = True
    set_mod(size - 8, 8, True, True)

    # 填入資料位元
    stream = []
    for cw in final_cw:
        for b in range(7, -1, -1):
            stream.append((cw >> b) & 1)
    while len(stream) < size * size:
        stream.append(0)

    bit_idx = 0
    upward = True
    col = size - 1
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for r in rows:
            for dc in (0, -1):
                c = col + dc
                if not reserved[r][c]:
                    bit = stream[bit_idx]
                    bit_idx += 1
                    # Mask 0: (r + c) % 2 == 0
                    if (r + c) % 2 == 0:
                        bit ^= 1
                    grid[r][c] = bool(bit)
        upward = not upward
        col -= 2

    # Format info for Level L (01) + Mask 0 (000) -> precomputed BCH = 0x77C4 (111011111000100)
    fmt_bits = [(0x77C4 >> i) & 1 for i in range(14, -1, -1)]
    fmt_coords_1 = [(8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8), (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8)]
    for (r, c), b in zip(fmt_coords_1, fmt_bits):
        grid[r][c] = bool(b)
    for i in range(7):
        grid[size - 1 - i][8] = bool(fmt_bits[i])
    for i in range(7, 15):
        grid[8][size - 15 + i] = bool(fmt_bits[i])

    margin = 3
    total = size + margin * 2
    rects = []
    for r in range(size):
        for c in range(size):
            if grid[r][c]:
                rects.append(f'<rect x="{c + margin}" y="{r + margin}" width="1" height="1"/>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
        f'width="184" height="184" shape-rendering="crispEdges">'
        f'<rect width="{total}" height="{total}" fill="#faf8f4"/>'
        f'<g fill="#1d1c19">{"".join(rects)}</g></svg>'
    )
