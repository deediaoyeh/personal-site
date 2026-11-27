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
  let latestData = null;
  let hourlyMode = "30d"; // "30d" | "today"
  let subStatusFilter = "all"; // "all" | "active" | "pending" | "unsubscribed"
  let subSearchQuery = "";

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

    // 背景安靜檢查讀者新回應：工作台開啟後與每 5 分鐘一次，於「站台點閱」分頁標籤顯示紅色提醒
    setTimeout(() => loadAnalyticsData({ silent: true }), 2500);
    setInterval(() => {
      if (!document.hidden) loadAnalyticsData({ silent: true });
    }, 5 * 60 * 1000);

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

    // 分時閱覽模式切換（近 30 日各時段 vs 今日各時段）
    document.querySelectorAll("[data-hourly-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        hourlyMode = btn.getAttribute("data-hourly-mode") || "30d";
        document.querySelectorAll("[data-hourly-mode]").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
        if (latestData) {
          renderHourlySection(latestData.hourlySeries || []);
        }
      });
    });

    // 電子報訂戶狀態篩選
    document.querySelectorAll("[data-sub-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        subStatusFilter = btn.getAttribute("data-sub-filter") || "all";
        document.querySelectorAll("[data-sub-filter]").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
        });
        if (latestData) {
          renderSubscribersSection(latestData.subscribers || [], latestData.totals || {});
        }
      });
    });

    // 電子報訂戶關鍵字搜尋
    document.getElementById("subs-search-input")?.addEventListener("input", (e) => {
      subSearchQuery = String(e.target.value || "").trim().toLowerCase();
      if (latestData) {
        renderSubscribersSection(latestData.subscribers || [], latestData.totals || {});
      }
    });

    // 一鍵複製所有有效訂戶 Email
    document.getElementById("copy-active-subs-btn")?.addEventListener("click", async () => {
      const subs = (latestData?.subscribers || []).filter((s) => s.status === "active");
      if (!subs.length) {
        bridge()?.setStatus("目前尚無已確認 (active) 的有效訂戶信箱可複製");
        return;
      }
      const text = subs.map((s) => s.email).join(", ");
      try {
        await navigator.clipboard.writeText(text);
        bridge()?.setStatus(`✓ 已複製 ${subs.length} 位有效訂戶 Email 至剪貼簿`, "is-saved");
      } catch (_) {
        showBanner("瀏覽器未允許剪貼簿權限，請改按「匯出 CSV」下載名單。", true);
      }
    });

    // 匯出訂戶名單 CSV（含防試算表公式注入保護）
    document.getElementById("export-subs-csv-btn")?.addEventListener("click", () => {
      const subs = getFilteredSubscribers(latestData?.subscribers || []);
      if (!subs.length) {
        bridge()?.setStatus("目前篩選條件下沒有訂戶資料可匯出");
        return;
      }
      const csvSafe = (val) => {
        let s = String(val ?? "").replace(/"/g, '""');
        if (/^[=+\-@'"\t\r\n]/.test(s.trimStart())) {
          s = "'" + s;
        }
        return `"${s}"`;
      };
      const lines = [
        ["序號", "Email", "狀態", "訂閱或確認時間", "來源頁面"].map(csvSafe).join(","),
        ...subs.map((s, idx) =>
          [
            idx + 1,
            s.email,
            statusLabelText(s.status),
            formatVisitTime(s.subscribedAt),
            s.source || "#/"
          ]
            .map(csvSafe)
            .join(",")
        )
      ];
      const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      bridge()?.setStatus(`✓ 已匯出 ${subs.length} 筆訂戶名單 CSV`, "is-saved");
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

  async function loadAnalyticsData(opts = {}) {
    const silent = !!opts.silent;
    if (isLoading) return;
    isLoading = true;
    const refreshBtn = document.getElementById("analytics-refresh-btn");
    if (refreshBtn) refreshBtn.disabled = true;
    if (!silent) {
      showBanner("");
      document.getElementById("analytics-updated-at").textContent = "正在從雲端安全調閱數據⋯";
    }

    try {
      const res = await fetch(`/api/studio/analytics?t=${Date.now()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message || "無法取得點閱統計資料");
      }
      loadedOnce = true;
      latestData = data;
      renderDashboard(data);
      const tStr = new Date().toLocaleTimeString("zh-TW", { hour12: false });
      document.getElementById("analytics-updated-at").textContent = `最後更新：${tStr}`;
    } catch (err) {
      if (!silent) {
        showBanner(`無法載入點閱統計：${err.message}`, true);
        document.getElementById("analytics-updated-at").textContent = "讀取失敗";
      }
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
    const pendingCnt = Number(tot.pendingSubscribers || 0);
    document.getElementById("kpi-total-subs").textContent =
      pendingCnt > 0
        ? `總名單 ${fmtNum(tot.totalSubscribers || 0)} 人（待確認 ${fmtNum(pendingCnt)}）`
        : `總累計名單 ${fmtNum(tot.totalSubscribers || 0)} 人`;

    if (data.sheetUrl) {
      const link = document.getElementById("analytics-sheet-link");
      if (link) link.href = data.sheetUrl;
    }

    renderDailyChart(data.dailySeries || []);
    renderHourlySection(data.hourlySeries || []);
    renderTopPages(data.topPages || [], tot.totalViews || 0);
    renderReferrers(data.referrers || [], tot.totalViews || 0);
    renderDevices(data.devices || {}, tot.totalViews || 0);
    renderFeedbacksSection(data.readerFeedbacks || [], tot);
    renderSubscribersSection(data.subscribers || [], tot);
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

  function renderHourlySection(rawSeries) {
    const wrap = document.getElementById("analytics-hourly-chart");
    const periodWrap = document.getElementById("analytics-hourly-periods");
    const peakEl = document.getElementById("hourly-peak-summary");
    if (!wrap) return;

    // 補齊 00..23 共 24 小時欄位
    const series = [];
    for (let h = 0; h < 24; h++) {
      const found = rawSeries.find((item) => Number(item.hour) === h) || {};
      series.push({
        hour: h,
        label: found.label || String(h).padStart(2, "0"),
        visitors: Number(hourlyMode === "today" ? found.todayVisitors || 0 : found.visitors || 0),
        views: Number(hourlyMode === "today" ? found.todayViews || 0 : found.views || 0),
        avgDwellSec: Number(found.avgDwellSec || 0)
      });
    }

    const maxVisitors = Math.max(1, ...series.map((s) => s.visitors));
    let peakItem = null;
    for (const s of series) {
      if (s.visitors > 0 && (!peakItem || s.visitors > peakItem.visitors || (s.visitors === peakItem.visitors && s.views > peakItem.views))) {
        peakItem = s;
      }
    }

    if (peakEl) {
      if (peakItem) {
        const nextHr = String((peakItem.hour + 1) % 24).padStart(2, "0");
        peakEl.textContent = `尖峰時段 ${peakItem.label}:00–${nextHr}:00 · ${fmtNum(peakItem.visitors)} 人 / ${fmtNum(peakItem.views)} 次`;
      } else {
        peakEl.textContent = hourlyMode === "today" ? "今日尚無分時閱覽紀錄" : "尚無分時閱覽紀錄";
      }
    }

    wrap.innerHTML = series
      .map((s) => {
        const pct = Math.max(s.visitors > 0 ? 10 : 2, Math.round((s.visitors / maxVisitors) * 100));
        const isPeak = Boolean(peakItem && s.hour === peakItem.hour && s.visitors > 0);
        const dwellHint = s.avgDwellSec > 0 ? ` · 平均停留 ${fmtDuration(s.avgDwellSec)}` : "";
        const tip = `${s.label}:00–${s.label}:59｜閱覽人數 ${s.visitors} 人 · 點閱 ${s.views} 次${dwellHint}`;
        return `
          <div class="hourly-col" title="${esc(tip)}">
            <span class="chart-val mono-label">${s.visitors > 0 ? `${s.visitors}人` : ""}</span>
            <div class="hourly-bar-track">
              <div class="hourly-bar-fill ${s.visitors > 0 ? "has-data" : ""} ${isPeak ? "is-peak" : ""}" style="height:${pct}%;"></div>
            </div>
            <span class="chart-date mono-label">${esc(s.label)}時</span>
          </div>
        `;
      })
      .join("");

    if (periodWrap) {
      const periods = [
        { name: "深夜清晨 (00:00–05:59)", start: 0, end: 5 },
        { name: "上午時段 (06:00–11:59)", start: 6, end: 11 },
        { name: "午後時段 (12:00–17:59)", start: 12, end: 17 },
        { name: "晚間閱讀 (18:00–23:59)", start: 18, end: 23 }
      ];
      const totalPersonSlots = series.reduce((acc, s) => acc + s.visitors, 0);
      periodWrap.innerHTML = periods
        .map((p) => {
          const slice = series.filter((s) => s.hour >= p.start && s.hour <= p.end);
          const pVisitors = slice.reduce((acc, s) => acc + s.visitors, 0);
          const pViews = slice.reduce((acc, s) => acc + s.views, 0);
          const share = totalPersonSlots > 0 ? Math.round((pVisitors / totalPersonSlots) * 100) : 0;
          return `
            <div class="period-summary-card">
              <span class="period-summary-label mono-label">${esc(p.name)}</span>
              <div class="period-summary-val"><strong>${fmtNum(pVisitors)}</strong> 人次 <span class="mono-label" style="font-size:0.76rem; color:var(--ink-muted);">· ${fmtNum(pViews)} 次點閱 (${share}%)</span></div>
            </div>
          `;
        })
        .join("");
    }
  }

  function getFilteredSubscribers(allSubs) {
    return allSubs.filter((s) => {
      if (subStatusFilter !== "all" && s.status !== subStatusFilter) return false;
      if (subSearchQuery) {
        const hay = `${s.email || ""} ${s.source || ""}`.toLowerCase();
        if (!hay.includes(subSearchQuery)) return false;
      }
      return true;
    });
  }

  function statusLabelText(status) {
    if (status === "active") return "✓ 有效訂戶";
    if (status === "unsubscribed") return "已退訂";
    return "⏳ 待信箱確認";
  }

  function renderSubscribersSection(allSubs, totals) {
    const summaryEl = document.getElementById("subs-status-summary");
    const tbody = document.getElementById("analytics-subscribers-tbody");
    if (summaryEl) {
      const activeCnt = Number(totals.activeSubscribers ?? allSubs.filter((s) => s.status === "active").length);
      const pendingCnt = Number(totals.pendingSubscribers ?? allSubs.filter((s) => s.status === "pending").length);
      const unsubCnt = Number(totals.unsubscribedSubscribers ?? allSubs.filter((s) => s.status === "unsubscribed").length);
      summaryEl.textContent = `有效訂戶 ${fmtNum(activeCnt)} 人 · 待信箱確認 ${fmtNum(pendingCnt)} 人 · 已退訂 ${fmtNum(unsubCnt)} 人（共 ${fmtNum(allSubs.length)} 筆）`;
    }
    if (!tbody) return;

    const filtered = getFilteredSubscribers(allSubs);
    if (!filtered.length) {
      const emptyMsg = allSubs.length === 0 ? "目前尚無電子報訂閱紀錄" : "沒有符合目前篩選條件的訂戶";
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--ink-muted); text-align:center; padding:24px;">${esc(emptyMsg)}</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered
      .map((s, idx) => {
        const st = s.status === "active" ? "is-active" : s.status === "unsubscribed" ? "is-unsubscribed" : "is-pending";
        return `
          <tr>
            <td class="mono-label" style="color:var(--ink-muted); font-size:0.76rem;">${idx + 1}</td>
            <td class="mono-label" style="font-weight:500;">${esc(s.email)}</td>
            <td><span class="sub-status-pill mono-label ${st}">${esc(statusLabelText(s.status))}</span></td>
            <td class="mono-label" style="white-space:nowrap; font-size:0.78rem;">${esc(formatVisitTime(s.subscribedAt))}</td>
            <td class="mono-label" style="font-size:0.78rem; color:var(--ink-secondary);">${esc(s.source || "#/")}</td>
          </tr>
        `;
      })
      .join("");
  }

  const FEEDBACK_SEEN_KEY = "deediao_owner_feedback_seen_at";

  function feedbackTimeMs(f) {
    const t = Date.parse(f && f.timestamp);
    return Number.isFinite(t) ? t : 0;
  }

  function getFeedbackSeenAt() {
    return Number(localStorage.getItem(FEEDBACK_SEEN_KEY) || 0);
  }

  function getNewFeedbacks(feedbacks) {
    const seenAt = getFeedbackSeenAt();
    return (feedbacks || []).filter((f) => feedbackTimeMs(f) > seenAt);
  }

  function updateFeedbackTabBadge(newCount) {
    const badge = document.getElementById("analytics-tab-badge");
    if (!badge) return;
    if (newCount > 0) {
      badge.hidden = false;
      badge.textContent = `${newCount} 則新回應`;
      badge.title = `有 ${newCount} 則讀者新回應尚未查看`;
    } else {
      badge.hidden = true;
      badge.textContent = "";
    }
  }

  function markFeedbacksSeen() {
    const all = latestData?.readerFeedbacks || [];
    const newest = all.reduce((m, f) => Math.max(m, feedbackTimeMs(f)), 0);
    localStorage.setItem(FEEDBACK_SEEN_KEY, String(Math.max(newest, Date.now())));
    renderFeedbacksSection(all, latestData?.totals || {});
    bridge()?.setStatus("✓ 已將讀者回應標記為已讀", "is-saved");
  }

  function renderFeedbacksSection(feedbacks, totals) {
    const summaryEl = document.getElementById("feedback-status-summary");
    const tbody = document.getElementById("analytics-feedbacks-tbody");
    const alertEl = document.getElementById("feedback-new-alert");
    const boxEl = document.getElementById("feedback-inbox-box");
    const sorted = [...(feedbacks || [])].sort((a, b) => feedbackTimeMs(b) - feedbackTimeMs(a));
    const fresh = getNewFeedbacks(sorted);
    const freshSet = new Set(fresh);

    updateFeedbackTabBadge(fresh.length);
    if (boxEl) boxEl.classList.toggle("has-new", fresh.length > 0);

    if (summaryEl) {
      summaryEl.textContent = `全站累計點亮共鳴 ${fmtNum(totals.totalResonances || 0)} 次 · 收到私密回饋 ${fmtNum(
        totals.totalFeedbacks ?? sorted.length
      )} 則${fresh.length ? ` · 其中 ${fresh.length} 則尚未讀` : ""}`;
    }

    if (alertEl) {
      if (fresh.length) {
        const latest = fresh[0];
        const who = latest.sender || "一位匿名讀者";
        const where = latest.title || latest.route || "你的文章";
        const preview = String(latest.message || "").replace(/\s+/g, " ").slice(0, 60);
        alertEl.hidden = false;
        alertEl.innerHTML = `
          <div class="feedback-new-alert-icon" aria-hidden="true">🔔</div>
          <div class="feedback-new-alert-body">
            <div class="feedback-new-alert-title">有讀者回應你了！共 ${fresh.length} 則新的悄悄話尚未查看</div>
            <div class="feedback-new-alert-desc">最新一則：<strong>${esc(who)}</strong> 在〈${esc(where)}〉留言（${esc(
              formatVisitTime(latest.timestamp)
            )}）${preview ? `：「${esc(preview)}${String(latest.message || "").length > 60 ? "⋯" : ""}」` : ""}</div>
          </div>
          <button type="button" class="studio-btn studio-btn-primary feedback-mark-read-btn">✓ 我看過了，標記已讀</button>
        `;
        alertEl.querySelector(".feedback-mark-read-btn")?.addEventListener("click", markFeedbacksSeen);
      } else {
        alertEl.hidden = true;
        alertEl.innerHTML = "";
      }
    }

    if (!tbody) return;
    if (!sorted.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="color:var(--ink-muted); text-align:center; padding:22px;">目前尚無讀者悄悄話回饋（讀者於文章底部送出後將私密顯示於此）</td></tr>`;
      return;
    }
    tbody.innerHTML = sorted
      .map((f) => {
        const isNew = freshSet.has(f);
        return `
          <tr class="${isNew ? "feedback-row-new" : ""}">
            <td class="mono-label" style="white-space:nowrap; font-size:0.78rem;">${
              isNew ? '<span class="feedback-new-tag">NEW</span>' : ""
            }${esc(formatVisitTime(f.timestamp))}</td>
            <td><strong>${esc(f.title || f.route)}</strong></td>
            <td class="mono-label" style="font-size:0.8rem; color:var(--accent, #6e5039);">${esc(f.sender || "匿名讀者")}</td>
            <td style="white-space:pre-wrap; line-height:1.6;">${esc(f.message)}</td>
          </tr>
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
        const resLabel = p.resonances > 0 ? ` · 🕯️ 共鳴 ${fmtNum(p.resonances)}` : "";
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
        )} 人 (${sharePct}%)${esc(dwellLabel)}${esc(resLabel)}</span>
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
