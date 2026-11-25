# 網站建置與雲端串接完整紀錄 (BUILD_LOG.md)

本文件完整記錄個人品牌網站（靜謐書齋風 · Warm Craft）從零打造、雲端儲存庫建置、備援站設立到離線編輯工作台完成的所有執行步驟、檔案結構與雲端資源編號。

---

## 一、專案基本座標與雲端資源總表

| 項目 | 設定值 / 編號 | 狀態與說明 |
| --- | --- | --- |
| **本機專案根目錄** | `/Users/deediao/Downloads/Project/personal-site` | 獨立子資料夾，與外層既有專案完全隔離 |
| **本機網站預覽網址** | `http://localhost:8788/` | 雙擊 `start.command` 啟動 |
| **本機離線編輯工作台** | `http://localhost:8788/studio.html` | 雙擊 `start-studio.command` 啟動（100% 斷網可用） |
| **Google Workspace 帳號** | `deediao@gmail.com` | 已透過 `gdrive` 與 `gdocs` 連結驗證 |
| **Google Drive 根儲存庫** | `PersonalSite-Vault` (`1n_ZQELr2H9f1Zre0rmntedtvyrohcGxS`) | 已建立於雲端硬碟根目錄 |
| **Drive 長文子資料夾** | `essays` (`1wWS7-UFucygkzaz237ppzJDiB3207TIT`) | 已上傳初始 3 篇長文 `.md` |
| **Drive 筆記子資料夾** | `notes` (`1fv4vDPgjNKhPqSvZtYrdm9AC47bbkwOB`) | 已上傳初始 4 張知識卡片 `.md` |
| **Drive 電子報子資料夾** | `letters` (`1dDJ53xY7N7bCSNSkRLHub82WJ7d9kqPQ`) | 已上傳初始 2 期電子報 `.md` |
| **GitHub 預設對應帳號** | `deediaoyeh` (`https://github.com/deediaoyeh/personal-site`) | 本機已初始化獨立 Git `main` 分支並附 GitHub Actions |
| **Netlify 備份站專案** | `deediao-studio` (Site ID: `eb87f73c-c435-4e6a-82b5-1e649fa2543b`) | **已正式部署上線**（`https://deediao-studio.netlify.app`，Deploy ID: `6b0629bdbf91524657ad0454`） |

---

## 二、逐步執行紀錄（依時間序）

### 階段 1：設計系統與核心前端建置（2026-11-25 06:50–06:56）
1. **確認工作區隔離**：檢查 `/Users/deediao/Downloads/Project` 發現已有既有專案檔案，決定將個人品牌網站建置於 `/Users/deediao/Downloads/Project/personal-site/` 子目錄。
2. **建立全域設定檔 `site.config.js`**：集中管理品牌名稱、定位序言、近期關注題目、關於頁、`/now` 近況、代表作與電子報設定。
3. **打造靜謐書齋設計系統 `styles.css`**：
   - 採用棉紙米灰底色（`#f5f2eb`）、松煙墨文字（`#1d1c19`）、赭石茶褐點綴色（`#6e5039`）與 `1px` 髮絲細線分割，完全排除漸層、陰影、毛玻璃與浮誇圓角。
   - 實作「晨讀／夜讀（`data-theme="night"`）」切換模式。
4. **開發零框架依賴前端引擎 `index.html` & `app.js`**：
   - 實作四大核心視圖：**首頁**、**深度長文（`#/essays`）**、**知識筆記數位花園（`#/notes`）**、**電子報歸檔（`#/letters`）**與**關於與近況（`#/about`）**。
   - 內建純前端 Markdown 解析器：支援自動產生文章右側目錄（TOC）、閱讀進度細線、表格與程式碼區塊。
   - 實作知識庫雙向連結語法 `[[slug|顯示名稱]]`，並在每篇底部自動計算與渲染「知識網絡關聯（Backlinks）」（亦修正了 Markdown 表格內含直線符號雙向連結的解析邏輯）。
   - 實作全站即時搜尋對話框（支援快捷鍵 `⌘K` / `Ctrl+K`）。

### 階段 2：初始館藏內容與索引引擎建置（2026-11-25 06:57–07:02）
1. **建立 9 篇結構化 Markdown 範例館藏**：
   - `content/essays/`：`slow-writing-and-judgment.md`、`written-decision-culture.md`、`minimal-solo-architecture.md`
   - `content/notes/`：`note-collector-fallacy.md`、`note-evergreen-criteria.md`、`note-one-page-rfc.md`、`note-owned-audience.md`
   - `content/letters/`：`issue-01-manifesto.md`、`issue-02-good-questions.md`
2. **撰寫索引與 RSS 生成器 `scripts/build_content.py`**：自動掃描 Frontmatter 產生 `content/manifest.json` 與標準 `rss.xml`，並支援透過環境變數從 Google Workspace 拉取更新。
3. **撰寫 Google Workspace 雲端中樞腳本 `google/google-workspace-hub.gs`**：
   - 整合 Google Sheets 電子報名單寫入、防重複訂閱、安全退訂憑證與 Gmail 自動歡迎信。
   - 支援在 Google Sheets 產生「書齋控制台」選單：一鍵群發最新電子報、一鍵呼叫 GitHub `repository_dispatch` 同步網站。
   - 支援讀取 Google Drive 內的 `.md` 與 Google Docs 自動轉為網站 Markdown。
4. **建立雙站自動部署設定**：
   - `.github/workflows/deploy-and-sync.yml`：支援 `push` 自動部署、每 6 小時排程同步 Google Workspace、`workflow_dispatch` 手動執行與 Google Sheets 遠端觸發，自動部署至 GitHub Pages 主站並通知 Netlify。
   - `netlify.toml`：配置 Netlify 備份站建置指令（`python3 scripts/build_content.py`）與安全標頭。

### 階段 3：Google Drive 雲端內容庫與 Netlify 備份站實機建置（2026-11-25 07:08–07:16）
1. **建立 Google Drive 資料夾結構**（帳號：`deediao@gmail.com`）：
   - 建立根資料夾 `PersonalSite-Vault`（ID：`1n_ZQELr2H9f1Zre0rmntedtvyrohcGxS`）
   - 建立子資料夾 `essays`（ID：`1wWS7-UFucygkzaz237ppzJDiB3207TIT`）、`notes`（ID：`1fv4vDPgjNKhPqSvZtYrdm9AC47bbkwOB`）、`letters`（ID：`1dDJ53xY7N7bCSNSkRLHub82WJ7d9kqPQ`）
2. **上傳全數 9 篇初始 Markdown 檔案至 Google Drive**：
   - `slow-writing-and-judgment.md` (`1gWERLqZDVHNZpwv3RR9efLLvuGUqkz3m`)
   - `written-decision-culture.md` (`1xCjrK_5NpVIwfFJIRzs6hnRmYyZ-LHeB`)
   - `minimal-solo-architecture.md` (`10GFuc801M05E6PWajfap1Laiyco6h0SL`)
   - `note-collector-fallacy.md` (`1ph8Z-F7B4VaTyXWE0mjGiYe4jFz43gYd`)
   - `note-evergreen-criteria.md` (`1l6b8BGlgurG_fGujhcA5Qt13UeLQa-l_`)
   - `note-one-page-rfc.md` (`1HhBbuMCatpzS4DioYvG5lSr-Bw_gLies`)
   - `note-owned-audience.md` (`1H02srEZVapDH915HOHsUekoGUPFQe5iN`)
   - `issue-01-manifesto.md` (`1gp1qNQX1pfpJPw1t14LPRT1iypoYoE7n`)
   - `issue-02-good-questions.md` (`1FGPzHp4RwcdALc47Jx09oTaY2D2s6b3P`)
3. **建立 Netlify 備份站專案**：
   - 透過 Netlify API 於 `deediao` 團隊建立新專案 `deediao-studio`（Site ID：`eb87f73c-c435-4e6a-82b5-1e649fa2543b`，網址：`https://deediao-studio.netlify.app`）。
   - 將 `.netlify` 加入 `.gitignore` 防止本機狀態檔誤提交，並寫入 `.netlify/state.json`。
   - 將真實 Google Drive Folder ID、GitHub 帳號 `deediaoyeh` 與備份站網址寫入 `google/google-workspace-hub.gs` 與 `site.config.js`。

### 階段 4：打造「書齋離線編輯工作台 (Offline Studio)」（2026-11-25 07:17–07:23）
1. **建立零依賴本機編輯伺服器 `server.py`**：
   - 使用 Python 100% 內建標準庫實作 REST API（`/api/studio/bootstrap`、`/api/studio/config`、`/api/studio/theme`、`/api/studio/item`、`/api/studio/sync`），無網路環境亦可完整讀寫網站檔案並自動重建 `manifest.json` 與 `rss.xml`。
2. **打造五合一離線網站編輯器（`studio.html`、`studio.css`、`studio.js`）**：
   - **1. 內容寫作台**：三欄式設計（館藏目錄篩選 ＋ 結構化欄位與 Markdown 工具列、館藏雙向連結快速插入器 ＋ 右側即時書齋排版預覽與字數閱讀時間估算）。
   - **2. 門面與品牌**：視覺化表單直接修改名字、頭銜、首頁主標、序言、近期思考題目與頁尾連結，右側同步預覽首頁。
   - **3. 關於與近況**：視覺化修改關於頁段落、寫作準則、`/now` 近況與代表合作計畫，右側同步預覽關於頁。
   - **4. 視覺與字級微調**：內建四款低彩度紙感色票預設組（手工宣紙米灰、亞麻冷杉綠、古典藏書票、極簡清水石灰）與自訂色彩、字級、行高、版寬調整器，存檔即寫入 `theme.custom.css`。
   - **5. 電子報與雲端同步台**：設定電子報文案與 Google Apps Script 網址，並可一鍵呼叫 `scripts/sync_cloud.py` 將本機變更同步至 Google Drive、本機 Git 版本庫、GitHub 主站與 Netlify 備份站。
3. **建立本機快捷啟動檔**：
   - `start.command`：啟動本機服務並開啟前台網站預覽。
   - `start-studio.command`：啟動本機服務並直接開啟離線編輯工作台。
   - `sync.command`：終端機一鍵執行雲端同步。
4. **初始化本機獨立 Git 版本庫**：於 `personal-site/` 內完成 `git init -b main` 與首次完整版本提交（Initial Commit），讓離線編輯器的變更追蹤立即可用。
5. **實機端對端驗證完成（2026-11-25 07:26–07:29）**：
   - 修正 `server.py` 單行物件屬性解析與 `studio.js` 即時預覽完整表格／有序清單／引言渲染。
   - 驗證五大工作台分頁（`內容寫作`、`門面品牌`、`關於近況`、`視覺字級`、`電子報與同步`）、即時全站預覽 iframe 與 `POST /api/studio/item` 寫檔重建索引全數通過（HTTP 200，零 Console 錯誤），並將最新 `BUILD_LOG.md`（雲端檔案 ID：`1dOqOZPfY-BiwekE-Qczu-bYjeb-YRzAd`）同步更新至 Google Drive。

### 階段 5：升級全功能 HTML 編輯器與綁定 GitHub 遠端座標（2026-11-25 07:55–08:03）
1. **文章內容三模編輯器（`studio.html`、`studio.js`、`app.js`）**：
   - 於「內容寫作」分頁加入 **`Markdown` ｜ `視覺化 HTML (所見即所得)` ｜ `HTML 原始碼`** 三模即時切換與雙向轉換。
   - 支援視覺化富文本工具列（段落 P、H2、H3、粗體、斜體、底線、項目／編號清單、引言、超連結、重點提示匣、雙欄卡片、摺疊問答、表格、清除格式），前台引擎 `app.js` 亦同步支援 `format: html` 全文渲染、HTML 標題自動提取右側目錄（TOC）與 Markdown 混寫 HTML。
2. **全站 HTML 網頁與樣式原始碼編輯器（新增頂部 `HTML 編輯器` 分頁 + `server.py` API）**：
   - 新增 `/api/studio/web-files` 與 `/api/studio/web-file` 安全讀寫端點。
   - 支援直接以帶行號程式碼編輯器修改 `index.html`、`styles.css`、`theme.custom.css`，並支援 **「＋ 新增獨立 HTML 網頁」**（自動套用靜謐書齋頁首與樣式骨架），右側配備即時渲染預覽與「桌面寬度／手機 390px」響應式切換。
3. **GitHub 遠端倉庫預設綁定**：
   - 本機 Git 已設定預設 `origin` 為 `https://github.com/deediaoyeh/personal-site.git`（對應 GitHub Pages 主站網址：`https://deediaoyeh.github.io/personal-site/`），並於「電子報與同步」分頁新增遠端倉庫網址修改與綁定介面。
4. **完成 Netlify 備份站首次正式部署（2026-11-25 08:20）**：
   - 於暫存區配置免安裝版 Node.js (`v22.14.0` arm64)，執行官方 `@netlify/mcp` 正式部署，成功將全站發佈上線至 **`https://deediao-studio.netlify.app`**（Deploy ID：`6b0629bdbf91524657ad0454`，狀態：`ready`）。




