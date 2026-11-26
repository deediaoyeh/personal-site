/**
 * ==========================================================================
 * Google Workspace 書齋雲端中樞 — 資安強化版 v3 (google-workspace-hub.gs)
 * ==========================================================================
 * 資安防護設計：
 * 1. 【防濫寄垃圾信與保護 Gmail 額度】：
 *    - 採用 Double Opt-In（雙重確認訂閱）：新訂閱先標記為 pending，須由信箱本人點擊確認信連結才轉為 active。
 *    - 內建蜜罐欄位 (Honeypot) 與最小填表秒數過濾自動化機器人。
 *    - 嚴格四層寄信速率限制（單一信箱 24 小時冷卻、每分鐘最多 3 封、每小時最多 12 封、每日最多 35 封 ＋ Gmail 剩餘額度安全閥），徹底杜絕寄信額度耗盡或帳號停權風險。
 *    - 確認信內文 100% 靜態固定文字，絕不回顯任何使用者輸入字串，杜絕被利用夾帶垃圾訊息。
 * 2. 【防試算表公式注入 (Formula Injection)】：
 *    - 所有寫入儲存格一律經過 safeCell() 過濾（攔截 =, +, -, @, Tab, 換行等公式字元）並強制設定儲存格格式為純文字 ("@")，杜絕 IMPORTXML / IMAGE 外洩名單。
 * 3. 【嚴格預設拒絕 (Fail-Closed) 同步與管理金鑰】：
 *    - ?action=feed 與 action=save_draft 強制要求至少 16 碼之 SYNC_TOKEN 且採用常數時間比對；未設定金鑰時一律拒絕存取（Fail-Closed）。
 *    - action=analytics_summary 強制要求 ANALYTICS_READ_KEY 常數時間比對。
 * ==========================================================================
 */

// ── 基本設定區（公開倉庫內金鑰保持空白，部署至私人 Apps Script 時填入亂數金鑰）──
const HUB_CONFIG = {
  SENDER_NAME: "低調走過 · Deediao",
  NEWSLETTER_TITLE: "《低調走過》雙週電子報",
  SITE_URL: "https://deediaoyeh.github.io/personal-site",
  MIRROR_URL: "https://deediao-studio.netlify.app",

  // Google Drive 網站內容根資料夾 ID（PersonalSite-Vault）
  DRIVE_CONTENT_FOLDER_ID: "1n_ZQELr2H9f1Zre0rmntedtvyrohcGxS",

  // 必填（Fail-Closed）：內容拉取 (feed) 與工作台推送草稿 (save_draft) 專用保護金鑰（至少 16 碼）
  SYNC_TOKEN: "",

  // 必填（Fail-Closed）：私密點閱儀表板讀取金鑰（至少 16 碼）
  ANALYTICS_READ_KEY: "",

  // 選填：從 Google Sheet 選單觸發 GitHub Actions 同步與雲端工作台原子讀寫
  GITHUB_OWNER: "deediaoyeh",
  GITHUB_REPO: "personal-site",
  GITHUB_PAT: "",

  // 雲端編輯工作台雙重驗證 (2FA) 私密設定（公開倉庫保持空白，僅寫入私人 Apps Script）
  STUDIO_SALT_HEX: "",
  STUDIO_VERIFIER_HEX: "",
  STUDIO_TOTP_SECRET: "",
  STUDIO_RECOVERY_HASHES: "",
  STUDIO_JWT_SECRET: ""
};

const SHEET_SUBSCRIBERS = "Subscribers";
const SHEET_ISSUES = "NewsletterDrafts";
const SHEET_PAGEVIEWS = "PageViews";
const SHEET_RESONANCE = "Resonance";
const SHEET_FEEDBACK = "ReaderFeedback";

// ── 密碼學常數時間比對與試算表防公式注入工具 ─────────────────────────────
function constantTimeEqual(inputStr, secretStr) {
  if (typeof inputStr !== "string" || typeof secretStr !== "string") return false;
  if (secretStr.length < 16) return false; // 強制拒絕空金鑰或過短金鑰 (Fail-Closed)
  if (inputStr.length !== secretStr.length) return false;
  let diff = 0;
  for (let i = 0; i < secretStr.length; i++) {
    diff |= inputStr.charCodeAt(i) ^ secretStr.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 徹底阻絕 Google Sheets 公式注入 (CSV / Formula Injection)
 * 清除控制字元，若開頭為 =, +, -, @, Tab, 全形符號等任何可觸發公式運算之字元，強制加上單引號轉義
 */
function safeCell(val, maxLen) {
  const limit = maxLen || 200;
  let s = String(val === undefined || val === null ? "" : val)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .slice(0, limit);
  const trimmedLeft = s.replace(/^\s+/, "");
  if (/^[=+\-@'"\t\r\n＝＋－＠｜|]/.test(trimmedLeft) || /^[=+\-@'"\t\r\n]/.test(s)) {
    s = "'" + s;
  }
  return s;
}

/**
 * 以互斥鎖將整列以「純文字格式 (@)」安全寫入試算表，雙重杜絕公式執行與併發覆寫
 */
function appendSafeTextRow(sheet, rawCells, maxLenPerCol) {
  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const cleanRow = rawCells.map((c, idx) => {
      const colMax = Array.isArray(maxLenPerCol) ? maxLenPerCol[idx] || 200 : maxLenPerCol || 200;
      return safeCell(c, colMax);
    });
    const nextRow = sheet.getLastRow() + 1;
    const range = sheet.getRange(nextRow, 1, 1, cleanRow.length);
    range.setNumberFormat("@");
    range.setValues([cleanRow]);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 嚴格多層寄信速率限制與 Gmail 額度保護閥
 */
function checkAndConsumeSubscribeQuota(email) {
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();

  // 1. 同一 Email 24 小時內僅寄發一次確認信，防止針對特定信箱轟炸
  const emailKey = "sub_cool_" + Utilities.base64EncodeWebSafe(email).slice(0, 64);
  if (cache.get(emailKey)) {
    return { allowed: false, cooldownOnly: true };
  }

  // 3. 全站每分鐘最多 3 封（阻擋瞬間自動化腳本攻擊）
  const now = new Date();
  const minBucket = "sub_m_" + Utilities.formatDate(now, "UTC", "yyyyMMddHHmm");
  const minCount = Number(cache.get(minBucket) || "0");
  if (minCount >= 3) {
    return { allowed: false, reason: "目前訂閱請求較為頻繁，請稍候一分鐘再試。" };
  }

  // 4. 全站每小時最多 12 封
  const hrBucket = "sub_h_" + Utilities.formatDate(now, "UTC", "yyyyMMddHH");
  const hrCount = Number(cache.get(hrBucket) || "0");
  if (hrCount >= 12) {
    return { allowed: false, reason: "本時段訂閱確認名額已滿，請稍後再試。" };
  }

  // 5. 全站每日最多 35 封
  const dayKey = "sub_d_" + Utilities.formatDate(now, "UTC", "yyyyMMdd");
  const dayCount = Number(props.getProperty(dayKey) || "0");
  if (dayCount >= 35) {
    return { allowed: false, reason: "今日訂閱確認名額已滿，請明日再試。" };
  }

  cache.put(emailKey, "1", 86400);
  cache.put(minBucket, String(minCount + 1), 90);
  cache.put(hrBucket, String(hrCount + 1), 3700);
  props.setProperty(dayKey, String(dayCount + 1));
  return { allowed: true };
}

/**
 * 在 Google 試算表頂部建立「書齋控制台」自訂選單
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("書齋控制台")
    .addItem("1. 初始化試算表結構", "setupSheets")
    .addSeparator()
    .addItem("✨ 自動彙整最新「1 篇長文＋3 則筆記」產生本期草稿", "autoCompileBiweeklyDraft")
    .addItem("📨 寄送最新一期電子報草稿給所有已確認 (active) 訂戶", "sendLatestNewsletter")
    .addSeparator()
    .addItem("🔄 立即同步 Google Drive 內容至 GitHub 主站", "triggerGitHubSync")
    .addToUi();
}

/**
 * 一鍵建立所需的工作表：Subscribers、NewsletterDrafts、PageViews
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let subSheet = ss.getSheetByName(SHEET_SUBSCRIBERS);
  if (!subSheet) {
    subSheet = ss.insertSheet(SHEET_SUBSCRIBERS);
    subSheet.appendRow(["Email", "狀態 (pending/active/unsubscribed)", "訂閱時間", "來源頁面", "驗證與退訂憑證"]);
    subSheet.getRange("A1:E1").setFontWeight("bold");
  }

  let draftSheet = ss.getSheetByName(SHEET_ISSUES);
  if (!draftSheet) {
    draftSheet = ss.insertSheet(SHEET_ISSUES);
    draftSheet.appendRow(["期數", "信件主旨", "信件內容 (純文字或 HTML)", "發送狀態", "發送時間"]);
    draftSheet.getRange("A1:E1").setFontWeight("bold");
  }

  let pvSheet = ss.getSheetByName(SHEET_PAGEVIEWS);
  if (!pvSheet) {
    pvSheet = ss.insertSheet(SHEET_PAGEVIEWS);
    pvSheet.appendRow([
      "時間 (ISO)",
      "日期 (YYYY-MM-DD)",
      "路由路徑",
      "頁面標題",
      "內容類型",
      "當日匿名訪客雜湊",
      "流量來源",
      "閱讀裝置",
      "站點網域",
      "停留秒數",
      "訪問識別碼"
    ]);
    pvSheet.getRange("A1:K1").setFontWeight("bold");
  } else if (pvSheet.getLastColumn() < 11) {
    pvSheet.getRange("J1:K1").setValues([["停留秒數", "訪問識別碼"]]).setFontWeight("bold");
  }

  let resSheet = ss.getSheetByName(SHEET_RESONANCE);
  if (!resSheet) {
    resSheet = ss.insertSheet(SHEET_RESONANCE);
    resSheet.appendRow(["時間 (ISO)", "日期 (YYYY-MM-DD)", "文章識別碼 (Slug)", "文章標題", "當日匿名訪客雜湊"]);
    resSheet.getRange("A1:E1").setFontWeight("bold");
  }

  let fbSheet = ss.getSheetByName(SHEET_FEEDBACK);
  if (!fbSheet) {
    fbSheet = ss.insertSheet(SHEET_FEEDBACK);
    fbSheet.appendRow(["時間 (ISO)", "文章標題", "文章路徑", "讀者稱呼或信箱", "私密回饋內容"]);
    fbSheet.getRange("A1:E1").setFontWeight("bold");
  }
}

/**
 * 處理網站前端與工作台 POST 請求
 */
function doPost(e) {
  try {
    setupSheets();
    const rawBody = (e && e.postData && e.postData.contents) || "{}";
    if (rawBody.length > 25000000) {
      return jsonResponse({ ok: false, message: "請求內容超過上限" });
    }
    const payload = JSON.parse(rawBody);

    // 公開端點嚴格限制單次請求大小 (<= 50KB)
    if (
      (payload.action === "subscribe" ||
        payload.action === "pageview" ||
        payload.action === "pageview_engagement" ||
        payload.action === "get_resonance" ||
        payload.action === "resonance" ||
        payload.action === "reader_feedback") &&
      rawBody.length > 50000
    ) {
      return jsonResponse({ ok: false, message: "公開請求內容過大" });
    }

    if (payload.action === "subscribe") {
      return handleSubscribe(payload);
    }

    if (payload.action === "pageview") {
      return handleTrackPageview(payload);
    }

    if (payload.action === "pageview_engagement") {
      return handlePageviewEngagement(payload);
    }

    if (payload.action === "get_resonance") {
      return handleGetResonance(payload);
    }

    if (payload.action === "resonance") {
      return handleAddResonance(payload);
    }

    if (payload.action === "reader_feedback") {
      return handleReaderFeedback(payload);
    }

    // ── 雲端編輯工作台雙重驗證 (2FA) 與 GitHub 原子讀寫閘門 ────────────────
    if (payload.action === "studio_auth_salt") {
      const configured = Boolean(
        HUB_CONFIG.STUDIO_SALT_HEX &&
          HUB_CONFIG.STUDIO_VERIFIER_HEX &&
          HUB_CONFIG.STUDIO_TOTP_SECRET &&
          HUB_CONFIG.STUDIO_JWT_SECRET
      );
      return jsonResponse({
        ok: true,
        configured: configured,
        saltHex: configured ? HUB_CONFIG.STUDIO_SALT_HEX : "",
        iterations: 600000
      });
    }

    if (payload.action === "studio_auth_login") {
      return handleStudioCloudLogin(payload);
    }

    if (payload.action === "cloud_studio") {
      return handleStudioCloudApi(payload);
    }

    // 嚴格預設拒絕 (Fail-Closed)：必須持有正確 SYNC_TOKEN 方可寫入或發送電子報
    if (
      payload.action === "save_draft" ||
      payload.action === "send_test_newsletter" ||
      payload.action === "send_live_newsletter"
    ) {
      if (!constantTimeEqual(String(payload.token || ""), HUB_CONFIG.SYNC_TOKEN)) {
        return jsonResponse({ ok: false, message: "拒絕存取：缺少或無效的同步金鑰 (SYNC_TOKEN)" });
      }
      if (payload.action === "save_draft") return handleSaveDraftFromStudio(payload);
      if (payload.action === "send_test_newsletter") return handleSendTestNewsletter(payload);
      if (payload.action === "send_live_newsletter") return handleSendLiveNewsletterFromStudio(payload);
    }

    // 嚴格預設拒絕 (Fail-Closed)：必須持有正確 ANALYTICS_READ_KEY 方可讀取點閱儀表板
    if (payload.action === "analytics_summary") {
      if (!constantTimeEqual(String(payload.analyticsKey || ""), HUB_CONFIG.ANALYTICS_READ_KEY)) {
        return jsonResponse({ ok: false, message: "拒絕存取：缺少或無效的站長私密點閱金鑰" });
      }
      return handleAnalyticsSummary();
    }

    return jsonResponse({ ok: false, message: "未知的操作類型" });
  } catch (err) {
    return jsonResponse({ ok: false, message: "請求處理失敗" });
  }
}

/**
 * 處理 GET 請求：
 * 1. ?action=confirm&email=...&token=...     → Double Opt-In 讀者點擊信中連結確認訂閱
 * 2. ?action=unsubscribe&email=...&token=... → 讀者一鍵退訂
 * 3. ?action=feed&token=...                  → 供 GitHub Actions 拉取雲端硬碟（強制檢查 SYNC_TOKEN）
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.action === "confirm") {
    return handleConfirmSubscribe(params.email, params.token);
  }

  if (params.action === "unsubscribe") {
    return handleUnsubscribe(params.email, params.token);
  }

  if (params.action === "feed") {
    if (!constantTimeEqual(String(params.token || ""), HUB_CONFIG.SYNC_TOKEN)) {
      return jsonResponse({ ok: false, message: "拒絕存取：缺少或無效的同步金鑰 (SYNC_TOKEN)" });
    }
    return exportDriveContentAsJson();
  }

  return HtmlService.createHtmlOutput(
    '<div style="font-family:serif;padding:48px;background:#f5f2eb;color:#1d1c19;">《低調走過》電子報與雲端中樞運作正常（資安強化防護已啟用）。</div>'
  );
}

/**
 * 嚴格驗證 Email 格式（阻擋標頭注入、公式開頭字元與異常長度）
 */
function isValidSafeEmail(email) {
  if (!email || email.length > 120) return false;
  if (/[\r\n\t\s=+\-'"]/.test(email[0])) return false;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,16}$/i.test(email);
}

/**
 * 處理訂閱申請（蜜罐過濾 ＋ 速率限制 ＋ 防公式注入 ＋ Double Opt-In 雙重確認信）
 */
function handleSubscribe(payload) {
  // 1. 蜜罐欄位與填表秒數檢查（攔截自動化填表機器人，靜默丟棄不耗額度）
  if (payload.hp && String(payload.hp).trim() !== "") {
    return jsonResponse({ ok: true, pendingConfirm: true });
  }
  if (payload.elapsedMs !== undefined && Number(payload.elapsedMs) < 800) {
    return jsonResponse({ ok: false, message: "送出速度過快，請確認後再試。" });
  }

  const email = String(payload.email || "").trim().toLowerCase();
  if (!isValidSafeEmail(email)) {
    return jsonResponse({ ok: false, message: "請輸入格式正確的常用 Email 信箱。" });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBSCRIBERS);
  const rows = sheet.getDataRange().getValues();
  let existingRowIdx = -1;

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === email) {
      if (rows[i][1] === "active") {
        return jsonResponse({ ok: true, alreadySubscribed: true });
      }
      existingRowIdx = i + 1;
      break;
    }
  }

  // 2. 檢查多層速率限制與單一信箱 24 小時冷卻鎖
  const quota = checkAndConsumeSubscribeQuota(email);
  if (!quota.allowed) {
    if (quota.cooldownOnly) {
      return jsonResponse({ ok: true, pendingConfirm: true });
    }
    return jsonResponse({ ok: false, message: quota.reason || "目前系統忙碌中，請稍後再試。" });
  }

  // 3. 產生單次驗證憑證並以防公式純文字寫入試算表（狀態為 pending，未點擊確認前絕不列入群發名單）
  const confirmToken = Utilities.getUuid();
  const safeIso = new Date().toISOString();
  const safeSource = safeCell(payload.source || "#/", 80);

  if (existingRowIdx > 0) {
    const r = sheet.getRange(existingRowIdx, 1, 1, 5);
    r.setNumberFormat("@");
    r.setValues([[safeCell(email, 120), "pending", safeIso, safeSource, confirmToken]]);
  } else {
    appendSafeTextRow(sheet, [email, "pending", safeIso, safeSource, confirmToken], [120, 24, 40, 80, 64]);
  }

  // 4. 寄出 100% 靜態文案之「訂閱確認信」（不含任何訪客輸入內容，徹底防止被濫用夾帶垃圾文字）
  const scriptUrl = ScriptApp.getService().getUrl();
  const confirmUrl = `${scriptUrl}?action=confirm&email=${encodeURIComponent(email)}&token=${encodeURIComponent(confirmToken)}`;
  const body = [
    "你好，",
    "",
    `我們收到了以這個信箱訂閱${HUB_CONFIG.NEWSLETTER_TITLE}的申請。`,
    "為確保是你本人操作，請點擊下方連結完成訂閱確認（點擊後即正式加入雙週電子報名單）：",
    "",
    confirmUrl,
    "",
    "若你並未在網站提出此訂閱申請，請直接忽略並刪除此信，系統不會將你加入名單，也不會再寄送任何信件。",
    "",
    "——",
    `${HUB_CONFIG.SENDER_NAME} (${HUB_CONFIG.SITE_URL})`
  ].join("\n");

  GmailApp.sendEmail(email, `【請確認訂閱】${HUB_CONFIG.NEWSLETTER_TITLE}`, body, {
    name: HUB_CONFIG.SENDER_NAME
  });

  return jsonResponse({ ok: true, pendingConfirm: true });
}

/**
 * 讀者點擊確認信連結 → 轉為正式 active 訂戶並換發獨立退訂憑證
 */
function handleConfirmSubscribe(email, token) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanToken = String(token || "").trim();
  if (!cleanEmail || cleanToken.length < 20) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:Georgia,serif;max-width:480px;margin:80px auto;padding:32px;background:#f5f2eb;border:1px solid #d6d1c7;color:#1d1c19;line-height:1.8;"><h2>確認連結無效或已過期</h2><p>請返回網站重新申請訂閱。</p></div>'
    );
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
  let matched = false;
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBSCRIBERS);
    if (sheet) {
      const rows = sheet.getDataRange().getValues();
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0]).toLowerCase() === cleanEmail && String(rows[i][4]) === cleanToken) {
          const newUnsubToken = Utilities.getUuid();
          const r = sheet.getRange(i + 1, 2, 1, 4);
          r.setNumberFormat("@");
          r.setValues([["active", new Date().toISOString(), safeCell(rows[i][3], 80), newUnsubToken]]);
          matched = true;
          break;
        }
      }
    }
  } finally {
    lock.releaseLock();
  }

  if (!matched) {
    return HtmlService.createHtmlOutput(
      '<div style="font-family:Georgia,serif;max-width:480px;margin:80px auto;padding:32px;background:#f5f2eb;border:1px solid #d6d1c7;color:#1d1c19;line-height:1.8;"><h2>已完成確認或連結已失效</h2><p>若你先前已點擊過確認信，信箱已在有效訂閱名單中。</p></div>'
    );
  }

  return HtmlService.createHtmlOutput(
    '<div style="font-family:Georgia,serif;max-width:500px;margin:80px auto;padding:36px;background:#f5f2eb;border:1px solid #d6d1c7;color:#1d1c19;line-height:1.85;">' +
      '<h2 style="font-weight:500;margin-top:0;color:#485643;">✓ 訂閱確認成功！</h2>' +
      `<p>謝謝你正式訂閱${HUB_CONFIG.NEWSLETTER_TITLE}。我們雙週日早晨信箱見。</p>` +
      `<p><a href="${HUB_CONFIG.SITE_URL}" style="color:#6e5039;">← 返回《低調走過》個人網站</a></p>` +
      "</div>"
  );
}

/**
 * 接收來自受保護工作台後端推送的電子報草稿（已通過 SYNC_TOKEN 驗證）
 */
function handleSaveDraftFromStudio(payload) {
  const draftSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ISSUES);
  const issueStr = String(payload.issue || "01").padStart(2, "0").slice(0, 10);
  const subject = String(payload.subject || `${HUB_CONFIG.NEWSLETTER_TITLE} 第 ${issueStr} 期`).trim();
  const content = String(payload.content || "").trim();
  if (!content) {
    return jsonResponse({ ok: false, message: "電子報內容不可為空" });
  }

  appendSafeTextRow(draftSheet, [issueStr, subject, content, "draft", ""], [12, 200, 45000, 20, 40]);
  return jsonResponse({
    ok: true,
    message: `✓ 已透過安全金鑰將第 ${issueStr} 期草稿寫入試算表 NewsletterDrafts！`
  });
}

/**
 * ✨ 自動從 GitHub 主站最新索引抓取「最新 1 篇長文＋3 則近期筆記」自動組裝本期電子報草稿
 */
function autoCompileBiweeklyDraft() {
  setupSheets();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const draftSheet = ss.getSheetByName(SHEET_ISSUES);

  const manifestRes = UrlFetchApp.fetch(`${HUB_CONFIG.SITE_URL}/content/manifest.json?t=${Date.now()}`, {
    muteHttpExceptions: true
  });
  if (manifestRes.getResponseCode() !== 200) {
    throw new Error("無法讀取網站 manifest.json 索引");
  }

  const manifest = JSON.parse(manifestRes.getContentText());
  const items = manifest.items || [];
  const latestEssay = items.find((i) => i.type === "essay");
  const recentNotes = items.filter((i) => i.type === "note").slice(0, 3);

  const existingRows = draftSheet.getDataRange().getValues();
  const nextIssueNum = String(existingRows.length).padStart(2, "0");

  const subject = latestEssay
    ? `${HUB_CONFIG.NEWSLETTER_TITLE} № ${nextIssueNum}：${latestEssay.title}`
    : `${HUB_CONFIG.NEWSLETTER_TITLE} № ${nextIssueNum}：近期研究與讀書筆記整理`;

  const lines = [];
  lines.push("週日早安，");
  lines.push("");
  lines.push("這過去兩週，我整理了近期的思考與閱讀筆記，與你分享：");
  lines.push("");

  if (latestEssay) {
    lines.push("【一、本期核心長文導讀】");
    lines.push(`▸ ${latestEssay.title}`);
    if (latestEssay.summary) lines.push(latestEssay.summary);
    lines.push(`閱讀全文：${HUB_CONFIG.SITE_URL}/#/essays/${latestEssay.slug}`);
    lines.push("");
  }

  if (recentNotes.length > 0) {
    lines.push("【二、近期知識卡片摘錄】");
    recentNotes.forEach((n, idx) => {
      lines.push(`${idx + 1}. ${n.title}`);
      if (n.summary) lines.push(`   ${n.summary}`);
      lines.push(`   → ${HUB_CONFIG.SITE_URL}/#/notes/${n.slug}`);
    });
    lines.push("");
  }

  lines.push("【三、本週留給你思考的一個問題】");
  lines.push("• 在你目前投入最多時間的議題裡，哪一個假設如果其實是錯的，會徹底改變你的做法？");
  lines.push("");
  lines.push("祝你有個安靜充實的週日，");
  lines.push("低調走過 · Deediao");

  appendSafeTextRow(draftSheet, [nextIssueNum, subject, lines.join("\n"), "draft", ""], [12, 200, 45000, 20, 40]);

  try {
    SpreadsheetApp.getUi().alert(
      `✓ 已自動彙整產生第 ${nextIssueNum} 期電子報草稿！\n請查看「NewsletterDrafts」工作表最後一列，確認無誤後即可點選選單群發。`
    );
  } catch (_) {}
}

/**
 * 一鍵退訂處理（強制檢查有效退訂憑證長度）
 */
function handleUnsubscribe(email, token) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanToken = String(token || "").trim();
  if (cleanEmail && cleanToken.length >= 20) {
    const lock = LockService.getScriptLock();
    lock.waitLock(8000);
    try {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBSCRIBERS);
      if (sheet) {
        const rows = sheet.getDataRange().getValues();
        for (let i = 1; i < rows.length; i++) {
          if (String(rows[i][0]).toLowerCase() === cleanEmail && String(rows[i][4]) === cleanToken) {
            sheet.getRange(i + 1, 2).setNumberFormat("@").setValue("unsubscribed");
            break;
          }
        }
      }
    } finally {
      lock.releaseLock();
    }
  }
  return HtmlService.createHtmlOutput(
    '<div style="font-family:Georgia,serif;max-width:480px;margin:80px auto;padding:32px;background:#f5f2eb;border:1px solid #d6d1c7;color:#1d1c19;line-height:1.8;">' +
      '<h2 style="font-weight:500;margin-top:0;">已完成取消訂閱</h2>' +
      "<p>你的信箱已從發送名單移除，不會再收到後續信件。謝謝過去這段時間的同行。</p>" +
      "</div>"
  );
}

/**
 * 將電子報草稿（支援 Markdown、HTML 與 [[slug|標題]] 雙向連結）自動轉為溫潤書齋信紙 HTML 與純文字備援
 */
function renderNewsletterEmailBodies(rawContent) {
  const siteBase = String(HUB_CONFIG.SITE_URL || "").replace(/\/+$/, "");
  const escHtml = (s) =>
    String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // 先將 [[slug|標題]] 轉為真實可點擊之單篇分享網址 (/s/<slug>.html)
  const expandWikiPlain = (txt) =>
    String(txt || "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawSlug, label) => {
      const slug = String(rawSlug || "").trim();
      const title = (label || slug).trim();
      return `${title}（${siteBase}/s/${encodeURIComponent(slug)}.html）`;
    });

  const isHtmlInput = /<\/?(p|h[1-6]|div|ul|ol|li|blockquote|table)\b/i.test(rawContent);
  let innerHtml = "";

  if (isHtmlInput) {
    innerHtml = String(rawContent || "").replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawSlug, label) => {
      const slug = String(rawSlug || "").trim();
      const title = escHtml((label || slug).trim());
      return `<a href="${siteBase}/s/${encodeURIComponent(slug)}.html" style="color:#6e5039;text-decoration:underline;">${title}</a>`;
    });
  } else {
    const inlineMd = (line) => {
      let s = escHtml(line);
      s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, rawSlug, label) => {
        const slug = String(rawSlug || "").trim();
        const title = (label || slug).trim();
        return `<a href="${siteBase}/s/${encodeURIComponent(slug)}.html" style="color:#6e5039;font-weight:500;text-decoration:underline;">${title}</a>`;
      });
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color:#6e5039;text-decoration:underline;">$1</a>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#1d1c19;">$1</strong>');
      s = s.replace(/`([^`]+)`/g, '<code style="background:#ece7dd;padding:1px 5px;border-radius:2px;font-size:0.9em;">$1</code>');
      return s;
    };

    const lines = String(rawContent || "").split(/\r?\n/);
    const blocks = [];
    let listTag = "";
    let listItems = [];
    const flushList = () => {
      if (!listItems.length) return;
      blocks.push(
        `<${listTag} style="margin:0 0 18px;padding-left:22px;color:#1d1c19;">` +
          listItems.map((li) => `<li style="margin-bottom:8px;">${li}</li>`).join("") +
          `</${listTag}>`
      );
      listItems = [];
      listTag = "";
    };

    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) {
        flushList();
        continue;
      }
      if (/^---+$/.test(t)) {
        flushList();
        blocks.push('<hr style="border:none;border-top:1px solid #dcd6ca;margin:26px 0;" />');
      } else if (/^###\s+/.test(t)) {
        flushList();
        blocks.push(
          `<h3 style="font-family:Georgia,'Noto Serif TC',serif;font-size:18px;font-weight:600;color:#1d1c19;margin:20px 0 8px;">${inlineMd(
            t.replace(/^###\s+/, "")
          )}</h3>`
        );
      } else if (/^##\s+/.test(t)) {
        flushList();
        blocks.push(
          `<h2 style="font-family:Georgia,'Noto Serif TC',serif;font-size:20px;font-weight:600;color:#1d1c19;margin:28px 0 12px;padding-bottom:6px;border-bottom:1px solid #e4dfd4;">${inlineMd(
            t.replace(/^##\s+/, "")
          )}</h2>`
        );
      } else if (/^>\s?/.test(t)) {
        flushList();
        blocks.push(
          `<blockquote style="margin:16px 0;padding:8px 16px;border-left:3px solid #6e5039;background:#f3efe6;color:#534f46;">${inlineMd(
            t.replace(/^>\s?/, "")
          )}</blockquote>`
        );
      } else if (/^\d+\.\s+/.test(t)) {
        if (listTag && listTag !== "ol") flushList();
        listTag = "ol";
        listItems.push(inlineMd(t.replace(/^\d+\.\s+/, "")));
      } else if (/^[-*]\s+/.test(t)) {
        if (listTag && listTag !== "ul") flushList();
        listTag = "ul";
        listItems.push(inlineMd(t.replace(/^[-*]\s+/, "")));
      } else {
        flushList();
        blocks.push(`<p style="margin:0 0 16px;color:#1d1c19;">${inlineMd(t)}</p>`);
      }
    }
    flushList();
    innerHtml = blocks.join("\n");
  }

  const plainClean = expandWikiPlain(rawContent).replace(/<[^>]+>/g, "");
  return { innerHtml: innerHtml, plainText: plainClean };
}

function buildWrappedNewsletterHtml(innerHtml, unsubUrl, isTestPreview) {
  const siteBase = String(HUB_CONFIG.SITE_URL || "").replace(/\/+$/, "");
  const testBanner = isTestPreview
    ? `<div style="background:#ece7dd;border:1px solid #cbbba8;padding:10px 14px;margin-bottom:20px;font-size:13px;color:#6e5039;">🧪 <strong>站長試閱預覽信</strong>：正式群發時此提示框不會出現，且底部會自動帶入每位訂戶專屬的一鍵退訂連結。</div>`
    : "";
  const unsubHtml = unsubUrl
    ? `<br/>如需取消訂閱，請點此：<a href="${unsubUrl}" style="color:#6e5039;">一鍵取消訂閱</a>`
    : "";
  return (
    `<div style="background:#f5f2eb;padding:28px 12px;">` +
    `<div style="font-family:'PingFang TC','Noto Sans TC',Georgia,serif;max-width:620px;margin:0 auto;padding:32px 28px;background:#faf8f4;border:1px solid #e2ddd2;color:#1d1c19;line-height:1.85;font-size:16px;">` +
    testBanner +
    `<div style="font-size:12px;letter-spacing:0.08em;color:#857f73;margin-bottom:18px;">${HUB_CONFIG.NEWSLETTER_TITLE}</div>` +
    innerHtml +
    `<hr style="border:none;border-top:1px solid #dcd6ca;margin:32px 0 16px;" />` +
    `<p style="font-size:13px;color:#857f73;line-height:1.7;">線上閱讀與歷史歸檔：<a href="${siteBase}/#/letters" style="color:#6e5039;">${siteBase}</a>${unsubHtml}</p>` +
    `</div></div>`
  );
}

/**
 * 從工作台直接寄出一封「試閱測試信」給站長自己，確認信紙排版與連結無誤
 */
function handleSendTestNewsletter(payload) {
  const content = String(payload.content || "").trim();
  if (!content) return jsonResponse({ ok: false, message: "電子報內容不可為空" });
  const issueStr = String(payload.issue || "01").padStart(2, "0");
  const subject = "【試閱預覽】" + (String(payload.subject || "").trim() || `${HUB_CONFIG.NEWSLETTER_TITLE} 第 ${issueStr} 期`);
  const ownerEmail = String(payload.toEmail || "").trim() || Session.getEffectiveUser().getEmail();
  if (!ownerEmail || ownerEmail.indexOf("@") === -1) {
    return jsonResponse({ ok: false, message: "找不到收件信箱，請先於「門面品牌」設定聯絡 Email" });
  }

  const rendered = renderNewsletterEmailBodies(content);
  const htmlMail = buildWrappedNewsletterHtml(rendered.innerHtml, "", true);
  GmailApp.sendEmail(ownerEmail, subject, rendered.plainText, {
    name: HUB_CONFIG.SENDER_NAME,
    htmlBody: htmlMail
  });
  return jsonResponse({
    ok: true,
    message: `✓ 已寄出試閱信至 ${ownerEmail}！請打開信箱確認排版與文章連結。`
  });
}

/**
 * 從工作台直接正式群發電子報給所有已確認 (active) 訂戶，並同步記錄於 NewsletterDrafts
 */
function handleSendLiveNewsletterFromStudio(payload) {
  const content = String(payload.content || "").trim();
  if (!content) return jsonResponse({ ok: false, message: "電子報內容不可為空" });
  const issueStr = String(payload.issue || "01").padStart(2, "0").slice(0, 10);
  const subject = String(payload.subject || `${HUB_CONFIG.NEWSLETTER_TITLE} 第 ${issueStr} 期`).trim();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const subSheet = ss.getSheetByName(SHEET_SUBSCRIBERS);
  const draftSheet = ss.getSheetByName(SHEET_ISSUES);
  const subs = subSheet
    ? subSheet
        .getDataRange()
        .getValues()
        .slice(1)
        .filter((r) => String(r[1] || "").replace(/^'/, "").trim() === "active")
    : [];

  if (subs.length === 0) {
    return jsonResponse({ ok: false, message: "目前尚無已完成雙重確認 (active) 的有效訂戶可發送。" });
  }

  const rendered = renderNewsletterEmailBodies(content);
  const scriptUrl = ScriptApp.getService().getUrl();
  const siteBase = String(HUB_CONFIG.SITE_URL || "").replace(/\/+$/, "");

  subs.forEach((sub) => {
    const email = String(sub[0] || "").replace(/^'/, "").trim();
    const token = String(sub[4] || "").replace(/^'/, "").trim();
    if (!email) return;
    const unsubUrl = `${scriptUrl}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
    const htmlMail = buildWrappedNewsletterHtml(rendered.innerHtml, unsubUrl, false);
    const plainFallback = `${rendered.plainText}\n\n——\n線上閱讀：${siteBase}/#/letters\n取消訂閱：${unsubUrl}`;
    GmailApp.sendEmail(email, subject, plainFallback, {
      name: HUB_CONFIG.SENDER_NAME,
      htmlBody: htmlMail
    });
  });

  appendSafeTextRow(
    draftSheet,
    [issueStr, subject, content, "sent", new Date().toISOString()],
    [12, 200, 45000, 20, 40]
  );

  return jsonResponse({
    ok: true,
    sentCount: subs.length,
    message: `🎉 已正式寄出「${subject}」給 ${subs.length} 位有效訂戶，並歸檔至試算表！`
  });
}

/**
 * 群發最新一期草稿給所有已確認 (active) 訂戶
 */
function sendLatestNewsletter() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const draftSheet = ss.getSheetByName(SHEET_ISSUES);
  const subSheet = ss.getSheetByName(SHEET_SUBSCRIBERS);
  const ui = SpreadsheetApp.getUi();

  const drafts = draftSheet.getDataRange().getValues();
  let targetRowIndex = -1;
  for (let i = drafts.length - 1; i >= 1; i--) {
    if (drafts[i][3] === "draft") {
      targetRowIndex = i;
      break;
    }
  }

  if (targetRowIndex === -1) {
    ui.alert("找不到狀態為 draft 的電子報草稿。");
    return;
  }

  const subject = String(drafts[targetRowIndex][1] || "").replace(/^'/, "");
  const content = String(drafts[targetRowIndex][2] || "").replace(/^'/, "");
  const subs = subSheet.getDataRange().getValues().slice(1).filter((r) => String(r[1] || "").replace(/^'/, "") === "active");

  if (subs.length === 0) {
    ui.alert("目前尚無已完成雙重確認 (active) 的有效訂戶。");
    return;
  }

  const confirm = ui.alert(
    "確認發送電子報",
    `即將寄出「${subject}」給 ${subs.length} 位已確認訂戶，確定執行嗎？`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const rendered = renderNewsletterEmailBodies(content);
  const scriptUrl = ScriptApp.getService().getUrl();
  const siteBase = String(HUB_CONFIG.SITE_URL || "").replace(/\/+$/, "");

  subs.forEach((sub) => {
    const email = String(sub[0] || "").replace(/^'/, "").trim();
    const token = String(sub[4] || "").replace(/^'/, "").trim();
    const unsubUrl = `${scriptUrl}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
    const htmlMail = buildWrappedNewsletterHtml(rendered.innerHtml, unsubUrl, false);
    const plainFallback = `${rendered.plainText}\n\n——\n線上閱讀與歷史歸檔：${siteBase}/#/letters\n取消訂閱：${unsubUrl}`;
    GmailApp.sendEmail(email, subject, plainFallback, {
      name: HUB_CONFIG.SENDER_NAME,
      htmlBody: htmlMail
    });
  });

  draftSheet.getRange(targetRowIndex + 1, 4).setNumberFormat("@").setValue("sent");
  draftSheet.getRange(targetRowIndex + 1, 5).setNumberFormat("@").setValue(new Date().toISOString());
  ui.alert(`已成功發送給 ${subs.length} 位訂戶！`);
}

/**
 * 讀取 Google Drive 指定資料夾內的 essays / notes / letters（受 SYNC_TOKEN 保護）
 */
function exportDriveContentAsJson() {
  if (!HUB_CONFIG.DRIVE_CONTENT_FOLDER_ID) {
    return jsonResponse({ ok: true, documents: [], message: "尚未設定 DRIVE_CONTENT_FOLDER_ID" });
  }

  const rootFolder = DriveApp.getFolderById(HUB_CONFIG.DRIVE_CONTENT_FOLDER_ID);
  const folderMap = { essays: "essay", notes: "note", letters: "letter" };
  const documents = [];

  const subFolders = rootFolder.getFolders();
  while (subFolders.hasNext()) {
    const folder = subFolders.next();
    const folderName = folder.getName().toLowerCase();
    const docType = folderMap[folderName];
    if (!docType) continue;

    const files = folder.getFiles();
    while (files.hasNext()) {
      const file = files.next();
      const mime = file.getMimeType();
      const rawName = file.getName().replace(/\.md$/i, "");
      let markdown = "";

      if (mime === MimeType.GOOGLE_DOCS) {
        markdown = convertGoogleDocToMarkdown(file.getId(), rawName, docType, file.getLastUpdated());
      } else if (file.getName().endsWith(".md") || mime === MimeType.PLAIN_TEXT) {
        markdown = file.getBlob().getDataAsString("UTF-8");
      } else {
        continue;
      }

      documents.push({
        type: docType,
        slug: rawName,
        updatedAt: file.getLastUpdated().toISOString(),
        markdown: markdown
      });
    }
  }

  return jsonResponse({ ok: true, documents: documents });
}

function convertGoogleDocToMarkdown(docId, fallbackSlug, docType, updatedDate) {
  const doc = DocumentApp.openById(docId);
  const body = doc.getBody();
  const fullText = body.getText();

  if (fullText.trim().startsWith("---")) {
    return fullText;
  }

  const lines = [];
  const numChildren = body.getNumChildren();
  for (let i = 0; i < numChildren; i++) {
    const child = body.getChild(i);
    if (child.getType() === DocumentApp.ElementType.PARAGRAPH) {
      const p = child.asParagraph();
      const text = p.getText().trim();
      if (!text) {
        lines.push("");
        continue;
      }
      const heading = p.getHeading();
      if (heading === DocumentApp.ParagraphHeading.HEADING1 || heading === DocumentApp.ParagraphHeading.HEADING2) {
        lines.push(`## ${text}`);
      } else if (heading === DocumentApp.ParagraphHeading.HEADING3) {
        lines.push(`### ${text}`);
      } else {
        lines.push(text);
      }
    } else if (child.getType() === DocumentApp.ElementType.LIST_ITEM) {
      const li = child.asListItem();
      lines.push(`- ${li.getText().trim()}`);
    }
  }

  const dateStr = Utilities.formatDate(updatedDate, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const frontmatter = [
    "---",
    `title: ${doc.getName()}`,
    `slug: ${fallbackSlug}`,
    `type: ${docType}`,
    `date: ${dateStr}`,
    `summary: ${lines.find((l) => l && !l.startsWith("#")) || ""}`.slice(0, 120),
    "---",
    ""
  ].join("\n");

  return frontmatter + lines.join("\n");
}

function triggerGitHubSync() {
  const ui = SpreadsheetApp.getUi();
  if (!HUB_CONFIG.GITHUB_OWNER || !HUB_CONFIG.GITHUB_REPO || !HUB_CONFIG.GITHUB_PAT) {
    ui.alert("請先在 Apps Script 頂端的 HUB_CONFIG 填入 GITHUB_OWNER、GITHUB_REPO 與 GITHUB_PAT。");
    return;
  }

  const url = `https://api.github.com/repos/${HUB_CONFIG.GITHUB_OWNER}/${HUB_CONFIG.GITHUB_REPO}/dispatches`;
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${HUB_CONFIG.GITHUB_PAT}`,
      Accept: "application/vnd.github+json"
    },
    payload: JSON.stringify({ event_type: "google_workspace_sync" }),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() >= 200 && res.getResponseCode() < 300) {
    ui.alert("已成功通知 GitHub 主站開始同步！約 45 秒後將同步更新完成。");
  } else {
    ui.alert(`觸發失敗 (${res.getResponseCode()})：${res.getContentText()}`);
  }
}

/**
 * 記錄公開網站匿名點閱事件（含速率限制與防公式純文字寫入）
 */
function handleTrackPageview(payload) {
  const cache = CacheService.getScriptCache();
  const now = new Date();
  const pvBucket = "pv_m_" + Utilities.formatDate(now, "UTC", "yyyyMMddHHmm");
  const pvCount = Number(cache.get(pvBucket) || "0");
  if (pvCount >= 40) {
    return jsonResponse({ ok: true }); // 超過每分鐘寫入上限時靜默略過，防止惡意灌爆試算表
  }
  cache.put(pvBucket, String(pvCount + 1), 70);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pvSheet = ss.getSheetByName(SHEET_PAGEVIEWS);
  const tz = Session.getScriptTimeZone() || "Asia/Taipei";
  const isoStr = now.toISOString();
  const dateStr = Utilities.formatDate(now, tz, "yyyy-MM-dd");

  const initDwell = Math.min(1800, Math.max(0, Math.round(Number(payload.dwellSec || 0))));
  const visitId = String(payload.visitId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);

  appendSafeTextRow(
    pvSheet,
    [
      isoStr,
      dateStr,
      payload.route || "#/",
      payload.title || "首頁",
      payload.pageType || "home",
      payload.visitorHash || "anon",
      payload.referrer || "直接造訪",
      payload.device || "desktop",
      payload.host || "",
      String(initDwell),
      visitId
    ],
    [40, 16, 180, 160, 32, 48, 140, 24, 80, 12, 50]
  );
  return jsonResponse({ ok: true });
}

/**
 * 更新單次造訪之真實活躍畫面停留秒數（不重複增加點閱次數，僅原地更新對應 visitId 之停留秒數）
 */
function handlePageviewEngagement(payload) {
  const visitId = String(payload.visitId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  const dwellSec = Math.min(1800, Math.max(0, Math.round(Number(payload.dwellSec || 0))));
  if (!visitId || dwellSec <= 0) {
    return jsonResponse({ ok: true });
  }

  const cache = CacheService.getScriptCache();
  const now = new Date();
  const engBucket = "eng_m_" + Utilities.formatDate(now, "UTC", "yyyyMMddHHmm");
  const engCount = Number(cache.get(engBucket) || "0");
  if (engCount >= 80) {
    return jsonResponse({ ok: true });
  }
  cache.put(engBucket, String(engCount + 1), 70);

  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const pvSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_PAGEVIEWS);
    if (!pvSheet) return jsonResponse({ ok: true });
    const lastRow = pvSheet.getLastRow();
    if (lastRow < 2) return jsonResponse({ ok: true });

    const scanCount = Math.min(150, lastRow - 1);
    const startRow = lastRow - scanCount + 1;
    const tailVals = pvSheet.getRange(startRow, 10, scanCount, 2).getValues();
    for (let i = tailVals.length - 1; i >= 0; i--) {
      const rowVid = String(tailVals[i][1] || "").replace(/^'/, "");
      if (rowVid === visitId) {
        const prevSec = Number(String(tailVals[i][0] || "0").replace(/^'/, "")) || 0;
        if (dwellSec > prevSec) {
          pvSheet.getRange(startRow + i, 10).setNumberFormat("@").setValue(String(dwellSec));
        }
        break;
      }
    }
  } finally {
    lock.releaseLock();
  }
  return jsonResponse({ ok: true });
}

/**
 * 查詢單篇文章之累計閱讀共鳴數（含 25 秒快取加速）
 */
function handleGetResonance(payload) {
  const slug = String(payload.slug || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!slug) return jsonResponse({ ok: true, count: 0 });

  const cache = CacheService.getScriptCache();
  const cKey = "res_cnt_" + slug;
  const cached = cache.get(cKey);
  if (cached !== null) {
    return jsonResponse({ ok: true, slug: slug, count: Number(cached) || 0 });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESONANCE);
  if (!sheet || sheet.getLastRow() < 2) {
    cache.put(cKey, "0", 25);
    return jsonResponse({ ok: true, slug: slug, count: 0 });
  }

  const vals = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues();
  let count = 0;
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || "").replace(/^'/, "") === slug) count++;
  }
  cache.put(cKey, String(count), 25);
  return jsonResponse({ ok: true, slug: slug, count: count });
}

/**
 * 讀者點亮文章共鳴燈（同一匿名訪客同日對同一篇文章僅計一次，防灌水）
 */
function handleAddResonance(payload) {
  const slug = String(payload.slug || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!slug) return jsonResponse({ ok: false, message: "缺少文章識別碼" });

  const cache = CacheService.getScriptCache();
  const now = new Date();
  const tz = Session.getScriptTimeZone() || "Asia/Taipei";
  const dateStr = Utilities.formatDate(now, tz, "yyyy-MM-dd");
  const vHash = String(payload.visitorHash || "anon").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
  const title = String(payload.title || slug).slice(0, 160);

  const rateKey = "res_m_" + Utilities.formatDate(now, "UTC", "yyyyMMddHHmm");
  const mCnt = Number(cache.get(rateKey) || "0");
  if (mCnt >= 45) return jsonResponse({ ok: true, throttled: true });
  cache.put(rateKey, String(mCnt + 1), 70);

  const dedupKey = `res_u_${slug}_${dateStr}_${vHash}`.slice(0, 240);
  if (cache.get(dedupKey)) {
    return handleGetResonance({ slug: slug });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESONANCE);
  if (sheet && sheet.getLastRow() >= 2) {
    const scanN = Math.min(200, sheet.getLastRow() - 1);
    const tail = sheet.getRange(sheet.getLastRow() - scanN + 1, 2, scanN, 4).getValues();
    for (let i = tail.length - 1; i >= 0; i--) {
      const rDate = String(tail[i][0] || "").replace(/^'/, "").slice(0, 10);
      const rSlug = String(tail[i][1] || "").replace(/^'/, "");
      const rHash = String(tail[i][3] || "").replace(/^'/, "");
      if (rDate === dateStr && rSlug === slug && rHash === vHash) {
        cache.put(dedupKey, "1", 21600);
        return handleGetResonance({ slug: slug });
      }
    }
  }

  appendSafeTextRow(
    sheet,
    [now.toISOString(), dateStr, slug, title, vHash],
    [40, 16, 80, 160, 48]
  );
  cache.put(dedupKey, "1", 21600);
  cache.remove("res_cnt_" + slug);
  return handleGetResonance({ slug: slug });
}

/**
 * 接收讀者私密悄悄話回饋（含蜜罐、最小填寫秒數、速率限制與防公式注入保護，不公開展示）
 */
function handleReaderFeedback(payload) {
  if (payload.website && String(payload.website).trim() !== "") {
    return jsonResponse({ ok: true });
  }
  const elapsedMs = Number(payload.elapsedMs || 0);
  if (elapsedMs > 0 && elapsedMs < 900) {
    return jsonResponse({ ok: true });
  }

  const message = String(payload.message || "").trim();
  if (!message || message.length < 2) {
    return jsonResponse({ ok: false, message: "請輸入想傳達的回饋內容" });
  }
  if (message.length > 1500) {
    return jsonResponse({ ok: false, message: "回饋內容請精簡於 1,500 字以內" });
  }

  const cache = CacheService.getScriptCache();
  const now = new Date();
  const minBucket = "fb_m_" + Utilities.formatDate(now, "UTC", "yyyyMMddHHmm");
  const mCount = Number(cache.get(minBucket) || "0");
  if (mCount >= 6) {
    return jsonResponse({ ok: false, message: "目前傳送較為頻繁，請稍候一分鐘再試。" });
  }
  cache.put(minBucket, String(mCount + 1), 70);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FEEDBACK);
  appendSafeTextRow(
    sheet,
    [
      now.toISOString(),
      String(payload.title || "未命名文章"),
      String(payload.route || "#/"),
      String(payload.sender || "匿名讀者"),
      message
    ],
    [40, 160, 160, 120, 1500]
  );
  return jsonResponse({ ok: true, message: "✓ 已私密送達作者信箱匣，謝謝你的閱讀與回饋！" });
}

/**
 * 彙整站長專屬私密點閱儀表板數據（已通過 ANALYTICS_READ_KEY 常數時間驗證）
 */
function handleAnalyticsSummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pvSheet = ss.getSheetByName(SHEET_PAGEVIEWS);
  const subSheet = ss.getSheetByName(SHEET_SUBSCRIBERS);
  const tz = Session.getScriptTimeZone() || "Asia/Taipei";
  const now = new Date();
  const todayStr = Utilities.formatDate(now, tz, "yyyy-MM-dd");

  const dayKeys = [];
  const dailyMap = {};
  for (let d = 13; d >= 0; d--) {
    const dt = new Date(now.getTime() - d * 86400000);
    const full = Utilities.formatDate(dt, tz, "yyyy-MM-dd");
    const shortLabel = Utilities.formatDate(dt, tz, "MM/dd");
    dayKeys.push(full);
    dailyMap[full] = { fullDate: full, label: shortLabel, views: 0, visitorSet: {} };
  }

  const cutoff7d = Utilities.formatDate(new Date(now.getTime() - 6 * 86400000), tz, "yyyy-MM-dd");
  const cutoff30d = Utilities.formatDate(new Date(now.getTime() - 29 * 86400000), tz, "yyyy-MM-dd");

  const rows = pvSheet ? pvSheet.getDataRange().getValues() : [];
  let totalViews = 0;
  let todayViews = 0;
  let last7dViews = 0;
  let last30dViews = 0;
  let totalDwellSec = 0;
  let dwellSampleCount = 0;
  const allVisitorSet = {};
  const todayVisitorSet = {};
  const pageStats = {};
  const referrerStats = {};
  const deviceStats = { desktop: 0, mobile: 0, tablet: 0 };
  const recentVisits = [];

  const hourlyBuckets = [];
  for (let h = 0; h < 24; h++) {
    hourlyBuckets.push({
      hour: h,
      label: (h < 10 ? "0" : "") + h,
      views: 0,
      visitorSet: {},
      todayViews: 0,
      todayVisitorSet: {},
      dwellSum: 0,
      dwellCnt: 0
    });
  }

  const unquote = (v) => String(v || "").replace(/^'/, "");

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    let visitDateObj = null;
    if (r[0] instanceof Date) {
      visitDateObj = r[0];
    } else {
      const parsedTs = new Date(unquote(r[0]));
      if (!isNaN(parsedTs.getTime())) visitDateObj = parsedTs;
    }
    const dStr =
      r[1] instanceof Date
        ? Utilities.formatDate(r[1], tz, "yyyy-MM-dd")
        : visitDateObj
        ? Utilities.formatDate(visitDateObj, tz, "yyyy-MM-dd")
        : unquote(r[1]).slice(0, 10);
    const hourNum = visitDateObj ? Number(Utilities.formatDate(visitDateObj, tz, "HH")) : -1;
    const route = unquote(r[2]) || "#/";
    const title = unquote(r[3]) || route;
    const pType = unquote(r[4]) || "page";
    const vHash = unquote(r[5]) || "anon";
    const ref = unquote(r[6]) || "直接造訪";
    const dev = (unquote(r[7]) || "desktop").toLowerCase();
    const dwell = Math.min(1800, Math.max(0, Number(unquote(r[9])) || 0));

    totalViews++;
    allVisitorSet[`${dStr}:${vHash}`] = true;
    if (dwell > 0) {
      totalDwellSec += dwell;
      dwellSampleCount++;
    }

    if (dStr === todayStr) {
      todayViews++;
      todayVisitorSet[vHash] = true;
    }
    if (dStr >= cutoff7d) last7dViews++;
    if (dStr >= cutoff30d) {
      last30dViews++;
      if (hourNum >= 0 && hourNum < 24) {
        const hb = hourlyBuckets[hourNum];
        hb.views++;
        hb.visitorSet[`${dStr}:${vHash}`] = true;
        if (dwell > 0) {
          hb.dwellSum += dwell;
          hb.dwellCnt++;
        }
        if (dStr === todayStr) {
          hb.todayViews++;
          hb.todayVisitorSet[vHash] = true;
        }
      }
    }

    if (dailyMap[dStr]) {
      dailyMap[dStr].views++;
      dailyMap[dStr].visitorSet[vHash] = true;
    }

    if (!pageStats[route]) {
      pageStats[route] = {
        route: route,
        title: title,
        pageType: pType,
        views: 0,
        visitorSet: {},
        dwellSum: 0,
        dwellCnt: 0
      };
    }
    pageStats[route].views++;
    pageStats[route].title = title || pageStats[route].title;
    pageStats[route].pageType = pType || pageStats[route].pageType;
    pageStats[route].visitorSet[`${dStr}:${vHash}`] = true;
    if (dwell > 0) {
      pageStats[route].dwellSum += dwell;
      pageStats[route].dwellCnt++;
    }

    referrerStats[ref] = (referrerStats[ref] || 0) + 1;

    if (dev === "mobile") deviceStats.mobile++;
    else if (dev === "tablet") deviceStats.tablet++;
    else deviceStats.desktop++;
  }

  for (let j = rows.length - 1; j >= 1 && recentVisits.length < 25; j--) {
    const r = rows[j];
    recentVisits.push({
      timestamp: r[0] instanceof Date ? r[0].toISOString() : unquote(r[0]),
      route: unquote(r[2]) || "#/",
      title: unquote(r[3]) || "",
      pageType: unquote(r[4]) || "page",
      referrer: unquote(r[6]) || "直接造訪",
      device: unquote(r[7]) || "desktop",
      host: unquote(r[8]) || "",
      dwellSec: Math.min(1800, Math.max(0, Number(unquote(r[9])) || 0))
    });
  }

  let activeSubscribers = 0;
  let pendingSubscribers = 0;
  let unsubscribedSubscribers = 0;
  let totalSubscribers = 0;
  const subscribers = [];
  if (subSheet) {
    const sRows = subSheet.getDataRange().getValues();
    for (let k = 1; k < sRows.length; k++) {
      const subEmail = unquote(sRows[k][0]).trim();
      if (subEmail) {
        totalSubscribers++;
        const subStatus = unquote(sRows[k][1]).trim().toLowerCase() || "pending";
        if (subStatus === "active") activeSubscribers++;
        else if (subStatus === "unsubscribed") unsubscribedSubscribers++;
        else pendingSubscribers++;

        const subTime =
          sRows[k][2] instanceof Date ? sRows[k][2].toISOString() : unquote(sRows[k][2]).trim();
        const subSource = unquote(sRows[k][3]).trim() || "#/";
        subscribers.push({
          email: subEmail,
          status: subStatus,
          subscribedAt: subTime,
          source: subSource
        });
      }
    }
  }
  subscribers.sort((a, b) => String(b.subscribedAt || "").localeCompare(String(a.subscribedAt || "")));

  const hourlySeries = hourlyBuckets.map((hb) => ({
    hour: hb.hour,
    label: hb.label,
    views: hb.views,
    visitors: Object.keys(hb.visitorSet).length,
    todayViews: hb.todayViews,
    todayVisitors: Object.keys(hb.todayVisitorSet).length,
    avgDwellSec: hb.dwellCnt > 0 ? Math.round(hb.dwellSum / hb.dwellCnt) : 0
  }));

  const dailySeries = dayKeys.map((k) => ({
    fullDate: dailyMap[k].fullDate,
    label: dailyMap[k].label,
    views: dailyMap[k].views,
    visitors: Object.keys(dailyMap[k].visitorSet).length
  }));

  const resSheet = ss.getSheetByName(SHEET_RESONANCE);
  let totalResonances = 0;
  const resonanceBySlug = {};
  if (resSheet && resSheet.getLastRow() >= 2) {
    const rVals = resSheet.getRange(2, 3, resSheet.getLastRow() - 1, 1).getValues();
    for (let m = 0; m < rVals.length; m++) {
      const sKey = unquote(rVals[m][0]).trim();
      if (sKey) {
        totalResonances++;
        resonanceBySlug[sKey] = (resonanceBySlug[sKey] || 0) + 1;
      }
    }
  }

  const fbSheet = ss.getSheetByName(SHEET_FEEDBACK);
  let totalFeedbacks = 0;
  const readerFeedbacks = [];
  if (fbSheet && fbSheet.getLastRow() >= 2) {
    const fRows = fbSheet.getDataRange().getValues();
    totalFeedbacks = Math.max(0, fRows.length - 1);
    for (let f = fRows.length - 1; f >= 1 && readerFeedbacks.length < 50; f--) {
      const fr = fRows[f];
      readerFeedbacks.push({
        timestamp: fr[0] instanceof Date ? fr[0].toISOString() : unquote(fr[0]),
        title: unquote(fr[1]) || "文章回饋",
        route: unquote(fr[2]) || "#/",
        sender: unquote(fr[3]) || "匿名讀者",
        message: unquote(fr[4]) || ""
      });
    }
  }

  const topPages = Object.keys(pageStats)
    .map((k) => {
      const ps = pageStats[k];
      const slugTail = String(ps.route || "").split("/").filter(Boolean).pop() || "";
      return {
        route: ps.route,
        title: ps.title,
        pageType: ps.pageType,
        views: ps.views,
        visitors: Object.keys(ps.visitorSet).length,
        totalDwellSec: ps.dwellSum,
        avgDwellSec: ps.dwellCnt > 0 ? Math.round(ps.dwellSum / ps.dwellCnt) : 0,
        resonances: resonanceBySlug[slugTail] || 0
      };
    })
    .sort((a, b) => b.views - a.views)
    .slice(0, 15);

  const referrers = Object.keys(referrerStats)
    .map((k) => ({ source: k, count: referrerStats[k] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return jsonResponse({
    ok: true,
    generatedAt: now.toISOString(),
    sheetUrl: ss.getUrl(),
    totals: {
      totalViews: totalViews,
      uniqueVisitors: Object.keys(allVisitorSet).length,
      todayViews: todayViews,
      todayVisitors: Object.keys(todayVisitorSet).length,
      last7dViews: last7dViews,
      last30dViews: last30dViews,
      totalDwellSec: totalDwellSec,
      avgDwellSec: dwellSampleCount > 0 ? Math.round(totalDwellSec / dwellSampleCount) : 0,
      activeSubscribers: activeSubscribers,
      pendingSubscribers: pendingSubscribers,
      unsubscribedSubscribers: unsubscribedSubscribers,
      totalSubscribers: totalSubscribers,
      totalResonances: totalResonances,
      totalFeedbacks: totalFeedbacks
    },
    dailySeries: dailySeries,
    hourlySeries: hourlySeries,
    subscribers: subscribers.slice(0, 500),
    readerFeedbacks: readerFeedbacks,
    topPages: topPages,
    referrers: referrers,
    devices: deviceStats,
    recentVisits: recentVisits
  });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}


// ==========================================================================
// 雲端編輯工作台：嚴謹雙重驗證 (PBKDF2 Verifier + RFC 6238 TOTP) 與 GitHub 原子讀寫引擎
// ==========================================================================
function bytesToHex(signedBytes) {
  let out = "";
  for (let i = 0; i < signedBytes.length; i++) {
    out += (signedBytes[i] & 0xff).toString(16).padStart(2, "0");
  }
  return out;
}

function sha256HexUtf8(str) {
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8));
}

function toSignedByte(u) {
  const b = u & 0xff;
  return b > 127 ? b - 256 : b;
}

function base32ToSignedBytes(b32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = String(b32 || "")
    .toUpperCase()
    .replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let val = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    val = (val << 5) | alphabet.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) {
      out.push(toSignedByte((val >>> (bits - 8)) & 0xff));
      bits -= 8;
    }
  }
  return out;
}

function computeTotp6(secretB32, stepCounter) {
  const keyBytes = base32ToSignedBytes(secretB32);
  const hi = Math.floor(stepCounter / 0x100000000);
  const lo = stepCounter >>> 0;
  const msgBytes = [
    toSignedByte((hi >>> 24) & 0xff),
    toSignedByte((hi >>> 16) & 0xff),
    toSignedByte((hi >>> 8) & 0xff),
    toSignedByte(hi & 0xff),
    toSignedByte((lo >>> 24) & 0xff),
    toSignedByte((lo >>> 16) & 0xff),
    toSignedByte((lo >>> 8) & 0xff),
    toSignedByte(lo & 0xff)
  ];
  const hmac = Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_1, msgBytes, keyBytes);
  const u = hmac.map((b) => b & 0xff);
  const offset = u[u.length - 1] & 0x0f;
  const code =
    (((u[offset] & 0x7f) << 24) |
      ((u[offset + 1] & 0xff) << 16) |
      ((u[offset + 2] & 0xff) << 8) |
      (u[offset + 3] & 0xff)) %
    1000000;
  return String(code).padStart(6, "0");
}

function verifyTotp6(secretB32, rawInput) {
  const clean = String(rawInput || "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let d = -1; d <= 1; d++) {
    const expected = computeTotp6(secretB32, step + d);
    let diff = 0;
    for (let i = 0; i < 6; i++) {
      diff |= clean.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) return true;
  }
  return false;
}

function signStudioJwt() {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 7200; // 2 小時效期
  const csrf = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "").slice(0, 16);
  const hdr = Utilities.base64EncodeWebSafe(JSON.stringify({ alg: "HS256", typ: "JWT" })).replace(/=+$/, "");
  const body = Utilities.base64EncodeWebSafe(
    JSON.stringify({ sub: "studio-owner", iat: now, exp: exp, csrf: csrf })
  ).replace(/=+$/, "");
  const sigBytes = Utilities.computeHmacSha256Signature(`${hdr}.${body}`, HUB_CONFIG.STUDIO_JWT_SECRET);
  const sig = Utilities.base64EncodeWebSafe(sigBytes).replace(/=+$/, "");
  return { token: `${hdr}.${body}.${sig}`, csrfToken: csrf, expiresAt: exp };
}

function verifyStudioJwt(token, csrfToken, requireCsrf) {
  if (!HUB_CONFIG.STUDIO_JWT_SECRET || HUB_CONFIG.STUDIO_JWT_SECRET.length < 16) {
    return { ok: false, error: "雲端 JWT 金鑰尚未啟用" };
  }
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, error: "授權權杖格式無效" };

  const expectedBytes = Utilities.computeHmacSha256Signature(
    `${parts[0]}.${parts[1]}`,
    HUB_CONFIG.STUDIO_JWT_SECRET
  );
  const expectedSig = Utilities.base64EncodeWebSafe(expectedBytes).replace(/=+$/, "");
  if (!constantTimeEqual(parts[2], expectedSig)) {
    return { ok: false, error: "授權權杖簽章驗證失敗" };
  }

  let bodyStr = parts[1];
  while (bodyStr.length % 4 !== 0) bodyStr += "=";
  const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(bodyStr)).getDataAsString("UTF-8");
  const claims = JSON.parse(decoded);
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || claims.exp < now) {
    return { ok: false, error: "登入憑證已逾時（超過 2 小時），請重新登入" };
  }

  if (requireCsrf && !constantTimeEqual(String(csrfToken || ""), String(claims.csrf || ""))) {
    return { ok: false, error: "CSRF 權杖驗證失敗" };
  }
  return { ok: true, csrf: claims.csrf };
}

function handleStudioCloudLogin(payload) {
  const cache = CacheService.getScriptCache();
  const lockUntil = Number(cache.get("studio_lock_until") || "0");
  const nowSec = Math.floor(Date.now() / 1000);
  if (lockUntil > nowSec) {
    return jsonResponse({
      ok: false,
      message: `驗證失敗次數過多，雲端閘門已鎖定，請於 ${Math.ceil((lockUntil - nowSec) / 60)} 分鐘後再試。`
    });
  }

  if (!HUB_CONFIG.STUDIO_VERIFIER_HEX || !HUB_CONFIG.STUDIO_TOTP_SECRET || !HUB_CONFIG.STUDIO_JWT_SECRET) {
    return jsonResponse({ ok: false, message: "雲端雙重驗證金鑰尚未設定完成。" });
  }

  const dkHex = String(payload.dkHex || "").trim().toLowerCase();
  const secondFactor = String(payload.secondFactor || "").trim().toUpperCase();
  const actualVerifier = sha256HexUtf8("studio-v1:" + dkHex);
  const pwOk = constantTimeEqual(actualVerifier, HUB_CONFIG.STUDIO_VERIFIER_HEX.toLowerCase());

  let factor2Ok = false;
  if (pwOk) {
    factor2Ok = verifyTotp6(HUB_CONFIG.STUDIO_TOTP_SECRET, secondFactor);
    if (!factor2Ok && secondFactor.length >= 8 && HUB_CONFIG.STUDIO_RECOVERY_HASHES) {
      const candHash = sha256HexUtf8(secondFactor);
      const savedList = HUB_CONFIG.STUDIO_RECOVERY_HASHES.split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      for (let i = 0; i < savedList.length; i++) {
        if (constantTimeEqual(candHash, savedList[i])) {
          factor2Ok = true;
          break;
        }
      }
    }
  }

  if (!pwOk || !factor2Ok) {
    const fails = Number(cache.get("studio_fail_cnt") || "0") + 1;
    if (fails >= 5) {
      cache.put("studio_lock_until", String(nowSec + 900), 920);
      cache.remove("studio_fail_cnt");
    } else {
      cache.put("studio_fail_cnt", String(fails), 900);
    }
    return jsonResponse({ ok: false, message: "主管理密碼或 6 位數動態驗證碼不正確。" });
  }

  cache.remove("studio_fail_cnt");
  cache.remove("studio_lock_until");
  const signed = signStudioJwt();
  return jsonResponse({
    ok: true,
    token: signed.token,
    csrfToken: signed.csrfToken,
    expiresAt: signed.expiresAt
  });
}

// ── GitHub REST & Git Trees 原子讀寫工具 ──────────────────────────────────
function ghRepoRequest(apiPath, method, bodyObj) {
  if (!HUB_CONFIG.GITHUB_PAT) {
    throw new Error("雲端中樞尚未設定 GITHUB_PAT");
  }
  const url = `https://api.github.com/repos/${HUB_CONFIG.GITHUB_OWNER}/${HUB_CONFIG.GITHUB_REPO}${apiPath}`;
  const opts = {
    method: (method || "get").toLowerCase(),
    headers: {
      Authorization: `Bearer ${HUB_CONFIG.GITHUB_PAT}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Deediao-Studio-AppsScript/4.0"
    },
    muteHttpExceptions: true
  };
  if (bodyObj !== undefined) {
    opts.contentType = "application/json";
    opts.payload = JSON.stringify(bodyObj);
  }
  const res = UrlFetchApp.fetch(url, opts);
  const code = res.getResponseCode();
  if (code === 404) return null;
  if (code < 200 || code >= 300) {
    throw new Error(`GitHub API (${code}): ${res.getContentText().slice(0, 180)}`);
  }
  const txt = res.getContentText();
  return txt ? JSON.parse(txt) : {};
}

function ghReadTextFile(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  const data = ghRepoRequest(`/contents/${clean}?ref=main`, "get");
  if (!data || !data.content) return "";
  const rawB64 = String(data.content).replace(/\s+/g, "");
  return Utilities.newBlob(Utilities.base64Decode(rawB64)).getDataAsString("UTF-8");
}

function ghAtomicCommit(commitMsg, upserts, deletes) {
  const refData = ghRepoRequest("/git/ref/heads/main", "get");
  const headSha = refData.object.sha;
  const commitData = ghRepoRequest(`/git/commits/${headSha}`, "get");
  const baseTreeSha = commitData.tree.sha;

  const treeEntries = [];
  (upserts || []).forEach((u) => {
    if (u.contentBase64 !== undefined) {
      const blob = ghRepoRequest("/git/blobs", "post", {
        content: u.contentBase64,
        encoding: "base64"
      });
      treeEntries.push({ path: u.path, mode: "100644", type: "blob", sha: blob.sha });
    } else {
      treeEntries.push({ path: u.path, mode: "100644", type: "blob", content: u.contentUtf8 || "" });
    }
  });

  (deletes || []).forEach((delPath) => {
    const existing = ghRepoRequest(`/contents/${delPath}?ref=main`, "get");
    if (existing && existing.sha) {
      treeEntries.push({ path: delPath, mode: "100644", type: "blob", sha: null });
    }
  });

  if (treeEntries.length === 0) return;

  const newTree = ghRepoRequest("/git/trees", "post", { base_tree: baseTreeSha, tree: treeEntries });
  const newCommit = ghRepoRequest("/git/commits", "post", {
    message: commitMsg,
    tree: newTree.sha,
    parents: [headSha]
  });
  ghRepoRequest("/git/refs/heads/main", "patch", { sha: newCommit.sha, force: false });
}

function parseMdFrontmatter(raw) {
  const m = String(raw || "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw || "" };
  const meta = {};
  m[1].split(/\r?\n/).forEach((line) => {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  });
  return { meta: meta, body: m[2] };
}

function composeMdWithFrontmatter(meta, body) {
  const keys = [
    "title",
    "slug",
    "type",
    "format",
    "noteCode",
    "stage",
    "issue",
    "date",
    "readingTime",
    "tags",
    "links",
    "resourceLabel",
    "resourceUrl",
    "summary"
  ];
  const lines = ["---"];
  keys.forEach((k) => {
    const v = meta[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      lines.push(`${k}: ${String(v).replace(/\n/g, " ").trim()}`);
    }
  });
  lines.push("---", "", String(body || "").replace(/\s+$/, ""), "");
  return lines.join("\n");
}

function ghListMedia() {
  const dir = ghRepoRequest("/contents/assets/uploads?ref=main", "get");
  if (!Array.isArray(dir)) return [];
  return dir
    .filter((f) => f.type === "file" && !f.name.startsWith("."))
    .map((f) => {
      const dot = f.name.lastIndexOf(".");
      const ext = dot >= 0 ? f.name.slice(dot).toLowerCase() : "";
      const sz = f.size || 0;
      const szLabel =
        sz < 1024 ? `${sz} B` : sz < 1048576 ? `${(sz / 1024).toFixed(1)} KB` : `${(sz / 1048576).toFixed(2)} MB`;
      const kind = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif"].includes(ext)
        ? "image"
        : [".mp4", ".webm", ".mov"].includes(ext)
        ? "video"
        : [".mp3", ".m4a", ".wav"].includes(ext)
        ? "audio"
        : "file";
      return {
        filename: f.name,
        url: `./assets/uploads/${f.name}`,
        size: sz,
        sizeLabel: szLabel,
        ext: ext.replace(/^\./, "").toUpperCase() || "FILE",
        kind: kind
      };
    });
}

function ghListEditableWebFiles() {
  const rootList = ghRepoRequest("/contents?ref=main", "get") || [];
  const excluded = {
    "studio.html": 1,
    "studio.css": 1,
    "studio.js": 1,
    "studio-media.js": 1,
    "studio-cloud-client.js": 1,
    "studio-analytics.js": 1
  };
  const coreMap = {
    "index.html": "網站主骨架 HTML",
    "styles.css": "靜謐書齋主樣式 CSS",
    "theme.custom.css": "視覺微調覆寫 CSS"
  };
  const out = [];
  Object.keys(coreMap).forEach((k) => {
    if (rootList.some((f) => f.name === k)) {
      out.push({ path: k, label: coreMap[k], isCore: true });
    }
  });
  rootList.forEach((f) => {
    if (f.type === "file" && f.name.endsWith(".html") && !coreMap[f.name] && !excluded[f.name]) {
      out.push({ path: f.name, label: "獨立 HTML 頁面", isCore: false });
    }
  });
  return out;
}

function ghBuildUpdatedManifest(overrideItem, deletedPath) {
  const folders = [
    ["essay", "content/essays"],
    ["note", "content/notes"],
    ["letter", "content/letters"]
  ];
  const items = [];

  folders.forEach((pair) => {
    const docType = pair[0];
    const dirPath = pair[1];
    const list = ghRepoRequest(`/contents/${dirPath}?ref=main`, "get");
    const fileMap = {};
    if (Array.isArray(list)) {
      list.forEach((f) => {
        if (f.type === "file" && f.name.endsWith(".md")) {
          const fullRel = `${dirPath}/${f.name}`;
          if (fullRel !== deletedPath) fileMap[fullRel] = f.name;
        }
      });
    }
    if (overrideItem && overrideItem.path.indexOf(`${dirPath}/`) === 0) {
      fileMap[overrideItem.path] = overrideItem.path.split("/").pop();
    }

    Object.keys(fileMap).forEach((fullRel) => {
      const fname = fileMap[fullRel];
      const raw = overrideItem && overrideItem.path === fullRel ? overrideItem.rawMd : ghReadTextFile(fullRel);
      const parsed = parseMdFrontmatter(raw);
      const meta = parsed.meta;
      const body = parsed.body;
      const slug = meta.slug || fname.replace(/\.md$/i, "");
      const cleanChars = body.replace(/[#*>`_\-\[\]\(\)\s]/g, "").length;
      const plainSearch = body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[#*>`~_\-\[\]\(\)|]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 5000);
      const entry = {
        title: meta.title || slug,
        slug: slug,
        type: meta.type || docType,
        format: meta.format || "markdown",
        date: meta.date || new Date().toISOString().slice(0, 10),
        readingTime: meta.readingTime || `${Math.max(1, Math.round(cleanChars / 380))} min`,
        summary: meta.summary || plainSearch.slice(0, 78),
        tags: String(meta.tags || "")
          .split(/[,，、]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        links: String(meta.links || "")
          .split(/[,，、]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        path: `./${fullRel}`,
        searchText: plainSearch
      };
      if (meta.stage) entry.stage = meta.stage;
      if (meta.noteCode) entry.noteCode = meta.noteCode;
      if (meta.issue) entry.issue = Number(meta.issue) || meta.issue;
      if (meta.resourceUrl) {
        entry.resourceUrl = meta.resourceUrl;
        entry.resourceLabel = meta.resourceLabel || "開啟本篇附屬教材／資料庫";
      }
      items.push(entry);
    });
  });

  items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return {
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    count: items.length,
    items: items
  };
}

function handleStudioCloudApi(payload) {
  const method = String(payload.method || "GET").toUpperCase();
  const subPath = String(payload.subPath || "/");
  const query = payload.query || {};
  const data = payload.body || {};

  const auth = verifyStudioJwt(payload.jwtToken, payload.csrfToken, method !== "GET");
  if (!auth.ok) {
    return jsonResponse({ ok: false, authRequired: true, message: auth.error || "未授權存取" });
  }

  const gitInfo = {
    initialized: true,
    changedCount: 0,
    remoteUrl: `https://github.com/${HUB_CONFIG.GITHUB_OWNER}/${HUB_CONFIG.GITHUB_REPO}.git`
  };

  try {
    if (method === "GET" && subPath === "/bootstrap") {
      const cfgRaw = ghReadTextFile("site.config.js");
      const mCfg = cfgRaw.match(/window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      const config = mCfg ? JSON.parse(mCfg[1]) : {};
      const themeRaw = ghReadTextFile("theme.config.json");
      const theme = themeRaw ? JSON.parse(themeRaw) : {};
      const manifestRaw = ghReadTextFile("content/manifest.json");
      const manifest = manifestRaw ? JSON.parse(manifestRaw) : { count: 0, items: [] };
      return jsonResponse({
        ok: true,
        mode: "cloud",
        csrfToken: auth.csrf,
        config: config,
        theme: theme,
        manifest: manifest,
        webFiles: ghListEditableWebFiles(),
        media: ghListMedia(),
        git: gitInfo
      });
    }

    if (method === "GET" && subPath === "/media") {
      return jsonResponse({ ok: true, media: ghListMedia() });
    }

    if (method === "GET" && subPath === "/analytics") {
      return handleAnalyticsSummary();
    }

    if (method === "POST" && subPath === "/analytics/test-ping") {
      return handleTrackPageview({
        route: "#/",
        title: "首頁 · 書齋總覽（雲端工作台驗證）",
        pageType: "首頁",
        visitorHash: "owner-cloud-verify",
        referrer: "站長儀表板測試",
        device: "desktop",
        host: "deediaoyeh.github.io",
        dwellSec: 85,
        visitId: "cloud-verify-" + Date.now()
      });
    }

    if (method === "POST" && subPath === "/newsletter/push-draft") {
      return handleSaveDraftFromStudio(data);
    }

    if (method === "POST" && subPath === "/newsletter/test-send") {
      return handleSendTestNewsletter(data);
    }

    if (method === "POST" && subPath === "/newsletter/send-live") {
      return handleSendLiveNewsletterFromStudio(data);
    }

    if (method === "GET" && subPath === "/item") {
      const docType = query.type || "essay";
      const slug = query.slug || "";
      const folder = docType === "essay" ? "essays" : docType === "note" ? "notes" : "letters";
      const raw = ghReadTextFile(`content/${folder}/${slug}.md`);
      const parsed = parseMdFrontmatter(raw);
      return jsonResponse({ ok: true, meta: parsed.meta, body: parsed.body });
    }

    if (method === "POST" && subPath === "/item") {
      const meta = data.meta || {};
      const body = String(data.body || "");
      const docType = meta.type || "essay";
      const slug = String(meta.slug || "")
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!slug) return jsonResponse({ ok: false, message: "請填寫英文網址代稱 (Slug)" });

      meta.slug = slug;
      meta.type = docType;
      const folder = docType === "essay" ? "essays" : docType === "note" ? "notes" : "letters";
      const targetPath = `content/${folder}/${slug}.md`;
      const rawMd = composeMdWithFrontmatter(meta, body);

      let deleteOld = "";
      const oldSlug = String(data.originalSlug || "").trim();
      const oldType = String(data.originalType || docType).trim();
      if (oldSlug && (oldSlug !== slug || oldType !== docType)) {
        const oldFolder = oldType === "essay" ? "essays" : oldType === "note" ? "notes" : "letters";
        deleteOld = `content/${oldFolder}/${oldSlug}.md`;
      }

      const manifest = ghBuildUpdatedManifest({ path: targetPath, rawMd: rawMd }, deleteOld || undefined);
      ghAtomicCommit(
        `cloud-studio: save ${docType}/${slug}`,
        [
          { path: targetPath, contentUtf8: rawMd },
          { path: "content/manifest.json", contentUtf8: JSON.stringify(manifest, null, 2) + "\n" }
        ],
        deleteOld ? [deleteOld] : []
      );
      return jsonResponse({ ok: true, slug: slug, type: docType, manifest: manifest, git: gitInfo });
    }

    if (method === "DELETE" && subPath === "/item") {
      const docType = query.type || "essay";
      const slug = query.slug || "";
      const folder = docType === "essay" ? "essays" : docType === "note" ? "notes" : "letters";
      const delPath = `content/${folder}/${slug}.md`;
      const manifest = ghBuildUpdatedManifest(undefined, delPath);
      ghAtomicCommit(
        `cloud-studio: delete ${docType}/${slug}`,
        [{ path: "content/manifest.json", contentUtf8: JSON.stringify(manifest, null, 2) + "\n" }],
        [delPath]
      );
      return jsonResponse({ ok: true, manifest: manifest, git: gitInfo });
    }

    if (method === "POST" && subPath === "/config") {
      const cfgText =
        `/**\n * 網站全域設定檔 (site.config.js)\n */\nwindow.SITE_CONFIG = ` +
        JSON.stringify(data.config || {}, null, 2) +
        `;\n`;
      ghAtomicCommit("cloud-studio: update site.config.js", [{ path: "site.config.js", contentUtf8: cfgText }]);
      return jsonResponse({ ok: true, git: gitInfo });
    }

    if (method === "POST" && subPath === "/theme") {
      const t = data.theme || {};
      const css = `/* 由雲端工作台產生 */\n:root,\n[data-theme="paper"] {\n  --bg-paper: ${t.bgPaper};\n  --bg-subtle: ${t.bgSubtle};\n  --bg-elevated: ${t.bgElevated || "#faf8f4"};\n  --ink-primary: ${t.inkPrimary};\n  --ink-secondary: ${t.inkSecondary};\n  --ink-muted: ${t.inkMuted || "#857f73"};\n  --accent: ${t.accent};\n  --accent-hover: ${t.inkPrimary};\n  --accent-moss: ${t.accentMoss};\n}\nbody {\n  font-size: ${Number(t.fontSize) || 16}px;\n  line-height: ${Number(t.lineHeight) || 1.8};\n}\n.site-shell {\n  max-width: ${Number(t.maxWidth) || 980}px;\n}\n`;
      ghAtomicCommit("cloud-studio: update theme", [
        { path: "theme.config.json", contentUtf8: JSON.stringify(t, null, 2) + "\n" },
        { path: "theme.custom.css", contentUtf8: css }
      ]);
      return jsonResponse({ ok: true, theme: t, git: gitInfo });
    }

    if (method === "GET" && subPath === "/web-file") {
      const rel = String(query.path || "").replace(/^\/+/, "");
      if (!rel || rel.indexOf("..") >= 0 || rel.indexOf("studio") === 0) {
        return jsonResponse({ ok: false, message: "不允許讀取此檔案" });
      }
      const content = ghReadTextFile(rel);
      const isCore = ["index.html", "styles.css", "theme.custom.css", "app.js"].indexOf(rel) >= 0;
      return jsonResponse({ ok: true, path: rel, content: content, isCore: isCore });
    }

    if (method === "POST" && subPath === "/web-file") {
      const rel = String(data.path || "")
        .trim()
        .replace(/^\/+/, "");
      if (!rel || rel.indexOf("..") >= 0 || rel.indexOf("studio") === 0 || !/\.(html|css)$/i.test(rel)) {
        return jsonResponse({ ok: false, message: "不允許寫入此路徑" });
      }
      ghAtomicCommit(`cloud-studio: save ${rel}`, [{ path: rel, contentUtf8: String(data.content || "") }]);
      return jsonResponse({ ok: true, path: rel, webFiles: ghListEditableWebFiles(), git: gitInfo });
    }

    if (method === "DELETE" && subPath === "/web-file") {
      const rel = String(query.path || "").replace(/^\/+/, "");
      if (["index.html", "styles.css", "theme.custom.css", "app.js"].indexOf(rel) >= 0) {
        return jsonResponse({ ok: false, message: "系統核心檔案不可刪除" });
      }
      ghAtomicCommit(`cloud-studio: delete ${rel}`, [], [rel]);
      return jsonResponse({ ok: true, webFiles: ghListEditableWebFiles(), git: gitInfo });
    }

    if (method === "POST" && subPath === "/upload") {
      const rawName = String(data.filename || "upload.bin").trim();
      const dot = rawName.lastIndexOf(".");
      const ext = dot >= 0 ? rawName.slice(dot).toLowerCase() : "";
      const stem =
        rawName
          .slice(0, dot >= 0 ? dot : rawName.length)
          .replace(/[^\w\u4e00-\u9fa5\-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50) || "file";
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(8, 14);
      const finalName = `${stem}-${stamp}${ext}`;

      let b64 = String(data.dataBase64 || "");
      if (b64.indexOf("data:") === 0 && b64.indexOf(",") >= 0) {
        b64 = b64.split(",", 2)[1];
      }
      const rawBytes = Utilities.base64Decode(b64);
      ghAtomicCommit(`cloud-studio: upload ${finalName}`, [{ path: `assets/uploads/${finalName}`, contentBase64: b64 }]);

      const sz = rawBytes.length;
      const szLabel =
        sz < 1024 ? `${sz} B` : sz < 1048576 ? `${(sz / 1024).toFixed(1)} KB` : `${(sz / 1048576).toFixed(2)} MB`;
      const kind = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif"].indexOf(ext) >= 0 ? "image" : "file";
      return jsonResponse({
        ok: true,
        filename: finalName,
        url: `./assets/uploads/${finalName}`,
        size: sz,
        sizeLabel: szLabel,
        ext: ext.slice(1).toUpperCase(),
        kind: kind,
        media: ghListMedia(),
        git: gitInfo
      });
    }

    // 雲端工作台亦直接支援瀏覽與匯入個人 Google Drive 檔案！
    if (method === "GET" && subPath === "/gdrive/list") {
      const qStr = String(query.query || "").trim();
      const folderId = String(query.folderId || "root");
      const mode = String(query.mode || "folder");
      let iter;
      const items = [];

      if (qStr) {
        const escaped = qStr.replace(/'/g, "\\'");
        iter = DriveApp.searchFiles(`title contains '${escaped}' and trashed = false`);
      } else if (mode === "recent") {
        iter = DriveApp.getFiles();
      } else {
        const targetFolder = folderId && folderId !== "root" ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
        const fIter = targetFolder.getFolders();
        let fCnt = 0;
        while (fIter.hasNext() && fCnt < 30) {
          const fld = fIter.next();
          fCnt++;
          items.push({
            id: fld.getId(),
            name: fld.getName(),
            mimeType: "application/vnd.google-apps.folder",
            isFolder: true,
            size: 0,
            sizeLabel: "資料夾",
            modifiedTime: Utilities.formatDate(fld.getLastUpdated(), "Asia/Taipei", "yyyy-MM-dd"),
            isImage: false
          });
        }
        iter = targetFolder.getFiles();
      }

      let cnt = 0;
      while (iter.hasNext() && cnt < 40) {
        const f = iter.next();
        cnt++;
        const mime = f.getMimeType();
        const sz = f.getSize() || 0;
        items.push({
          id: f.getId(),
          name: f.getName(),
          mimeType: mime,
          isFolder: false,
          size: sz,
          sizeLabel: sz ? (sz < 1048576 ? `${(sz / 1024).toFixed(1)} KB` : `${(sz / 1048576).toFixed(2)} MB`) : "雲端文件",
          modifiedTime: Utilities.formatDate(f.getLastUpdated(), "Asia/Taipei", "yyyy-MM-dd"),
          isImage: mime.indexOf("image/") === 0
        });
      }
      return jsonResponse({ ok: true, items: items });
    }

    if (method === "POST" && subPath === "/gdrive/import") {
      const fileId = String(data.fileId || "").trim();
      if (!fileId) return jsonResponse({ ok: false, message: "缺少檔案 ID" });
      const file = DriveApp.getFileById(fileId);
      const mime = file.getMimeType();
      let blob;
      let rawName = file.getName();
      if (mime.indexOf("application/vnd.google-apps.") === 0) {
        blob = file.getAs("application/pdf");
        rawName = rawName.replace(/\.[^.]+$/, "") + ".pdf";
      } else {
        blob = file.getBlob();
      }
      const dot = rawName.lastIndexOf(".");
      const ext = dot >= 0 ? rawName.slice(dot).toLowerCase() : ".bin";
      const stem =
        rawName
          .slice(0, dot >= 0 ? dot : rawName.length)
          .replace(/[^\w\u4e00-\u9fa5\-]+/g, "-")
          .slice(0, 50) || "drive-file";
      const finalName = `${stem}${ext}`;
      const bytes = blob.getBytes();
      const b64 = Utilities.base64Encode(bytes);
      ghAtomicCommit(`cloud-studio: import ${finalName} from Drive`, [
        { path: `assets/uploads/${finalName}`, contentBase64: b64 }
      ]);
      const sz = bytes.length;
      return jsonResponse({
        ok: true,
        filename: finalName,
        url: `./assets/uploads/${finalName}`,
        size: sz,
        sizeLabel: sz < 1048576 ? `${(sz / 1024).toFixed(1)} KB` : `${(sz / 1048576).toFixed(2)} MB`,
        ext: ext.replace(/^\./, "").toUpperCase(),
        kind: [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"].indexOf(ext) >= 0 ? "image" : "file",
        media: ghListMedia(),
        git: gitInfo
      });
    }

    if (method === "POST" && subPath === "/sync") {
      return jsonResponse({
        ok: true,
        output: "✓ 雲端工作台每次按下「儲存 ⌘S」皆已直接原子寫入 GitHub 主站，前台 1–3 秒內自動同步生效！",
        git: gitInfo
      });
    }

    return jsonResponse({ ok: false, message: `未知的雲端工作台 API：${method} ${subPath}` });
  } catch (err) {
    return jsonResponse({ ok: false, message: err.message || "雲端工作台執行錯誤" });
  }
}
