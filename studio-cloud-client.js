/**
 * studio-cloud-client.js — 線上雲端工作台嚴謹雙重驗證 (PBKDF2-SHA256 + TOTP 2FA) 與 API 代理層
 *
 * 架構說明：
 * - 在本機環境 (localhost / 127.0.0.1)：不介入，交由本機 server.py 離線認證與直寫硬碟處理。
 * - 在公開雲端環境 (GitHub Pages / Netlify)：
 *   1. 載入瞬間即鎖定並隱藏工作台，未通過雙重驗證前絕不開放操作。
 *   2. 採用瀏覽器原生 WebCrypto 執行 60 萬次 PBKDF2-HMAC-SHA256 衍生運算，並透過 Google Workspace 雲端中樞
 *      完成伺服器端 SHA-256 Verifier 常數時間校驗 ＋ RFC 6238 TOTP 六位數動態驗證碼驗證（零月租費、不受 Netlify 建置額度限制）。
 *   3. 攔截所有 /api/studio/* 請求，自動附上 2 小時效期之 HMAC-SHA256 JWT 與 CSRF 權杖，直接原子讀寫 GitHub 主站與個人雲端硬碟。
 */
(function () {
  "use strict";

  const host = window.location.hostname;
  const IS_LOCAL = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (IS_LOCAL) {
    window.__STUDIO_IS_CLOUD__ = false;
    window.__STUDIO_CLOUD_LOCKED__ = false;
    return;
  }

  window.__STUDIO_IS_CLOUD__ = true;
  const cfgScriptUrl =
    window.SITE_CONFIG &&
    window.SITE_CONFIG.newsletter &&
    typeof window.SITE_CONFIG.newsletter.googleScriptUrl === "string"
      ? window.SITE_CONFIG.newsletter.googleScriptUrl.trim()
      : "";
  const CLOUD_HUB_URL = cfgScriptUrl;
  const SESSION_KEY = "__deediao_cloud_studio_session_v2";

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj.token || !obj.expiresAt || obj.expiresAt * 1000 <= Date.now()) {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }
      return obj;
    } catch (_) {
      return null;
    }
  }

  function saveSession(token, csrf, expiresAt) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token, csrf, expiresAt }));
  }

  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  window.__STUDIO_CLOUD_LOCKED__ = !readSession();
  if (window.__STUDIO_CLOUD_LOCKED__) {
    document.documentElement.classList.add("cloud-auth-locked");
  }

  function hexToUint8(hex) {
    const clean = String(hex || "").trim();
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function uint8ToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function derivePbkdf2Hex(password, saltHex, iterations) {
    const enc = new TextEncoder();
    const baseKey = await window.crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveBits"]
    );
    const bits = await window.crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: hexToUint8(saltHex),
        iterations: Number(iterations) || 600000,
        hash: "SHA-256",
      },
      baseKey,
      256
    );
    return uint8ToHex(new Uint8Array(bits));
  }

  const origFetch = window.fetch.bind(window);

  async function postHubJson(payload) {
    if (!CLOUD_HUB_URL) {
      throw new Error(
        "尚未設定 Google Apps Script 雲端中樞網址。請先依《新手零基礎快速上線手冊》完成試算表部署，並填入「網站品牌設定」的電子報雲端網址。"
      );
    }
    const resp = await origFetch(CLOUD_HUB_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error(`雲端中樞連線異常 (${resp.status})`);
    }
    return resp.json();
  }

  // 攔截所有 /api/studio/* 與 /api/auth/logout 請求，轉送至受 2FA 保護之 Google Workspace 雲端中樞
  window.fetch = async function (input, initOpts) {
    const urlStr = typeof input === "string" ? input : input?.url || "";
    const opts = initOpts ? { ...initOpts } : {};

    if (urlStr === "/api/auth/logout") {
      clearSession();
      window.__STUDIO_CLOUD_LOCKED__ = true;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.startsWith("/api/studio/")) {
      const sess = readSession();
      if (!sess) {
        window.__STUDIO_CLOUD_LOCKED__ = true;
        showCloudAuthGate();
        return new Response(
          JSON.stringify({ ok: false, authRequired: true, message: "請先通過雲端雙重驗證" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      const parsed = new URL(urlStr, window.location.origin);
      const subPath = parsed.pathname.slice("/api/studio".length) || "/";
      const query = {};
      parsed.searchParams.forEach((v, k) => {
        query[k] = v;
      });

      const method = (opts.method || "GET").toUpperCase();
      let reqBody = {};
      if (method !== "GET" && opts.body) {
        try {
          reqBody = typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
        } catch (_) {
          reqBody = {};
        }
      }

      try {
        const data = await postHubJson({
          action: "cloud_studio",
          method,
          subPath,
          query,
          body: reqBody,
          jwtToken: sess.token,
          csrfToken: sess.csrf,
        });

        if (data && data.authRequired) {
          clearSession();
          window.__STUDIO_CLOUD_LOCKED__ = true;
          showCloudAuthGate(data.message || "登入憑證已逾時，請重新通過雙重驗證。");
          return new Response(JSON.stringify(data), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        const status = data && data.ok === false ? 400 : 200;
        return new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, message: err.message || "雲端 API 請求失敗" }),
          { status: 502, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    return origFetch(input, opts);
  };

  function showCloudAuthGate(initialErr) {
    document.documentElement.classList.add("cloud-auth-locked");
    let overlay = document.getElementById("cloud-auth-gate-overlay");
    if (overlay) {
      overlay.hidden = false;
      const errEl = overlay.querySelector("#cloud-gate-error");
      if (errEl && initialErr) errEl.textContent = initialErr;
      return;
    }

    overlay = document.createElement("div");
    overlay.id = "cloud-auth-gate-overlay";
    overlay.className = "cloud-auth-overlay";
    overlay.innerHTML = `
      <div class="cloud-auth-card" role="dialog" aria-modal="true" aria-labelledby="cloud-gate-title">
        <span class="cloud-gate-kicker">CLOUD SECURITY GATE · 雲端雙重驗證閘門</span>
        <h1 id="cloud-gate-title" class="cloud-gate-title">書齋雲端編輯工作台</h1>
        <p class="cloud-gate-desc">
          此工作台直接連通 GitHub 主站、Google 雲端硬碟與站長點閱儀表板，受 <strong>PBKDF2-SHA256 六十萬次雜湊 ＋ RFC 6238 TOTP 六位數動態驗證碼</strong> 嚴謹保護。
          連續驗證失敗 5 次將自動鎖定 15 分鐘，單次憑證 2 小時自動失效。
        </p>

        <form id="cloud-login-form" class="cloud-gate-form" autocomplete="off">
          <div class="cloud-gate-field">
            <label for="cloud-login-pw">第一因素：主管理密碼 (Master Passphrase)</label>
            <div class="pw-input-wrap">
              <input type="password" id="cloud-login-pw" required autofocus placeholder="輸入主管理密碼⋯" spellcheck="false" autocapitalize="off" />
              <button type="button" id="toggle-cloud-pw-btn" class="pw-toggle-btn" aria-pressed="false" title="切換顯示或隱藏輸入的密碼文字">顯示密碼</button>
            </div>
          </div>
          <label class="cloud-gate-field">
            <span>第二因素：6 位數動態驗證碼（或單次緊急恢復碼）</span>
            <input type="text" id="cloud-login-2fa" required placeholder="6 位數驗證碼 或 XXXX-XXXX-XXXX" class="cloud-code-input" />
          </label>
          <div id="cloud-gate-error" class="cloud-gate-error" role="alert"></div>
          <button type="submit" id="cloud-gate-submit" class="cloud-gate-btn">驗證身分並解鎖雲端工作台</button>
        </form>

        <div class="cloud-gate-footer" style="display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <a href="./">← 返回公開網站首頁</a>
          <a href="http://localhost:8788/studio.html">切換至 Mac 本機離線工作台 →</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const errEl = overlay.querySelector("#cloud-gate-error");
    if (initialErr) errEl.textContent = initialErr;

    requestAnimationFrame(() => {
      document.getElementById("cloud-login-pw")?.focus();
    });

    const pwInputEl = overlay.querySelector("#cloud-login-pw");
    const pwToggleBtn = overlay.querySelector("#toggle-cloud-pw-btn");
    pwToggleBtn?.addEventListener("click", () => {
      if (!pwInputEl) return;
      const showPlain = pwInputEl.type === "password";
      pwInputEl.type = showPlain ? "text" : "password";
      pwToggleBtn.textContent = showPlain ? "隱藏密碼" : "顯示密碼";
      pwToggleBtn.setAttribute("aria-pressed", showPlain ? "true" : "false");
      pwToggleBtn.classList.toggle("is-showing", showPlain);
      pwInputEl.focus();
      const len = pwInputEl.value.length;
      try {
        pwInputEl.setSelectionRange(len, len);
      } catch (_) {}
    });

    const form = overlay.querySelector("#cloud-login-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.textContent = "";
      const pw = document.getElementById("cloud-login-pw").value;
      const code = document.getElementById("cloud-login-2fa").value.trim();
      const btn = overlay.querySelector("#cloud-gate-submit");
      btn.disabled = true;
      btn.textContent = "密碼學雙重驗證中⋯";

      try {
        const saltInfo = await postHubJson({ action: "studio_auth_salt" });
        if (!saltInfo || !saltInfo.ok || !saltInfo.configured || !saltInfo.saltHex) {
          throw new Error(saltInfo?.message || "雲端雙重驗證金鑰尚未就緒");
        }

        const dkHex = await derivePbkdf2Hex(pw, saltInfo.saltHex, saltInfo.iterations || 600000);
        const loginRes = await postHubJson({
          action: "studio_auth_login",
          dkHex,
          secondFactor: code,
        });

        if (!loginRes || !loginRes.ok) {
          throw new Error(loginRes?.message || "主管理密碼或 6 位數驗證碼不正確");
        }

        saveSession(loginRes.token, loginRes.csrfToken, loginRes.expiresAt);
        window.__STUDIO_CLOUD_LOCKED__ = false;
        overlay.remove();
        document.documentElement.classList.remove("cloud-auth-locked");
        window.location.reload();
      } catch (err) {
        errEl.textContent = err.message || "連線雲端驗證閘門失敗";
        btn.disabled = false;
        btn.textContent = "驗證身分並解鎖雲端工作台";
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const sess = readSession();
    if (sess) {
      window.__STUDIO_CLOUD_LOCKED__ = false;
      document.documentElement.classList.remove("cloud-auth-locked");
      const badge = document.querySelector(".studio-badge");
      if (badge) badge.textContent = "CLOUD STUDIO · 2FA";
      const status = document.getElementById("studio-status");
      if (status) status.textContent = "雲端即時直寫模式 · 存檔即同步";
    } else {
      showCloudAuthGate();
    }
  });
})();
