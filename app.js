/**
 * 低調走過 (Deediao) — 靜謐書齋風個人知識庫與電子報前端引擎 (零外部框架依賴)
 * 支援：Hash 路由、內建 Markdown + Wiki-links 雙向連結解析、文章目錄生成、全站搜尋、Google Apps Script 電子報訂閱。
 */
(function () {
  "use strict";

  let CONFIG = window.SITE_CONFIG;
  const IS_LOCAL_HOST =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "::1";
  const LIVE_DATA_ENDPOINT = "https://deediao-studio.netlify.app/api/live-data";
  const GITHUB_REPO = "deediaoyeh/personal-site";
  const GITHUB_REF_URL = `https://api.github.com/repos/${GITHUB_REPO}/git/ref/heads/main`;

  const state = {
    manifest: null,
    contentCache: new Map(),
    liveSha: null,
    liveRawBase: null,
    liveThemeBlobUrl: null,
    essayTag: "全部",
    noteStage: "全部",
    noteTag: "全部",
    theme: localStorage.getItem("warmcraft_theme") || "paper"
  };

  const STAGE_LABELS = {
    evergreen: "常青 · Evergreen",
    budding: "整理中 · Budding",
    seedling: "萌芽 · Seedling"
  };

  const TYPE_LABELS = {
    essay: "長文 · Essay",
    note: "筆記 · Note",
    letter: "電子報 · Letter"
  };

  // =========================================================================
  // 初始化
  // =========================================================================
  function applyLiveThemeCss(cssText) {
    if (!cssText) return;
    try {
      if (state.liveThemeBlobUrl) {
        URL.revokeObjectURL(state.liveThemeBlobUrl);
      }
      const blob = new Blob([cssText], { type: "text/css" });
      const blobUrl = URL.createObjectURL(blob);
      state.liveThemeBlobUrl = blobUrl;
      let link = document.getElementById("live-theme-override");
      if (!link) {
        link = document.createElement("link");
        link.id = "live-theme-override";
        link.rel = "stylesheet";
        document.head.appendChild(link);
      }
      link.href = blobUrl;
    } catch (_) {
      // 略過，保留原有樣式
    }
  }

  async function fetchLatestShaFromGitHub(signal) {
    const res = await fetch(`${GITHUB_REF_URL}?t=${Date.now()}`, {
      cache: "no-store",
      headers: { Accept: "application/vnd.github+json" },
      signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.object?.sha || null;
  }

  async function fetchLiveDataFromGitHub(signal) {
    const sha = await fetchLatestShaFromGitHub(signal);
    if (!sha) return null;
    const rawBase = `https://raw.githubusercontent.com/${GITHUB_REPO}/${sha}`;
    const [cfgRes, themeRes, manifestRes] = await Promise.all([
      fetch(`${rawBase}/site.config.js`, { cache: "no-store", signal }),
      fetch(`${rawBase}/theme.custom.css`, { cache: "no-store", signal }),
      fetch(`${rawBase}/content/manifest.json`, { cache: "no-store", signal })
    ]);

    let config = null;
    if (cfgRes.ok) {
      const cfgRaw = await cfgRes.text();
      const m = cfgRaw.match(/window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (m) config = JSON.parse(m[1]);
    }
    const themeCss = themeRes.ok ? await themeRes.text() : "";
    const manifest = manifestRes.ok ? await manifestRes.json() : null;
    return { ok: true, sha, rawBase, config, themeCss, manifest };
  }

  async function fetchLiveDataSnapshot() {
    if (IS_LOCAL_HOST) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      // 優先直接透過 GitHub 最新 Commit SHA + 不可變 raw URL 拉取（0 秒快取延遲、不消耗 Netlify 額度）
      const ghSnap = await fetchLiveDataFromGitHub(ctrl.signal);
      if (ghSnap && ghSnap.manifest) return ghSnap;

      // 備援：若 GitHub 匿名額度暫時達上限，退回 Netlify Function
      const res = await fetch(`${LIVE_DATA_ENDPOINT}?t=${Date.now()}`, {
        cache: "no-store",
        signal: ctrl.signal
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !data.ok) return null;
      return data;
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkLiveUpdatesSilently() {
    if (IS_LOCAL_HOST || document.hidden) return;
    try {
      const sha = await fetchLatestShaFromGitHub();
      if (!sha || (state.liveSha && sha === state.liveSha)) return;

      const snap = await fetchLiveDataSnapshot();
      if (!snap) return;
      state.liveSha = snap.sha;
      state.liveRawBase = snap.rawBase || null;
      if (snap.config) {
        window.SITE_CONFIG = snap.config;
        CONFIG = snap.config;
      }
      if (snap.themeCss) {
        applyLiveThemeCss(snap.themeCss);
      }
      if (snap.manifest) {
        state.manifest = snap.manifest;
        state.contentCache.clear();
      }
      renderShellChrome();
      await handleRoute(false);
    } catch (_) {
      // 離線或暫時無回應時靜默忽略
    }
  }

  async function refreshLatestSiteConfig() {
    try {
      const bust = Date.now();
      const customThemeLink = document.querySelector('link[href*="./theme.custom.css"]');
      if (customThemeLink) {
        customThemeLink.href = `./theme.custom.css?t=${bust}`;
      }
      const cfgRes = await fetch(`./site.config.js?t=${bust}`, { cache: "no-store" });
      if (cfgRes.ok) {
        const raw = await cfgRes.text();
        const m = raw.match(/window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
        if (m) {
          const parsed = JSON.parse(m[1]);
          window.SITE_CONFIG = parsed;
          CONFIG = parsed;
        }
      }
    } catch (_) {
      // 保留初始載入之 window.SITE_CONFIG
    }
  }

  async function init() {
    applyTheme(state.theme);
    // 先以現有 SITE_CONFIG 零延遲渲染導覽列品牌與頁尾，避免網路請求期間閃現預設字樣
    if (CONFIG && CONFIG.brand) {
      renderShellChrome();
    }

    // 公開雲端站點（GitHub Pages / Netlify）優先從準即時端點拉取最新 Commit 資料（~1 秒反映，無須等建置與 CDN 快取）
    const liveSnap = await fetchLiveDataSnapshot();
    if (liveSnap) {
      state.liveSha = liveSnap.sha;
      state.liveRawBase = liveSnap.rawBase || null;
      if (liveSnap.config) {
        window.SITE_CONFIG = liveSnap.config;
        CONFIG = liveSnap.config;
      }
      if (liveSnap.themeCss) {
        applyLiveThemeCss(liveSnap.themeCss);
      }
      if (liveSnap.manifest) {
        state.manifest = liveSnap.manifest;
      }
    } else {
      await refreshLatestSiteConfig();
    }

    renderShellChrome();
    bindGlobalEvents();

    try {
      if (!state.manifest) {
        const res = await fetch(`./content/manifest.json?t=${Date.now()}`, { cache: "no-store" });
        if (!res.ok) throw new Error("無法讀取內容索引檔");
        state.manifest = await res.json();
      }
      await handleRoute(true);

      // 公開站點：切回分頁或每 60 秒輕量檢查 GitHub 最新 SHA，有變更即自動無縫刷新
      if (!IS_LOCAL_HOST) {
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden) checkLiveUpdatesSilently();
        });
        setInterval(checkLiveUpdatesSilently, 60000);
      }
    } catch (err) {
      document.getElementById("app-main").innerHTML = `
        <div class="page-header">
          <span class="section-kicker mono-label">LOCAL SERVER NOTICE</span>
          <h1 class="page-title">請透過本機伺服器開啟預覽</h1>
          <p class="page-desc">瀏覽器基於安全限制無法直接以 <code>file://</code> 讀取 Markdown 檔案。請雙擊資料夾內的 <code>start.command</code>，或執行 <code>python3 -m http.server 8788</code> 開啟。</p>
        </div>
      `;
    }
  }

  function renderShellChrome() {
    document.title = CONFIG.brand.studioTitle;
    document.getElementById("brand-name").textContent = CONFIG.brand.name;
    document.getElementById("brand-latin").textContent = CONFIG.brand.latinName;

    // 顯示受雙重驗證 (2FA) 保護之「編輯工作台」入口（未授權訪客點入將被雙重認證閘門攔截）
    const studioLink = document.getElementById("local-studio-link");
    if (studioLink) {
      studioLink.hidden = false;
    }

    const year = new Date().getFullYear();
    document.getElementById("footer-colophon").textContent =
      `© ${CONFIG.brand.since}–${year} ${CONFIG.brand.name} (${CONFIG.brand.latinName}). 以靜謐書齋風格打造，內容以純文字 Markdown 長期保存。`;

    const linksWrap = document.getElementById("footer-links");
    linksWrap.innerHTML = CONFIG.links
      .filter((l) => l.url)
      .map((l) => {
        const external = l.url.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${escapeHtml(l.url)}"${external}>${escapeHtml(l.label)}</a>`;
      })
      .join("");
  }

  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("warmcraft_theme", theme);
    const label = document.getElementById("theme-toggle-label");
    if (label) {
      label.textContent = theme === "paper" ? "夜讀" : "晨讀";
    }
  }

  // =========================================================================
  // 路由控制
  // =========================================================================
  async function handleRoute(shouldScrollTop = true) {
    const hash = window.location.hash || "#/";
    const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const route = parts[0] || "home";
    const slug = parts[1] || null;

    // 更新導覽列選取態
    document.querySelectorAll(".nav-link").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.route === route);
    });

    // 重設閱讀進度條
    const progressEl = document.getElementById("reading-progress");
    progressEl.style.width = "0%";

    const mainEl = document.getElementById("app-main");

    if (route === "home") {
      renderHome(mainEl);
    } else if (route === "essays" && !slug) {
      renderEssaysList(mainEl);
    } else if (route === "essays" && slug) {
      await renderDetail(mainEl, "essay", slug);
    } else if (route === "notes" && !slug) {
      renderNotesList(mainEl);
    } else if (route === "notes" && slug) {
      await renderDetail(mainEl, "note", slug);
    } else if (route === "letters" && !slug) {
      renderLettersList(mainEl);
    } else if (route === "letters" && slug) {
      await renderDetail(mainEl, "letter", slug);
    } else if (route === "about") {
      renderAbout(mainEl);
    } else {
      renderHome(mainEl);
    }

    if (shouldScrollTop) {
      window.scrollTo({ top: 0, behavior: "instant" });
    }
    bindNewsletterForms();
    schedulePageviewBeacon(route, slug);
  }

  // =========================================================================
  // 輕量無痕點閱統計信標（不蒐集個資與 Cookie；自動排除本機與已開啟排除之站長瀏覽器）
  // =========================================================================
  let lastTrackedRoute = "";
  let beaconTimer = null;

  function getAnonVisitorHash() {
    try {
      const key = "deediao_anon_vid";
      let vid = sessionStorage.getItem(key);
      if (!vid) {
        vid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        sessionStorage.setItem(key, vid);
      }
      return vid;
    } catch (_) {
      return "anon";
    }
  }

  function classifyReferrer() {
    const ref = document.referrer || "";
    if (!ref) return "直接造訪 (Direct)";
    try {
      const host = new URL(ref).hostname.toLowerCase().replace(/^www\./, "");
      if (host === window.location.hostname.toLowerCase()) return "站內導覽";
      if (host.includes("google.")) return "Google 搜尋";
      if (host.includes("facebook.") || host.includes("fb.")) return "Facebook";
      if (host.includes("threads.net")) return "Threads";
      if (host.includes("line.me")) return "LINE";
      if (host.includes("github.")) return "GitHub";
      if (host.includes("bing.")) return "Bing 搜尋";
      return host;
    } catch (_) {
      return "外部連結";
    }
  }

  function detectDeviceKind() {
    const ua = navigator.userAgent || "";
    if (/ipad|tablet/i.test(ua)) return "tablet";
    if (/mobi|iphone|android/i.test(ua)) return "mobile";
    return "desktop";
  }

  function resolveRouteTitleAndType(route, slug) {
    if (route === "home") return { title: "首頁 · 書齋總覽", pageType: "首頁" };
    if (route === "about") return { title: "關於與近況 (/about)", pageType: "關於" };
    if (route === "essays" && !slug) return { title: "深度長文列表", pageType: "列表" };
    if (route === "notes" && !slug) return { title: "知識筆記列表", pageType: "列表" };
    if (route === "letters" && !slug) return { title: "雙週電子報歸檔", pageType: "列表" };

    if (slug && state.manifest?.items) {
      const targetType = route === "essays" ? "essay" : route === "notes" ? "note" : "letter";
      const found = state.manifest.items.find((i) => i.type === targetType && i.slug === slug);
      const typeLabel = targetType === "essay" ? "長文" : targetType === "note" ? "筆記" : "電子報";
      if (found) return { title: found.title, pageType: typeLabel };
    }
    return { title: window.location.hash || "#/", pageType: "頁面" };
  }

  function schedulePageviewBeacon(route, slug) {
    if (IS_LOCAL_HOST) return;
    try {
      if (localStorage.getItem("deediao_owner_exclude_analytics") === "1") return;
    } catch (_) {}

    const scriptUrl = (CONFIG?.newsletter?.googleScriptUrl || "").trim();
    if (!scriptUrl) return;

    const canonicalRoute = window.location.hash || "#/";
    if (canonicalRoute === lastTrackedRoute) return;

    if (beaconTimer) clearTimeout(beaconTimer);
    beaconTimer = setTimeout(() => {
      lastTrackedRoute = canonicalRoute;
      const info = resolveRouteTitleAndType(route, slug);
      const payload = JSON.stringify({
        action: "pageview",
        route: canonicalRoute,
        title: info.title,
        pageType: info.pageType,
        visitorHash: getAnonVisitorHash(),
        referrer: classifyReferrer(),
        device: detectDeviceKind(),
        host: window.location.hostname
      });
      fetch(scriptUrl, {
        method: "POST",
        mode: "no-cors",
        keepalive: true,
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: payload
      }).catch(() => {});
    }, 650);
  }

  // =========================================================================
  // 首頁視圖 (Home)
  // =========================================================================
  function renderHome(container) {
    const essays = state.manifest.items.filter((i) => i.type === "essay");
    const notes = state.manifest.items.filter((i) => i.type === "note");
    const letters = state.manifest.items.filter((i) => i.type === "letter");

    const featuredEssays = essays.slice(0, 4);
    const recentNotes = notes.slice(0, 4);

    container.innerHTML = `
      <section class="home-intro-grid">
        <div>
          <div class="home-role-line">${escapeHtml(CONFIG.brand.role)} · ${escapeHtml(CONFIG.brand.location)}</div>
          <h1 class="home-headline">${escapeHtml(CONFIG.intro.greeting)}</h1>
          <p class="home-lead">${escapeHtml(CONFIG.intro.lead)}</p>
          <a href="#/about" class="home-more-link">認識我與近期研究（/now） →</a>
        </div>

        <aside class="home-desk-panel" aria-label="近期研究與館藏統計">
          <div>
            <span class="section-kicker mono-label">CURRENTLY EXPLORING · 近期思考題目</span>
            <ul class="exploring-list">
              ${CONFIG.intro.currentlyExploring.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>
          </div>

          <div class="archive-metrics">
            <a href="#/essays" class="metric-item">
              <span class="metric-num">${essays.length}</span>
              <span class="metric-label">深度長文</span>
            </a>
            <a href="#/notes" class="metric-item">
              <span class="metric-num">${notes.length}</span>
              <span class="metric-label">知識筆記</span>
            </a>
            <a href="#/letters" class="metric-item">
              <span class="metric-num">№ ${String(letters.length).padStart(2, "0")}</span>
              <span class="metric-label">電子報期數</span>
            </a>
          </div>
        </aside>
      </section>

      <section class="home-section">
        <div class="section-header-row">
          <div>
            <span class="section-kicker mono-label">SELECTED ESSAYS</span>
            <h2 class="section-heading">深度長文</h2>
          </div>
          <a href="#/essays" class="section-all-link">瀏覽全部 ${essays.length} 篇 →</a>
        </div>
        <div class="essay-list">
          ${featuredEssays.map(renderEssayRowHtml).join("")}
        </div>
      </section>

      <section class="home-section">
        <div class="section-header-row">
          <div>
            <span class="section-kicker mono-label">FIELD NOTES & DIGITAL GARDEN</span>
            <h2 class="section-heading">近期知識卡片與短筆記</h2>
          </div>
          <a href="#/notes" class="section-all-link">進入筆記庫 →</a>
        </div>
        <div class="notes-grid">
          ${recentNotes.map(renderNoteCardHtml).join("")}
        </div>
      </section>

      <section class="home-section">
        ${renderNewsletterBoxHtml("home")}
      </section>
    `;
  }

  // =========================================================================
  // 深度長文列表 (Essays)
  // =========================================================================
  function renderEssaysList(container) {
    const essays = state.manifest.items.filter((i) => i.type === "essay");
    const allTags = ["全部", ...new Set(essays.flatMap((e) => e.tags || []))];
    const filtered =
      state.essayTag === "全部"
        ? essays
        : essays.filter((e) => (e.tags || []).includes(state.essayTag));

    container.innerHTML = `
      <header class="page-header">
        <span class="section-kicker mono-label">ESSAYS · 結構化論述</span>
        <h1 class="page-title">深度長文</h1>
        <p class="page-desc">針對系統思考、知識工作方法與組織決策的完整推論。每篇文章皆經過實務驗證與反覆修訂。</p>
      </header>

      <div class="filter-bar" role="tablist" aria-label="文章主題篩選">
        ${allTags
          .map(
            (tag) => `
          <button type="button" class="filter-chip ${state.essayTag === tag ? "is-active" : ""}" data-essay-tag="${escapeHtml(tag)}">
            ${escapeHtml(tag)}
          </button>
        `
          )
          .join("")}
      </div>

      <div class="essay-list">
        ${filtered.map(renderEssayRowHtml).join("")}
      </div>
    `;

    container.querySelectorAll("[data-essay-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.essayTag = btn.dataset.essayTag;
        renderEssaysList(container);
      });
    });
  }

  function renderEssayRowHtml(item) {
    return `
      <a href="#/essays/${encodeURIComponent(item.slug)}" class="essay-row">
        <span class="meta-date">${escapeHtml(formatDateDot(item.date))}</span>
        <div class="essay-row-main">
          <h3 class="essay-row-title">${escapeHtml(item.title)}</h3>
          <p class="essay-row-summary">${escapeHtml(item.summary)}</p>
        </div>
        <span class="essay-row-meta mono-label">${escapeHtml(item.readingTime || "6 min")}</span>
      </a>
    `;
  }

  // =========================================================================
  // 知識卡片與短筆記列表 (Notes / Digital Garden)
  // =========================================================================
  function renderNotesList(container) {
    const notes = state.manifest.items.filter((i) => i.type === "note");
    const stages = [
      { key: "全部", label: "全部狀態" },
      { key: "evergreen", label: "常青 Evergreen" },
      { key: "budding", label: "整理中 Budding" },
      { key: "seedling", label: "萌芽 Seedling" }
    ];
    const allNoteTags = ["全部", ...new Set(notes.flatMap((n) => n.tags || []))];
    if (!allNoteTags.includes(state.noteTag)) {
      state.noteTag = "全部";
    }

    const filtered = notes.filter((n) => {
      if (state.noteStage !== "全部" && n.stage !== state.noteStage) return false;
      if (state.noteTag !== "全部" && !(n.tags || []).includes(state.noteTag)) return false;
      return true;
    });

    container.innerHTML = `
      <header class="page-header">
        <span class="section-kicker mono-label">NOTES · 數位花園與知識卡片</span>
        <h1 class="page-title">知識筆記</h1>
        <p class="page-desc">這裡存放讀書摘錄、方法備忘與尚未寫成長文的思考碎片。筆記依成熟度分為「萌芽」、「整理中」與「常青」，並可依主題標籤交叉檢索。</p>
      </header>

      <div class="filter-bar" aria-label="筆記成熟度篩選" style="margin-bottom: 10px;">
        ${stages
          .map(
            (s) => `
          <button type="button" class="filter-chip ${state.noteStage === s.key ? "is-active" : ""}" data-note-stage="${s.key}">
            ${escapeHtml(s.label)}
          </button>
        `
          )
          .join("")}
      </div>

      ${
        allNoteTags.length > 1
          ? `
        <div class="filter-bar" aria-label="筆記主題標籤篩選">
          ${allNoteTags
            .map(
              (tag) => `
            <button type="button" class="filter-chip ${state.noteTag === tag ? "is-active" : ""}" data-note-tag="${escapeHtml(tag)}">
              ${tag === "全部" ? "全部標籤" : "#" + escapeHtml(tag)}
            </button>
          `
            )
            .join("")}
        </div>
      `
          : ""
      }

      <div class="notes-grid">
        ${
          filtered.length > 0
            ? filtered.map(renderNoteCardHtml).join("")
            : `<p style="color:var(--ink-muted); padding:20px 0;">此篩選條件下尚無對應筆記。</p>`
        }
      </div>
    `;

    container.querySelectorAll("[data-note-stage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.noteStage = btn.dataset.noteStage;
        renderNotesList(container);
      });
    });

    container.querySelectorAll("[data-note-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.noteTag = btn.dataset.noteTag;
        renderNotesList(container);
      });
    });
  }

  function renderNoteCardHtml(note) {
    const stageText = STAGE_LABELS[note.stage] || STAGE_LABELS.seedling;
    return `
      <a href="#/notes/${encodeURIComponent(note.slug)}" class="note-card">
        <div>
          <div class="note-card-top">
            <span class="note-id mono-label">${escapeHtml(note.noteCode || "NOTE")}</span>
            <span class="note-stage" data-stage="${escapeHtml(note.stage || "seedling")}">${escapeHtml(stageText)}</span>
          </div>
          <h3 class="note-card-title">${escapeHtml(note.title)}</h3>
          <p class="note-card-excerpt">${escapeHtml(note.summary)}</p>
        </div>
        <div class="note-card-footer">
          <div class="tag-list-inline">
            ${(note.tags || []).map((t) => `<span class="tag-item">#${escapeHtml(t)}</span>`).join("")}
          </div>
          <span class="meta-date">${escapeHtml(formatDateDot(note.date))}</span>
        </div>
      </a>
    `;
  }

  // =========================================================================
  // 電子報專頁與歷史歸檔 (Letters)
  // =========================================================================
  function renderLettersList(container) {
    const letters = state.manifest.items.filter((i) => i.type === "letter");

    container.innerHTML = `
      <header class="page-header">
        <span class="section-kicker mono-label">NEWSLETTER · 獨立發行</span>
        <h1 class="page-title">${escapeHtml(CONFIG.newsletter.title)}</h1>
        <p class="page-desc">${escapeHtml(CONFIG.newsletter.promise)}</p>
      </header>

      <div style="margin-bottom: 52px;">
        ${renderNewsletterBoxHtml("letters-page", true)}
      </div>

      <section>
        <div class="section-header-row">
          <div>
            <span class="section-kicker mono-label">PAST ISSUES</span>
            <h2 class="section-heading">過往期數歸檔（可免費試讀）</h2>
          </div>
        </div>
        <div>
          ${
            letters.length === 0
              ? `<p style="color:var(--ink-muted); padding:20px 0;">首期雙週電子報正在彙整撰寫中。歡迎先於上方留下常用信箱，出刊週日早晨將第一時間寄送給你。</p>`
              : letters
                  .map(
                    (item) => `
            <a href="#/letters/${encodeURIComponent(item.slug)}" class="issue-row">
              <span class="issue-num">ISSUE № ${escapeHtml(String(item.issue || "01").padStart(2, "0"))}</span>
              <div class="essay-row-main">
                <h3 class="essay-row-title">${escapeHtml(item.title)}</h3>
                <p class="essay-row-summary">${escapeHtml(item.summary)}</p>
              </div>
              <span class="meta-date" style="text-align:right;">${escapeHtml(formatDateDot(item.date))}</span>
            </a>
          `
                  )
                  .join("")
          }
        </div>
      </section>
    `;
  }

  // =========================================================================
  // 關於與近況頁 (About & Now)
  // =========================================================================
  function renderAbout(container) {
    const about = CONFIG.about || {};
    const paragraphs = about.paragraphs || [];
    const principles = about.principles || [];
    const nowItems = about.nowItems || [];
    const workAndProjects = about.workAndProjects || [];

    container.innerHTML = `
      <header class="page-header">
        <span class="section-kicker mono-label">ABOUT & NOW · 關於書齋主人</span>
        <h1 class="page-title">${escapeHtml(about.headline || "")}</h1>
        <p class="page-desc">${escapeHtml(CONFIG.brand.name)} — ${escapeHtml(CONFIG.brand.role)}</p>
      </header>

      ${
        paragraphs.length > 0
          ? `
        <div class="prose about-prose">
          ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
        </div>
      `
          : ""
      }

      ${
        principles.length > 0
          ? `
        <section>
          <span class="section-kicker mono-label">PRINCIPLES · 寫作與研究準則</span>
          <div class="principles-grid">
            ${principles
              .map(
                (p) => `
              <div class="principle-item">
                <h3>${escapeHtml(p.title)}</h3>
                <p>${escapeHtml(p.desc)}</p>
              </div>
            `
              )
              .join("")}
          </div>
        </section>
      `
          : ""
      }

      ${
        nowItems.length > 0
          ? `
        <section style="margin-bottom: 56px;">
          <div class="section-header-row">
            <div>
              <span class="section-kicker mono-label">NOW · 近況更新（${escapeHtml(about.nowUpdated || "")}）</span>
              <h2 class="section-heading">最近正在專注的事</h2>
            </div>
          </div>
          <div class="now-list">
            ${nowItems
              .map(
                (n) => `
              <div class="now-row">
                <span class="now-label">${escapeHtml(n.label)}</span>
                <div>${escapeHtml(n.text)}</div>
              </div>
            `
              )
              .join("")}
          </div>
        </section>
      `
          : ""
      }

      ${
        workAndProjects.length > 0
          ? `
        <section style="margin-bottom: 56px;">
          <div class="section-header-row">
            <div>
              <span class="section-kicker mono-label">SELECTED WORK & ADVISORY</span>
              <h2 class="section-heading">代表計畫與合作項目</h2>
            </div>
          </div>
          <div class="work-list">
            ${workAndProjects
              .map(
                (w) => `
              <div class="work-row">
                <span class="meta-date">${escapeHtml(w.year)}</span>
                <div>
                  <h3 style="margin:0 0 4px; font-size:1.08rem; font-weight:500;">
                    <a href="${escapeHtml(w.link)}" style="border-bottom:1px solid var(--rule-strong);">${escapeHtml(w.title)}</a>
                    <span style="font-size:0.82rem; color:var(--ink-muted); font-family:Inter,sans-serif; margin-left:8px;">${escapeHtml(w.role)}</span>
                  </h3>
                  <p style="margin:0; font-size:0.92rem; color:var(--ink-secondary);">${escapeHtml(w.desc)}</p>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
        </section>
      `
          : ""
      }

      ${renderNewsletterBoxHtml("about")}
    `;
  }

  // =========================================================================
  // 單篇閱讀視圖（支援長文、筆記、電子報期數 + 目錄 + 雙向連結）
  // =========================================================================
  async function renderDetail(container, type, slug) {
    const item = state.manifest.items.find((i) => i.type === type && i.slug === slug);
    if (!item) {
      container.innerHTML = `
        <div class="page-header">
          <span class="section-kicker mono-label">NOT FOUND</span>
          <h1 class="page-title">找不到此篇內容</h1>
          <p class="page-desc"><a href="#/" class="home-more-link">返回書齋首頁</a></p>
        </div>
      `;
      return;
    }

    const rawMd = await loadMarkdown(item.path);
    const { meta, body } = splitFrontmatter(rawMd);
    const docFormat = (meta.format || item.format || "markdown").toLowerCase();
    const { html, headings } = docFormat === "html" ? parseHtmlContent(body) : parseMarkdown(body);

    // 計算雙向連結：找出所有引用到此 slug，或此篇引用到的館藏項目
    const relatedItems = findConnections(item, body);

    const backRoute = type === "essay" ? "#/essays" : type === "note" ? "#/notes" : "#/letters";
    const backLabel = type === "essay" ? "← 返回長文列表" : type === "note" ? "← 返回知識筆記" : "← 返回電子報歸檔";

    const showToc = headings.length >= 2 && type !== "note";

    container.innerHTML = `
      <a href="${backRoute}" class="back-nav-link">${backLabel}</a>

      <div class="reader-layout ${showToc ? "" : "is-single-col"}">
        <article>
          <header class="article-header">
            <div class="article-meta-top mono-label">
              <span>${escapeHtml(formatDateDot(item.date))}</span>
              <span>·</span>
              <span>${escapeHtml(TYPE_LABELS[type])}</span>
              ${item.readingTime ? `<span>·</span><span>${escapeHtml(item.readingTime)}</span>` : ""}
              ${
                item.stage
                  ? `<span>·</span><span class="note-stage" data-stage="${escapeHtml(item.stage)}">${escapeHtml(STAGE_LABELS[item.stage])}</span>`
                  : ""
              }
              ${
                item.issue
                  ? `<span>·</span><span>ISSUE № ${escapeHtml(String(item.issue).padStart(2, "0"))}</span>`
                  : ""
              }
            </div>
            <h1 class="article-title">${escapeHtml(item.title)}</h1>
            ${item.summary ? `<p class="article-subtitle">${escapeHtml(item.summary)}</p>` : ""}
            ${
              (item.tags || []).length > 0
                ? `<div class="tag-list-inline" style="margin-top:14px;">
                    ${(item.tags || [])
                      .map(
                        (t) =>
                          `<button type="button" class="filter-chip" style="padding:3px 10px; font-size:0.78rem;" data-jump-tag="${escapeHtml(
                            t
                          )}" data-jump-type="${escapeHtml(type)}">#${escapeHtml(t)}</button>`
                      )
                      .join("")}
                  </div>`
                : ""
            }
          </header>

          <div class="prose" id="article-prose">
            ${html}
          </div>

          ${
            relatedItems.length > 0
              ? `
            <aside class="backlinks-box" aria-label="雙向連結與關聯內容">
              <span class="section-kicker mono-label">CONNECTED NOTES & ESSAYS · 知識網絡關聯</span>
              <div class="backlinks-list">
                ${relatedItems
                  .map((rel) => {
                    const routePrefix = rel.type === "essay" ? "essays" : rel.type === "note" ? "notes" : "letters";
                    return `
                      <a href="#/${routePrefix}/${encodeURIComponent(rel.slug)}" class="backlink-card">
                        <span class="backlink-type mono-label">${escapeHtml(TYPE_LABELS[rel.type])} · ${escapeHtml(formatDateDot(rel.date))}</span>
                        <div class="backlink-title">${escapeHtml(rel.title)}</div>
                      </a>
                    `;
                  })
                  .join("")}
              </div>
            </aside>
          `
              : ""
          }

          <div style="margin-top: 56px;">
            ${renderNewsletterBoxHtml(`detail-${slug}`)}
          </div>
        </article>

        ${
          showToc
            ? `
          <aside class="reader-toc" aria-label="文章目錄">
            <h2 class="toc-title mono-label">CONTENTS · 目錄</h2>
            <ul class="toc-list">
              ${headings
                .map(
                  (h) => `
                <li>
                  <a href="#${escapeHtml(h.id)}" class="toc-link toc-level-${h.level}" data-toc-target="${escapeHtml(h.id)}">
                    ${escapeHtml(h.text)}
                  </a>
                </li>
              `
                )
                .join("")}
            </ul>
          </aside>
        `
            : ""
        }
      </div>
    `;

    // 目錄錨點平滑捲動（避免覆蓋 Hash 路由）
    container.querySelectorAll("[data-toc-target]").forEach((link) => {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const target = document.getElementById(link.dataset.tocTarget);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });

    // 點擊文章頂部主題標籤 → 直接跳轉至該分類並套用標籤篩選
    container.querySelectorAll("[data-jump-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tag = btn.dataset.jumpTag;
        const jType = btn.dataset.jumpType;
        if (jType === "essay") {
          state.essayTag = tag;
          window.location.hash = "#/essays";
        } else {
          state.noteStage = "全部";
          state.noteTag = tag;
          window.location.hash = "#/notes";
        }
      });
    });
  }

  function findConnections(currentItem, currentBody) {
    const connectedSlugs = new Set();
    // 1. 此篇主動透過 [[slug]] 引用的項目
    const wikiMatches = currentBody.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g);
    for (const m of wikiMatches) {
      connectedSlugs.add(m[1].trim());
    }
    // 2. manifest 中標記 links 指向此篇，或此篇 links 指向對方
    (currentItem.links || []).forEach((s) => connectedSlugs.add(s));
    state.manifest.items.forEach((other) => {
      if (other.slug !== currentItem.slug && (other.links || []).includes(currentItem.slug)) {
        connectedSlugs.add(other.slug);
      }
    });

    connectedSlugs.delete(currentItem.slug);
    return state.manifest.items.filter((i) => connectedSlugs.has(i.slug));
  }

  // =========================================================================
  // 電子報訂閱元件與 Google Apps Script 串接
  // =========================================================================
  function renderNewsletterBoxHtml(formId, compactHeader = false) {
    const nl = CONFIG.newsletter;
    return `
      <div class="newsletter-panel">
        <div class="newsletter-panel-grid">
          <div>
            <span class="section-kicker mono-label">${escapeHtml(nl.frequency)}</span>
            <h3 class="newsletter-title">${compactHeader ? "把經過沉澱的思考，直接寄進你的信箱" : escapeHtml(nl.title)}</h3>
            <p class="newsletter-promise">${escapeHtml(nl.promise)}</p>
          </div>
          <form class="newsletter-form" data-nl-form="${escapeHtml(formId)}" novalidate style="position:relative;">
            <input
              type="text"
              name="website"
              tabindex="-1"
              autocomplete="off"
              aria-hidden="true"
              style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;"
            />
            <div class="newsletter-input-group">
              <input
                type="email"
                name="email"
                required
                class="newsletter-input"
                placeholder="${escapeHtml(nl.inputPlaceholder)}"
                aria-label="電子郵件地址"
              />
              <button type="submit" class="newsletter-submit">${escapeHtml(nl.buttonText)}</button>
            </div>
            <div class="newsletter-feedback" aria-live="polite"></div>
          </form>
        </div>
      </div>
    `;
  }

  function bindNewsletterForms() {
    document.querySelectorAll("[data-nl-form]").forEach((form) => {
      if (form.dataset.bound === "true") return;
      form.dataset.bound = "true";
      const mountedAt = Date.now();

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = form.querySelector('input[name="email"]');
        const hpInput = form.querySelector('input[name="website"]');
        const submitBtn = form.querySelector('button[type="submit"]');
        const feedback = form.querySelector(".newsletter-feedback");
        const email = (input.value || "").trim();

        feedback.className = "newsletter-feedback";
        if (!email || /^[=+\-@'"\s]/.test(email) || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,16}$/i.test(email)) {
          feedback.textContent = "請輸入格式正確的 Email 信箱。";
          feedback.classList.add("is-error");
          input.focus();
          return;
        }

        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.textContent = "處理中⋯";

        const scriptUrl = (CONFIG.newsletter.googleScriptUrl || "").trim();

        try {
          if (scriptUrl) {
            // 使用 text/plain 傳送 JSON 字串，可完美避開 Google Apps Script 的 CORS OPTIONS 預檢阻擋並取得回傳結果
            const response = await fetch(scriptUrl, {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: JSON.stringify({
                action: "subscribe",
                email: email,
                hp: hpInput ? hpInput.value : "",
                elapsedMs: Date.now() - mountedAt,
                source: window.location.hash || "#/",
                timestamp: new Date().toISOString()
              })
            });

            let result = { ok: true, pendingConfirm: true };
            try {
              result = await response.json();
            } catch (_) {
              // 若使用者設定權限造成 opaque response 仍視為已送出
            }

            if (result.ok === false) {
              throw new Error(result.message || "訂閱失敗，請稍後再試。");
            }

            feedback.textContent = result.alreadySubscribed
              ? "這個信箱已經在有效訂閱名單中了，感謝你的支持。"
              : "✓ 確認信已寄往你的信箱！為防止他人冒用信箱，請打開信件點擊一次「確認訂閱」連結即完成加入。";
            feedback.classList.add("is-success");
            input.value = "";
          } else {
            // 尚未填入 Google Apps Script URL 時的本機預覽體驗
            const saved = JSON.parse(localStorage.getItem("warmcraft_demo_subscribers") || "[]");
            if (!saved.includes(email)) {
              saved.push(email);
              localStorage.setItem("warmcraft_demo_subscribers", JSON.stringify(saved));
            }
            await new Promise((r) => setTimeout(r, 350));
            feedback.textContent =
              "✓ 訂閱互動測試成功（已暫存於本機）。完成 ARCHITECTURE_AND_SETUP.md 的 Google Workspace 設定後，名單即會自動寫入你的雲端試算表並寄出歡迎信。";
            feedback.classList.add("is-success");
            input.value = "";
          }
        } catch (err) {
          feedback.textContent = err.message || "連線發生問題，請稍後再試或直接來信聯繫。";
          feedback.classList.add("is-error");
        } finally {
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
        }
      });
    });
  }

  // =========================================================================
  // 輕量內建 Markdown + Wiki-links 解析器
  // =========================================================================
  async function loadMarkdown(path) {
    if (state.contentCache.has(path)) {
      return state.contentCache.get(path);
    }
    let text = null;
    if (!IS_LOCAL_HOST && state.liveRawBase) {
      try {
        const rel = path.replace(/^\.?\//, "");
        const liveRes = await fetch(`${state.liveRawBase}/${rel}`, { cache: "no-store" });
        if (liveRes.ok) {
          text = await liveRes.text();
        }
      } catch (_) {
        // 退回靜態檔案路徑
      }
    }
    if (text === null) {
      const ver = encodeURIComponent(state.manifest?.updatedAt || Date.now());
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${path}${sep}v=${ver}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`無法載入內容：${path}`);
      text = await res.text();
    }
    state.contentCache.set(path, text);
    return text;
  }

  function splitFrontmatter(raw) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { meta: {}, body: raw };
    const meta = {};
    match[1].split(/\r?\n/).forEach((line) => {
      const idx = line.indexOf(":");
      if (idx > 0) {
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });
    return { meta, body: match[2] };
  }

  function extractStandaloneYouTube(rawLine) {
    const trimmed = String(rawLine || "").trim();
    const m = trimmed.match(
      /^https?:\/\/(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&][^\s]*)?$/i
    );
    if (!m) return null;
    const videoId = m[1];
    let startSec = 0;
    try {
      const u = new URL(trimmed);
      const rawT = (u.searchParams.get("t") || u.searchParams.get("start") || "").toLowerCase();
      if (/^\d+$/.test(rawT)) startSec = Number(rawT);
    } catch (_) {}
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}` + (startSec > 0 ? `&t=${startSec}s` : "");
    const embedUrl = `https://www.youtube.com/embed/${videoId}?rel=0` + (startSec > 0 ? `&start=${startSec}` : "");
    return {
      html:
        `<figure class="yt-media-card" data-yt-id="${escapeHtml(videoId)}">` +
        `<div class="yt-player-stage">` +
        `<img class="yt-thumb-bg" src="https://i.ytimg.com/vi/${escapeHtml(videoId)}/hqdefault.jpg" alt="YouTube 影片縮圖" loading="lazy" />` +
        `<iframe class="yt-embed-iframe" src="${escapeHtml(embedUrl)}" title="YouTube video player" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>` +
        `</div>` +
        `<figcaption class="yt-card-bar">` +
        `<a class="yt-thumb-mini-wrap" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer"><img class="yt-thumb-mini" src="https://i.ytimg.com/vi/${escapeHtml(videoId)}/mqdefault.jpg" alt="影片縮圖" loading="lazy" /></a>` +
        `<div class="yt-card-info"><span class="yt-badge mono-label">YOUTUBE VIDEO</span><a class="yt-card-title" href="${escapeHtml(watchUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(watchUrl)} ↗</a></div>` +
        `</figcaption></figure>`
    };
  }

  function stripMarkdownSyntax(raw) {
    return String(raw || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, slug, label) => {
        if (label) return label.trim();
        const found = state.manifest ? state.manifest.items.find((i) => i.slug === slug.trim()) : null;
        return found ? found.title : slug.trim();
      })
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*([\s\S]+?)\*\*/g, "$1")
      .replace(/__([\s\S]+?)__/g, "$1")
      .replace(/~~([\s\S]+?)~~/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\*+|\*+$/g, "")
      .trim();
  }

  function parseHtmlContent(rawHtml) {
    const headings = [];
    // 若 HTML 段落中單獨放了一行純文字 YouTube 網址，自動轉為縮圖與內嵌播放器
    let processed = rawHtml.replace(/<p[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/p>/gi, (full, urlCandidate) => {
      const yt = extractStandaloneYouTube(urlCandidate);
      return yt ? yt.html : full;
    });
    // 解析雙向連結 [[slug|label]]
    processed = processed.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, targetSlug, customLabel) => {
      const cleanSlug = targetSlug.trim();
      const found = state.manifest ? state.manifest.items.find((i) => i.slug === cleanSlug) : null;
      const routePrefix = found
        ? found.type === "essay"
          ? "essays"
          : found.type === "note"
          ? "notes"
          : "letters"
        : "notes";
      const label = customLabel ? customLabel.trim() : found ? found.title : cleanSlug;
      return `<a href="#/${routePrefix}/${encodeURIComponent(cleanSlug)}" class="wikilink">${escapeHtml(label)}</a>`;
    });

    // 為 HTML 內的 h2 / h3 自動補上目錄錨點 ID
    processed = processed.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (full, lvl, attrs, inner) => {
      const plainText = stripMarkdownSyntax(inner);
      const idMatch = attrs.match(/\bid=["']([^"']+)["']/i);
      const id =
        idMatch ? idMatch[1] : "sec-" + headings.length + "-" + plainText.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-");
      headings.push({ id, level: Number(lvl), text: plainText });
      if (idMatch) return full;
      return `<h${lvl}${attrs} id="${escapeHtml(id)}">${inner}</h${lvl}>`;
    });

    return { html: processed, headings };
  }

  function parseMarkdown(md) {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    const headings = [];
    let inCode = false;
    let codeBuffer = [];
    let listType = null;
    let listBuffer = [];
    let quoteBuffer = [];
    let tableBuffer = [];
    let paragraphBuffer = [];

    const flushParagraph = () => {
      if (paragraphBuffer.length > 0) {
        out.push(`<p>${paragraphBuffer.map(renderInline).join("<br />")}</p>`);
        paragraphBuffer = [];
      }
    };

    const flushList = () => {
      if (listBuffer.length > 0) {
        out.push(`<${listType}>${listBuffer.map((li) => `<li>${renderInline(li)}</li>`).join("")}</${listType}>`);
        listBuffer = [];
        listType = null;
      }
    };

    const flushQuote = () => {
      if (quoteBuffer.length > 0) {
        out.push(`<blockquote><p>${renderInline(quoteBuffer.join(" "))}</p></blockquote>`);
        quoteBuffer = [];
      }
    };

    const flushTable = () => {
      if (tableBuffer.length >= 2) {
        const parseRow = (r) => {
          // 保護 [[slug|顯示文字]] 內的直線符號不被表格欄位切開
          const safe = r.replace(/\[\[([^\]]*?)\|([^\]]*?)\]\]/g, "[[$1\u0000$2]]");
          return safe
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim().replace(/\u0000/g, "|"));
        };
        const headers = parseRow(tableBuffer[0]);
        const rows = tableBuffer.slice(2).map(parseRow);
        out.push(`
          <table>
            <thead><tr>${headers.map((h) => `<th>${renderInline(h)}</th>`).join("")}</tr></thead>
            <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>
          </table>
        `);
      }
      tableBuffer = [];
    };

    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
      flushTable();
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.trim().startsWith("```")) {
        flushAll();
        if (!inCode) {
          inCode = true;
          codeBuffer = [];
        } else {
          out.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
          inCode = false;
        }
        continue;
      }

      if (inCode) {
        codeBuffer.push(line);
        continue;
      }

      const trimmed = line.trim();

      if (!trimmed) {
        flushAll();
        continue;
      }

      // 表格
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        flushParagraph();
        flushList();
        flushQuote();
        tableBuffer.push(trimmed);
        continue;
      } else if (tableBuffer.length > 0) {
        flushTable();
      }

      // 原生支援在 Markdown 中直接撰寫 HTML 區塊與媒體標籤
      if (/^<\/?(div|section|aside|figure|figcaption|details|summary|table|thead|tbody|tr|td|th|iframe|blockquote|p|ul|ol|li|h[1-6]|hr|br|img|video|audio|a|span)\b/i.test(trimmed)) {
        flushAll();
        out.push(line);
        continue;
      }

      // 單行獨立 YouTube 網址自動渲染為影片縮圖＋內嵌播放器
      const ytBlock = extractStandaloneYouTube(trimmed);
      if (ytBlock) {
        flushAll();
        out.push(ytBlock.html);
        continue;
      }

      // 分隔線
      if (/^(---|\*\*\*|___)$/.test(trimmed)) {
        flushAll();
        out.push("<hr />");
        continue;
      }

      // 標題 (忽略 H1 因為頁首已渲染主標題，若寫了 H1 自動轉 H2)
      const hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (hMatch) {
        flushAll();
        const rawLevel = hMatch[1].length;
        const level = rawLevel === 1 ? 2 : rawLevel;
        const text = hMatch[2].trim();
        const cleanHeading = stripMarkdownSyntax(text);
        const id = "sec-" + headings.length + "-" + cleanHeading.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-");
        headings.push({ id, level, text: cleanHeading });
        out.push(`<h${level} id="${escapeHtml(id)}">${renderInline(text)}</h${level}>`);
        continue;
      }

      // 引用區塊
      if (trimmed.startsWith(">")) {
        flushParagraph();
        flushList();
        quoteBuffer.push(trimmed.replace(/^>\s?/, ""));
        continue;
      } else if (quoteBuffer.length > 0) {
        flushQuote();
      }

      // 無序清單
      const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
      if (ulMatch) {
        flushParagraph();
        if (listType && listType !== "ul") flushList();
        listType = "ul";
        listBuffer.push(ulMatch[1]);
        continue;
      }

      // 有序清單
      const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
      if (olMatch) {
        flushParagraph();
        if (listType && listType !== "ol") flushList();
        listType = "ol";
        listBuffer.push(olMatch[1]);
        continue;
      }

      if (listBuffer.length > 0) {
        flushList();
      }

      paragraphBuffer.push(trimmed);
    }

    flushAll();
    return { html: out.join("\n"), headings };
  }

  function renderInline(text) {
    let s = escapeHtml(text);

    // 行內程式碼 `code`
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");

    // 粗體與斜體
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // 雙向連結 [[slug|顯示名稱]] 或 [[slug]]
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, targetSlug, customLabel) => {
      const cleanSlug = targetSlug.trim();
      const found = state.manifest
        ? state.manifest.items.find((i) => i.slug === cleanSlug)
        : null;
      const routePrefix = found
        ? found.type === "essay"
          ? "essays"
          : found.type === "note"
          ? "notes"
          : "letters"
        : "notes";
      const label = customLabel ? customLabel.trim() : found ? found.title : cleanSlug;
      return `<a href="#/${routePrefix}/${encodeURIComponent(cleanSlug)}" class="wikilink">${label}</a>`;
    });

    // 圖片語法 ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const cap = alt ? `<figcaption>${alt}</figcaption>` : "";
      return `<figure class="craft-figure"><img src="${url}" alt="${alt}" loading="lazy" />${cap}</figure>`;
    });

    // 一般連結 [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const external = url.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${url}"${external}>${label}</a>`;
    });

    return s;
  }

  // =========================================================================
  // 全站搜尋與快捷鍵
  // =========================================================================
  function bindGlobalEvents() {
    window.addEventListener("hashchange", handleRoute);

    // 閱讀進度細線
    window.addEventListener(
      "scroll",
      () => {
        const prose = document.getElementById("article-prose");
        const bar = document.getElementById("reading-progress");
        if (!prose || !bar) return;
        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        const pct = docHeight > 0 ? Math.min(100, Math.max(0, (scrollTop / docHeight) * 100)) : 0;
        bar.style.width = `${pct}%`;
      },
      { passive: true }
    );

    // 晨讀 / 夜讀切換
    document.getElementById("theme-toggle-btn").addEventListener("click", () => {
      applyTheme(state.theme === "paper" ? "night" : "paper");
    });

    // 搜尋對話框
    const modal = document.getElementById("search-modal");
    const openBtn = document.getElementById("open-search-btn");
    const closeBtn = document.getElementById("close-search-btn");
    const input = document.getElementById("global-search-input");

    const openSearch = () => {
      modal.hidden = false;
      input.value = "";
      renderSearchResults("");
      setTimeout(() => input.focus(), 20);
    };

    const closeSearch = () => {
      modal.hidden = true;
    };

    openBtn.addEventListener("click", openSearch);
    closeBtn.addEventListener("click", closeSearch);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeSearch();
    });

    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        modal.hidden ? openSearch() : closeSearch();
      } else if (e.key === "Escape" && !modal.hidden) {
        closeSearch();
      }
    });

    input.addEventListener("input", () => {
      renderSearchResults(input.value.trim());
    });
  }

  function renderSearchResults(query) {
    const resultsEl = document.getElementById("search-results");
    if (!state.manifest) return;

    const items = state.manifest.items;
    const q = query.toLowerCase();
    const matched = !q
      ? items.slice(0, 6)
      : items.filter((item) => {
          const hay = [item.title, item.summary, ...(item.tags || [])].join(" ").toLowerCase();
          return hay.includes(q);
        });

    if (matched.length === 0) {
      resultsEl.innerHTML = `<div style="padding:20px 4px; color:var(--ink-muted); font-size:0.9rem;">沒有找到符合「${escapeHtml(query)}」的館藏內容。</div>`;
      return;
    }

    resultsEl.innerHTML = matched
      .map((item) => {
        const prefix = item.type === "essay" ? "essays" : item.type === "note" ? "notes" : "letters";
        return `
          <a href="#/${prefix}/${encodeURIComponent(item.slug)}" class="search-hit" data-search-hit>
            <div class="search-hit-meta mono-label">${escapeHtml(TYPE_LABELS[item.type])} · ${escapeHtml(formatDateDot(item.date))}</div>
            <div class="search-hit-title">${escapeHtml(item.title)}</div>
            <div class="search-hit-desc">${escapeHtml(item.summary)}</div>
          </a>
        `;
      })
      .join("");

    resultsEl.querySelectorAll("[data-search-hit]").forEach((el) => {
      el.addEventListener("click", () => {
        document.getElementById("search-modal").hidden = true;
      });
    });
  }

  // =========================================================================
  // 工具函式
  // =========================================================================
  function formatDateDot(dateStr) {
    if (!dateStr) return "";
    return dateStr.replace(/-/g, ".");
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
