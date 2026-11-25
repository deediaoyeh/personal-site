/**
 * studio-cloud-client.js — GitHub Pages & Netlify 雲端工作台嚴謹雙重驗證 (2FA) 閘門與 API 代理層
 *
 * 行為說明：
 * - 在本機環境 (localhost / 127.0.0.1)：不介入，完全交由本機 server.py 雙重驗證與離線直寫處理。
 * - 在公開雲端環境 (GitHub Pages / Netlify)：
 *   1. 載入瞬間即鎖定並隱藏整個工作台 DOM，未通過 PBKDF2-SHA256 + TOTP 雙重驗證前絕不開放操作。
 *   2. 攔截所有 /api/studio/* 請求並透明轉發至 https://deediao-studio.netlify.app/api/cloud-studio/*，
 *      自動附上 HMAC-SHA256 JWT (Authorization: Bearer) 與 X-Studio-CSRF 權杖。
 *   3. 憑證僅存於分頁 sessionStorage（關閉分頁即自動清除，且伺服器端強制 2 小時失效）。
 */
(function () {
  "use strict";

  const host = window.location.hostname;
  const IS_LOCAL = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (IS_LOCAL) {
    window.__STUDIO_IS_CLOUD__ = false;
    return;
  }

  window.__STUDIO_IS_CLOUD__ = true;
  const CLOUD_API_BASE = "https://deediao-studio.netlify.app/api/cloud-studio";
  const SESSION_KEY = "__deediao_cloud_studio_session_v1";

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

  // 立即鎖定頁面，避免未驗證前閃現工作台介面
  document.documentElement.classList.add("cloud-auth-locked");

  // 攔截 fetch：將 /api/studio/* 與 /api/auth/logout 導向受 2FA 保護之雲端 API
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input, initOpts) {
    const urlStr = typeof input === "string" ? input : input?.url || "";
    const opts = initOpts ? { ...initOpts } : {};

    if (urlStr === "/api/auth/logout") {
      clearSession();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.startsWith("/api/studio/")) {
      const sess = readSession();
      if (!sess) {
        showCloudAuthGate();
        return new Response(JSON.stringify({ ok: false, authRequired: true, message: "請先通過雲端雙重驗證" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const targetUrl = CLOUD_API_BASE + urlStr.slice("/api/studio".length);
      const headers = new Headers(opts.headers || {});
      headers.set("Authorization", `Bearer ${sess.token}`);
      const method = (opts.method || "GET").toUpperCase();
      if (method !== "GET" && sess.csrf) {
        headers.set("X-Studio-CSRF", sess.csrf);
      }
      opts.headers = headers;

      const resp = await origFetch(targetUrl, opts);
      if (resp.status === 401) {
        clearSession();
        showCloudAuthGate("登入憑證已逾時或失效，請重新通過雙重驗證。");
      }
      return resp;
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
          此工作台直接寫入 GitHub 主站與 Netlify 備份站，受 <strong>PBKDF2-SHA256 ＋ RFC 6238 TOTP 六位數動態驗證碼</strong> 嚴謹保護。
          連續驗證失敗 5 次將自動鎖定 15 分鐘，單次憑證 2 小時自動失效。
        </p>

        <form id="cloud-login-form" class="cloud-gate-form" autocomplete="off">
          <label class="cloud-gate-field">
            <span>第一因素：主管理密碼 (Master Passphrase)</span>
            <input type="password" id="cloud-login-pw" required autofocus placeholder="輸入主管理密碼⋯" />
          </label>
          <label class="cloud-gate-field">
            <span>第二因素：6 位數動態驗證碼（或單次緊急恢復碼）</span>
            <input type="text" id="cloud-login-2fa" required placeholder="6 位數驗證碼 或 XXXX-XXXX-XXXX" class="cloud-code-input" />
          </label>
          <div id="cloud-gate-error" class="cloud-gate-error" role="alert"></div>
          <button type="submit" id="cloud-gate-submit" class="cloud-gate-btn">驗證身分並解鎖雲端工作台</button>
        </form>

        <div class="cloud-gate-footer">
          <a href="./">← 返回公開網站首頁</a>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const errEl = overlay.querySelector("#cloud-gate-error");
    if (initialErr) errEl.textContent = initialErr;

    const form = overlay.querySelector("#cloud-login-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.textContent = "";
      const btn = overlay.querySelector("#cloud-gate-submit");
      btn.disabled = true;
      btn.textContent = "密碼學雙重驗證中⋯";

      try {
        const res = await origFetch(`${CLOUD_API_BASE}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: document.getElementById("cloud-login-pw").value,
            secondFactor: document.getElementById("cloud-login-2fa").value,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.message || "驗證失敗，請確認密碼與 6 位數驗證碼");
        }
        saveSession(data.token, data.csrfToken, data.expiresAt);
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
