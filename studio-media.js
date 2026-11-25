/**
 * studio-media.js — 照片上傳、全編輯器檔案拖曳加入、剪貼簿貼圖、Google Drive 雲端硬碟選檔器與安全鎖定登出
 */
(function () {
  "use strict";

  const modalState = {
    targetScope: "content", // "content" | "html-page"
    activeSourceTab: "gdrive",
    folderStack: [{ id: "root", name: "根目錄" }],
    gdriveMode: "folder" // "folder" | "recent" | "search"
  };

  function bridge() {
    return window.__STUDIO_BRIDGE__;
  }

  function initMediaFeatures() {
    bindToolbarButtons();
    bindFileInputs();
    bindDragAndDropAndPaste();
    bindMediaDriveModal();
    bindLockLogoutButton();
  }

  // =========================================================================
  // 1. 頂部安全鎖定登出按鈕
  // =========================================================================
  function bindLockLogoutButton() {
    const lockBtn = document.getElementById("lock-studio-btn");
    if (!lockBtn) return;
    lockBtn.addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST", body: "{}" });
      window.location.reload();
    });
  }

  // =========================================================================
  // 2. 工具列「＋插入照片」、「＋加入檔案」、「Google 雲端硬碟」按鈕
  // =========================================================================
  function bindToolbarButtons() {
    const photoInput = document.getElementById("hidden-photo-input");
    const fileInput = document.getElementById("hidden-file-input");

    document.querySelectorAll("[data-trigger-photo]").forEach((btn) => {
      btn.addEventListener("click", () => {
        modalState.targetScope = btn.dataset.triggerPhoto;
        photoInput.value = "";
        photoInput.click();
      });
    });

    document.querySelectorAll("[data-trigger-file]").forEach((btn) => {
      btn.addEventListener("click", () => {
        modalState.targetScope = btn.dataset.triggerFile;
        fileInput.value = "";
        fileInput.click();
      });
    });

    document.querySelectorAll("[data-open-gdrive]").forEach((btn) => {
      btn.addEventListener("click", () => {
        openMediaModal(btn.dataset.openGdrive, "gdrive");
      });
    });
  }

  function bindFileInputs() {
    const photoInput = document.getElementById("hidden-photo-input");
    const fileInput = document.getElementById("hidden-file-input");

    photoInput.addEventListener("change", async () => {
      if (photoInput.files && photoInput.files.length > 0) {
        await uploadAndInsertFiles(Array.from(photoInput.files), modalState.targetScope);
      }
    });

    fileInput.addEventListener("change", async () => {
      if (fileInput.files && fileInput.files.length > 0) {
        await uploadAndInsertFiles(Array.from(fileInput.files), modalState.targetScope);
      }
    });
  }

  // =========================================================================
  // 3. 拖曳加入檔案 (Drag & Drop) 與剪貼簿貼圖 (Paste Image)
  // =========================================================================
  function bindDragAndDropAndPaste() {
    const dropTargets = [
      { el: document.getElementById("doc-wysiwyg"), scope: "content" },
      { el: document.getElementById("doc-body"), scope: "content" },
      { el: document.getElementById("html-code-textarea"), scope: "html-page" }
    ];

    dropTargets.forEach(({ el, scope }) => {
      if (!el) return;

      el.addEventListener("dragover", (e) => {
        if (e.dataTransfer && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          el.classList.add("is-drag-over");
          bridge()?.setStatus("放開滑鼠即可上傳並插入照片或附件檔案⋯");
        }
      });

      el.addEventListener("dragleave", () => {
        el.classList.remove("is-drag-over");
      });

      el.addEventListener("drop", async (e) => {
        el.classList.remove("is-drag-over");
        const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
        if (files.length === 0) return;
        e.preventDefault();
        await uploadAndInsertFiles(files, scope);
      });

      // 支援直接 ⌘V 貼上螢幕截圖或複製的圖片
      el.addEventListener("paste", async (e) => {
        const items = e.clipboardData?.items ? Array.from(e.clipboardData.items) : [];
        const imgFiles = items
          .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
          .map((it) => {
            const blob = it.getAsFile();
            const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
            const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
            return new File([blob], `screenshot-${stamp}.${ext}`, { type: blob.type });
          });

        if (imgFiles.length > 0) {
          e.preventDefault();
          await uploadAndInsertFiles(imgFiles, scope);
        }
      });
    });

    // 媒體櫃視窗內的拖曳區
    const modalDrop = document.getElementById("modal-dropzone");
    const modalBrowse = document.getElementById("modal-browse-btn");
    if (modalDrop) {
      modalDrop.addEventListener("dragover", (e) => {
        e.preventDefault();
        modalDrop.classList.add("is-drag-over");
      });
      modalDrop.addEventListener("dragleave", () => modalDrop.classList.remove("is-drag-over"));
      modalDrop.addEventListener("drop", async (e) => {
        modalDrop.classList.remove("is-drag-over");
        const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
        if (files.length === 0) return;
        e.preventDefault();
        await uploadAndInsertFiles(files, modalState.targetScope);
        renderLocalMediaGrid();
      });
    }
    if (modalBrowse) {
      modalBrowse.addEventListener("click", () => {
        document.getElementById("hidden-file-input").click();
      });
    }
  }

  async function uploadAndInsertFiles(files, targetScope) {
    const b = bridge();
    if (!b) return;

    b.setStatus(`正在上傳 ${files.length} 個檔案至網站媒體櫃⋯`);
    let okCount = 0;

    for (const file of files) {
      try {
        const base64 = await readFileAsBase64(file);
        const res = await fetch("/api/studio/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            mimeType: file.type || "application/octet-stream",
            dataBase64: base64
          })
        });
        const data = await res.json();
        if (!data.ok) {
          throw new Error(data.message || `上傳 ${file.name} 失敗`);
        }
        b.setMediaList(data.media || []);
        b.updateGitBadge(data.git);
        b.insertAsset(targetScope, data);
        okCount++;
      } catch (err) {
        b.setStatus(`上傳失敗：${err.message}`, "is-dirty");
        return;
      }
    }

    b.setStatus(`✓ 已加入 ${okCount} 個照片／檔案（按 ⌘S 儲存文章或網頁）`, "is-saved");
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("讀取本機檔案失敗"));
      reader.readAsDataURL(file);
    });
  }

  // =========================================================================
  // 4. Google Drive 雲端硬碟選檔器 & 本站媒體櫃視窗
  // =========================================================================
  function openMediaModal(targetScope, initialTab = "gdrive") {
    modalState.targetScope = targetScope;
    const modal = document.getElementById("media-drive-modal");
    modal.hidden = false;
    switchModalSourceTab(initialTab);
  }

  function closeMediaModal() {
    document.getElementById("media-drive-modal").hidden = true;
  }

  function switchModalSourceTab(tabKey) {
    modalState.activeSourceTab = tabKey;
    document.querySelectorAll("[data-media-tab]").forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.mediaTab === tabKey);
    });
    document.getElementById("media-pane-gdrive").hidden = tabKey !== "gdrive";
    document.getElementById("media-pane-local").hidden = tabKey !== "local";

    if (tabKey === "gdrive") {
      loadGdriveList();
    } else {
      renderLocalMediaGrid();
    }
  }

  function bindMediaDriveModal() {
    const modal = document.getElementById("media-drive-modal");
    document.getElementById("close-media-modal-btn").addEventListener("click", closeMediaModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeMediaModal();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) closeMediaModal();
    });

    document.querySelectorAll("[data-media-tab]").forEach((btn) => {
      btn.addEventListener("click", () => switchModalSourceTab(btn.dataset.mediaTab));
    });

    document.getElementById("gdrive-root-btn").addEventListener("click", () => {
      modalState.gdriveMode = "folder";
      modalState.folderStack = [{ id: "root", name: "根目錄" }];
      document.getElementById("gdrive-search-input").value = "";
      updateGdriveNavButtons();
      loadGdriveList();
    });

    document.getElementById("gdrive-recent-btn").addEventListener("click", () => {
      modalState.gdriveMode = "recent";
      document.getElementById("gdrive-search-input").value = "";
      updateGdriveNavButtons();
      loadGdriveList();
    });

    document.getElementById("gdrive-up-btn").addEventListener("click", () => {
      if (modalState.folderStack.length > 1) {
        modalState.folderStack.pop();
        modalState.gdriveMode = "folder";
        updateGdriveNavButtons();
        loadGdriveList();
      }
    });

    const searchInput = document.getElementById("gdrive-search-input");
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const q = searchInput.value.trim();
        modalState.gdriveMode = q ? "search" : "folder";
        updateGdriveNavButtons();
        loadGdriveList(q);
      }
    });
  }

  function updateGdriveNavButtons() {
    document.getElementById("gdrive-root-btn").classList.toggle("is-active", modalState.gdriveMode === "folder");
    document.getElementById("gdrive-recent-btn").classList.toggle("is-active", modalState.gdriveMode === "recent");
    document.getElementById("gdrive-up-btn").hidden =
      modalState.gdriveMode !== "folder" || modalState.folderStack.length <= 1;

    const crumb = document.getElementById("gdrive-breadcrumb");
    if (modalState.gdriveMode === "recent") {
      crumb.textContent = "最近使用的雲端檔案";
    } else if (modalState.gdriveMode === "search") {
      crumb.textContent = `搜尋結果：${document.getElementById("gdrive-search-input").value.trim()}`;
    } else {
      crumb.textContent = "/ " + modalState.folderStack.map((f) => f.name).join(" / ");
    }
  }

  async function loadGdriveList(searchQuery = "") {
    const container = document.getElementById("gdrive-items-container");
    container.innerHTML = `<div style="padding:28px; color:var(--ink-muted);">正在讀取你的 Google 雲端硬碟檔案清單⋯</div>`;
    updateGdriveNavButtons();

    const currentFolder = modalState.folderStack[modalState.folderStack.length - 1];
    const params = new URLSearchParams({
      folderId: currentFolder.id,
      mode: modalState.gdriveMode,
      query: searchQuery || document.getElementById("gdrive-search-input").value.trim()
    });

    try {
      const res = await fetch(`/api/studio/gdrive/list?${params.toString()}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || "無法讀取 Google Drive");

      const items = data.items || [];
      if (items.length === 0) {
        container.innerHTML = `<div style="padding:28px; color:var(--ink-muted);">此資料夾或搜尋條件下沒有檔案。</div>`;
        return;
      }

      container.innerHTML = items
        .map((it) => {
          const badgeLabel = it.isFolder
            ? "FOLDER"
            : it.isImage
            ? "IMAGE"
            : (it.name.split(".").pop() || "FILE").slice(0, 6).toUpperCase();
          return `
            <div class="drive-row">
              <div class="drive-row-left">
                <span class="drive-kind-tag mono-label ${it.isFolder ? "is-folder" : ""}">${esc(badgeLabel)}</span>
                <button type="button" class="drive-name-btn" data-drive-open="${esc(it.id)}" data-drive-isfolder="${it.isFolder}" data-drive-name="${esc(it.name)}" data-drive-mime="${esc(it.mimeType)}">
                  ${esc(it.name)}
                </button>
              </div>
              <div style="display:flex; align-items:center; gap:12px; flex-shrink:0;">
                <span class="mono-label" style="font-size:0.74rem; color:var(--ink-muted);">${esc(it.sizeLabel)} · ${esc(it.modifiedTime)}</span>
                ${
                  it.isFolder
                    ? `<button type="button" class="tool-btn" data-drive-folder="${esc(it.id)}" data-drive-name="${esc(it.name)}">開啟 →</button>`
                    : `<button type="button" class="tool-btn media-accent-btn" data-drive-import="${esc(it.id)}" data-drive-name="${esc(it.name)}" data-drive-mime="${esc(it.mimeType)}">匯入並插入</button>`
                }
              </div>
            </div>
          `;
        })
        .join("");

      // 綁定開啟資料夾
      container.querySelectorAll("[data-drive-folder]").forEach((btn) => {
        btn.addEventListener("click", () => {
          modalState.gdriveMode = "folder";
          modalState.folderStack.push({ id: btn.dataset.driveFolder, name: btn.dataset.driveName });
          loadGdriveList();
        });
      });

      container.querySelectorAll("[data-drive-open]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.driveIsfolder === "true") {
            modalState.gdriveMode = "folder";
            modalState.folderStack.push({ id: btn.dataset.driveOpen, name: btn.dataset.driveName });
            loadGdriveList();
          } else {
            importFromDriveAndInsert(btn.dataset.driveOpen, btn.dataset.driveName, btn.dataset.driveMime, btn);
          }
        });
      });

      container.querySelectorAll("[data-drive-import]").forEach((btn) => {
        btn.addEventListener("click", () => {
          importFromDriveAndInsert(btn.dataset.driveImport, btn.dataset.driveName, btn.dataset.driveMime, btn);
        });
      });
    } catch (err) {
      container.innerHTML = `<div style="padding:24px; color:#9e3f33;">${esc(err.message)}（若目前為離線狀態，可切換至上方「本站媒體櫃」選用已儲存的照片與檔案）</div>`;
    }
  }

  async function importFromDriveAndInsert(fileId, name, mimeType, triggerBtn) {
    const b = bridge();
    if (!b) return;
    const origLabel = triggerBtn.textContent;
    triggerBtn.disabled = true;
    triggerBtn.textContent = "匯入中⋯";
    b.setStatus(`正在從 Google 雲端硬碟下載匯入「${name}」⋯`);

    try {
      const res = await fetch("/api/studio/gdrive/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, name, mimeType })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || "匯入失敗");

      b.setMediaList(data.media || []);
      b.updateGitBadge(data.git);
      b.insertAsset(modalState.targetScope, data);
      closeMediaModal();
      b.setStatus(`✓ 已從 Google 雲端硬碟匯入並插入「${data.filename}」`, "is-saved");
    } catch (err) {
      b.setStatus(`雲端硬碟匯入失敗：${err.message}`, "is-dirty");
      triggerBtn.disabled = false;
      triggerBtn.textContent = origLabel;
    }
  }

  function renderLocalMediaGrid() {
    const container = document.getElementById("local-media-container");
    const items = bridge()?.getMediaList() || [];
    if (items.length === 0) {
      container.innerHTML = `<div style="grid-column:1/-1; padding:24px; color:var(--ink-muted); text-align:center;">目前媒體櫃尚無檔案，可直接將照片或檔案拖曳至上方虛線框。</div>`;
      return;
    }

    container.innerHTML = items
      .map(
        (m, idx) => `
      <div class="media-card">
        <div>
          <div class="media-thumb-box">
            ${
              m.kind === "image"
                ? `<img src="${esc(m.url)}" alt="${esc(m.filename)}" loading="lazy" />`
                : `<span class="file-ext-badge">${esc(m.ext)}</span>`
            }
          </div>
          <div class="media-card-name" title="${esc(m.filename)}" style="margin-top:8px;">${esc(m.filename)}</div>
          <div class="media-card-meta mono-label">${esc(m.sizeLabel)}</div>
        </div>
        <button type="button" class="tool-btn media-accent-btn full-w" data-insert-local-idx="${idx}">插入至游標</button>
      </div>
    `
      )
      .join("");

    container.querySelectorAll("[data-insert-local-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const asset = items[Number(btn.dataset.insertLocalIdx)];
        if (asset) {
          bridge()?.insertAsset(modalState.targetScope, asset);
          closeMediaModal();
          bridge()?.setStatus(`✓ 已插入「${asset.filename}」`, "is-saved");
        }
      });
    });
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.addEventListener("DOMContentLoaded", initMediaFeatures);
})();
