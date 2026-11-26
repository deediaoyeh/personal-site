/**
 * studio.js — 書齋離線編輯工作台前端控制器（含 Markdown / 視覺化 HTML / HTML 原始碼三模文章編輯器 ＋ 全站 HTML 網頁編輯器）
 */
(function () {
  "use strict";

  const PRESETS = {
    "warm-paper": {
      preset: "warm-paper",
      bgPaper: "#f5f2eb",
      bgSubtle: "#ece7dd",
      bgElevated: "#faf8f4",
      inkPrimary: "#1d1c19",
      inkSecondary: "#534f46",
      inkMuted: "#857f73",
      accent: "#6e5039",
      accentMoss: "#485643"
    },
    "linen-slate": {
      preset: "linen-slate",
      bgPaper: "#f1f0ec",
      bgSubtle: "#e5e4de",
      bgElevated: "#f7f6f3",
      inkPrimary: "#191a1c",
      inkSecondary: "#4b4e52",
      inkMuted: "#7c8085",
      accent: "#3d5245",
      accentMoss: "#3d5245"
    },
    "classic-ivory": {
      preset: "classic-ivory",
      bgPaper: "#faf7f0",
      bgSubtle: "#f0ebe0",
      bgElevated: "#ffffff",
      inkPrimary: "#221e1a",
      inkSecondary: "#595047",
      inkMuted: "#8c8277",
      accent: "#7d4632",
      accentMoss: "#4d5e47"
    },
    "stone-minimal": {
      preset: "stone-minimal",
      bgPaper: "#ededeb",
      bgSubtle: "#e2e2df",
      bgElevated: "#f5f5f3",
      inkPrimary: "#161616",
      inkSecondary: "#4a4a48",
      inkMuted: "#7a7a77",
      accent: "#383836",
      accentMoss: "#455242"
    }
  };

  const HTML_BLOCKS = {
    callout: `<aside class="callout-box">\n  <strong>書齋重點筆記</strong>\n  <p>在此寫下需要特別凸顯的核心原則、提醒或研究結論。</p>\n</aside>\n`,
    twocol: `<div class="two-col-html">\n  <div>\n    <h3>觀點 A</h3>\n    <p>左側對照說明內容。</p>\n  </div>\n  <div>\n    <h3>觀點 B</h3>\n    <p>右側對照說明內容。</p>\n  </div>\n</div>\n`,
    details: `<details class="craft-details">\n  <summary>點擊展開延伸思考或常見問答</summary>\n  <p style="margin-top:10px;">這裡放置展開後的詳細補充說明。</p>\n</details>\n`,
    table: `<table>\n  <thead>\n    <tr><th>面向</th><th>傳統做法</th><th>書齋系統做法</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>核心差異</td><td>追逐即時熱點</td><td>累積常青結構</td></tr>\n  </tbody>\n</table>\n`,
    section: `\n<section class="home-section">\n  <span class="section-kicker mono-label">CUSTOM SECTION</span>\n  <h2 class="section-heading serif">自訂章節標題</h2>\n  <p style="color:var(--ink-secondary); max-width:62ch;">在此編寫自訂 HTML 區塊內容⋯</p>\n</section>\n`,
    cta: `\n<div class="newsletter-panel">\n  <span class="section-kicker mono-label">SPECIAL INVITATION</span>\n  <h3 class="newsletter-title serif">自訂行動呼籲或專案邀請</h3>\n  <p class="newsletter-promise" style="margin-bottom:16px;">說明你的諮詢服務、專題計畫或讀者專屬資源。</p>\n  <a href="#/about" class="studio-btn studio-btn-primary">進一步了解 →</a>\n</div>\n`
  };

  const state = {
    activeTab: "content",
    config: null,
    theme: null,
    manifest: { items: [] },
    webFiles: [],
    media: [],
    csrfToken: "",
    currentWebFile: { path: "index.html", isCore: true },
    filterType: "all",
    searchQuery: "",
    editorMode: "markdown", // "markdown" | "wysiwyg" | "html-source"
    docFormat: "markdown",  // "markdown" | "html"
    currentDoc: {
      originalSlug: "",
      originalType: "",
      isNew: false
    },
    dirty: false,
    dirtyScopes: {
      content: false,
      html: false,
      config: false,
      theme: false
    }
  };

  // =========================================================================
  // 啟動載入
  // =========================================================================
  // 攔截同源 /api/studio/* 寫入請求自動附加 X-Studio-CSRF 權杖，若階段逾時則自動回導至雙重認證頁
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, initOpts) {
    const urlStr = typeof input === "string" ? input : input.url || "";
    const opts = initOpts ? { ...initOpts } : {};
    const method = (opts.method || "GET").toUpperCase();
    if (urlStr.startsWith("/api/studio/") && method !== "GET" && state.csrfToken) {
      opts.headers = { ...(opts.headers || {}), "X-Studio-CSRF": state.csrfToken };
    }
    const resp = await nativeFetch(input, opts);
    if (resp.status === 401 && urlStr.startsWith("/api/studio/") && !window.__STUDIO_IS_CLOUD__) {
      window.location.reload();
    }
    return resp;
  };

  async function init() {
    if (window.__STUDIO_IS_CLOUD__ && window.__STUDIO_CLOUD_LOCKED__) {
      return;
    }
    bindTabs();
    bindContentStudioEvents();
    bindHtmlPageEditorEvents();
    bindConfigAndThemeEvents();
    bindGlobalShortcuts();

    try {
      const res = await fetch("/api/studio/bootstrap");
      if (!res.ok) throw new Error("請先通過雙重認證後進入工作台");
      const data = await res.json();

      state.csrfToken = data.csrfToken || "";
      state.config = data.config;
      state.theme = data.theme;
      state.manifest = data.manifest;
      state.webFiles = data.webFiles || [];
      state.media = data.media || [];

      populateConfigForms();
      populateThemeForm();
      renderSidebarList();
      renderWebFilesList();
      populateWikilinkPicker();
      updateGitBadge(data.git);

      if (state.manifest.items.length > 0) {
        const first = state.manifest.items[0];
        await selectDoc(first.type, first.slug);
      } else {
        startNewDoc("essay");
      }

      if (state.webFiles.length > 0) {
        await selectWebFile(state.webFiles[0].path);
      }
    } catch (err) {
      setStatus("無法連接本機編輯服務 — 請執行 python3 server.py", "is-dirty");
    }
  }

  function setStatus(msg, cls = "") {
    const el = document.getElementById("studio-status");
    el.textContent = msg;
    el.className = `studio-status ${cls}`;
  }

  function markDirty(explicitScope) {
    state.dirty = true;
    const scope =
      explicitScope ||
      (state.activeTab === "content"
        ? "content"
        : state.activeTab === "html"
        ? "html"
        : state.activeTab === "theme"
        ? "theme"
        : "config");
    state.dirtyScopes[scope] = true;
    setStatus("尚有未儲存的修改（按 ⌘S 儲存全部分頁變更）", "is-dirty");
  }

  function updateGitBadge(gitInfo) {
    const el = document.getElementById("git-changed-count");
    if (!el || !gitInfo) return;
    el.textContent = gitInfo.initialized ? `${gitInfo.changedCount} 個檔案待同步` : "尚未初始化 Git";

    const remoteUrl = gitInfo.remoteUrl || "https://github.com/deediaoyeh/personal-site.git";
    const remoteInput = document.getElementById("git-remote-input");
    if (remoteInput && !remoteInput.value) {
      remoteInput.value = remoteUrl;
    }
    updateGitHubDisplayUrls(remoteUrl);
  }

  function updateGitHubDisplayUrls(remoteUrl) {
    const cleanRepo = remoteUrl.replace(/\.git$/i, "");
    const repoEl = document.getElementById("display-github-repo");
    const pagesEl = document.getElementById("display-github-pages");
    if (repoEl) repoEl.textContent = cleanRepo;
    const m = cleanRepo.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
    if (pagesEl && m) {
      pagesEl.textContent = `https://${m[1]}.github.io/${m[2]}/`;
    }
  }

  // =========================================================================
  // 頂部分頁切換
  // =========================================================================
  function bindTabs() {
    document.querySelectorAll(".studio-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeTab = btn.dataset.tab;
        document.querySelectorAll(".studio-tab").forEach((b) => b.classList.toggle("is-active", b === btn));
        document.querySelectorAll(".studio-panel").forEach((panel) => {
          panel.hidden = panel.id !== `tab-${state.activeTab}`;
        });
      });
    });

    document.querySelectorAll("[data-refresh-iframe]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const iframe = document.getElementById(btn.dataset.refreshIframe);
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.location.reload();
        }
      });
    });
  }

  // =========================================================================
  // Tab 1: 內容寫作台（支援 Markdown / 視覺化 HTML / HTML 原始碼）
  // =========================================================================
  function renderSidebarList() {
    const listEl = document.getElementById("sidebar-item-list");
    const q = state.searchQuery.toLowerCase();

    const filtered = state.manifest.items.filter((item) => {
      if (state.filterType !== "all" && item.type !== state.filterType) return false;
      if (q) {
        const hay = `${item.title} ${item.summary} ${(item.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const typeTag = { essay: "長文", note: "筆記", letter: "電子報" };

    listEl.innerHTML = filtered
      .map((item) => {
        const selected =
          item.slug === state.currentDoc.originalSlug && item.type === state.currentDoc.originalType;
        const fmtBadge = item.format === "html" ? " · HTML" : "";
        return `
          <button type="button" class="sidebar-item ${selected ? "is-selected" : ""}" data-doc-type="${escapeAttr(item.type)}" data-doc-slug="${escapeAttr(item.slug)}">
            <div class="sidebar-item-meta mono-label">${typeTag[item.type] || item.type} · ${escapeHtml(item.date)}${fmtBadge}</div>
            <div class="sidebar-item-title">${escapeHtml(item.title)}</div>
          </button>
        `;
      })
      .join("");

    listEl.querySelectorAll("[data-doc-slug]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectDoc(btn.dataset.docType, btn.dataset.docSlug);
      });
    });
  }

  function populateWikilinkPicker() {
    const sel = document.getElementById("insert-wikilink-select");
    sel.innerHTML =
      `<option value="">＋ 插入館藏雙向連結 [[...]]</option>` +
      state.manifest.items
        .map(
          (i) =>
            `<option value="[[${escapeAttr(i.slug)}|${escapeAttr(i.title)}]]">${escapeHtml(i.title)} (${i.slug})</option>`
        )
        .join("");
    renderTagSuggestions();
  }

  function parseTagList(raw) {
    return String(raw || "")
      .split(/[,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function renderTagSuggestions() {
    const bar = document.getElementById("tag-suggestions-bar");
    const input = document.getElementById("doc-tags");
    if (!bar || !input) return;

    const currentTags = parseTagList(input.value);
    const currentSet = new Set(currentTags);

    // 統計全站所有文章、筆記、電子報「曾經用過的標籤」並依使用次數排序
    const freq = new Map();
    (state.manifest?.items || []).forEach((it) => {
      (it.tags || []).forEach((rawT) => {
        const t = String(rawT || "").trim();
        if (t) freq.set(t, (freq.get(t) || 0) + 1);
      });
    });

    const allUsedTags = [...freq.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-Hant"))
      .map(([tag]) => tag);

    if (allUsedTags.length === 0) {
      bar.innerHTML = "";
      return;
    }

    bar.innerHTML = allUsedTags
      .map((tag) => {
        const picked = currentSet.has(tag);
        return `<button type="button" class="tag-pick-chip ${picked ? "is-picked" : ""}" data-pick-tag="${escapeAttr(
          tag
        )}" title="點擊${picked ? "移除" : "加入"}此標籤">${picked ? "✓ " : "＋ "}#${escapeHtml(tag)}</button>`;
      })
      .join("");

    bar.querySelectorAll("[data-pick-tag]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tag = btn.dataset.pickTag;
        const list = parseTagList(input.value);
        const idx = list.indexOf(tag);
        if (idx >= 0) {
          list.splice(idx, 1);
        } else {
          list.push(tag);
        }
        input.value = list.join(", ");
        renderTagSuggestions();
        markDirty("content");
        renderLiveContentPreview();
      });
    });
  }

  async function selectDoc(type, slug) {
    const res = await fetch(`/api/studio/item?type=${encodeURIComponent(type)}&slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const { meta, body } = await res.json();

    state.currentDoc = { originalSlug: slug, originalType: type, isNew: false };
    state.docFormat = (meta.format || "markdown").toLowerCase();

    document.getElementById("doc-title").value = meta.title || "";
    document.getElementById("doc-type").value = meta.type || type;
    document.getElementById("doc-slug").value = meta.slug || slug;
    document.getElementById("doc-date").value = meta.date || todayStr();
    document.getElementById("doc-tags").value = meta.tags || "";
    document.getElementById("doc-stage").value = meta.stage || "seedling";
    document.getElementById("doc-notecode").value = meta.noteCode || "";
    document.getElementById("doc-issue").value = meta.issue || "";
    document.getElementById("doc-summary").value = meta.summary || "";
    document.getElementById("doc-body").value = body || "";
    document.getElementById("doc-wysiwyg").innerHTML =
      state.docFormat === "html" ? body || "<p><br></p>" : simplePreviewMarkdown(body || "");

    applyEditorModeUI(state.docFormat === "html" ? "wysiwyg" : "markdown", false);
    toggleTypeSpecificFields(meta.type || type);
    renderSidebarList();
    renderTagSuggestions();
    renderLiveContentPreview();
    state.dirty = false;
    setStatus(`正在編輯：${meta.title || slug}`);
  }

  function startNewDoc(docType) {
    const count = state.manifest.items.filter((i) => i.type === docType).length + 1;
    const defaultSlug = `${docType}-${todayStr().replace(/-/g, "")}-${count}`;

    state.currentDoc = { originalSlug: "", originalType: "", isNew: true };

    document.getElementById("doc-title").value = "";
    document.getElementById("doc-type").value = docType;
    document.getElementById("doc-slug").value = defaultSlug;
    document.getElementById("doc-date").value = todayStr();
    document.getElementById("doc-tags").value = "";
    document.getElementById("doc-stage").value = "seedling";
    document.getElementById("doc-notecode").value = `NOTE · ${String(count + 20).padStart(3, "0")}`;
    document.getElementById("doc-issue").value = docType === "letter" ? String(count) : "";
    document.getElementById("doc-summary").value = "";

    if (state.editorMode === "wysiwyg" || state.editorMode === "html-source") {
      state.docFormat = "html";
      const starterHtml =
        docType === "essay"
          ? "<h2>問題背景</h2>\n<p>在此開始以 HTML 視覺化或原始碼模式撰寫你的核心論述⋯</p>\n"
          : "<p>在此輸入你的筆記或信件內容⋯</p>\n";
      document.getElementById("doc-body").value = starterHtml;
      document.getElementById("doc-wysiwyg").innerHTML = starterHtml;
    } else {
      state.docFormat = "markdown";
      const starterMd =
        docType === "essay"
          ? "## 問題背景\n\n在這裡開始書寫你的核心推論⋯\n"
          : docType === "note"
          ? "寫下單一原子概念或讀書摘錄⋯\n"
          : "週日早安，歡迎讀到新一期的電子報。\n\n## 一、本期短論\n\n";
      document.getElementById("doc-body").value = starterMd;
      document.getElementById("doc-wysiwyg").innerHTML = simplePreviewMarkdown(starterMd);
    }

    toggleTypeSpecificFields(docType);
    renderSidebarList();
    renderTagSuggestions();
    renderLiveContentPreview();
    document.getElementById("doc-title").focus();
    setStatus("已建立新草稿 — 輸入標題並按 ⌘S 即可寫入網站", "is-dirty");
  }

  function applyEditorModeUI(nextMode, convertContent = true) {
    const prevMode = state.editorMode;
    const ta = document.getElementById("doc-body");
    const wy = document.getElementById("doc-wysiwyg");

    if (convertContent && prevMode !== nextMode) {
      if (prevMode === "markdown" && (nextMode === "wysiwyg" || nextMode === "html-source")) {
        // Markdown -> HTML
        const html = state.docFormat === "html" ? ta.value : simplePreviewMarkdown(ta.value);
        ta.value = formatHtmlPretty(html);
        wy.innerHTML = html || "<p><br></p>";
        state.docFormat = "html";
        markDirty();
      } else if (prevMode === "wysiwyg" && nextMode === "html-source") {
        ta.value = formatHtmlPretty(wy.innerHTML);
        state.docFormat = "html";
      } else if (prevMode === "html-source" && nextMode === "wysiwyg") {
        wy.innerHTML = ta.value || "<p><br></p>";
        state.docFormat = "html";
      } else if ((prevMode === "wysiwyg" || prevMode === "html-source") && nextMode === "markdown") {
        const currentHtml = prevMode === "wysiwyg" ? wy.innerHTML : ta.value;
        ta.value = htmlToMarkdown(currentHtml);
        state.docFormat = "markdown";
        markDirty();
      }
    }

    state.editorMode = nextMode;
    document.querySelectorAll("[data-editor-mode]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.editorMode === nextMode);
    });

    const isMd = nextMode === "markdown";
    const isWy = nextMode === "wysiwyg";
    document.getElementById("toolbar-markdown").hidden = !isMd;
    document.getElementById("toolbar-html").hidden = isMd;
    ta.hidden = isWy;
    wy.hidden = !isWy;

    renderLiveContentPreview();
  }

  function syncSlugPrefixForType(nextType) {
    const slugInput = document.getElementById("doc-slug");
    const raw = slugInput.value.trim();
    const count =
      state.manifest.items.filter(
        (i) => i.type === nextType && !(i.slug === state.currentDoc.originalSlug && i.type === state.currentDoc.originalType)
      ).length + 1;

    if (!raw) {
      slugInput.value = `${nextType}-${todayStr().replace(/-/g, "")}-${count}`;
    } else {
      // 若為系統預設日期流水號格式 (essay-YYYYMMDD-N)，連同該分類最新序號一併更新
      const autoMatch = raw.match(/^(?:essay|note|letter|issue)-(\d{8})-\d+$/i);
      if (autoMatch) {
        slugInput.value = `${nextType}-${autoMatch[1]}-${count}`;
      } else {
        // 移除舊類型前綴後，冠上新類型前綴 (essay- / note- / letter-)
        const stripped = raw.replace(/^(?:essay|note|letter|issue)-/i, "");
        slugInput.value = stripped ? `${nextType}-${stripped}` : `${nextType}-${todayStr().replace(/-/g, "")}-${count}`;
      }
    }

    // 切換至筆記或電子報時，若專屬編號空白則自動補上預設編號
    if (nextType === "note" && !document.getElementById("doc-notecode").value.trim()) {
      document.getElementById("doc-notecode").value = `NOTE · ${String(count).padStart(3, "0")}`;
    }
    if (nextType === "letter" && !document.getElementById("doc-issue").value.trim()) {
      document.getElementById("doc-issue").value = String(count);
    }
  }

  function toggleTypeSpecificFields(type) {
    document.getElementById("wrap-note-stage").hidden = type !== "note";
    document.getElementById("wrap-note-code").hidden = type !== "note";
    document.getElementById("wrap-letter-issue").hidden = type !== "letter";
  }

  function bindContentStudioEvents() {
    // 三模切換器
    document.querySelectorAll("[data-editor-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        applyEditorModeUI(btn.dataset.editorMode, true);
      });
    });

    document.querySelectorAll("[data-filter-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.filterType = btn.dataset.filterType;
        document.querySelectorAll("[data-filter-type]").forEach((b) => b.classList.toggle("is-active", b === btn));
        renderSidebarList();
      });
    });

    document.getElementById("sidebar-search").addEventListener("input", (e) => {
      state.searchQuery = e.target.value.trim();
      renderSidebarList();
    });

    document.getElementById("new-essay-btn").addEventListener("click", () => startNewDoc("essay"));
    document.getElementById("new-note-btn").addEventListener("click", () => startNewDoc("note"));
    document.getElementById("new-letter-btn").addEventListener("click", () => startNewDoc("letter"));
    const autoLetterBtn = document.getElementById("auto-compile-letter-btn");
    if (autoLetterBtn) {
      autoLetterBtn.addEventListener("click", autoCompileNewsletterIssue);
    }

    document.getElementById("doc-type").addEventListener("change", (e) => {
      const nextType = e.target.value;
      syncSlugPrefixForType(nextType);
      toggleTypeSpecificFields(nextType);
      markDirty();
      renderLiveContentPreview();
    });

    [
      "doc-title",
      "doc-slug",
      "doc-date",
      "doc-tags",
      "doc-stage",
      "doc-notecode",
      "doc-issue",
      "doc-summary",
      "doc-body"
    ].forEach((id) => {
      document.getElementById(id).addEventListener("input", () => {
        markDirty();
        renderLiveContentPreview();
      });
    });

    document.getElementById("doc-tags").addEventListener("input", renderTagSuggestions);

    // 支援 doc-body 在 HTML 原始碼模式下按 Tab 縮排
    document.getElementById("doc-body").addEventListener("keydown", handleTabIndent);

    // 視覺化 HTML 畫布輸入連動
    document.getElementById("doc-wysiwyg").addEventListener("input", () => {
      document.getElementById("doc-body").value = document.getElementById("doc-wysiwyg").innerHTML;
      markDirty();
      renderLiveContentPreview();
    });

    // Markdown 工具列
    document.querySelectorAll("[data-md]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const snippets = {
          h2: "\n## 段落標題\n",
          h3: "\n### 子標題\n",
          bold: "**重點文字**",
          quote: "\n> 在此輸入引言或核心洞見。\n",
          ul: "\n- 第一點觀察\n- 第二點觀察\n",
          table: "\n| 比較面向 | 選項 A | 選項 B |\n| --- | --- | --- |\n| 核心優勢 | 說明 | 說明 |\n",
          callout: "\n" + HTML_BLOCKS.callout + "\n",
          hr: "\n---\n"
        };
        insertAtCursor(document.getElementById("doc-body"), snippets[btn.dataset.md] || "");
        markDirty();
        renderLiveContentPreview();
      });
    });

    // WYSIWYG 富文本工具列
    document.querySelectorAll("[data-wysiwyg]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.dataset.wysiwyg;
        if (state.editorMode === "html-source") {
          // 在 HTML 原始碼模式下直接插入對應 HTML 標籤
          const rawTags = {
            p: "<p>段落內容</p>\n",
            h2: "<h2>段落標題</h2>\n",
            h3: "<h3>子標題</h3>\n",
            bold: "<strong>重點文字</strong>",
            italic: "<em>強調文字</em>",
            underline: "<u>底線文字</u>",
            ul: "<ul>\n  <li>項目一</li>\n  <li>項目二</li>\n</ul>\n",
            ol: "<ol>\n  <li>步驟一</li>\n  <li>步驟二</li>\n</ol>\n",
            blockquote: "<blockquote><p>引言內容</p></blockquote>\n",
            link: '<a href="https://">連結文字</a>',
            clean: ""
          };
          if (rawTags[cmd]) {
            insertAtCursor(document.getElementById("doc-body"), rawTags[cmd]);
          }
        } else {
          const wy = document.getElementById("doc-wysiwyg");
          wy.focus();
          if (cmd === "p" || cmd === "h2" || cmd === "h3" || cmd === "blockquote") {
            document.execCommand("formatBlock", false, cmd.toUpperCase());
          } else if (cmd === "bold") {
            document.execCommand("bold", false, null);
          } else if (cmd === "italic") {
            document.execCommand("italic", false, null);
          } else if (cmd === "underline") {
            document.execCommand("underline", false, null);
          } else if (cmd === "ul") {
            document.execCommand("insertUnorderedList", false, null);
          } else if (cmd === "ol") {
            document.execCommand("insertOrderedList", false, null);
          } else if (cmd === "link") {
            const url = window.prompt("請輸入連結網址：", "https://");
            if (url) document.execCommand("createLink", false, url);
          } else if (cmd === "clean") {
            document.execCommand("removeFormat", false, null);
          }
          document.getElementById("doc-body").value = wy.innerHTML;
        }
        markDirty();
        renderLiveContentPreview();
      });
    });

    // 插入進階 HTML 元件區塊（重點匣、雙欄卡、摺疊問答、表格）
    document.querySelectorAll("[data-html-block]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const htmlSnippet = HTML_BLOCKS[btn.dataset.htmlBlock] || "";
        if (state.editorMode === "wysiwyg") {
          const wy = document.getElementById("doc-wysiwyg");
          wy.focus();
          document.execCommand("insertHTML", false, htmlSnippet);
          document.getElementById("doc-body").value = wy.innerHTML;
        } else {
          insertAtCursor(document.getElementById("doc-body"), "\n" + htmlSnippet);
        }
        markDirty();
        renderLiveContentPreview();
      });
    });

    // 雙向連結插入器（同時支援 Markdown 與 HTML 模式）
    document.getElementById("insert-wikilink-select").addEventListener("change", (e) => {
      const val = e.target.value;
      if (!val) return;
      if (state.editorMode === "wysiwyg") {
        const wy = document.getElementById("doc-wysiwyg");
        wy.focus();
        document.execCommand("insertText", false, val);
        document.getElementById("doc-body").value = wy.innerHTML;
      } else {
        insertAtCursor(document.getElementById("doc-body"), val);
      }
      e.target.value = "";
      markDirty();
      renderLiveContentPreview();
    });

    document.getElementById("delete-doc-btn").addEventListener("click", async () => {
      if (!state.currentDoc.originalSlug) {
        startNewDoc("essay");
        return;
      }
      const title = document.getElementById("doc-title").value || state.currentDoc.originalSlug;
      if (!window.confirm(`確定要刪除「${title}」嗎？此動作會移除對應的內容檔案。`)) return;

      const res = await fetch(
        `/api/studio/item?type=${encodeURIComponent(state.currentDoc.originalType)}&slug=${encodeURIComponent(
          state.currentDoc.originalSlug
        )}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (data.ok) {
        state.manifest = data.manifest;
        updateGitBadge(data.git);
        renderSidebarList();
        populateWikilinkPicker();
        if (state.manifest.items.length > 0) {
          selectDoc(state.manifest.items[0].type, state.manifest.items[0].slug);
        } else {
          startNewDoc("essay");
        }
        setStatus("已刪除內容並更新網站索引", "is-saved");
      }
    });
  }

  function renderLiveContentPreview() {
    const title = document.getElementById("doc-title").value.trim() || "未命名標題";
    const type = document.getElementById("doc-type").value;
    const date = (document.getElementById("doc-date").value || todayStr()).replace(/-/g, ".");
    const summary = document.getElementById("doc-summary").value.trim();
    const rawBody =
      state.editorMode === "wysiwyg"
        ? document.getElementById("doc-wysiwyg").innerHTML
        : document.getElementById("doc-body").value;

    const textOnly = rawBody.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    document.getElementById("word-count-indicator").textContent = `${textOnly.length} 字 · 約 ${Math.max(
      1,
      Math.round(textOnly.length / 380)
    )} min 閱讀`;

    document.getElementById("preview-meta").textContent = `${date} · ${type.toUpperCase()} · ${state.docFormat.toUpperCase()}`;
    document.getElementById("preview-title").textContent = title;
    document.getElementById("preview-summary").textContent = summary;

    if (state.docFormat === "html") {
      document.getElementById("preview-prose").innerHTML = renderWikilinksInHtml(rawBody);
    } else {
      document.getElementById("preview-prose").innerHTML = simplePreviewMarkdown(rawBody);
    }
  }

  // =========================================================================
  // Tab 2: 全站 HTML 頁面與樣式原始碼編輯器
  // =========================================================================
  function renderWebFilesList() {
    const listEl = document.getElementById("html-file-list");
    listEl.innerHTML = state.webFiles
      .map((f) => {
        const selected = f.path === state.currentWebFile.path;
        return `
          <button type="button" class="sidebar-item ${selected ? "is-selected" : ""}" data-web-path="${escapeAttr(f.path)}">
            <div class="sidebar-item-meta mono-label">${escapeHtml(f.label)}</div>
            <div class="sidebar-item-title mono-label" style="font-size:0.86rem;">${escapeHtml(f.path)}</div>
          </button>
        `;
      })
      .join("");

    listEl.querySelectorAll("[data-web-path]").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectWebFile(btn.dataset.webPath);
      });
    });
  }

  async function selectWebFile(relPath) {
    const res = await fetch(`/api/studio/web-file?path=${encodeURIComponent(relPath)}`);
    if (!res.ok) return;
    const data = await res.json();

    state.currentWebFile = { path: data.path, isCore: data.isCore };
    document.getElementById("current-html-filepath").textContent = data.path;
    document.getElementById("delete-html-page-btn").hidden = Boolean(data.isCore);

    const codeTa = document.getElementById("html-code-textarea");
    codeTa.value = data.content || "";
    updateCodeLineNumbers();
    renderWebFilesList();
    updateHtmlLiveIframe(data.path, data.content);
    setStatus(`正在編輯網頁檔案：${data.path}`);
  }

  function updateCodeLineNumbers() {
    const codeTa = document.getElementById("html-code-textarea");
    const lineNumsEl = document.getElementById("html-line-numbers");
    const count = (codeTa.value.match(/\n/g) || []).length + 1;
    const nums = [];
    for (let i = 1; i <= count; i++) nums.push(i);
    lineNumsEl.textContent = nums.join("\n");
  }

  function updateHtmlLiveIframe(filePath, rawCode) {
    const iframe = document.getElementById("html-live-iframe");
    if (!iframe) return;
    if (filePath.endsWith(".html")) {
      // 將相對路徑注入 <base href="./"> 讓即時預覽無須先存檔就能載入全套靜謐書齋 CSS 與字體！
      const baseTag = `<base href="${window.location.origin}/" />`;
      const injected = rawCode.includes("<head>")
        ? rawCode.replace("<head>", `<head>\n  ${baseTag}`)
        : `${baseTag}\n${rawCode}`;
      iframe.removeAttribute("src");
      iframe.srcdoc = injected;
    } else {
      iframe.removeAttribute("srcdoc");
      iframe.src = "./#/";
    }
  }

  function bindHtmlPageEditorEvents() {
    const codeTa = document.getElementById("html-code-textarea");
    const lineNumsEl = document.getElementById("html-line-numbers");

    let previewTimer = null;
    codeTa.addEventListener("input", () => {
      markDirty();
      updateCodeLineNumbers();
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (state.currentWebFile.path.endsWith(".html")) {
          updateHtmlLiveIframe(state.currentWebFile.path, codeTa.value);
        }
      }, 220);
    });

    codeTa.addEventListener("scroll", () => {
      lineNumsEl.scrollTop = codeTa.scrollTop;
    });

    codeTa.addEventListener("keydown", handleTabIndent);

    // 快捷插入 HTML 元件片段
    document.querySelectorAll("[data-html-snippet]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const snippet = HTML_BLOCKS[btn.dataset.htmlSnippet] || "";
        insertAtCursor(codeTa, snippet);
        markDirty();
        updateCodeLineNumbers();
        if (state.currentWebFile.path.endsWith(".html")) {
          updateHtmlLiveIframe(state.currentWebFile.path, codeTa.value);
        }
      });
    });

    // 新增獨立 HTML 網頁
    document.getElementById("new-html-page-btn").addEventListener("click", async () => {
      const name = window.prompt("請輸入新 HTML 網頁檔名（英文與連字號，例如 workshop.html 或 services.html）：", "workshop.html");
      if (!name) return;
      let cleanName = name.trim().replace(/[^a-zA-Z0-9_.-]/g, "-");
      if (!cleanName.endsWith(".html")) cleanName += ".html";
      if (cleanName === "studio.html") {
        window.alert("studio.html 為系統保留檔名，請使用其他名稱。");
        return;
      }

      const brandName = state.config?.brand?.name || "低調走過";
      const starterPage = `<!DOCTYPE html>
<html lang="zh-Hant" data-theme="paper">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>專題頁面 · ${brandName}</title>
  <link rel="stylesheet" href="./styles.css" />
  <link rel="stylesheet" href="./theme.custom.css" />
</head>
<body>
  <div class="site-shell">
    <header class="site-header">
      <div class="header-inner">
        <a href="./" class="brand-mark">
          <span class="brand-name">${brandName}</span>
        </a>
        <nav class="primary-nav">
          <a href="./#/essays" class="nav-link">長文</a>
          <a href="./#/notes" class="nav-link">筆記</a>
          <a href="./#/letters" class="nav-link">電子報</a>
          <a href="./" class="nav-link">返回首頁 →</a>
        </nav>
      </div>
    </header>

    <main class="site-main">
      <header class="page-header">
        <span class="section-kicker mono-label">CUSTOM HTML PAGE</span>
        <h1 class="page-title serif">自訂獨立專題網頁</h1>
        <p class="page-desc">這是一頁完全由你自由編排 HTML 結構的獨立頁面，已自動套用靜謐書齋字體與紙感設計系統。</p>
      </header>

      <div class="prose">
        <aside class="callout-box">
          <strong>直接編輯左側 HTML 原始碼</strong>
          <p>你可以在此放入課程介紹、顧問服務方案、互動工具或任何自訂 HTML 版面。</p>
        </aside>
      </div>
    </main>
  </div>
</body>
</html>
`;

      const res = await fetch("/api/studio/web-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: cleanName, content: starterPage })
      });
      const data = await res.json();
      if (data.ok) {
        state.webFiles = data.webFiles;
        updateGitBadge(data.git);
        await selectWebFile(cleanName);
        setStatus(`✓ 已建立並開啟新網頁：${cleanName}`, "is-saved");
      }
    });

    // 刪除自建 HTML 網頁
    document.getElementById("delete-html-page-btn").addEventListener("click", async () => {
      const p = state.currentWebFile.path;
      if (state.currentWebFile.isCore) return;
      if (!window.confirm(`確定要刪除獨立網頁「${p}」嗎？`)) return;

      const res = await fetch(`/api/studio/web-file?path=${encodeURIComponent(p)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        state.webFiles = data.webFiles;
        updateGitBadge(data.git);
        await selectWebFile("index.html");
        setStatus(`已刪除網頁 ${p}`, "is-saved");
      }
    });

    // 預覽寬度切換（桌機 / 手機）
    document.querySelectorAll("[data-viewport]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-viewport]").forEach((b) => b.classList.toggle("is-active", b === btn));
        document.getElementById("html-iframe-stage").classList.toggle("is-mobile", btn.dataset.viewport === "mobile");
      });
    });

    document.getElementById("refresh-html-preview-btn").addEventListener("click", () => {
      updateHtmlLiveIframe(state.currentWebFile.path, codeTa.value);
    });
  }

  // =========================================================================
  // Tab 3, 4, 5, 6: 門面、關於、視覺、電子報與同步
  // =========================================================================
  function populateConfigForms() {
    const c = state.config || {};
    const b = c.brand || {};
    const intro = c.intro || {};
    const about = c.about || {};
    const nl = c.newsletter || {};

    document.getElementById("cfg-brand-name").value = b.name || "";
    document.getElementById("cfg-brand-latin").value = b.latinName || "";
    document.getElementById("cfg-brand-studiotitle").value = b.studioTitle || "";
    document.getElementById("cfg-brand-role").value = b.role || "";
    document.getElementById("cfg-brand-location").value = b.location || "";
    document.getElementById("cfg-brand-since").value = b.since || "2024";
    document.getElementById("cfg-brand-email").value = b.email || "";

    document.getElementById("cfg-intro-greeting").value = intro.greeting || "";
    document.getElementById("cfg-intro-lead").value = intro.lead || "";
    document.getElementById("cfg-intro-exploring").value = (intro.currentlyExploring || []).join("\n");

    document.getElementById("cfg-footer-links").value = (c.links || [])
      .map((l) => `${l.label} | ${l.url}`)
      .join("\n");

    document.getElementById("cfg-about-headline").value = about.headline || "";
    document.getElementById("cfg-about-paragraphs").value = (about.paragraphs || []).join("\n\n");
    document.getElementById("cfg-about-principles").value = (about.principles || [])
      .map((p) => `${p.title} | ${p.desc}`)
      .join("\n");
    document.getElementById("cfg-about-nowupdated").value = about.nowUpdated || "";
    document.getElementById("cfg-about-nowitems").value = (about.nowItems || [])
      .map((n) => `${n.label} | ${n.text}`)
      .join("\n");
    document.getElementById("cfg-about-work").value = (about.workAndProjects || [])
      .map((w) => `${w.year} | ${w.title} | ${w.role} | ${w.desc} | ${w.link}`)
      .join("\n");

    document.getElementById("cfg-nl-title").value = nl.title || "";
    document.getElementById("cfg-nl-frequency").value = nl.frequency || "";
    document.getElementById("cfg-nl-promise").value = nl.promise || "";
    document.getElementById("cfg-nl-placeholder").value = nl.inputPlaceholder || "";
    document.getElementById("cfg-nl-buttontext").value = nl.buttonText || "";
    document.getElementById("cfg-nl-scripturl").value = nl.googleScriptUrl || "";
    updateNewsletterConnectionBadge();
  }

  function updateNewsletterConnectionBadge() {
    const box = document.getElementById("nl-connection-status");
    if (!box) return;
    const url = (document.getElementById("cfg-nl-scripturl")?.value || "").trim();
    if (!url) {
      box.innerHTML =
        `<strong style="color:#9e3f33;">● 目前狀態：本機展示模式（尚未綁定 Google 試算表收單端點）</strong><br/>` +
        `訪客目前填寫信箱僅會顯示測試成功訊息，尚未寫入雲端試算表。<br/>` +
        `<strong>啟用步驟：</strong>新增一份 Google 試算表 →「擴充功能 → Apps Script」貼入專案內的 <code>google/google-workspace-hub.gs</code> → 右上角「部署 → 新增部署作業 → 網頁應用程式（誰可以存取：所有人）」→ 將取得的 <code>https://script.google.com/.../exec</code> 貼入上方欄位並按「儲存 ⌘S」即完成！`;
    } else if (/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/i.test(url)) {
      box.innerHTML =
        `<strong style="color:#485643;">● 目前狀態：已正式連通 Google Workspace 自動收單與發信中樞</strong><br/>` +
        `訂戶填寫信箱後將自動寫入試算表 <code>Subscribers</code>、自動寄出歡迎信並支援一鍵退訂。`;
    } else {
      box.innerHTML =
        `<strong style="color:#9e3f33;">● 網址格式提醒：</strong>Google Apps Script 網頁應用程式網址通常以 <code>https://script.google.com/macros/s/</code> 開頭、<code>/exec</code> 結尾，請確認是否複製到正式部署網址。`;
    }
  }

  async function autoCompileNewsletterIssue() {
    // 切換回「內容寫作」分頁並自動組裝新一期電子報
    document.querySelector('[data-tab="content"]')?.click();
    startNewDoc("letter");

    const items = state.manifest?.items || [];
    const latestEssay = items.find((i) => i.type === "essay");
    const recentNotes = items.filter((i) => i.type === "note").slice(0, 3);
    const issueCount = items.filter((i) => i.type === "letter").length + 1;
    const issuePad = String(issueCount).padStart(2, "0");
    const nlTitle = state.config?.newsletter?.title || "《低調走過》雙週電子報";

    document.getElementById("doc-issue").value = String(issueCount);
    document.getElementById("doc-title").value = latestEssay
      ? `${nlTitle} № ${issuePad}：${latestEssay.title}`
      : `${nlTitle} № ${issuePad}：近期研究與思考卡片整理`;
    document.getElementById("doc-tags").value = "雙週電子報, 研究整理";
    document.getElementById("doc-summary").value = latestEssay
      ? `本期導讀核心長文〈${latestEssay.title}〉，並精選 ${recentNotes.length} 則近期知識卡片與一個留給你反覆推敲的問題。`
      : `精選近期完成的 ${recentNotes.length} 則知識筆記卡片與研究觀察。`;

    const mdLines = [];
    mdLines.push("週日早安，");
    mdLines.push("");
    mdLines.push("這過去兩週，我將近期持續追蹤的議題與閱讀思考整理成這封信，陪你安靜開啟新的一週。");
    mdLines.push("");

    if (latestEssay) {
      mdLines.push("## 一、本期核心長文導讀");
      mdLines.push("");
      mdLines.push(`### [[${latestEssay.slug}|${latestEssay.title}]]`);
      if (latestEssay.summary) {
        mdLines.push("");
        mdLines.push(`> ${latestEssay.summary}`);
      }
      mdLines.push("");
      mdLines.push(`→ 點擊閱讀完整推論：[[${latestEssay.slug}|前往閱讀全文]]`);
      mdLines.push("");
    }

    if (recentNotes.length > 0) {
      mdLines.push("## 二、近期三則讀書與思考卡片");
      mdLines.push("");
      recentNotes.forEach((n, idx) => {
        const summaryPart = n.summary ? ` — ${n.summary}` : "";
        mdLines.push(`${idx + 1}. **[[${n.slug}|${n.title}]]**${summaryPart}`);
      });
      mdLines.push("");
    }

    mdLines.push("## 三、本週留給你反覆推敲的一個問題");
    mdLines.push("");
    mdLines.push("> 在你目前投入最多心力的課題裡，哪一個「理所當然的前提」如果其實不再成立，會讓你做出完全不同的決定？");
    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");
    mdLines.push("祝你有個安靜而充實的週日，");
    mdLines.push(`${state.config?.brand?.name || "低調走過"} (${state.config?.brand?.latinName || "Deediao"})`);

    const compiledMd = mdLines.join("\n");
    applyEditorModeUI("markdown", false);
    document.getElementById("doc-body").value = compiledMd;
    state.docFormat = "markdown";
    markDirty("content");
    renderLiveContentPreview();
    setStatus(`✨ 已自動彙整產生第 ${issuePad} 期電子報草稿！確認或微調後按「儲存 ⌘S」即可發佈歸檔`, "is-saved");
  }

  async function pushCurrentLetterToGoogleSheets() {
    const scriptUrl = (document.getElementById("cfg-nl-scripturl")?.value || state.config?.newsletter?.googleScriptUrl || "").trim();
    if (!scriptUrl) {
      setStatus("請先在上方填入 Google Apps Script 網頁應用程式網址後再推送草稿", "is-dirty");
      document.getElementById("cfg-nl-scripturl")?.focus();
      return;
    }

    const docType = document.getElementById("doc-type").value;
    const title = document.getElementById("doc-title").value.trim();
    const body =
      state.editorMode === "wysiwyg"
        ? document.getElementById("doc-wysiwyg").innerHTML
        : document.getElementById("doc-body").value.trim();
    const issue = document.getElementById("doc-issue").value.trim() || "01";

    if (docType !== "letter" || !body) {
      setStatus("請先在「內容寫作」選擇或點擊「✨ 自動彙整本期電子報」準備好電子報內容再推送", "is-dirty");
      return;
    }

    const btn = document.getElementById("push-nl-draft-btn");
    btn.disabled = true;
    setStatus("正在將本期電子報草稿推送至 Google 試算表發信台⋯");

    try {
      // 透過受雙重驗證保護之後端代理附帶私密 SYNC_TOKEN 推送，金鑰絕不暴露於前端瀏覽器
      const res = await fetch("/api/studio/newsletter/push-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          issue,
          subject: title,
          content: body
        })
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.message || "推送草稿失敗");
      setStatus(data.message || `✓ 已將第 ${issue} 期草稿安全送入 Google 試算表發信台！`, "is-saved");
    } catch (err) {
      setStatus(`推送失敗：${err.message}`, "is-dirty");
    } finally {
      btn.disabled = false;
    }
  }

  function collectConfigFromForms() {
    const parsePipeLines = (raw, mapper) =>
      raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => mapper(line.split("|").map((s) => s.trim())));

    return {
      brand: {
        name: document.getElementById("cfg-brand-name").value.trim(),
        latinName: document.getElementById("cfg-brand-latin").value.trim(),
        studioTitle: document.getElementById("cfg-brand-studiotitle").value.trim(),
        tagline: document.getElementById("cfg-intro-greeting").value.trim(),
        role: document.getElementById("cfg-brand-role").value.trim(),
        location: document.getElementById("cfg-brand-location").value.trim(),
        since: document.getElementById("cfg-brand-since").value.trim(),
        email: document.getElementById("cfg-brand-email").value.trim()
      },
      intro: {
        greeting: document.getElementById("cfg-intro-greeting").value.trim(),
        lead: document.getElementById("cfg-intro-lead").value.trim(),
        currentlyExploring: document
          .getElementById("cfg-intro-exploring")
          .value.split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      },
      newsletter: {
        title: document.getElementById("cfg-nl-title").value.trim(),
        frequency: document.getElementById("cfg-nl-frequency").value.trim(),
        promise: document.getElementById("cfg-nl-promise").value.trim(),
        inputPlaceholder: document.getElementById("cfg-nl-placeholder").value.trim(),
        buttonText: document.getElementById("cfg-nl-buttontext").value.trim(),
        googleScriptUrl: document.getElementById("cfg-nl-scripturl").value.trim()
      },
      about: {
        headline: document.getElementById("cfg-about-headline").value.trim(),
        paragraphs: document
          .getElementById("cfg-about-paragraphs")
          .value.split(/\n\s*\n/)
          .map((s) => s.trim())
          .filter(Boolean),
        principles: parsePipeLines(document.getElementById("cfg-about-principles").value, (parts) => ({
          title: parts[0] || "",
          desc: parts[1] || ""
        })),
        nowUpdated: document.getElementById("cfg-about-nowupdated").value.trim(),
        nowItems: parsePipeLines(document.getElementById("cfg-about-nowitems").value, (parts) => ({
          label: parts[0] || "",
          text: parts[1] || ""
        })),
        workAndProjects: parsePipeLines(document.getElementById("cfg-about-work").value, (parts) => ({
          year: parts[0] || "",
          title: parts[1] || "",
          role: parts[2] || "",
          desc: parts[3] || "",
          link: parts[4] || "#/"
        }))
      },
      links: parsePipeLines(document.getElementById("cfg-footer-links").value, (parts) => ({
        label: parts[0] || "",
        url: parts[1] || ""
      }))
    };
  }

  function populateThemeForm() {
    const t = state.theme || PRESETS["warm-paper"];
    document.getElementById("thm-bg-paper").value = t.bgPaper || "#f5f2eb";
    document.getElementById("thm-bg-subtle").value = t.bgSubtle || "#ece7dd";
    document.getElementById("thm-ink-primary").value = t.inkPrimary || "#1d1c19";
    document.getElementById("thm-ink-secondary").value = t.inkSecondary || "#534f46";
    document.getElementById("thm-accent").value = t.accent || "#6e5039";
    document.getElementById("thm-accent-moss").value = t.accentMoss || "#485643";

    document.getElementById("thm-fontsize").value = t.fontSize || 16;
    document.getElementById("val-fontsize").textContent = `${t.fontSize || 16}px`;

    document.getElementById("thm-lineheight").value = t.lineHeight || 1.8;
    document.getElementById("val-lineheight").textContent = String(t.lineHeight || 1.8);

    document.getElementById("thm-maxwidth").value = t.maxWidth || 980;
    document.getElementById("val-maxwidth").textContent = `${t.maxWidth || 980}px`;
  }

  function collectThemeFromForm() {
    return {
      preset: state.theme?.preset || "custom",
      bgPaper: document.getElementById("thm-bg-paper").value,
      bgSubtle: document.getElementById("thm-bg-subtle").value,
      bgElevated: state.theme?.bgElevated || "#faf8f4",
      inkPrimary: document.getElementById("thm-ink-primary").value,
      inkSecondary: document.getElementById("thm-ink-secondary").value,
      inkMuted: state.theme?.inkMuted || "#857f73",
      accent: document.getElementById("thm-accent").value,
      accentMoss: document.getElementById("thm-accent-moss").value,
      fontSize: Number(document.getElementById("thm-fontsize").value),
      lineHeight: Number(document.getElementById("thm-lineheight").value),
      maxWidth: Number(document.getElementById("thm-maxwidth").value)
    };
  }

  function bindConfigAndThemeEvents() {
    document.querySelectorAll("[data-preset]").forEach((card) => {
      card.addEventListener("click", () => {
        const p = PRESETS[card.dataset.preset];
        if (!p) return;
        state.theme = { ...collectThemeFromForm(), ...p };
        populateThemeForm();
        markDirty();
      });
    });

    document.getElementById("thm-fontsize").addEventListener("input", (e) => {
      document.getElementById("val-fontsize").textContent = `${e.target.value}px`;
      markDirty();
    });
    document.getElementById("thm-lineheight").addEventListener("input", (e) => {
      document.getElementById("val-lineheight").textContent = e.target.value;
      markDirty();
    });
    document.getElementById("thm-maxwidth").addEventListener("input", (e) => {
      document.getElementById("val-maxwidth").textContent = `${e.target.value}px`;
      markDirty();
    });

    document
      .querySelectorAll(
        "#tab-brand input, #tab-brand textarea, #tab-about input, #tab-about textarea, #tab-sync input:not(#git-remote-input), #tab-sync textarea, #tab-theme input"
      )
      .forEach((el) => {
        el.addEventListener("input", markDirty);
      });

    document.getElementById("cfg-nl-scripturl").addEventListener("input", updateNewsletterConnectionBadge);
    const syncCompileBtn = document.getElementById("sync-tab-compile-letter-btn");
    if (syncCompileBtn) {
      syncCompileBtn.addEventListener("click", autoCompileNewsletterIssue);
    }
    const pushDraftBtn = document.getElementById("push-nl-draft-btn");
    if (pushDraftBtn) {
      pushDraftBtn.addEventListener("click", pushCurrentLetterToGoogleSheets);
    }

    // 綁定 GitHub 遠端倉庫按鈕
    document.getElementById("save-git-remote-btn").addEventListener("click", async () => {
      const remoteUrl = document.getElementById("git-remote-input").value.trim();
      const res = await fetch("/api/studio/git-remote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteUrl })
      });
      const data = await res.json();
      if (data.ok) {
        updateGitBadge(data.git);
        setStatus("✓ 已更新 GitHub 遠端倉庫網址", "is-saved");
      } else {
        setStatus(data.message || "綁定失敗", "is-dirty");
      }
    });

    // 雲端同步按鈕
    document.getElementById("run-cloud-sync-btn").addEventListener("click", async () => {
      const btn = document.getElementById("run-cloud-sync-btn");
      const logEl = document.getElementById("sync-log-output");
      btn.disabled = true;
      logEl.textContent = "正在先儲存本機變更，並執行 Google Drive + Git + Netlify 雲端同步⋯";

      await saveActiveWork();

      try {
        const res = await fetch("/api/studio/sync", { method: "POST", body: "{}" });
        const data = await res.json();
        logEl.textContent = data.output || (data.ok ? "同步完成！" : "同步過程發生錯誤");
        updateGitBadge(data.git);
        setStatus(data.ok ? "✓ 已完成雲端同步" : "同步出現提醒，請查看下方紀錄", data.ok ? "is-saved" : "is-dirty");
      } catch (err) {
        logEl.textContent = `同步失敗（若目前處於離線狀態，你的修改已安全保存在本機硬碟）：\n${err.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  }

  // =========================================================================
  // 全域儲存動作 (⌘S / 點擊儲存)
  // =========================================================================
  async function saveActiveWork() {
    const saveBtn = document.getElementById("global-save-btn");
    saveBtn.disabled = true;
    setStatus("正在寫入網站檔案⋯");

    try {
      const saveContent = state.activeTab === "content" || state.dirtyScopes.content;
      const saveHtml = state.activeTab === "html" || state.dirtyScopes.html;
      const saveTheme = state.activeTab === "theme" || state.dirtyScopes.theme;
      const saveConfig =
        state.activeTab === "brand" ||
        state.activeTab === "about" ||
        state.activeTab === "sync" ||
        state.dirtyScopes.config;

      if (saveConfig) {
        const config = collectConfigFromForms();
        const res = await fetch("/api/studio/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "儲存網站設定失敗");
        state.config = config;
        state.dirtyScopes.config = false;
        updateGitBadge(data.git);
      }

      if (saveTheme) {
        const theme = collectThemeFromForm();
        const res = await fetch("/api/studio/theme", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "儲存主題失敗");
        state.theme = data.theme;
        state.dirtyScopes.theme = false;
        updateGitBadge(data.git);
      }

      if (saveHtml && state.currentWebFile.path) {
        const content = document.getElementById("html-code-textarea").value;
        const res = await fetch("/api/studio/web-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: state.currentWebFile.path, content })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "儲存 HTML 檔案失敗");
        state.webFiles = data.webFiles;
        state.dirtyScopes.html = false;
        updateGitBadge(data.git);
        updateHtmlLiveIframe(state.currentWebFile.path, content);
      }

      if (saveContent && document.getElementById("doc-slug").value.trim()) {
        if (state.editorMode === "wysiwyg") {
          document.getElementById("doc-body").value = formatHtmlPretty(
            document.getElementById("doc-wysiwyg").innerHTML
          );
          state.docFormat = "html";
        } else if (state.editorMode === "html-source") {
          state.docFormat = "html";
        } else {
          state.docFormat = "markdown";
        }

        const body = document.getElementById("doc-body").value;
        const wikiSlugs = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
        const docType = document.getElementById("doc-type").value;

        const meta = {
          title: document.getElementById("doc-title").value.trim() || "未命名文章",
          slug: document.getElementById("doc-slug").value.trim(),
          type: docType,
          format: state.docFormat,
          date: document.getElementById("doc-date").value || todayStr(),
          tags: parseTagList(document.getElementById("doc-tags").value).join(", "),
          links: [...new Set(wikiSlugs)].join(", "),
          summary: document.getElementById("doc-summary").value.trim()
        };

        if (docType === "note") {
          meta.stage = document.getElementById("doc-stage").value;
          meta.noteCode = document.getElementById("doc-notecode").value.trim();
        } else if (docType === "letter") {
          meta.issue = document.getElementById("doc-issue").value.trim();
        }

        const res = await fetch("/api/studio/item", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            originalSlug: state.currentDoc.originalSlug,
            originalType: state.currentDoc.originalType,
            meta,
            body
          })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "儲存文章失敗");

        state.currentDoc = { originalSlug: data.slug, originalType: data.type, isNew: false };
        document.getElementById("doc-slug").value = data.slug;
        state.manifest = data.manifest;
        state.dirtyScopes.content = false;
        updateGitBadge(data.git);
        renderSidebarList();
        populateWikilinkPicker();
      }

      reloadPreviewIframes();
      state.dirty = false;
      const timeStr = new Date().toLocaleTimeString("zh-TW", { hour12: false });

      if (window.__STUDIO_IS_CLOUD__) {
        setStatus(`✓ 已於 ${timeStr} 即時寫入雲端（前台 1–3 秒內自動同步）`, "is-saved");
      } else {
        setStatus(`✓ 已於 ${timeStr} 寫入本機 · 正在極速同步至雲端⋯`, "is-saved");
        triggerFastAutoSync(timeStr);
      }
    } catch (err) {
      setStatus(`儲存失敗：${err.message}`, "is-dirty");
    } finally {
      saveBtn.disabled = false;
    }
  }

  let autoSyncInFlight = false;
  async function triggerFastAutoSync(savedTimeStr) {
    if (autoSyncInFlight || window.__STUDIO_IS_CLOUD__) return;
    autoSyncInFlight = true;
    try {
      const res = await fetch("/api/studio/sync?fast=1", { method: "POST", body: "{}" });
      const data = await res.json();
      if (data.ok) {
        updateGitBadge(data.git);
        setStatus(`✓ 已於 ${savedTimeStr} 存檔並即時同步雲端（前台 1–3 秒內更新）`, "is-saved");
      } else {
        setStatus(`✓ 已寫入本機（雲端同步離線待命，連網後可再按同步）`, "is-saved");
      }
    } catch (_) {
      setStatus(`✓ 已寫入本機（離線模式，連網後可一鍵同步）`, "is-saved");
    } finally {
      autoSyncInFlight = false;
    }
  }

  function reloadPreviewIframes() {
    ["brand-iframe", "about-iframe", "theme-iframe"].forEach((id) => {
      const iframe = document.getElementById(id);
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.location.reload();
      }
    });
  }

  function bindGlobalShortcuts() {
    document.getElementById("global-save-btn").addEventListener("click", saveActiveWork);
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActiveWork();
      }
    });
  }

  // =========================================================================
  // Markdown ↔ HTML 轉換與預覽工具
  // =========================================================================
  function handleTabIndent(e) {
    if (e.key === "Tab") {
      e.preventDefault();
      insertAtCursor(e.target, "  ");
      e.target.dispatchEvent(new Event("input"));
    }
  }

  function insertAtCursor(textarea, snippet) {
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const val = textarea.value;
    textarea.value = val.slice(0, start) + snippet + val.slice(end);
    textarea.focus();
    const pos = start + snippet.length;
    textarea.setSelectionRange(pos, pos);
  }

  function formatHtmlPretty(html) {
    return String(html || "")
      .replace(/></g, ">\n<")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function htmlToMarkdown(html) {
    let s = String(html || "");
    // 還原雙向連結 <a href="#/.../slug" class="wikilink">label</a> -> [[slug|label]]
    s = s.replace(/<a[^>]*href=["']#\/(?:essays|notes|letters)\/([^"']+)["'][^>]*class=["'][^"']*wikilink[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, (_, slug, label) => {
      return `[[${decodeURIComponent(slug)}|${label.replace(/<[^>]+>/g, "").trim()}]]`;
    });
    s = s.replace(/<a[^>]*class=["'][^"']*wikilink[^"']*["'][^>]*href=["']#\/(?:essays|notes|letters)\/([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, slug, label) => {
      return `[[${decodeURIComponent(slug)}|${label.replace(/<[^>]+>/g, "").trim()}]]`;
    });
    // 一般超連結 <a href="url">label</a> -> [label](url)
    s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
    s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n\n");
    s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n\n");
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**");
    s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**");
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "*$1*");
    s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "*$1*");
    s = s.replace(/<blockquote[^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/blockquote>/gi, "\n> $1\n\n");
    // 有序清單還原為 1. 2. 3.
    s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, inner) => {
      let idx = 1;
      return "\n" + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (__, item) => `${idx++}. ${item.trim()}\n`) + "\n";
    });
    s = s.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, inner) => {
      return "\n" + inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n") + "\n";
    });
    s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
    s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "$1\n\n");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    return s.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }

  function renderWikilinksInHtml(html) {
    return String(html || "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, slug, label) => {
      return `<a href="#/notes/${encodeURIComponent(slug.trim())}" class="wikilink">${escapeHtml(label || slug)}</a>`;
    });
  }

  function simplePreviewMarkdown(md) {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let inCode = false;
    let codeBuf = [];
    let listType = null;
    let listBuf = [];
    let quoteBuf = [];
    let tableBuf = [];
    let paraBuf = [];

    const flushPara = () => {
      if (paraBuf.length) {
        out.push(`<p>${paraBuf.map(inlineFmt).join("<br />")}</p>`);
        paraBuf = [];
      }
    };
    const flushList = () => {
      if (listBuf.length) {
        out.push(`<${listType}>${listBuf.map((li) => `<li>${inlineFmt(li)}</li>`).join("")}</${listType}>`);
        listBuf = [];
        listType = null;
      }
    };
    const flushQuote = () => {
      if (quoteBuf.length) {
        out.push(`<blockquote><p>${inlineFmt(quoteBuf.join(" "))}</p></blockquote>`);
        quoteBuf = [];
      }
    };
    const flushTable = () => {
      if (tableBuf.length >= 2) {
        const parseRow = (r) => {
          const safe = r.replace(/\[\[([^\]]*?)\|([^\]]*?)\]\]/g, "[[$1\u0000$2]]");
          return safe
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim().replace(/\u0000/g, "|"));
        };
        const headers = parseRow(tableBuf[0]);
        const rows = tableBuf.slice(2).map(parseRow);
        out.push(
          `<table><thead><tr>${headers.map((h) => `<th>${inlineFmt(h)}</th>`).join("")}</tr></thead><tbody>${rows
            .map((r) => `<tr>${r.map((c) => `<td>${inlineFmt(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`
        );
      }
      tableBuf = [];
    };
    const flushAll = () => {
      flushPara();
      flushList();
      flushQuote();
      flushTable();
    };

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
        flushAll();
        if (!inCode) {
          inCode = true;
          codeBuf = [];
        } else {
          out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
          inCode = false;
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }
      const t = line.trim();
      if (!t) {
        flushAll();
        continue;
      }
      if (/^<\/?(div|section|aside|figure|figcaption|details|summary|table|thead|tbody|tr|td|th|iframe|blockquote|p|ul|ol|li|h[1-6]|hr|br|img|video|audio|a|span)\b/i.test(t)) {
        flushAll();
        out.push(line);
        continue;
      }
      const ytPreviewId = extractYouTubeIdSimple(t);
      if (ytPreviewId) {
        flushAll();
        out.push(
          `<figure class="yt-media-card" data-yt-id="${escapeAttr(ytPreviewId)}">` +
            `<div class="yt-player-stage">` +
            `<img class="yt-thumb-bg" src="https://i.ytimg.com/vi/${escapeAttr(ytPreviewId)}/hqdefault.jpg" alt="YouTube 影片縮圖" loading="lazy" />` +
            `<iframe class="yt-embed-iframe" src="https://www.youtube.com/embed/${escapeAttr(ytPreviewId)}?rel=0" title="YouTube video player" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>` +
            `</div>` +
            `<figcaption class="yt-card-bar">` +
            `<a class="yt-thumb-mini-wrap" href="${escapeAttr(t)}" target="_blank" rel="noopener noreferrer"><img class="yt-thumb-mini" src="https://i.ytimg.com/vi/${escapeAttr(ytPreviewId)}/mqdefault.jpg" alt="縮圖" loading="lazy" /></a>` +
            `<div class="yt-card-info"><span class="yt-badge mono-label">YOUTUBE VIDEO</span><a class="yt-card-title" href="${escapeAttr(t)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t)} ↗</a></div>` +
            `</figcaption></figure>`
        );
        continue;
      }
      if (t.startsWith("|") && t.endsWith("|")) {
        flushPara();
        flushList();
        flushQuote();
        tableBuf.push(t);
        continue;
      } else if (tableBuf.length) {
        flushTable();
      }
      if (/^(---|\*\*\*|___)$/.test(t)) {
        flushAll();
        out.push("<hr />");
      } else if (t.startsWith("### ")) {
        flushAll();
        out.push(`<h3>${inlineFmt(t.slice(4))}</h3>`);
      } else if (t.startsWith("## ") || t.startsWith("# ")) {
        flushAll();
        out.push(`<h2>${inlineFmt(t.replace(/^#+\s+/, ""))}</h2>`);
      } else if (t.startsWith(">")) {
        flushPara();
        flushList();
        quoteBuf.push(t.replace(/^>\s?/, ""));
      } else if (/^[-*]\s+/.test(t)) {
        flushPara();
        flushQuote();
        if (listType && listType !== "ul") flushList();
        listType = "ul";
        listBuf.push(t.replace(/^[-*]\s+/, ""));
      } else if (/^\d+\.\s+/.test(t)) {
        flushPara();
        flushQuote();
        if (listType && listType !== "ol") flushList();
        listType = "ol";
        listBuf.push(t.replace(/^\d+\.\s+/, ""));
      } else {
        if (quoteBuf.length) flushQuote();
        if (listBuf.length) flushList();
        paraBuf.push(t);
      }
    }
    flushAll();
    return out.join("\n");
  }

  function inlineFmt(str) {
    let s = escapeHtml(str);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      const cap = alt ? `<figcaption>${alt}</figcaption>` : "";
      return `<figure class="craft-figure"><img src="${url}" alt="${alt}" loading="lazy" />${cap}</figure>`;
    });
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, slug, label) => {
      return `<a href="#/notes/${encodeURIComponent(slug.trim())}" class="wikilink">${label || slug}</a>`;
    });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const ext = url.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${url}"${ext}>${label}</a>`;
    });
    return s;
  }

  function extractYouTubeIdSimple(rawLine) {
    const m = String(rawLine || "")
      .trim()
      .match(
        /^https?:\/\/(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?[^\s]*v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[?&][^\s]*)?$/i
      );
    return m ? m[1] : "";
  }

  // 對外橋接介面供 studio-media.js 呼叫（插入照片、檔案、YouTube 影片與雲端硬碟匯入資產）
  window.__STUDIO_BRIDGE__ = {
    getMediaList: () => state.media || [],
    setMediaList: (list) => {
      state.media = list || [];
    },
    updateGitBadge,
    setStatus,
    insertHtmlBlock(targetScope, htmlMarkup) {
      if (targetScope === "html-page" || state.activeTab === "html") {
        const codeTa = document.getElementById("html-code-textarea");
        insertAtCursor(codeTa, "\n" + htmlMarkup);
        markDirty("html");
        updateCodeLineNumbers();
        if (state.currentWebFile.path.endsWith(".html")) {
          updateHtmlLiveIframe(state.currentWebFile.path, codeTa.value);
        }
        return;
      }

      if (state.editorMode === "wysiwyg") {
        const wy = document.getElementById("doc-wysiwyg");
        wy.focus();
        const blockWithAfter = htmlMarkup + "<p><br></p>";
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && wy.contains(sel.anchorNode)) {
          document.execCommand("insertHTML", false, blockWithAfter);
        } else {
          wy.insertAdjacentHTML("beforeend", blockWithAfter);
        }
        document.getElementById("doc-body").value = wy.innerHTML;
      } else {
        insertAtCursor(document.getElementById("doc-body"), "\n" + htmlMarkup + "\n");
      }

      markDirty("content");
      renderLiveContentPreview();
    },
    updateYouTubeTitle(videoId, realTitle) {
      if (!videoId || !realTitle) return;
      const safeLabel = `${escapeHtml(realTitle)} ↗`;
      const defaultLabel = `YouTube 影片 (${escapeHtml(videoId)}) ↗`;

      // 1. 更新視覺化 HTML 畫布中的標題連結與 iframe title
      const wy = document.getElementById("doc-wysiwyg");
      if (wy) {
        wy.querySelectorAll(`[data-yt-title-for="${CSS.escape(videoId)}"]`).forEach((a) => {
          a.textContent = `${realTitle} ↗`;
        });
        wy.querySelectorAll(`.yt-media-card[data-yt-id="${CSS.escape(videoId)}"] iframe`).forEach((ifr) => {
          ifr.setAttribute("title", realTitle);
        });
        if (state.editorMode === "wysiwyg") {
          document.getElementById("doc-body").value = wy.innerHTML;
        }
      }

      // 2. 更新 Markdown / HTML 原始碼文字區與全站 HTML 編輯器中的預設標題字串
      ["doc-body", "html-code-textarea"].forEach((taId) => {
        const ta = document.getElementById(taId);
        if (ta && ta.value.includes(defaultLabel)) {
          ta.value = ta.value.split(defaultLabel).join(safeLabel);
          if (taId === "html-code-textarea" && state.currentWebFile.path.endsWith(".html")) {
            updateHtmlLiveIframe(state.currentWebFile.path, ta.value);
          }
        }
      });

      renderLiveContentPreview();
    },
    insertAsset(targetScope, asset) {
      const stem = (asset.filename || "").replace(/\.[^.]+$/, "");
      let htmlMarkup = "";
      if (asset.kind === "image") {
        htmlMarkup = `<figure class="craft-figure">\n  <img src="${escapeAttr(asset.url)}" alt="${escapeAttr(stem)}" loading="lazy" />\n  <figcaption>${escapeHtml(stem)}</figcaption>\n</figure>\n`;
      } else if (asset.kind === "video") {
        htmlMarkup = `<video class="craft-video" controls src="${escapeAttr(asset.url)}"></video>\n`;
      } else if (asset.kind === "audio") {
        htmlMarkup = `<audio class="craft-audio" controls src="${escapeAttr(asset.url)}"></audio>\n`;
      } else {
        htmlMarkup = `<a class="file-attachment-card" href="${escapeAttr(asset.url)}" download="${escapeAttr(asset.filename)}">\n  <span class="file-attachment-left">\n    <span class="file-ext-badge">${escapeHtml(asset.ext || "FILE")}</span>\n    <span class="file-attachment-name">${escapeHtml(asset.filename)}</span>\n  </span>\n  <span class="file-attachment-meta">${escapeHtml(asset.sizeLabel || "")} · 下載 ↓</span>\n</a>\n`;
      }

      if (targetScope === "html-page" || state.activeTab === "html") {
        const codeTa = document.getElementById("html-code-textarea");
        insertAtCursor(codeTa, "\n" + htmlMarkup);
        markDirty("html");
        updateCodeLineNumbers();
        if (state.currentWebFile.path.endsWith(".html")) {
          updateHtmlLiveIframe(state.currentWebFile.path, codeTa.value);
        }
        return;
      }

      // 插入至內容寫作台 (視覺化 HTML / HTML 原始碼 / Markdown)
      if (state.editorMode === "wysiwyg") {
        const wy = document.getElementById("doc-wysiwyg");
        wy.focus();
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && wy.contains(sel.anchorNode)) {
          document.execCommand("insertHTML", false, htmlMarkup);
        } else {
          wy.insertAdjacentHTML("beforeend", htmlMarkup);
        }
        document.getElementById("doc-body").value = wy.innerHTML;
      } else if (state.editorMode === "markdown" && asset.kind === "image") {
        insertAtCursor(document.getElementById("doc-body"), `\n![${stem}](${asset.url})\n`);
      } else {
        insertAtCursor(document.getElementById("doc-body"), "\n" + htmlMarkup);
      }

      markDirty("content");
      renderLiveContentPreview();
    }
  };

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
