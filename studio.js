/**
 * studio.js — 書齋離線編輯工作台前端控制器
 * 100% 無外部套件依賴，與本機 server.py 通訊，直接讀寫 Markdown、site.config.js 與 theme.custom.css。
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

  const state = {
    activeTab: "content",
    config: null,
    theme: null,
    manifest: { items: [] },
    filterType: "all",
    searchQuery: "",
    currentDoc: {
      originalSlug: "",
      originalType: "",
      isNew: false
    },
    dirty: false
  };

  // =========================================================================
  // 啟動載入
  // =========================================================================
  async function init() {
    bindTabs();
    bindContentStudioEvents();
    bindConfigAndThemeEvents();
    bindGlobalShortcuts();

    try {
      const res = await fetch("/api/studio/bootstrap");
      if (!res.ok) throw new Error("請透過 start.command 或 python3 server.py 啟動工作台");
      const data = await res.json();

      state.config = data.config;
      state.theme = data.theme;
      state.manifest = data.manifest;

      populateConfigForms();
      populateThemeForm();
      renderSidebarList();
      populateWikilinkPicker();
      updateGitBadge(data.git);

      if (state.manifest.items.length > 0) {
        const first = state.manifest.items[0];
        await selectDoc(first.type, first.slug);
      } else {
        startNewDoc("essay");
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

  function markDirty() {
    state.dirty = true;
    setStatus("尚有未儲存的修改（按 ⌘S 儲存）", "is-dirty");
  }

  function updateGitBadge(gitInfo) {
    const el = document.getElementById("git-changed-count");
    if (!el || !gitInfo) return;
    el.textContent = gitInfo.initialized
      ? `${gitInfo.changedCount} 個檔案待同步`
      : "尚未初始化 Git";
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
  // Tab 1: 內容寫作台
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
        return `
          <button type="button" class="sidebar-item ${selected ? "is-selected" : ""}" data-doc-type="${escapeAttr(item.type)}" data-doc-slug="${escapeAttr(item.slug)}">
            <div class="sidebar-item-meta mono-label">${typeTag[item.type] || item.type} · ${escapeHtml(item.date)}</div>
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
  }

  async function selectDoc(type, slug) {
    const res = await fetch(`/api/studio/item?type=${encodeURIComponent(type)}&slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return;
    const { meta, body } = await res.json();

    state.currentDoc = { originalSlug: slug, originalType: type, isNew: false };

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

    toggleTypeSpecificFields(meta.type || type);
    renderSidebarList();
    renderLiveMarkdownPreview();
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
    document.getElementById("doc-body").value =
      docType === "essay"
        ? "## 問題背景\n\n在這裡開始書寫你的核心推論⋯\n"
        : docType === "note"
        ? "寫下單一原子概念或讀書摘錄⋯\n"
        : "週日早安，歡迎讀到新一期的電子報。\n\n## 一、本期短論\n\n";

    toggleTypeSpecificFields(docType);
    renderSidebarList();
    renderLiveMarkdownPreview();
    document.getElementById("doc-title").focus();
    setStatus("已建立新草稿 — 輸入標題並按 ⌘S 即可寫入網站", "is-dirty");
  }

  function toggleTypeSpecificFields(type) {
    document.getElementById("wrap-note-stage").hidden = type !== "note";
    document.getElementById("wrap-note-code").hidden = type !== "note";
    document.getElementById("wrap-letter-issue").hidden = type !== "letter";
  }

  function bindContentStudioEvents() {
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

    document.getElementById("doc-type").addEventListener("change", (e) => {
      toggleTypeSpecificFields(e.target.value);
      markDirty();
      renderLiveMarkdownPreview();
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
        renderLiveMarkdownPreview();
      });
    });

    // Markdown 工具列插入
    document.querySelectorAll("[data-md]").forEach((btn) => {
      btn.addEventListener("click", () => {
        insertMarkdownSnippet(btn.dataset.md);
      });
    });

    document.getElementById("insert-wikilink-select").addEventListener("change", (e) => {
      if (!e.target.value) return;
      insertAtCursor(document.getElementById("doc-body"), e.target.value);
      e.target.value = "";
      markDirty();
      renderLiveMarkdownPreview();
    });

    document.getElementById("delete-doc-btn").addEventListener("click", async () => {
      if (!state.currentDoc.originalSlug) {
        startNewDoc("essay");
        return;
      }
      const title = document.getElementById("doc-title").value || state.currentDoc.originalSlug;
      if (!window.confirm(`確定要刪除「${title}」嗎？此動作會移除對應的 .md 檔案。`)) return;

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

  function insertMarkdownSnippet(kind) {
    const ta = document.getElementById("doc-body");
    const snippets = {
      h2: "\n## 段落標題\n",
      h3: "\n### 子標題\n",
      bold: "**重點文字**",
      quote: "\n> 在此輸入引言或核心洞見。\n",
      ul: "\n- 第一點觀察\n- 第二點觀察\n",
      table: "\n| 比較面向 | 選項 A | 選項 B |\n| --- | --- | --- |\n| 核心優勢 | 說明 | 說明 |\n",
      hr: "\n---\n"
    };
    insertAtCursor(ta, snippets[kind] || "");
    markDirty();
    renderLiveMarkdownPreview();
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

  function renderLiveMarkdownPreview() {
    const title = document.getElementById("doc-title").value.trim() || "未命名標題";
    const type = document.getElementById("doc-type").value;
    const date = (document.getElementById("doc-date").value || todayStr()).replace(/-/g, ".");
    const summary = document.getElementById("doc-summary").value.trim();
    const body = document.getElementById("doc-body").value;

    const cleanChars = body.replace(/\s+/g, "").length;
    document.getElementById("word-count-indicator").textContent = `${cleanChars} 字 · 約 ${Math.max(
      1,
      Math.round(cleanChars / 380)
    )} min 閱讀`;

    document.getElementById("preview-meta").textContent = `${date} · ${type.toUpperCase()}`;
    document.getElementById("preview-title").textContent = title;
    document.getElementById("preview-summary").textContent = summary;
    document.getElementById("preview-prose").innerHTML = simplePreviewMarkdown(body);
  }

  // =========================================================================
  // Tab 2, 3, 4, 5: 門面、關於、視覺、電子報與同步
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

    document.querySelectorAll("#tab-brand input, #tab-brand textarea, #tab-about input, #tab-about textarea, #tab-sync input, #tab-sync textarea, #tab-theme input").forEach(
      (el) => {
        el.addEventListener("input", markDirty);
      }
    );

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
  // 全域儲存動作 (⌘S / 點擊儲存變更)
  // =========================================================================
  async function saveActiveWork() {
    const saveBtn = document.getElementById("global-save-btn");
    saveBtn.disabled = true;
    setStatus("正在寫入網站檔案⋯");

    try {
      if (state.activeTab === "content") {
        // 擷取所有連動的 [[slug]] 自動寫入 links 欄位
        const body = document.getElementById("doc-body").value;
        const wikiSlugs = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
        const docType = document.getElementById("doc-type").value;

        const meta = {
          title: document.getElementById("doc-title").value.trim() || "未命名文章",
          slug: document.getElementById("doc-slug").value.trim(),
          type: docType,
          date: document.getElementById("doc-date").value || todayStr(),
          tags: document.getElementById("doc-tags").value.trim(),
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
        updateGitBadge(data.git);
        renderSidebarList();
        populateWikilinkPicker();
      } else if (state.activeTab === "theme") {
        const theme = collectThemeFromForm();
        const res = await fetch("/api/studio/theme", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "儲存主題失敗");
        state.theme = data.theme;
        updateGitBadge(data.git);
        reloadPreviewIframes();
      } else {
        const config = collectConfigFromForms();
        const res = await fetch("/api/studio/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config })
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.message || "儲存網站設定失敗");
        state.config = config;
        updateGitBadge(data.git);
        reloadPreviewIframes();
      }

      state.dirty = false;
      const timeStr = new Date().toLocaleTimeString("zh-TW", { hour12: false });
      setStatus(`✓ 已於 ${timeStr} 寫入本機網站並更新索引`, "is-saved");
    } catch (err) {
      setStatus(`儲存失敗：${err.message}`, "is-dirty");
    } finally {
      saveBtn.disabled = false;
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
  // 輔助解析器（預覽窗格專用）
  // =========================================================================
  function simplePreviewMarkdown(md) {
    const lines = md.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let inCode = false;
    let codeBuf = [];

    for (const line of lines) {
      if (line.trim().startsWith("```")) {
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
      if (!t) continue;
      if (/^(---|\*\*\*)$/.test(t)) {
        out.push("<hr />");
      } else if (t.startsWith("### ")) {
        out.push(`<h3>${inlineFmt(t.slice(4))}</h3>`);
      } else if (t.startsWith("## ") || t.startsWith("# ")) {
        out.push(`<h2>${inlineFmt(t.replace(/^#+\s+/, ""))}</h2>`);
      } else if (t.startsWith(">")) {
        out.push(`<blockquote><p>${inlineFmt(t.replace(/^>\s?/, ""))}</p></blockquote>`);
      } else if (t.startsWith("- ") || t.startsWith("* ")) {
        out.push(`<ul><li>${inlineFmt(t.slice(2))}</li></ul>`);
      } else {
        out.push(`<p>${inlineFmt(t)}</p>`);
      }
    }
    return out.join("\n");
  }

  function inlineFmt(str) {
    let s = escapeHtml(str);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, slug, label) => {
      return `<a href="#/notes/${encodeURIComponent(slug.trim())}" class="wikilink">${label || slug}</a>`;
    });
    return s;
  }

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
