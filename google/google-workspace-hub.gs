/**
 * ==========================================================================
 * Google Workspace 書齋雲端中樞 (google-workspace-hub.gs)
 * ==========================================================================
 * 結合四大核心功能（零月租費，100% 資料自主保存在你的 Google Workspace）：
 * 1. 【Google Sheets 電子報名單管理】：接收網站訂閱、防重複、一鍵安全退訂。
 * 2. 【Gmail 自動歡迎信與 HTML/純文字群發電子報】：訂閱即寄歡迎信，試算表內建一鍵群發。
 * 3. 【自動彙整本期電子報】：一鍵（或設定雙週排程）自動抓取最新 1 篇長文＋3 則筆記生成草稿！
 * 4. 【Google Drive 內容儲存空間同步】：讀取雲端硬碟 .md 或 Google Docs 同步至網站。
 * ==========================================================================
 */

// ── 基本設定區（已預設對應你的網站資訊）──────────────────────────────────
const HUB_CONFIG = {
  SENDER_NAME: "低調走過 · Deediao",
  NEWSLETTER_TITLE: "《低調走過》雙週電子報",
  SITE_URL: "https://deediaoyeh.github.io/personal-site",
  MIRROR_URL: "https://deediao-studio.netlify.app",

  // Google Drive 網站內容根資料夾 ID（PersonalSite-Vault，內含 essays、notes、letters 三個子資料夾）
  DRIVE_CONTENT_FOLDER_ID: "1n_ZQELr2H9f1Zre0rmntedtvyrohcGxS",

  // 內容與草稿推送保護金鑰（選填，若填寫請與工作台／GitHub Secrets 一致）
  SYNC_TOKEN: "",

  // 用於從 Google Sheet 選單「一鍵觸發 GitHub 主站與 Netlify 備份站同步」（選填）
  GITHUB_OWNER: "deediaoyeh",
  GITHUB_REPO: "personal-site",
  GITHUB_PAT: ""
};

const SHEET_SUBSCRIBERS = "Subscribers";
const SHEET_ISSUES = "NewsletterDrafts";

/**
 * 在 Google 試算表頂部建立「書齋控制台」自訂選單
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("書齋控制台")
    .addItem("1. 初始化試算表結構", "setupSheets")
    .addSeparator()
    .addItem("✨ 自動彙整最新「1 篇長文＋3 則筆記」產生本期草稿", "autoCompileBiweeklyDraft")
    .addItem("📨 寄送最新一期電子報草稿給所有訂戶", "sendLatestNewsletter")
    .addSeparator()
    .addItem("🔄 立即同步 Google Drive 內容至 GitHub 主站", "triggerGitHubSync")
    .addToUi();
}

/**
 * 一鍵建立所需的兩個工作表：訂戶名單 (Subscribers) 與電子報發信台 (NewsletterDrafts)
 */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let subSheet = ss.getSheetByName(SHEET_SUBSCRIBERS);
  if (!subSheet) {
    subSheet = ss.insertSheet(SHEET_SUBSCRIBERS);
    subSheet.appendRow(["Email", "狀態 (active/unsubscribed)", "訂閱時間", "來源頁面", "退訂憑證"]);
    subSheet.getRange("A1:E1").setFontWeight("bold");
  }

  let draftSheet = ss.getSheetByName(SHEET_ISSUES);
  if (!draftSheet) {
    draftSheet = ss.insertSheet(SHEET_ISSUES);
    draftSheet.appendRow(["期數", "信件主旨", "信件內容 (純文字或 HTML)", "發送狀態", "發送時間"]);
    draftSheet.getRange("A1:E1").setFontWeight("bold");
    draftSheet.appendRow([
      "01",
      "《低調走過》第 01 期：慢下來拆解問題，累積可複用的思維模型",
      "週日早安，\n\n這是來自《低調走過》發信台的範例草稿。你也可以在工作台點擊「自動彙整本期電子報」後一鍵推送草稿至此處！\n\n祝安好，\n低調走過 (Deediao)",
      "draft",
      ""
    ]);
  }
}

/**
 * 處理網站前端與工作台 POST 請求：
 * - action: "subscribe"  → 網站訪客訂閱電子報
 * - action: "save_draft" → 從編輯工作台直接將寫好的電子報期數推送進試算表草稿匣
 */
function doPost(e) {
  try {
    setupSheets();
    const payload = JSON.parse((e && e.postData && e.postData.contents) || "{}");

    if (payload.action === "subscribe") {
      return handleSubscribe(payload);
    }

    if (payload.action === "save_draft") {
      if (HUB_CONFIG.SYNC_TOKEN && payload.token !== HUB_CONFIG.SYNC_TOKEN) {
        return jsonResponse({ ok: false, message: "金鑰驗證失敗 (SYNC_TOKEN 不符)" });
      }
      return handleSaveDraftFromStudio(payload);
    }

    return jsonResponse({ ok: false, message: "未知的操作類型" });
  } catch (err) {
    return jsonResponse({ ok: false, message: err.message });
  }
}

/**
 * 處理 GET 請求：
 * 1. ?action=unsubscribe&email=...&token=... → 讀者一鍵退訂
 * 2. ?action=feed&token=...                  → 供 GitHub Actions 拉取 Google Drive 內容庫
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.action === "unsubscribe") {
    return handleUnsubscribe(params.email, params.token);
  }

  if (params.action === "feed") {
    if (HUB_CONFIG.SYNC_TOKEN && params.token !== HUB_CONFIG.SYNC_TOKEN) {
      return jsonResponse({ ok: false, message: "Sync token 驗證失敗" });
    }
    return exportDriveContentAsJson();
  }

  return HtmlService.createHtmlOutput(
    '<div style="font-family:serif;padding:48px;background:#f5f2eb;color:#1d1c19;">《低調走過》電子報與雲端中樞運作正常。</div>'
  );
}

/**
 * 新增訂戶並自動寄出歡迎信
 */
function handleSubscribe(payload) {
  const email = String(payload.email || "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ ok: false, message: "Email 格式不正確" });
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBSCRIBERS);
  const rows = sheet.getDataRange().getValues();

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).toLowerCase() === email) {
      if (rows[i][1] === "active") {
        return jsonResponse({ ok: true, alreadySubscribed: true });
      }
      sheet.getRange(i + 1, 2).setValue("active");
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      return jsonResponse({ ok: true, resubscribed: true });
    }
  }

  const unsubToken = Utilities.getUuid();
  sheet.appendRow([email, "active", payload.timestamp || new Date().toISOString(), payload.source || "#/", unsubToken]);

  const scriptUrl = ScriptApp.getService().getUrl();
  const unsubUrl = `${scriptUrl}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(unsubToken)}`;
  const body = [
    "你好，",
    "",
    `謝謝你訂閱${HUB_CONFIG.NEWSLETTER_TITLE}。`,
    "未來每隔週日早晨，我會將近期完成的深度長文導讀、三則讀書卡片與一個值得反覆推敲的問題寄到這個信箱。",
    "",
    `在等待下一封信之前，你可以隨時造訪網站閱讀最新文章與筆記：${HUB_CONFIG.SITE_URL}`,
    "",
    "——",
    `${HUB_CONFIG.SENDER_NAME}`,
    `如需取消訂閱，請點此一鍵退訂：${unsubUrl}`
  ].join("\n");

  GmailApp.sendEmail(email, `歡迎訂閱${HUB_CONFIG.NEWSLETTER_TITLE} —— 我們雙週日早晨見`, body, {
    name: HUB_CONFIG.SENDER_NAME
  });

  return jsonResponse({ ok: true });
}

/**
 * 接收來自編輯工作台直接推送的電子報草稿
 */
function handleSaveDraftFromStudio(payload) {
  const draftSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ISSUES);
  const issueStr = String(payload.issue || "01").padStart(2, "0");
  const subject = String(payload.subject || `${HUB_CONFIG.NEWSLETTER_TITLE} 第 ${issueStr} 期`).trim();
  const content = String(payload.content || "").trim();
  if (!content) {
    return jsonResponse({ ok: false, message: "電子報內容不可為空" });
  }

  draftSheet.appendRow([issueStr, subject, content, "draft", ""]);
  return jsonResponse({
    ok: true,
    message: `已將第 ${issueStr} 期草稿寫入 Google 試算表 NewsletterDrafts！隨時可於試算表點選「書齋控制台 → 寄送最新一期電子報草稿」。`
  });
}

/**
 * ✨ 自動從 GitHub 主站最新索引抓取「最新 1 篇長文＋3 則近期筆記」自動組裝本期電子報草稿
 * （可手動從試算表選單點選，亦可於 Apps Script「觸發條件」設定每雙週自動執行！）
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

  draftSheet.appendRow([nextIssueNum, subject, lines.join("\n"), "draft", ""]);

  try {
    SpreadsheetApp.getUi().alert(
      `✓ 已自動彙整產生第 ${nextIssueNum} 期電子報草稿！\n請查看「NewsletterDrafts」工作表最後一列，確認無誤後即可點選選單群發。`
    );
  } catch (_) {
    // 若由排程自動觸發則無 UI 視窗，直接靜默完成
  }
}

/**
 * 一鍵退訂處理
 */
function handleUnsubscribe(email, token) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SUBSCRIBERS);
  if (sheet) {
    const rows = sheet.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]).toLowerCase() === cleanEmail && String(rows[i][4]) === String(token)) {
        sheet.getRange(i + 1, 2).setValue("unsubscribed");
        break;
      }
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
 * 群發最新一期草稿給所有 active 訂戶（自動支援 HTML 與純文字雙格式）
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
    ui.alert("找不到狀態為 draft 的電子報草稿。可先點選「✨ 自動彙整最新 1 篇長文＋3 則筆記」產生草稿！");
    return;
  }

  const subject = drafts[targetRowIndex][1];
  const content = String(drafts[targetRowIndex][2] || "");
  const subs = subSheet.getDataRange().getValues().slice(1).filter((r) => r[1] === "active");

  if (subs.length === 0) {
    ui.alert("目前尚無狀態為 active 的有效訂戶。");
    return;
  }

  const confirm = ui.alert(
    "確認發送電子報",
    `即將寄出「${subject}」給 ${subs.length} 位訂閱者，確定執行嗎？`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const isHtml = /<\/?(p|h[1-6]|div|ul|ol|li|blockquote|a|strong)\b/i.test(content);
  const scriptUrl = ScriptApp.getService().getUrl();

  subs.forEach((sub) => {
    const email = sub[0];
    const token = sub[4];
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

  draftSheet.getRange(targetRowIndex + 1, 4).setValue("sent");
  draftSheet.getRange(targetRowIndex + 1, 5).setValue(new Date().toISOString());
  ui.alert(`已成功發送給 ${subs.length} 位訂戶！`);
}

/**
 * 讀取 Google Drive 指定資料夾內的 essays / notes / letters
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

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
