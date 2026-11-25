/**
 * 澄觀書齋 — 靜謐書齋風個人知識庫與電子報前端引擎 (零外部框架依賴)
 * 支援：Hash 路由、內建 Markdown + Wiki-links 雙向連結解析、文章目錄生成、全站搜尋、Google Apps Script 電子報訂閱。
 */
(function () {
  "use strict";

  const CONFIG = window.SITE_CONFIG;
  const state = {
    manifest: null,
    contentCache: new Map(),
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
  async function init() {
    applyTheme(state.theme);
    renderShellChrome();
    bindGlobalEvents();

    try {
      const res = await fetch("./content/manifest.json");
      if (!res.ok) throw new Error("無法讀取內容索引檔");
      state.manifest = await res.json();
      await handleRoute();
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

    // 僅於本機預覽 (localhost / 127.0.0.1) 顯示「編輯工作台」入口，公開主站與備份站自動隱藏
    const studioLink = document.getElementById("local-studio-link");
    if (studioLink && (location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
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
  async function handleRoute() {
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

    window.scrollTo({ top: 0, behavior: "instant" });
    bindNewsletterForms();
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

    const filtered = notes.filter((n) => {
      if (state.noteStage !== "全部" && n.stage !== state.noteStage) return false;
      return true;
    });

    container.innerHTML = `
      <header class="page-header">
        <span class="section-kicker mono-label">NOTES · 數位花園與知識卡片</span>
        <h1 class="page-title">知識筆記</h1>
        <p class="page-desc">這裡存放讀書摘錄、方法備忘與尚未寫成長文的思考碎片。筆記依成熟度分為「萌芽」、「整理中」與「常青」，並透過雙向連結與長文彼此串聯。</p>
      </header>

      <div class="filter-bar" aria-label="筆記成熟度篩選">
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

      <div class="notes-grid">
        ${filtered.map(renderNoteCardHtml).join("")}
      </div>
    `;

    container.querySelectorAll("[data-note-stage]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.noteStage = btn.dataset.noteStage;
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
          ${letters
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
            .join("")}
        </div>
      </section>
    `;
  }

  // =========================================================================
  // 關於與近況頁 (About & Now)
  // =========================================================================
  function renderAbout(container) {
    const about = CONFIG.about;
    container.innerHTML = `
      <header class="page-header">
        <span class="section-kicker mono-label">ABOUT & NOW · 關於書齋主人</span>
        <h1 class="page-title">${escapeHtml(about.headline)}</h1>
        <p class="page-desc">${escapeHtml(CONFIG.brand.name)} — ${escapeHtml(CONFIG.brand.role)}</p>
      </header>

      <div class="prose about-prose">
        ${about.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
      </div>

      <section>
        <span class="section-kicker mono-label">PRINCIPLES · 寫作與研究準則</span>
        <div class="principles-grid">
          ${about.principles
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

      <section style="margin-bottom: 56px;">
        <div class="section-header-row">
          <div>
            <span class="section-kicker mono-label">NOW · 近況更新（${escapeHtml(about.nowUpdated)}）</span>
            <h2 class="section-heading">最近正在專注的事</h2>
          </div>
        </div>
        <div class="now-list">
          ${about.nowItems
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

      <section style="margin-bottom: 56px;">
        <div class="section-header-row">
          <div>
            <span class="section-kicker mono-label">SELECTED WORK & ADVISORY</span>
            <h2 class="section-heading">代表計畫與合作項目</h2>
          </div>
        </div>
        <div class="work-list">
          ${about.workAndProjects
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
          <form class="newsletter-form" data-nl-form="${escapeHtml(formId)}" novalidate>
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

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const input = form.querySelector('input[name="email"]');
        const submitBtn = form.querySelector('button[type="submit"]');
        const feedback = form.querySelector(".newsletter-feedback");
        const email = (input.value || "").trim();

        feedback.className = "newsletter-feedback";
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
                source: window.location.hash || "#/",
                timestamp: new Date().toISOString()
              })
            });

            let result = { ok: true };
            try {
              result = await response.json();
            } catch (_) {
              // 若使用者設定權限造成 opaque response 仍視為已送出
            }

            if (result.ok === false) {
              throw new Error(result.message || "訂閱失敗，請稍後再試。");
            }

            feedback.textContent = result.alreadySubscribed
              ? "這個信箱已經在訂閱名單中了，感謝你的支持。"
              : "訂閱成功。歡迎信已寄往你的信箱，我們雙週日早晨見。";
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
    const res = await fetch(path);
    if (!res.ok) throw new Error(`無法載入內容：${path}`);
    const text = await res.text();
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

  function parseHtmlContent(rawHtml) {
    const headings = [];
    // 解析雙向連結 [[slug|label]]
    let processed = rawHtml.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, targetSlug, customLabel) => {
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
      const plainText = inner.replace(/<[^>]+>/g, "").trim();
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

      // 原生支援在 Markdown 中直接撰寫 HTML 區塊標籤
      if (/^<\/?(div|section|aside|figure|figcaption|details|summary|table|thead|tbody|tr|td|th|iframe|blockquote|p|ul|ol|li|h[1-6]|hr|br)\b/i.test(trimmed)) {
        flushAll();
        out.push(line);
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
        const id = "sec-" + headings.length + "-" + text.toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, "-");
        headings.push({ id, level, text });
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
