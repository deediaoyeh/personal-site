# 系統架構與啟用指南（GitHub 主站 × Netlify 備份站 × Google Workspace 儲存中樞）

這座個人品牌網站採用**零月租費、純文字永久保存、三方互為備援**的架構設計：

```
┌───────────────────────────────────────────────────────────────────┐
│                  Google Workspace（雲端資料與名單中樞）               │
│  • Google Drive：儲存 essays / notes / letters（支援 .md 與 Docs） │
│  • Google Sheets：儲存電子報訂戶名單、退訂狀態、電子報草稿              │
│  • Gmail + Apps Script：自動寄歡迎信、群發電子報、一鍵觸發網站同步       │
└───────────────────────────────┬───────────────────────────────────┘
                                │ 自動排程 (每 6 小時) / 手動一鍵觸發
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                   GitHub Repository & Actions                     │
│  • 執行 scripts/build_content.py 拉取內容並產生 manifest.json + RSS  │
└──────────────┬────────────────────────────────────┬───────────────┘
               │ 自動發佈                             │ 自動鏡像同步
               ▼                                    ▼
┌──────────────────────────────┐     ┌──────────────────────────────┐
│   GitHub Pages（正式主站）     │     │     Netlify（異地備份站）      │
│   主要網域對外服務             │     │   主站維護或異常時無縫接手      │
└──────────────────────────────┘     └──────────────────────────────┘
```

---

## 一、快速修改你的個人品牌資訊

打開 `site.config.js`，即可修改：
- **姓名、英文署名、書齋標題與個人定位**（`brand` 區塊）
- **首頁序言與近期關注的研究題目**（`intro` 區塊）
- **電子報名稱、發送頻率與 Google Apps Script 網址**（`newsletter` 區塊）
- **關於頁、`/now` 近況與合作項目**（`about` 區塊）

---

## 二、設定 Google Workspace（電子報 ＋ 雲端儲存空間）

1. 在你的 Google Workspace 建立三個子資料夾（供雲端寫作儲存）：
   - 在 Google Drive 新增一個主資料夾（例如 `PersonalSite-Vault`），記下網址列最後一段的 **Folder ID**。
   - 在裡面建立三個子資料夾：`essays`、`notes`、`letters`（裡面可直接放 `.md` 檔，或直接新增 **Google Docs** 寫文章！）。
2. 建立電子報與控制中樞試算表：
   - 新增一份 Google Sheets（例如命名為 `個人網站電子報與同步後台`）。
   - 點選頂部選單 **「擴充功能 → Apps Script」**，將本專案 `google/google-workspace-hub.gs` 的內容完整貼上。
   - 修改頂端 `HUB_CONFIG` 的 `SENDER_NAME`、`SITE_URL`、`DRIVE_CONTENT_FOLDER_ID`。
3. 部署為 API 端點：
   - 點選右上角 **「部署 → 新增部署作業」**，類型選 **「網頁應用程式 (Web App)」**。
   - 執行身分選 **「我」**，誰可以存取選 **「所有人」**，按部署並複製取得的 `https://script.google.com/macros/s/.../exec` 網址。
   - 將該網址貼回網站 `site.config.js` 的 `newsletter.googleScriptUrl` 中，前端訂閱表單即刻正式連通！
   - 重新整理 Google Sheets 頁面，上方會出現 **「書齋控制台」** 選單，點選「初始化試算表結構」即完成。

---

## 三、部署 GitHub Pages 主站與 Netlify 備份站

### 1. 建立 GitHub 主站
1. 在 GitHub 新增一個公開倉庫（例如 `personal-site`），將 `personal-site/` 資料夾初始化並推送上去：
   ```bash
   cd /Users/deediao/Downloads/Project/personal-site
   git init
   git branch -M main
   git add .
   git commit -m "init: warm craft personal brand site"
   git remote add origin https://github.com/你的帳號/personal-site.git
   git push -u origin main
   ```
2. 到 GitHub 倉庫的 **Settings → Pages**，將 **Source** 設為 **GitHub Actions**。
3. 到 **Settings → Secrets and variables → Actions** 新增 Secrets（選填，啟用雲端自動拉取）：
   - `GOOGLE_WORKSPACE_FEED_URL`：貼上剛才的 Google Apps Script 網址。
   - `GOOGLE_WORKSPACE_SYNC_TOKEN`：自訂一組密碼（與 `google-workspace-hub.gs` 中的 `SYNC_TOKEN` 相同）。

### 2. 綁定 Netlify 備份站
1. 登入 Netlify，點選 **Add new site → Import an existing project → GitHub**，選擇同一個 `personal-site` 倉庫。
2. 專案內已附帶 `netlify.toml`，無須額外填寫設定，直接按 **Deploy** 即完成備份站！
3. （選填）在 Netlify 的 **Site configuration → Build & deploy → Build hooks** 新增一個 Hook 網址，貼入 GitHub Secrets 的 `NETLIFY_BUILD_HOOK_URL`。

---

## 四、日常更新與「自動／手動同步」三種方式

- **自動同步**：
  1. 只要 `git push` 更新主站，GitHub Pages 主站與 Netlify 備份站會**同時自動重新部署**。
  2. GitHub Actions 每 6 小時會自動向 Google Workspace 檢查有無新寫好的 Google Docs 或 `.md`，有變更即自動更新雙站。
- **手動立即同步（三選一，看當下在哪裡最順手）**：
  1. **在 Google Workspace 雲端**：寫完 Google Docs 後，打開 Google Sheets 點選頂部 **「書齋控制台 → 立即同步 Google Drive 內容至 GitHub 主站 & Netlify」**。
  2. **在 GitHub 網頁**：進入 **Actions** 分頁，點選 **Run workflow**。
  3. **在 Mac 本機**：雙擊資料夾中的 `sync.command`，自動完成索引更新、本機雲端硬碟備份與 GitHub / Netlify 同步推送。
