/**
 * ==========================================================================
 * Google Workspace 書齋雲端中樞 (google-workspace-hub.gs)
 * ==========================================================================
 * 結合三大核心功能（零月租費，100% 資料自主保存在你的 Google Workspace）：
 * 1. 【Google Sheets 電子報名單管理】：接收網站訂閱、防重複、一鍵安全退訂。
 * 2. 【Gmail 自動歡迎信與群發電子報】：訂閱即寄歡迎信，並在試算表內建「群發電子報」選單。
 * 3. 【Google Drive 內容儲存空間同步】：讀取指定雲端硬碟資料夾內的 .md 或 Google Docs，
 *    並支援「一鍵手動觸發」或「定時自動同步」推送至 GitHub 主站與 Netlify 備份站！
 * ==========================================================================
 */

// ── 基本設定區（請填入你的資訊）──────────────────────────────────────────
const HUB_CONFIG = {
  SENDER_NAME: "Samuel Yeh · 靜水深流電子報",
  SITE_URL: "https://deediaoyeh.github.io/personal-site",
  MIRROR_URL: "https://deediao-studio.netlify.app",

  // Google Drive 網站內容根資料夾 ID（PersonalSite-Vault，內含 essays、notes、letters 三個子資料夾）
  DRIVE_CONTENT_FOLDER_ID: "1n_ZQELr2H9f1Zre0rmntedtvyrohcGxS",

  // 內容同步保護金鑰（選填，若填寫需與 GitHub Secrets 的 GOOGLE_WORKSPACE_SYNC_TOKEN 一致）
  SYNC_TOKEN: "",

  // 用於從 Google Sheet 選單「一鍵觸發 GitHub 主站與 Netlify 備份站同步」
  GITHUB_OWNER: "deediaoyeh",
  GITHUB_REPO: "personal-site",
  GITHUB_PAT: ""             // GitHub Fine-grained Token (需具備 Contents / Actions 權限)
};

const SHEET_SUBSCRIBERS = "Subscribers";
const SHEET_ISSUES = "NewsletterDrafts";

/**
 * 在 Google 試算表頂部建立「書齋控制台」自訂選單
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("書齋控制台")
    .addItem("初始化試算表結構", "setupSheets")
    .addSeparator()
    .addItem("立即同步 Google Drive 內容至 GitHub 主站 & Netlify", "triggerGitHubSync")
    .addItem("寄送最新一期電子報草稿給所有訂戶", "sendLatestNewsletter")
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
    draftSheet.appendRow(["期數", "信件主旨", "信件純文字或簡易 HTML 內容", "發送狀態", "發送時間"]);
    draftSheet.getRange("A1:E1").setFontWeight("bold");
    draftSheet.appendRow([
      "03",
      "《靜水深流》第 03 期：在資訊洪流中建立自己的判斷基準",
      "週日早安，\n\n這是來自 Google Workspace 發信台的範例草稿。\n\n祝安好，\n澄觀",
      "draft",
      ""
    ]);
  }
}

/**
 * 處理網站前端 POST 請求（電子報訂閱）
 */
function doPost(e) {
  try {
    setupSheets();
    const payload = JSON.parse(e.postData.contents || "{}");

    if (payload.action === "subscribe") {
      return handleSubscribe(payload);
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
    '<div style="font-family:serif;padding:48px;background:#f5f2eb;color:#1d1c19;">書齋雲端中樞運作正常。</div>'
  );
}

/**
 * 新增訂戶並寄出歡迎信
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
      // 曾退訂者重新訂閱
      sheet.getRange(i + 1, 2).setValue("active");
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      return jsonResponse({ ok: true, resubscribed: true });
    }
  }

  const unsubToken = Utilities.getUuid();
  sheet.appendRow([email, "active", payload.timestamp || new Date().toISOString(), payload.source || "#/", unsubToken]);

  // 寄出歡迎信
  const scriptUrl = ScriptApp.getService().getUrl();
  const unsubUrl = `${scriptUrl}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(unsubToken)}`;
  const body = [
    "你好，",
    "",
    "謝謝你訂閱《靜水深流》雙週電子報。",
    "未來每隔週日早晨，我會將近期完成的深度長文與讀書卡片寄到這個信箱。",
    "",
    `在等待下一封信之前，你可以隨時造訪主站閱讀過往歸檔：${HUB_CONFIG.SITE_URL}`,
    `（若主站維護中，亦可造訪備援站點：${HUB_CONFIG.MIRROR_URL}）`,
    "",
    "——",
    `${HUB_CONFIG.SENDER_NAME}`,
    `如需取消訂閱，請點此一鍵退訂：${unsubUrl}`
  ].join("\n");

  GmailApp.sendEmail(email, "歡迎訂閱《靜水深流》—— 我們雙週日早晨見", body, {
    name: HUB_CONFIG.SENDER_NAME
  });

  return jsonResponse({ ok: true });
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
 * 群發最新一期草稿給所有 active 訂戶
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

  const subject = drafts[targetRowIndex][1];
  const content = drafts[targetRowIndex][2];
  const subs = subSheet.getDataRange().getValues().slice(1).filter((r) => r[1] === "active");

  const confirm = ui.alert(
    "確認發送電子報",
    `即將寄出「${subject}」給 ${subs.length} 位訂閱者，確定執行嗎？`,
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  const scriptUrl = ScriptApp.getService().getUrl();
  subs.forEach((sub) => {
    const email = sub[0];
    const token = sub[4];
    const unsubUrl = `${scriptUrl}?action=unsubscribe&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
    const fullBody = `${content}\n\n——\n線上閱讀與歷史歸檔：${HUB_CONFIG.SITE_URL}\n取消訂閱：${unsubUrl}`;
    GmailApp.sendEmail(email, subject, fullBody, { name: HUB_CONFIG.SENDER_NAME });
  });

  draftSheet.getRange(targetRowIndex + 1, 4).setValue("sent");
  draftSheet.getRange(targetRowIndex + 1, 5).setValue(new Date().toISOString());
  ui.alert(`已成功發送給 ${subs.length} 位訂戶！`);
}

/**
 * 讀取 Google Drive 指定資料夾內的 essays / notes / letters（支援 .md 純文字檔與 Google Docs 文件）
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

/**
 * 將 Google Docs 轉換為含 Frontmatter 的乾淨 Markdown（若文件開頭已有 --- Frontmatter 則直接保留）
 */
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
      if (heading === DocumentApp.ParagraphHeading.HEADING1) {
        lines.push(`## ${text}`);
      } else if (heading === DocumentApp.ParagraphHeading.HEADING2) {
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

/**
 * 從 Google Sheets 選單手動觸發 GitHub Actions，立即更新 GitHub Pages 主站與 Netlify 備份站
 */
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
    ui.alert("已成功通知 GitHub 主站開始同步！約 45 秒後 GitHub Pages 主站與 Netlify 備份站將同步更新完成。");
  } else {
    ui.alert(`觸發失敗 (${res.getResponseCode()})：${res.getContentText()}`);
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
