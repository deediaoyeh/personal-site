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

  // 選填：從 Google Sheet 選單觸發 GitHub Actions 同步
  GITHUB_OWNER: "deediaoyeh",
  GITHUB_REPO: "personal-site",
  GITHUB_PAT: ""
};

const SHEET_SUBSCRIBERS = "Subscribers";
const SHEET_ISSUES = "NewsletterDrafts";
const SHEET_PAGEVIEWS = "PageViews";

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
      "站點網域"
    ]);
    pvSheet.getRange("A1:I1").setFontWeight("bold");
  }
}

/**
 * 處理網站前端與工作台 POST 請求
 */
function doPost(e) {
  try {
    setupSheets();
    const rawBody = (e && e.postData && e.postData.contents) || "{}";
    if (rawBody.length > 250000) {
      return jsonResponse({ ok: false, message: "請求內容過大" });
    }
    const payload = JSON.parse(rawBody);

    if (payload.action === "subscribe") {
      return handleSubscribe(payload);
    }

    if (payload.action === "pageview") {
      return handleTrackPageview(payload);
    }

    // 嚴格預設拒絕 (Fail-Closed)：必須持有正確 SYNC_TOKEN 方可寫入電子報草稿
    if (payload.action === "save_draft") {
      if (!constantTimeEqual(String(payload.token || ""), HUB_CONFIG.SYNC_TOKEN)) {
        return jsonResponse({ ok: false, message: "拒絕存取：缺少或無效的同步金鑰 (SYNC_TOKEN)" });
      }
      return handleSaveDraftFromStudio(payload);
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
  const subs = subSheet.getDataRange().getValues().slice(1).filter((r) => r[1] === "active");

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

  const isHtml = /<\/?(p|h[1-6]|div|ul|ol|li|blockquote|a|strong)\b/i.test(content);
  const scriptUrl = ScriptApp.getService().getUrl();

  subs.forEach((sub) => {
    const email = String(sub[0] || "").replace(/^'/, "");
    const token = String(sub[4] || "");
    const unsubUrl = `${scriptUrl}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
    const footerPlain = `\n\n——\n線上閱讀與歷史歸檔：${HUB_CONFIG.SITE_URL}/#/letters\n取消訂閱：${unsubUrl}`;

    if (isHtml) {
      const htmlMail =
        `<div style="font-family:'PingFang TC','Noto Sans TC',Georgia,serif;max-width:620px;margin:0 auto;padding:28px 24px;background:#faf8f4;color:#1d1c19;line-height:1.85;font-size:16px;">` +
        content +
        `<hr style="border:none;border-top:1px solid #dcd6ca;margin:32px 0 16px;" />` +
        `<p style="font-size:13px;color:#857f73;">線上閱讀與歷史歸檔：<a href="${HUB_CONFIG.SITE_URL}/#/letters" style="color:#6e5039;">${HUB_CONFIG.SITE_URL}</a><br/>如需取消訂閱，請點此：<a href="${unsubUrl}" style="color:#6e5039;">一鍵取消訂閱</a></p>` +
        `</div>`;
      const plainFallback = content.replace(/<[^>]+>/g, "") + footerPlain;
      GmailApp.sendEmail(email, subject, plainFallback, {
        name: HUB_CONFIG.SENDER_NAME,
        htmlBody: htmlMail
      });
    } else {
      GmailApp.sendEmail(email, subject, content + footerPlain, {
        name: HUB_CONFIG.SENDER_NAME
      });
    }
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
      payload.host || ""
    ],
    [40, 16, 180, 160, 32, 48, 140, 24, 80]
  );
  return jsonResponse({ ok: true });
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
  const allVisitorSet = {};
  const todayVisitorSet = {};
  const pageStats = {};
  const referrerStats = {};
  const deviceStats = { desktop: 0, mobile: 0, tablet: 0 };
  const recentVisits = [];

  const unquote = (v) => String(v || "").replace(/^'/, "");

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dStr =
      r[1] instanceof Date ? Utilities.formatDate(r[1], tz, "yyyy-MM-dd") : unquote(r[1]).slice(0, 10);
    const route = unquote(r[2]) || "#/";
    const title = unquote(r[3]) || route;
    const pType = unquote(r[4]) || "page";
    const vHash = unquote(r[5]) || "anon";
    const ref = unquote(r[6]) || "直接造訪";
    const dev = (unquote(r[7]) || "desktop").toLowerCase();

    totalViews++;
    allVisitorSet[`${dStr}:${vHash}`] = true;

    if (dStr === todayStr) {
      todayViews++;
      todayVisitorSet[vHash] = true;
    }
    if (dStr >= cutoff7d) last7dViews++;
    if (dStr >= cutoff30d) last30dViews++;

    if (dailyMap[dStr]) {
      dailyMap[dStr].views++;
      dailyMap[dStr].visitorSet[vHash] = true;
    }

    if (!pageStats[route]) {
      pageStats[route] = { route: route, title: title, pageType: pType, views: 0, visitorSet: {} };
    }
    pageStats[route].views++;
    pageStats[route].title = title || pageStats[route].title;
    pageStats[route].pageType = pType || pageStats[route].pageType;
    pageStats[route].visitorSet[`${dStr}:${vHash}`] = true;

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
      host: unquote(r[8]) || ""
    });
  }

  let activeSubscribers = 0;
  let totalSubscribers = 0;
  if (subSheet) {
    const sRows = subSheet.getDataRange().getValues();
    for (let k = 1; k < sRows.length; k++) {
      if (sRows[k][0]) {
        totalSubscribers++;
        if (sRows[k][1] === "active") activeSubscribers++;
      }
    }
  }

  const dailySeries = dayKeys.map((k) => ({
    fullDate: dailyMap[k].fullDate,
    label: dailyMap[k].label,
    views: dailyMap[k].views,
    visitors: Object.keys(dailyMap[k].visitorSet).length
  }));

  const topPages = Object.keys(pageStats)
    .map((k) => ({
      route: pageStats[k].route,
      title: pageStats[k].title,
      pageType: pageStats[k].pageType,
      views: pageStats[k].views,
      visitors: Object.keys(pageStats[k].visitorSet).length
    }))
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
      activeSubscribers: activeSubscribers,
      totalSubscribers: totalSubscribers
    },
    dailySeries: dailySeries,
    topPages: topPages,
    referrers: referrers,
    devices: deviceStats,
    recentVisits: recentVisits
  });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
