/**
 * studio-analytics.js — 站長專屬私密點閱儀表板控制器
 * 僅在通過 PBKDF2-SHA256 + TOTP 雙重驗證之工作台內執行；
 * 透過伺服器端私密金鑰 (STUDIO_ANALYTICS_KEY) 代理讀取 Google Workspace 點閱統計，外部訪客完全無法存取。
 */
(function () {
  "use strict";

  const EXCLUDE_KEY = "deediao_owner_exclude_analytics";
  let loadedOnce = false;
  let isLoading = false;

  function bridge() {
    return window.__STUDIO_BRIDGE__;
  }

  function initAnalyticsDashboard() {
    // 預設在站長工作台所在瀏覽器開啟「排除自己的瀏覽」，避免站長日常巡檢灌水
    const chk = document.getElementById("analytics-exclude-self-chk");
    if (chk) {
      if (localStorage.getItem(EXCLUDE_KEY) === null) {
        localStorage.setItem(EXCLUDE_KEY, "1");
      }
      chk.checked = localStorage.getItem(EXCLUDE_KEY) === "1";
      chk.addEventListener("change", () => {
        localStorage.setItem(EXCLUDE_KEY, chk.checked ? "1" : "0");
        bridge()?.setStatus(
          chk.checked ? "✓ 已設定在此瀏覽器排除站長本人的前台瀏覽" : "已允許此瀏覽器計入前台點閱統計",
          "is-saved"
        );
      });
    }

    document.querySelectorAll('[data-tab="analytics"]').forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        if (!loadedOnce) {
          loadAnalyticsData();
        }
      });
    });

    document.getElementById("analytics-refresh-btn")?.addEventListener("click", () => {
      loadAnalyticsData();
    });

    document.getElementById("analytics-test-ping-btn")?.addEventListener("click", async () => {
      const btn = document.getElementById("analytics-test-ping-btn");
      btn.disabled = true;
      bridge()?.setStatus("正在發送一筆測試點閱紀錄至雲端統計表⋯");
      try {
        const res = await fetch("/api/studio/analytics/test-ping", { method: "POST", body: "{}" });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.message || "測試點閱發送失敗");
        }
        bridge()?.setStatus("✓ 測試點閱已寫入！正在刷新儀表板⋯", "is-saved");
        await loadAnalyticsData();
      } catch (err) {
        showBanner(`發送測試點閱失敗：${err.message}`, true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function showBanner(msg, isError = false) {
    const el = document.getElementById("analytics-alert-banner");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.className = `analytics-banner ${isError ? "is-error" : ""}`;
    el.textContent = msg;
  }

  async function loadAnalyticsData() {
    if (isLoading) return;
    isLoading = true;
    const refreshBtn = document.getElementById("analytics-refresh-btn");
    if (refreshBtn) refreshBtn.disabled = true;
    showBanner("");
    document.getElementById("analytics-updated-at").textContent = "正在從雲端安全調閱數據⋯";

    try {
      const res = await fetch(`/api/studio/analytics?t=${Date.now()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message || "無法取得點閱統計資料");
      }
      loadedOnce = true;
      renderDashboard(data);
      const tStr = new Date().toLocaleTimeString("zh-TW", { hour12: false });
      document.getElementById("analytics-updated-at").textContent = `最後更新：${tStr}`;
    } catch (err) {
      showBanner(`無法載入點閱統計：${err.message}`, true);
      document.getElementById("analytics-updated-at").textContent = "讀取失敗";
    } finally {
      isLoading = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function renderDashboard(data) {
    const tot = data.totals || {};
    document.getElementById("kpi-total-views").textContent = fmtNum(tot.totalViews || 0);
    document.getElementById("kpi-today-views").textContent = `今日新增 +${fmtNum(tot.todayViews || 0)} 次`;

    document.getElementById("kpi-unique-visitors").textContent = fmtNum(tot.uniqueVisitors || 0);
    document.getElementById("kpi-today-visitors").textContent = `今日不重複訪客 ${fmtNum(tot.todayVisitors || 0)} 人`;

    const avgDwellEl = document.getElementById("kpi-avg-dwell");
    const totalReadEl = document.getElementById("kpi-total-read-time");
    if (avgDwellEl) {
      avgDwellEl.textContent = tot.avgDwellSec > 0 ? fmtDuration(tot.avgDwellSec) : "累積計算中";
    }
    if (totalReadEl) {
      totalReadEl.textContent = `累計總停留 ${fmtTotalDuration(tot.totalDwellSec || 0)}`;
    }

    document.getElementById("kpi-7d-views").textContent = fmtNum(tot.last7dViews || 0);
    document.getElementById("kpi-30d-views").textContent = `近 7 日點閱（近 30 日 ${fmtNum(tot.last30dViews || 0)} 次）`;

    document.getElementById("kpi-active-subs").textContent = fmtNum(tot.activeSubscribers || 0);
    document.getElementById("kpi-total-subs").textContent = `總累計名單 ${fmtNum(tot.totalSubscribers || 0)} 人`;

    if (data.sheetUrl) {
      const link = document.getElementById("analytics-sheet-link");
      if (link) link.href = data.sheetUrl;
    }

    renderDailyChart(data.dailySeries || []);
    renderTopPages(data.topPages || [], tot.totalViews || 0);
    renderReferrers(data.referrers || [], tot.totalViews || 0);
    renderDevices(data.devices || {}, tot.totalViews || 0);
    renderRecentVisits(data.recentVisits || []);
  }

  function renderDailyChart(series) {
    const wrap = document.getElementById("analytics-daily-chart");
    if (!wrap) return;
    if (!series.length) {
      wrap.innerHTML = `<div class="analytics-empty">尚無近期點閱趨勢紀錄</div>`;
      return;
    }
    const maxViews = Math.max(1, ...series.map((d) => d.views || 0));
    wrap.innerHTML = series
      .map((d) => {
        const pct = Math.max(d.views > 0 ? 8 : 2, Math.round(((d.views || 0) / maxViews) * 100));
        return `
          <div class="chart-col" title="${esc(d.fullDate)}：${d.views} 次點閱 / ${d.visitors} 位不重複訪客">
            <span class="chart-val mono-label">${d.views > 0 ? d.views : ""}</span>
            <div class="chart-bar-track">
              <div class="chart-bar-fill ${d.views > 0 ? "has-data" : ""}" style="height:${pct}%;"></div>
            </div>
            <span class="chart-date mono-label">${esc(d.label)}</span>
          </div>
        `;
      })
      .join("");
  }

  function renderTopPages(pages, totalViews) {
    const wrap = document.getElementById("analytics-top-pages");
    if (!wrap) return;
    if (!pages.length) {
      wrap.innerHTML = `<div class="analytics-empty">目前尚無頁面點閱紀錄。可點擊右上角「＋ 發送測試點閱」測試連線，或用手機開啟公開網站瀏覽。</div>`;
      return;
    }
    const maxV = Math.max(1, pages[0]?.views || 1);
    wrap.innerHTML = pages
      .map((p) => {
        const widthPct = Math.max(4, Math.round((p.views / maxV) * 100));
        const sharePct = totalViews > 0 ? Math.round((p.views / totalViews) * 100) : 0;
        const href = p.route.startsWith("#") ? `./${p.route}` : `./#/${p.route}`;
        const dwellLabel = p.avgDwellSec > 0 ? ` · ⏱ 平均停留 ${fmtDuration(p.avgDwellSec)}` : "";
        return `
          <div class="rank-row">
            <div class="rank-top">
              <div class="rank-title-group">
                <span class="rank-badge mono-label">${esc(p.pageType || "頁面")}</span>
                <a href="${esc(href)}" target="_blank" rel="noopener noreferrer" class="rank-title">${esc(
          p.title || p.route
        )}</a>
              </div>
              <span class="rank-metrics mono-label"><strong>${fmtNum(p.views)}</strong> 次 · ${fmtNum(
          p.visitors
        )} 人 (${sharePct}%)${esc(dwellLabel)}</span>
            </div>
            <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${widthPct}%;"></div></div>
          </div>
        `;
      })
      .join("");
  }

  function renderReferrers(refs, totalViews) {
    const wrap = document.getElementById("analytics-referrers");
    if (!wrap) return;
    if (!refs.length) {
      wrap.innerHTML = `<div class="analytics-empty">尚無來源紀錄</div>`;
      return;
    }
    const maxC = Math.max(1, refs[0]?.count || 1);
    wrap.innerHTML = refs
      .map((r) => {
        const widthPct = Math.max(4, Math.round((r.count / maxC) * 100));
        const sharePct = totalViews > 0 ? Math.round((r.count / totalViews) * 100) : 0;
        return `
          <div class="rank-row compact">
            <div class="rank-top">
              <span class="rank-title">${esc(r.source)}</span>
              <span class="rank-metrics mono-label"><strong>${fmtNum(r.count)}</strong> (${sharePct}%)</span>
            </div>
            <div class="rank-bar-bg"><div class="rank-bar-fill moss" style="width:${widthPct}%;"></div></div>
          </div>
        `;
      })
      .join("");
  }

  function renderDevices(dev, totalViews) {
    const wrap = document.getElementById("analytics-devices");
    if (!wrap) return;
    const rows = [
      { label: "桌面電腦 (Desktop)", count: dev.desktop || 0 },
      { label: "行動手機 (Mobile)", count: dev.mobile || 0 },
      { label: "平板裝置 (Tablet)", count: dev.tablet || 0 }
    ];
    const maxC = Math.max(1, ...rows.map((r) => r.count));
    wrap.innerHTML = rows
      .map((r) => {
        const widthPct = r.count > 0 ? Math.max(4, Math.round((r.count / maxC) * 100)) : 0;
        const sharePct = totalViews > 0 ? Math.round((r.count / totalViews) * 100) : 0;
        return `
          <div class="rank-row compact">
            <div class="rank-top">
              <span class="rank-title">${esc(r.label)}</span>
              <span class="rank-metrics mono-label"><strong>${fmtNum(r.count)}</strong> (${sharePct}%)</span>
            </div>
            <div class="rank-bar-bg"><div class="rank-bar-fill" style="width:${widthPct}%;"></div></div>
          </div>
        `;
      })
      .join("");
  }

  function renderRecentVisits(visits) {
    const tbody = document.getElementById("analytics-recent-tbody");
    if (!tbody) return;
    if (!visits.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="color:var(--ink-muted); text-align:center; padding:24px;">目前尚無訪客造訪紀錄</td></tr>`;
      return;
    }
    tbody.innerHTML = visits
      .map((v) => {
        const timeText = formatVisitTime(v.timestamp);
        const deviceLabel = v.device === "mobile" ? "手機" : v.device === "tablet" ? "平板" : "桌機";
        const dwellSec = Number(v.dwellSec || 0);
        const dwellCell =
          dwellSec > 0
            ? `<strong style="color:var(--accent-moss, #485643);">${esc(fmtDuration(dwellSec))}</strong>`
            : `<span style="color:var(--ink-muted);">瀏覽中 / 短暫</span>`;
        return `
          <tr>
            <td class="mono-label" style="white-space:nowrap; font-size:0.78rem;">${esc(timeText)}</td>
            <td><span class="rank-badge mono-label">${esc(v.pageType || "頁面")}</span></td>
            <td><strong>${esc(v.title || v.route)}</strong> <span class="mono-label" style="color:var(--ink-muted); font-size:0.74rem;">${esc(
          v.route
        )}</span></td>
            <td class="mono-label" style="white-space:nowrap; font-size:0.8rem;">${dwellCell}</td>
            <td>${esc(v.referrer || "直接造訪")}</td>
            <td class="mono-label" style="font-size:0.78rem;">${esc(deviceLabel)}</td>
          </tr>
        `;
      })
      .join("");
  }

  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s < 60) return `${s} 秒`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}分 ${String(rem).padStart(2, "0")}秒` : `${m} 分鐘`;
  }

  function fmtTotalDuration(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    if (s === 0) return "0 秒";
    if (s < 60) return `${s} 秒`;
    const totalMin = Math.floor(s / 60);
    if (totalMin < 60) return `${totalMin} 分 ${s % 60} 秒`;
    const hr = Math.floor(totalMin / 60);
    const remMin = totalMin % 60;
    return `${hr} 小時 ${remMin} 分`;
  }

  function formatVisitTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 19);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString("en-US");
  }

  function esc(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.addEventListener("DOMContentLoaded", initAnalyticsDashboard);
})();
