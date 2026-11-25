/**
 * netlify/functions/live-data.mts
 * 公開唯讀「準即時內容同步端點」(/api/live-data)
 *
 * 目的：
 * 消除 GitHub Pages (30–60 秒建置 + CDN 快取) 與 Netlify (20–45 秒建置) 的更新延遲。
 * 只要本機或雲端工作台一推上 GitHub main 分支，此端點立刻取得最新 Commit SHA，
 * 並透過不可變 SHA 網址 (raw.githubusercontent.com/.../<sha>/...) 零快取延遲回傳最新：
 *   - site.config.js (門面品牌 / 關於近況 / 電子報設定)
 *   - theme.custom.css (視覺配色與字級)
 *   - content/manifest.json (文章、筆記與電子報索引)
 *   - 任意 content/*.md 單篇內容
 */

declare const Netlify: {
  env: {
    get(key: string): string | undefined;
  };
};

const GITHUB_REPO = "deediaoyeh/personal-site";
const GITHUB_BRANCH = "main";

function buildHeaders(contentType = "application/json; charset=utf-8"): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Netlify-CDN-Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  };
}

async function getLatestMainSha(): Promise<string> {
  const pat = Netlify.env.get("STUDIO_GITHUB_PAT") || "";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Deediao-Live-Data/1.0",
    "Cache-Control": "no-cache",
  };
  if (pat) {
    headers["Authorization"] = `Bearer ${pat}`;
  }

  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/git/ref/heads/${GITHUB_BRANCH}`,
    { headers }
  );
  if (!res.ok) {
    throw new Error(`GitHub ref 查詢失敗 (${res.status})`);
  }
  const data = (await res.json()) as { object?: { sha?: string } };
  const sha = data?.object?.sha;
  if (!sha) {
    throw new Error("無法取得最新 main 分支 SHA");
  }
  return sha;
}

async function fetchRawAtSha(sha: string, relPath: string): Promise<string | null> {
  const clean = relPath.replace(/^\/+/, "");
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${sha}/${clean}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Deediao-Live-Data/1.0" },
  });
  if (!res.ok) return null;
  return res.text();
}

export default async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: buildHeaders("text/plain") });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ ok: false, message: "Method Not Allowed" }), {
      status: 405,
      headers: buildHeaders(),
    });
  }

  try {
    const url = new URL(req.url);
    const shaOnly = url.searchParams.get("shaOnly") === "1";
    const reqPath = (url.searchParams.get("path") || "").trim().replace(/^\.?\//, "");

    const sha = await getLatestMainSha();
    const rawBase = `https://raw.githubusercontent.com/${GITHUB_REPO}/${sha}`;

    // 輕量版本檢查模式（前端輪詢 / 切回分頁時使用，僅 ~100ms）
    if (shaOnly) {
      return new Response(JSON.stringify({ ok: true, sha, rawBase }), {
        status: 200,
        headers: buildHeaders(),
      });
    }

    // 單篇 Markdown 檔案即時讀取模式
    if (reqPath) {
      if (!reqPath.startsWith("content/") || !reqPath.endsWith(".md") || reqPath.includes("..")) {
        return new Response(JSON.stringify({ ok: false, message: "不允許讀取此路徑" }), {
          status: 400,
          headers: buildHeaders(),
        });
      }
      const mdText = await fetchRawAtSha(sha, reqPath);
      if (mdText === null) {
        return new Response("Not Found", { status: 404, headers: buildHeaders("text/plain; charset=utf-8") });
      }
      return new Response(mdText, {
        status: 200,
        headers: buildHeaders("text/markdown; charset=utf-8"),
      });
    }

    // 完整即時啟動資料包（平行拉取最新 config、theme、manifest）
    const [cfgRaw, themeCss, manifestRaw] = await Promise.all([
      fetchRawAtSha(sha, "site.config.js"),
      fetchRawAtSha(sha, "theme.custom.css"),
      fetchRawAtSha(sha, "content/manifest.json"),
    ]);

    let config: unknown = null;
    if (cfgRaw) {
      const m = cfgRaw.match(/window\.SITE_CONFIG\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
      if (m) {
        config = JSON.parse(m[1]);
      }
    }

    const manifest = manifestRaw ? JSON.parse(manifestRaw) : null;

    return new Response(
      JSON.stringify({
        ok: true,
        sha,
        rawBase,
        config,
        themeCss: themeCss || "",
        manifest,
      }),
      { status: 200, headers: buildHeaders() }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ ok: false, message: err?.message || "無法讀取即時資料" }),
      { status: 500, headers: buildHeaders() }
    );
  }
};

export const config = {
  path: "/api/live-data",
};
