/**
 * netlify/functions/studio-cloud.mts
 * 跨站雲端編輯工作台嚴謹雙重認證閘門與 GitHub 原子讀寫伺服器
 * 同時保護並服務：
 *   1. GitHub Pages 主站工作台 (https://deediaoyeh.github.io/personal-site/studio.html)
 *   2. Netlify 備份站工作台   (https://deediao-studio.netlify.app/studio.html)
 *
 * 安全設計：
 * - 所有機密（PBKDF2 60萬次迭代密碼雜湊、TOTP 密鑰、JWT 簽章金鑰、GitHub PAT）僅存放於 Netlify Secret Env Vars，絕不進入程式碼庫。
 * - 嚴格驗證 Origin 白名單、PBKDF2-HMAC-SHA256 常數時間比對、RFC 6238 TOTP 六位數動態驗證碼與 HMAC-SHA256 雙小時效期 JWT。
 */

import crypto from "node:crypto";

declare const Netlify: {
  env: {
    get(key: string): string | undefined;
  };
};

const GITHUB_REPO = "deediaoyeh/personal-site";
const GITHUB_BRANCH = "main";
const PBKDF2_ITERATIONS = 600_000;
const JWT_TTL_SECONDS = 2 * 3600; // 2 小時自動失效

const ALLOWED_ORIGINS = new Set([
  "https://deediaoyeh.github.io",
  "https://deediao-studio.netlify.app",
  "http://localhost:8788",
  "http://127.0.0.1:8788",
]);

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav"]);
const ALLOWED_UPLOAD_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg", ".avif",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".csv", ".txt", ".md", ".zip", ".epub",
  ".mp4", ".webm", ".mov", ".mp3", ".m4a", ".wav",
]);

// 單一實例記憶體內防暴力破解計數（搭配失敗延遲）
const failedByIp = new Map<string, { count: number; lockUntil: number }>();

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const headers: Record<string, string> = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization, X-Studio-CSRF";
    headers["Vary"] = "Origin";
  }
  return headers;
}

function jsonResp(req: Request, payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(req),
    },
  });
}

// =========================================================================
// 密碼學驗證：PBKDF2-SHA256 + RFC 6238 TOTP + HMAC-SHA256 JWT
// =========================================================================
function base32Decode(b32: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = b32.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    value = (value << 5) | alphabet.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function computeTotp(secretB32: string, counter: number): string {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

function verifyTotp(secretB32: string, inputCode: string): boolean {
  const clean = (inputCode || "").replace(/\D/g, "");
  if (clean.length !== 6) return false;
  const step = Math.floor(Date.now() / 1000 / 30);
  for (const delta of [-1, 0, 1]) {
    const expected = Buffer.from(computeTotp(secretB32, step + delta));
    const actual = Buffer.from(clean);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
      return true;
    }
  }
  return false;
}

function signJwt(jwtSecret: string): { token: string; csrf: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + JWT_TTL_SECONDS;
  const csrf = crypto.randomBytes(24).toString("hex");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ sub: "studio-owner", iat: now, exp, csrf })).toString("base64url");
  const sig = crypto.createHmac("sha256", jwtSecret).update(`${header}.${body}`).digest("base64url");
  return { token: `${header}.${body}.${sig}`, csrf, expiresAt: exp };
}

function verifyJwt(req: Request, requireCsrf: boolean): { ok: boolean; csrf?: string; error?: string } {
  const jwtSecret = Netlify.env.get("STUDIO_JWT_SECRET") || "";
  if (!jwtSecret) return { ok: false, error: "雲端安全金鑰尚未啟用" };

  const authHdr = req.headers.get("authorization") || "";
  if (!authHdr.startsWith("Bearer ")) return { ok: false, error: "未提供雙重驗證授權權杖" };
  const token = authHdr.slice(7).trim();
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "授權權杖格式無效" };

  const expectedSig = crypto
    .createHmac("sha256", jwtSecret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");

  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "授權權杖簽章驗證失敗" };
  }

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    return { ok: false, error: "登入憑證已逾時（超過 2 小時），請重新通過雙重驗證" };
  }

  if (requireCsrf) {
    const csrfHdr = req.headers.get("x-studio-csrf") || "";
    const c1 = Buffer.from(csrfHdr);
    const c2 = Buffer.from(String(payload.csrf || ""));
    if (!csrfHdr || c1.length !== c2.length || !crypto.timingSafeEqual(c1, c2)) {
      return { ok: false, error: "CSRF 安全權杖校驗失敗" };
    }
  }

  return { ok: true, csrf: payload.csrf };
}

// =========================================================================
// GitHub REST & Git Trees 原子寫入輔助函式
// =========================================================================
async function ghApi(path: string, init: RequestInit = {}): Promise<any> {
  const pat = Netlify.env.get("STUDIO_GITHUB_PAT") || "";
  if (!pat) throw new Error("雲端尚未設定 STUDIO_GITHUB_PAT 環境變數");

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Deediao-Studio-Cloud/1.0",
      ...(init.headers || {}),
    },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API (${res.status}): ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function readRepoTextFile(filePath: string): Promise<string> {
  const data = await ghApi(`/contents/${filePath}?ref=${GITHUB_BRANCH}`);
  if (!data || !data.content) return "";
  return Buffer.from(data.content, "base64").toString("utf-8");
}

async function atomicCommitFiles(
  message: string,
  upserts: Array<{ path: string; contentUtf8?: string; contentBase64?: string }>,
  deletes: string[] = []
): Promise<void> {
  const refData = await ghApi(`/git/ref/heads/${GITHUB_BRANCH}`);
  const headSha = refData.object.sha;
  const commitData = await ghApi(`/git/commits/${headSha}`);
  const baseTreeSha = commitData.tree.sha;

  const treeEntries: Array<Record<string, any>> = [];

  for (const item of upserts) {
    if (item.contentBase64 !== undefined) {
      const blob = await ghApi("/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: item.contentBase64, encoding: "base64" }),
      });
      treeEntries.push({ path: item.path, mode: "100644", type: "blob", sha: blob.sha });
    } else {
      treeEntries.push({
        path: item.path,
        mode: "100644",
        type: "blob",
        content: item.contentUtf8 ?? "",
      });
    }
  }

  for (const delPath of deletes) {
    const existing = await ghApi(`/contents/${delPath}?ref=${GITHUB_BRANCH}`);
    if (existing && existing.sha) {
      treeEntries.push({ path: delPath, mode: "100644", type: "blob", sha: null });
    }
  }

  if (treeEntries.length === 0) return;

  const newTree = await ghApi("/git/trees", {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });

  const newCommit = await ghApi("/git/commits", {
    method: "POST",
    body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }),
  });

  await ghApi(`/git/refs/heads/${GITHUB_BRANCH}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
}

// =========================================================================
// Markdown Frontmatter 與索引重建邏輯
// =========================================================================
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: m[2] };
}

function composeMarkdown(meta: Record<string, any>, body: string): string {
  const keys = [
    "title", "slug", "type", "format", "noteCode", "stage",
    "issue", "date", "readingTime", "tags", "links", "summary",
  ];
  const lines = ["---"];
  for (const k of keys) {
    const v = meta[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      lines.push(`${k}: ${String(v).replace(/\n/g, " ").trim()}`);
    }
  }
  lines.push("---", "", body.replace(/\s+$/, ""), "");
  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function classifyExt(ext: string): string {
  const e = ext.toLowerCase();
  if (IMAGE_EXTS.has(e)) return "image";
  if (VIDEO_EXTS.has(e)) return "video";
  if (AUDIO_EXTS.has(e)) return "audio";
  return "file";
}

async function listUploadedMediaFromRepo(): Promise<any[]> {
  const dir = await ghApi(`/contents/assets/uploads?ref=${GITHUB_BRANCH}`);
  if (!Array.isArray(dir)) return [];
  return dir
    .filter((f: any) => f.type === "file" && !f.name.startsWith("."))
    .map((f: any) => {
      const dot = f.name.lastIndexOf(".");
      const ext = dot >= 0 ? f.name.slice(dot) : "";
      return {
        filename: f.name,
        url: `./assets/uploads/${f.name}`,
        size: f.size || 0,
        sizeLabel: formatSize(f.size || 0),
        ext: ext.replace(/^\./, "").toUpperCase() || "FILE",
        kind: classifyExt(ext),
      };
    });
}

async function listEditableWebFilesFromRepo(): Promise<any[]> {
  const rootList = await ghApi(`/contents?ref=${GITHUB_BRANCH}`);
  if (!Array.isArray(rootList)) return [];
  const excluded = new Set(["studio.html", "studio.css", "studio.js", "studio-media.js"]);
  const coreMap: Record<string, string> = {
    "index.html": "網站主骨架 HTML",
    "styles.css": "靜謐書齋主樣式 CSS",
    "theme.custom.css": "視覺微調覆寫 CSS",
  };
  const out: any[] = [];
  for (const [k, label] of Object.entries(coreMap)) {
    if (rootList.some((f: any) => f.name === k)) {
      out.push({ path: k, label, isCore: true });
    }
  }
  for (const f of rootList) {
    if (f.type === "file" && f.name.endsWith(".html") && !coreMap[f.name] && !excluded.has(f.name)) {
      out.push({ path: f.name, label: "獨立 HTML 頁面", isCore: false });
    }
  }
  return out;
}

async function buildUpdatedManifest(
  overrideItem?: { path: string; rawMd: string },
  deletedPath?: string
): Promise<any> {
  const folders: Array<[string, string]> = [
    ["essay", "content/essays"],
    ["note", "content/notes"],
    ["letter", "content/letters"],
  ];
  const items: any[] = [];

  for (const [docType, dirPath] of folders) {
    const list = await ghApi(`/contents/${dirPath}?ref=${GITHUB_BRANCH}`);
    const fileMap = new Map<string, string>();
    if (Array.isArray(list)) {
      for (const f of list) {
        if (f.type === "file" && f.name.endsWith(".md")) {
          const fullRel = `${dirPath}/${f.name}`;
          if (fullRel !== deletedPath) {
            fileMap.set(fullRel, f.name);
          }
        }
      }
    }
    if (overrideItem && overrideItem.path.startsWith(`${dirPath}/`)) {
      fileMap.set(overrideItem.path, overrideItem.path.split("/").pop()!);
    }

    for (const [fullRel, fname] of fileMap.entries()) {
      const raw =
        overrideItem && overrideItem.path === fullRel
          ? overrideItem.rawMd
          : await readRepoTextFile(fullRel);
      const { meta, body } = parseFrontmatter(raw);
      const slug = meta.slug || fname.replace(/\.md$/i, "");
      const cleanChars = body.replace(/[#*>`_\-\[\]\(\)\s]/g, "").length;
      const entry: Record<string, any> = {
        title: meta.title || slug,
        slug,
        type: meta.type || docType,
        format: meta.format || "markdown",
        date: meta.date || new Date().toISOString().slice(0, 10),
        readingTime: meta.readingTime || `${Math.max(1, Math.round(cleanChars / 380))} min`,
        summary: meta.summary || "",
        tags: (meta.tags || "").split(/[,，、]+/).map((s) => s.trim()).filter(Boolean),
        links: (meta.links || "").split(/[,，、]+/).map((s) => s.trim()).filter(Boolean),
        path: `./${fullRel}`,
      };
      if (meta.stage) entry.stage = meta.stage;
      if (meta.noteCode) entry.noteCode = meta.noteCode;
      if (meta.issue) entry.issue = Number(meta.issue) || meta.issue;
      items.push(entry);
    }
  }

  items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return {
    updatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
}

// =========================================================================
// 主請求路由處理器
// =========================================================================
export default async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const origin = req.headers.get("origin") || "";
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return jsonResp(req, { ok: false, message: "不允許的跨來源存取 (Origin Rejected)" }, 403);
  }

  const url = new URL(req.url);
  const subPath = url.pathname.replace(/^\/api\/cloud-studio/, "") || "/";
  const pwSalt = Netlify.env.get("STUDIO_PW_SALT") || "";
  const pwHash = Netlify.env.get("STUDIO_PW_HASH") || "";
  const totpSecret = Netlify.env.get("STUDIO_TOTP_SECRET") || "";
  const jwtSecret = Netlify.env.get("STUDIO_JWT_SECRET") || "";
  const isConfigured = Boolean(pwSalt && pwHash && totpSecret && jwtSecret);

  try {
    // 1. 認證狀態查詢
    if (req.method === "GET" && subPath === "/auth/status") {
      const check = verifyJwt(req, false);
      return jsonResp(req, {
        ok: true,
        mode: "cloud",
        configured: isConfigured,
        authenticated: check.ok,
        csrfToken: check.csrf || "",
      });
    }

    // 2. 嚴謹雙重認證登入 (PBKDF2-SHA256 60萬次迭代 + TOTP 六位數動態驗證碼)
    if (req.method === "POST" && subPath === "/auth/login") {
      const ip = req.headers.get("x-nf-client-connection-ip") || "unknown";
      const rec = failedByIp.get(ip);
      const nowMs = Date.now();
      if (rec && rec.lockUntil > nowMs) {
        const waitSec = Math.ceil((rec.lockUntil - nowMs) / 1000);
        return jsonResp(req, { ok: false, message: `嘗試失敗過多，雲端保護已鎖定，請於 ${waitSec} 秒後再試。` }, 429);
      }

      if (!isConfigured) {
        return jsonResp(
          req,
          {
            ok: false,
            message: "雲端雙重驗證金鑰尚未綁定。請先於你的 Mac 本機開啟 http://localhost:8788/studio.html 完成首次掃碼與主密碼設定，系統即會自動將加密雜湊同步至雲端。",
          },
          403
        );
      }

      const body = await req.json();
      const password = String(body.password || "");
      const secondFactor = String(body.secondFactor || "").trim().toUpperCase();

      const derived = crypto.pbkdf2Sync(
        Buffer.from(password, "utf-8"),
        Buffer.from(pwSalt, "hex"),
        PBKDF2_ITERATIONS,
        32,
        "sha256"
      );
      const expected = Buffer.from(pwHash, "hex");
      const pwValid = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);

      let factor2Valid = verifyTotp(totpSecret, secondFactor);
      if (!factor2Valid && secondFactor) {
        const recoveryCsv = Netlify.env.get("STUDIO_RECOVERY_HASHES") || "";
        const candHash = crypto.createHash("sha256").update(secondFactor).digest("hex");
        for (const saved of recoveryCsv.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (
            saved.length === candHash.length &&
            crypto.timingSafeEqual(Buffer.from(saved), Buffer.from(candHash))
          ) {
            factor2Valid = true;
            break;
          }
        }
      }

      if (!pwValid || !factor2Valid) {
        await new Promise((r) => setTimeout(r, 650));
        const prevCount = (rec?.count || 0) + 1;
        failedByIp.set(ip, {
          count: prevCount >= 5 ? 0 : prevCount,
          lockUntil: prevCount >= 5 ? Date.now() + 15 * 60 * 1000 : 0,
        });
        return jsonResp(req, { ok: false, message: "主管理密碼或 6 位數動態驗證碼不正確。" }, 401);
      }

      failedByIp.delete(ip);
      const signed = signJwt(jwtSecret);
      return jsonResp(req, { ok: true, token: signed.token, csrfToken: signed.csrf, expiresAt: signed.expiresAt });
    }

    if (req.method === "POST" && subPath === "/auth/logout") {
      return jsonResp(req, { ok: true });
    }

    // ── 以下所有資料讀寫端點皆強制檢查雙重驗證簽章 JWT ──────────────────────
    const auth = verifyJwt(req, req.method !== "GET");
    if (!auth.ok) {
      return jsonResp(req, { ok: false, authRequired: true, message: auth.error || "未授權存取" }, 401);
    }

    // Bootstrap
    if (req.method === "GET" && subPath === "/bootstrap") {
      const [cfgRaw, themeRaw, manifestRaw, webFiles, media] = await Promise.all([
        readRepoTextFile("site.config.js"),
        readRepoTextFile("theme.config.json"),
        readRepoTextFile("content/manifest.json"),
        listEditableWebFilesFromRepo(),
        listUploadedMediaFromRepo(),
      ]);

      let config = {};
      const mCfg = cfgRaw.match(/window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (mCfg) config = JSON.parse(mCfg[1]);

      const theme = themeRaw ? JSON.parse(themeRaw) : {};
      const manifest = manifestRaw ? JSON.parse(manifestRaw) : { count: 0, items: [] };

      return jsonResp(req, {
        ok: true,
        mode: "cloud",
        csrfToken: auth.csrf,
        config,
        theme,
        manifest,
        webFiles,
        media,
        git: {
          initialized: true,
          changedCount: 0,
          remoteUrl: `https://github.com/${GITHUB_REPO}.git`,
        },
      });
    }

    // 讀取媒體清單
    if (req.method === "GET" && subPath === "/media") {
      return jsonResp(req, { ok: true, media: await listUploadedMediaFromRepo() });
    }

    // 站長專屬私密點閱統計（強制通過雲端 2FA JWT 驗證，並以伺服器端私密金鑰向 Google Workspace 調閱）
    if (req.method === "GET" && subPath === "/analytics") {
      const analyticsKey = Netlify.env.get("STUDIO_ANALYTICS_KEY") || "";
      if (!analyticsKey) {
        return jsonResp(req, { ok: false, message: "雲端尚未設定 STUDIO_ANALYTICS_KEY 私密金鑰" }, 400);
      }
      const cfgRaw = await readRepoTextFile("site.config.js");
      const mCfg = cfgRaw.match(/window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      const cfg = mCfg ? JSON.parse(mCfg[1]) : {};
      const scriptUrl = String(cfg?.newsletter?.googleScriptUrl || "").trim();
      if (!scriptUrl) {
        return jsonResp(req, { ok: false, message: "尚未設定 Google Apps Script 網址" }, 400);
      }
      const gsRes = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: "analytics_summary", analyticsKey }),
      });
      const gsData = await gsRes.json();
      return jsonResp(req, gsData, gsData.ok ? 200 : 400);
    }

    if (req.method === "POST" && subPath === "/analytics/test-ping") {
      const cfgRaw = await readRepoTextFile("site.config.js");
      const mCfg = cfgRaw.match(/window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      const cfg = mCfg ? JSON.parse(mCfg[1]) : {};
      const scriptUrl = String(cfg?.newsletter?.googleScriptUrl || "").trim();
      if (!scriptUrl) {
        return jsonResp(req, { ok: false, message: "尚未設定 Google Apps Script 網址" }, 400);
      }
      const gsRes = await fetch(scriptUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "pageview",
          route: "#/",
          title: "首頁 · 書齋總覽（雲端工作台驗證）",
          pageType: "首頁",
          visitorHash: "owner-cloud-verify",
          referrer: "站長儀表板測試",
          device: "desktop",
          host: "deediaoyeh.github.io",
        }),
      });
      const gsData = await gsRes.json();
      return jsonResp(req, gsData, gsData.ok ? 200 : 400);
    }

    // 讀取單篇文章
    if (req.method === "GET" && subPath === "/item") {
      const docType = url.searchParams.get("type") || "essay";
      const slug = url.searchParams.get("slug") || "";
      const folder = docType === "essay" ? "essays" : docType === "note" ? "notes" : "letters";
      const raw = await readRepoTextFile(`content/${folder}/${slug}.md`);
      if (!raw) return jsonResp(req, { ok: false, message: "找不到該篇內容" }, 404);
      const { meta, body } = parseFrontmatter(raw);
      return jsonResp(req, { ok: true, meta, body });
    }

    // 儲存文章並直接原子提交至 GitHub (自動觸發 GitHub Pages 與 Netlify 雙站更新)
    if (req.method === "POST" && subPath === "/item") {
      const data = await req.json();
      const meta = data.meta || {};
      const body = String(data.body || "");
      const oldSlug = String(data.originalSlug || "").trim();
      const oldType = String(data.originalType || "").trim();
      const docType = String(meta.type || "essay");
      const slug = String(meta.slug || "").replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
      if (!slug) return jsonResp(req, { ok: false, message: "請填寫英文網址代稱 (Slug)" }, 400);

      meta.slug = slug;
      meta.type = docType;
      const folder = docType === "essay" ? "essays" : docType === "note" ? "notes" : "letters";
      const relPath = `content/${folder}/${slug}.md`;
      const rawMd = composeMarkdown(meta, body);

      const deletes: string[] = [];
      let deletedRel: string | undefined;
      if (oldSlug && (oldSlug !== slug || (oldType && oldType !== docType))) {
        const prevFolder = (oldType || docType) === "essay" ? "essays" : (oldType || docType) === "note" ? "notes" : "letters";
        deletedRel = `content/${prevFolder}/${oldSlug}.md`;
        deletes.push(deletedRel);
      }

      const manifest = await buildUpdatedManifest({ path: relPath, rawMd }, deletedRel);
      await atomicCommitFiles(
        `cloud-studio: save ${docType}/${slug}`,
        [
          { path: relPath, contentUtf8: rawMd },
          { path: "content/manifest.json", contentUtf8: JSON.stringify(manifest, null, 2) + "\n" },
        ],
        deletes
      );

      return jsonResp(req, {
        ok: true,
        slug,
        type: docType,
        manifest,
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    // 刪除文章
    if (req.method === "DELETE" && subPath === "/item") {
      const docType = url.searchParams.get("type") || "essay";
      const slug = url.searchParams.get("slug") || "";
      const folder = docType === "essay" ? "essays" : docType === "note" ? "notes" : "letters";
      const targetRel = `content/${folder}/${slug}.md`;
      const manifest = await buildUpdatedManifest(undefined, targetRel);
      await atomicCommitFiles(
        `cloud-studio: delete ${docType}/${slug}`,
        [{ path: "content/manifest.json", contentUtf8: JSON.stringify(manifest, null, 2) + "\n" }],
        [targetRel]
      );
      return jsonResp(req, {
        ok: true,
        manifest,
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    // 儲存網站品牌與關於頁設定
    if (req.method === "POST" && subPath === "/config") {
      const data = await req.json();
      const cfgText =
        `/**\n * 網站全域設定檔 (site.config.js)\n */\nwindow.SITE_CONFIG = ` +
        JSON.stringify(data.config || {}, null, 2) +
        `;\n`;
      await atomicCommitFiles("cloud-studio: update site.config.js", [{ path: "site.config.js", contentUtf8: cfgText }]);
      return jsonResp(req, {
        ok: true,
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    // 儲存視覺主題
    if (req.method === "POST" && subPath === "/theme") {
      const data = await req.json();
      const t = data.theme || {};
      const css = `/* 由書齋雲端工作台產生 */\n:root,\n[data-theme="paper"] {\n  --bg-paper: ${t.bgPaper};\n  --bg-subtle: ${t.bgSubtle};\n  --bg-elevated: ${t.bgElevated || "#faf8f4"};\n  --ink-primary: ${t.inkPrimary};\n  --ink-secondary: ${t.inkSecondary};\n  --ink-muted: ${t.inkMuted || "#857f73"};\n  --accent: ${t.accent};\n  --accent-hover: ${t.inkPrimary};\n  --accent-moss: ${t.accentMoss};\n}\nbody {\n  font-size: ${Number(t.fontSize) || 16}px;\n  line-height: ${Number(t.lineHeight) || 1.8};\n}\n.site-shell {\n  max-width: ${Number(t.maxWidth) || 980}px;\n}\n`;
      await atomicCommitFiles("cloud-studio: update theme", [
        { path: "theme.config.json", contentUtf8: JSON.stringify(t, null, 2) + "\n" },
        { path: "theme.custom.css", contentUtf8: css },
      ]);
      return jsonResp(req, {
        ok: true,
        theme: t,
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    // 讀寫 HTML / CSS 檔案
    if (req.method === "GET" && subPath === "/web-file") {
      const rel = (url.searchParams.get("path") || "").replace(/^\/+/, "");
      if (!rel || rel.includes("..") || rel.startsWith("studio")) {
        return jsonResp(req, { ok: false, message: "不允許讀取此檔案" }, 400);
      }
      const content = await readRepoTextFile(rel);
      const isCore = ["index.html", "styles.css", "theme.custom.css", "app.js"].includes(rel);
      return jsonResp(req, { ok: true, path: rel, content, isCore });
    }

    if (req.method === "POST" && subPath === "/web-file") {
      const data = await req.json();
      const rel = String(data.path || "").trim().replace(/^\/+/, "");
      if (!rel || rel.includes("..") || rel.startsWith("studio") || !/\.(html|css)$/i.test(rel)) {
        return jsonResp(req, { ok: false, message: "不允許寫入此路徑" }, 400);
      }
      await atomicCommitFiles(`cloud-studio: save ${rel}`, [{ path: rel, contentUtf8: String(data.content || "") }]);
      return jsonResp(req, {
        ok: true,
        path: rel,
        webFiles: await listEditableWebFilesFromRepo(),
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    if (req.method === "DELETE" && subPath === "/web-file") {
      const rel = (url.searchParams.get("path") || "").replace(/^\/+/, "");
      if (["index.html", "styles.css", "theme.custom.css", "app.js"].includes(rel)) {
        return jsonResp(req, { ok: false, message: "系統核心檔案不可刪除" }, 400);
      }
      await atomicCommitFiles(`cloud-studio: delete ${rel}`, [], [rel]);
      return jsonResp(req, {
        ok: true,
        webFiles: await listEditableWebFilesFromRepo(),
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    // 上傳照片或拖曳檔案 (直接提交進 GitHub assets/uploads/)
    if (req.method === "POST" && subPath === "/upload") {
      const data = await req.json();
      const rawName = String(data.filename || "upload.bin").trim();
      const dot = rawName.lastIndexOf(".");
      const ext = dot >= 0 ? rawName.slice(dot).toLowerCase() : "";
      if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
        return jsonResp(req, { ok: false, message: `不支援上傳 ${ext || "無副檔名"} 檔案格式` }, 400);
      }
      const stem =
        rawName
          .slice(0, dot >= 0 ? dot : rawName.length)
          .replace(/[^\w\u4e00-\u9fa5\-]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 50) || "file";
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(8, 14);
      const finalName = `${stem}-${stamp}${ext}`;

      let b64 = String(data.dataBase64 || "");
      if (b64.startsWith("data:") && b64.includes(",")) {
        b64 = b64.split(",", 2)[1];
      }
      const byteSize = Buffer.from(b64, "base64").length;

      await atomicCommitFiles(`cloud-studio: upload ${finalName}`, [
        { path: `assets/uploads/${finalName}`, contentBase64: b64 },
      ]);

      return jsonResp(req, {
        ok: true,
        filename: finalName,
        url: `./assets/uploads/${finalName}`,
        size: byteSize,
        sizeLabel: formatSize(byteSize),
        ext: ext.slice(1).toUpperCase(),
        kind: classifyExt(ext),
        media: await listUploadedMediaFromRepo(),
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    // 雲端模式下支援貼上 Google Drive 分享連結直接匯入檔案至網站媒體櫃
    if (req.method === "POST" && subPath === "/gdrive/import-link") {
      const data = await req.json();
      const driveUrl = String(data.driveUrl || "").trim();
      const customName = String(data.filename || "").trim();
      const idMatch = driveUrl.match(/\/d\/([a-zA-Z0-9_-]{15,})/) || driveUrl.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
      if (!idMatch) {
        return jsonResp(req, { ok: false, message: "無法從連結解析 Google Drive 檔案 ID" }, 400);
      }
      const fileId = idMatch[1];
      const isDoc = driveUrl.includes("docs.google.com/document");
      const dlUrl = isDoc
        ? `https://docs.google.com/document/d/${fileId}/export?format=pdf`
        : `https://drive.google.com/uc?export=download&id=${fileId}`;

      const dlRes = await fetch(dlUrl);
      if (!dlRes.ok) {
        return jsonResp(req, { ok: false, message: "無法下載此雲端檔案，請確認該連結已開啟「知道連結的任何人可檢視」或於本機工作台直接選取。" }, 400);
      }
      const arrBuf = await dlRes.arrayBuffer();
      const buf = Buffer.from(arrBuf);
      const contentType = dlRes.headers.get("content-type") || "";
      if (contentType.includes("text/html") && !isDoc) {
        return jsonResp(req, { ok: false, message: "此 Google Drive 檔案尚未開放連結讀取權限（若不開放公開權限，可於 Mac 本機工作台免公開直接匯入）。" }, 400);
      }

      let ext = isDoc ? ".pdf" : ".jpg";
      if (customName && customName.includes(".")) {
        ext = "." + customName.split(".").pop()!.toLowerCase();
      } else if (contentType.includes("png")) ext = ".png";
      else if (contentType.includes("webp")) ext = ".webp";
      else if (contentType.includes("pdf")) ext = ".pdf";

      const baseStem = (customName ? customName.replace(/\.[^.]+$/, "") : `gdrive-${fileId.slice(0, 8)}`).replace(
        /[^\w\u4e00-\u9fa5\-]+/g,
        "-"
      );
      const finalName = `${baseStem}${ext}`;

      await atomicCommitFiles(`cloud-studio: import ${finalName} from Drive`, [
        { path: `assets/uploads/${finalName}`, contentBase64: buf.toString("base64") },
      ]);

      return jsonResp(req, {
        ok: true,
        filename: finalName,
        url: `./assets/uploads/${finalName}`,
        size: buf.length,
        sizeLabel: formatSize(buf.length),
        ext: ext.slice(1).toUpperCase(),
        kind: classifyExt(ext),
        media: await listUploadedMediaFromRepo(),
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    if (req.method === "POST" && subPath === "/sync") {
      return jsonResp(req, {
        ok: true,
        output: "✓ 雲端工作台每次按下「儲存 ⌘S」皆已直接原子寫入 GitHub 主站，並自動觸發 GitHub Pages 與 Netlify 備份站同步部署！",
        git: { initialized: true, changedCount: 0, remoteUrl: `https://github.com/${GITHUB_REPO}.git` },
      });
    }

    return jsonResp(req, { ok: false, message: `未知的雲端 API 路徑：${subPath}` }, 404);
  } catch (err: any) {
    return jsonResp(req, { ok: false, message: err?.message || "伺服器處理錯誤" }, 500);
  }
};

export const config = {
  path: "/api/cloud-studio/*",
};
