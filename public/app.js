const STATUS_TEXT = {
  success: "在线",
  quota_limited: "受限",
  auth_error: "需登录",
  disabled: "停用",
  failed: "异常",
  unknown: "等待"
};

const REASON_TEXT = {
  scheduled: "自动",
  startup: "启动",
  manual: "手动"
};

const PLAN_TEXT = {
  free: "ChatGPT Free",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  prolite: "Pro Lite",
  team: "ChatGPT Team",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu"
};

const ICONS = {
  "refresh-cw": '<path d="M3 12a9 9 0 0 1 15-6.7"/><path d="M21 3v6h-6"/><path d="M21 12a9 9 0 0 1-15 6.7"/><path d="M3 21v-6h6"/>',
  "sliders-horizontal": '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M14 4a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z"/><path d="M21 12h-9"/><path d="M8 12H3"/><path d="M12 12a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z"/><path d="M21 20h-5"/><path d="M12 20H3"/><path d="M16 20a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z"/>',
  "timer-reset": '<path d="M10 2h4"/><path d="M12 14v-4"/><path d="M4 13a8 8 0 1 0 2.3-5.7"/><path d="M4 7v6h6"/>',
  "calendar-clock": '<path d="M21 14V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h8"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><circle cx="18" cy="18" r="4"/><path d="M18 16v2l1 1"/>',
  "trash-2": '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  "file-text": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v6h6"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8A2 2 0 0 1 21 8.8V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'
};

let state = null;
let codexUsageState = null;
let codexUsageMonth = "";
let toastTimer = null;
let historyViewMode = "week";
let historyCursorDate = new Date();
let historyCursorInitialized = false;
let historyListExpanded = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  refreshState({ quiet: true });
  refreshCodexUsage({ quiet: true });
  setInterval(() => refreshState({ quiet: true }), 30000);
  setInterval(() => refreshCodexUsage({ quiet: true }), 5 * 60 * 1000);
});

function wireEvents() {
  $("#refreshButton").addEventListener("click", () => refreshUsage("manual"));
  $("#codexUsageRefreshButton").addEventListener("click", () => refreshCodexUsage({ force: true }));
  $("#codexUsageReportButton").addEventListener("click", generateCodexUsageReport);
  $("#codexMonthSelect").addEventListener("change", (event) => {
    codexUsageMonth = event.target.value;
    renderCodexUsage();
  });
  $("#settingsButton").addEventListener("click", openSettings);
  $("#closeSettingsButton").addEventListener("click", closeSettings);
  $("#cancelSettingsButton").addEventListener("click", closeSettings);
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#clearButton").addEventListener("click", clearHistory);
  $("#exportButton").addEventListener("click", exportData);
  $("#prevPeriodButton").addEventListener("click", () => shiftHistoryPeriod(-1));
  $("#nextPeriodButton").addEventListener("click", () => shiftHistoryPeriod(1));
  $("#toggleHistoryListButton").addEventListener("click", toggleHistoryList);
  for (const button of $$(".view-tab")) {
    button.addEventListener("click", () => setHistoryView(button.dataset.view));
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function refreshState({ quiet = false } = {}) {
  try {
    state = await api("/api/state");
    render();
    if (!quiet) showToast("状态已同步");
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshUsage(reason) {
  const button = $("#refreshButton");
  button.disabled = true;
  button.classList.add("spinning");
  try {
    state = await api("/api/refresh", {
      method: "POST",
      body: JSON.stringify({ reason })
    });
    render();
    showToast("用量已同步");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove("spinning");
  }
}

async function refreshCodexUsage({ quiet = false, force = false } = {}) {
  const button = $("#codexUsageRefreshButton");
  if (button) {
    button.disabled = true;
    button.classList.add("spinning");
  }
  try {
    codexUsageState = await api(force ? "/api/codex-usage/refresh" : "/api/codex-usage", {
      method: force ? "POST" : "GET"
    });
    renderCodexUsage();
    if (!quiet) showToast(codexUsageState.message || "Token 数据已同步");
  } catch (error) {
    codexUsageState = {
      status: "error",
      generatedAt: new Date().toISOString(),
      message: error.message,
      report: null
    };
    renderCodexUsage();
    showToast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("spinning");
    }
  }
}

async function generateCodexUsageReport() {
  const button = $("#codexUsageReportButton");
  const reportWindow = window.open("about:blank", "_blank");
  if (reportWindow) {
    reportWindow.opener = null;
    reportWindow.document.title = "Codex Token 报告";
    reportWindow.document.body.textContent = "正在生成报告...";
  }
  button.disabled = true;
  try {
    const result = await api("/api/codex-usage/report", { method: "POST" });
    if (result.status !== "ok") throw new Error(result.message || "报告生成失败");
    await refreshCodexUsage({ quiet: true });
    if (reportWindow) reportWindow.location.href = result.reportUrl;
    else window.location.href = result.reportUrl;
    showToast("Token 报告已生成");
  } catch (error) {
    if (reportWindow) reportWindow.close();
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

function render() {
  if (!state) return;
  applyTheme();
  renderHeader();
  renderWindowCards();
  renderHistory();
  renderCodexUsage();
  syncIcons();
}

function applyTheme() {
  const appearance = state.config.appearance || {};
  document.documentElement.style.setProperty("--accent", appearance.accentColor || "#f0f0fa");
  document.documentElement.dataset.density = appearance.density || "comfortable";
  document.documentElement.dataset.motion = appearance.reduceMotion ? "reduced" : "full";
}

function renderHeader() {
  const computed = state.computed || {};
  const latest = computed.latestCheck;
  const status = computed.status || "unknown";
  const rawPlan = latest?.planType || computed.quota?.planType || state.config.account?.planName;
  const account = latest?.account || computed.account || {};
  $("#statusBadge").textContent = STATUS_TEXT[status] || status;
  $("#statusBadge").className = `status-badge ${status}`;
  $("#planBadge").textContent = formatPlanName(rawPlan);
  $("#planBadge").title = rawPlan ? `plan_type: ${rawPlan}` : "";
  $("#userBadge").textContent = formatUserName(account);
  $("#userBadge").title = account.email || account.name || account.userId || "";
  $("#lastSync").textContent = latest ? formatDateTime(latest.at) : "--";
  $("#nextRun").textContent = computed.nextRunAt ? formatDateTime(computed.nextRunAt) : "关闭";
}

function renderWindowCards() {
  const quota = state.computed.quota || {};
  renderWindow("primary", quota.primaryWindow);
  renderWindow("secondary", quota.secondaryWindow);
}

function renderWindow(prefix, window) {
  const remaining = window?.remainingPercent;
  const used = window?.usedPercent;
  $(`#${prefix}Remaining`).textContent = formatPercent(remaining);
  $(`#${prefix}Meter`).style.width = `${safePercent(remaining)}%`;
  $(`#${prefix}Used`).textContent = formatPercent(used);
  $(`#${prefix}Reset`).textContent = window?.resetAfterLabel || formatDateTime(window?.resetAt);
}

function renderCodexUsage() {
  const select = $("#codexMonthSelect");
  const status = codexUsageState?.status || "loading";
  const report = codexUsageState?.report || null;
  $("#codexUsageStatus").textContent = codexUsageStatusText(codexUsageState);
  $(".token-panel").dataset.status = status;
  $("#codexUsageReportButton").disabled = !state?.config?.codexUsage?.enabled;

  if (!report) {
    select.innerHTML = `<option>--</option>`;
    select.disabled = true;
    setCodexMetricValues("--", "--", "--", "--", "--", "--");
    $("#codexCostNote").textContent = codexCostNote(report);
    $("#codexDailyList").innerHTML = `<div class="empty-state">Token 数据暂不可用</div>`;
    $("#codexSourceList").innerHTML = `<div class="empty-state">Token 数据暂不可用</div>`;
    $("#codexModelList").innerHTML = `<div class="empty-state">Token 数据暂不可用</div>`;
    $("#codexTopSessions").innerHTML = `<div class="empty-state">${escapeHtml(codexUsageState?.message || "等待 Token 数据")}</div>`;
    $("#codexSessionCount").textContent = "默认收起";
    return;
  }

  const monthViews = Array.isArray(report.month_views) ? report.month_views : [];
  const selectedView = selectCodexMonthView(report, monthViews);
  renderCodexMonthSelect(select, monthViews, selectedView?.month || "");
  const summary = report.summary || {};
  const today = findTodayUsage(selectedView?.days || []);
  setCodexMetricValues(
    summary.cost_estimate?.range_display || "--",
    selectedView?.cost_estimate?.range_display || "--",
    today?.cost_estimate?.range_display || "--",
    summary.total_tokens_display || "--",
    selectedView?.tokens_display || "--",
    selectedView ? `${formatInteger(selectedView.threads)} / ${selectedView?.avg_display || "--"}` : "--"
  );
  $("#codexCostNote").innerHTML = codexCostNote(report);
  $("#codexDailyList").innerHTML = renderCodexDaily(selectedView?.days || []);
  $("#codexSourceList").innerHTML = renderCodexBars(selectedView?.sources || report.sources || [], "source");
  $("#codexModelList").innerHTML = renderCodexBars(selectedView?.models || report.models || [], "model");
  const sessions = selectedView?.top_sessions || report.top_sessions || [];
  $("#codexSessionCount").textContent = `${sessions.length} 个 · 默认收起`;
  $("#codexTopSessions").innerHTML = renderCodexSessions(sessions);
}

function codexUsageStatusText(value) {
  if (!value) return "等待同步";
  const generated = value.generatedAt ? ` · ${formatDateTime(value.generatedAt)}` : "";
  const labels = {
    ok: "已同步",
    stale: "显示缓存",
    disabled: "已停用",
    unavailable: "不可用",
    error: "异常",
    loading: "同步中"
  };
  return `${labels[value.status] || value.status || "未知"}${generated} · ${value.message || ""}`.replace(/\s+·\s+$/, "");
}

function selectCodexMonthView(report, monthViews) {
  if (!monthViews.length) return null;
  const available = new Set(monthViews.map((item) => item.month));
  if (!available.has(codexUsageMonth)) {
    codexUsageMonth = report.default_month && available.has(report.default_month)
      ? report.default_month
      : monthViews.at(-1).month;
  }
  return monthViews.find((item) => item.month === codexUsageMonth) || monthViews.at(-1);
}

function renderCodexMonthSelect(select, monthViews, selectedMonth) {
  select.disabled = monthViews.length === 0;
  select.innerHTML = monthViews.map((item) => {
    const label = formatMonthLabel(item.month);
    const selected = item.month === selectedMonth ? " selected" : "";
    return `<option value="${escapeAttr(item.month)}"${selected}>${escapeHtml(label)}</option>`;
  }).join("");
}

function setCodexMetricValues(totalCost, monthCost, todayCost, totalTokens, monthTokens, threads) {
  $("#codexTotalCost").textContent = totalCost;
  $("#codexMonthCost").textContent = monthCost;
  $("#codexTodayCost").textContent = todayCost;
  $("#codexTotalTokens").textContent = totalTokens;
  $("#codexMonthTokens").textContent = monthTokens;
  $("#codexMonthThreads").textContent = threads;
}

function codexCostNote(report) {
  const source = report?.pricing?.source;
  if (!source) return "费用按 OpenAI 官方输入/输出价格估算。";
  return `价格源：<a href="${escapeAttr(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.name)}</a> · ${escapeHtml(source.checkedAt || "")} · ${escapeHtml(source.note)}`;
}

function findTodayUsage(days) {
  const key = localDateKey(new Date());
  return (Array.isArray(days) ? days : []).find((day) => day.day === key) || null;
}

function renderCodexDaily(days) {
  const visible = (Array.isArray(days) ? days : [])
    .filter((day) => Number(day.tokens) > 0)
    .slice(-14);
  if (!visible.length) return `<div class="empty-state">本月暂无日消耗数据</div>`;
  const width = 960;
  const height = 300;
  const left = 64;
  const right = 26;
  const top = 26;
  const bottom = 54;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const baseY = top + chartHeight;
  const maxTokens = Math.max(...visible.map((day) => Number(day.tokens) || 0), 1);
  const yMax = maxTokens * 1.12;
  const points = visible.map((day, index) => {
    const x = visible.length === 1
      ? left + chartWidth / 2
      : left + index * chartWidth / (visible.length - 1);
    const y = baseY - ((Number(day.tokens) || 0) / yMax) * chartHeight;
    return { day, x, y };
  });
  const linePath = points.map((point, index) => `${index ? "L" : "M"} ${svgNumber(point.x)} ${svgNumber(point.y)}`).join(" ");
  const areaPath = `${linePath} L ${svgNumber(points.at(-1).x)} ${svgNumber(baseY)} L ${svgNumber(points[0].x)} ${svgNumber(baseY)} Z`;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = baseY - ratio * chartHeight;
    const value = Math.round(yMax * ratio);
    return `
      <g>
        <line x1="${left}" y1="${svgNumber(y)}" x2="${width - right}" y2="${svgNumber(y)}"></line>
        <text x="${left - 14}" y="${svgNumber(y + 4)}">${escapeHtml(formatCompactTokens(value))}</text>
      </g>
    `;
  }).join("");
  const labelStep = Math.max(1, Math.ceil(visible.length / 7));
  const labels = points.map((point, index) => {
    if (index % labelStep !== 0 && index !== points.length - 1) return "";
    return `<text x="${svgNumber(point.x)}" y="${height - 18}" text-anchor="middle">${escapeHtml(formatDayLabel(point.day.day))}</text>`;
  }).join("");
  const markers = points.map((point) => `
    <g class="token-daily-point">
      <circle cx="${svgNumber(point.x)}" cy="${svgNumber(point.y)}" r="5"></circle>
      <title>${escapeHtml(`${formatDayLabel(point.day.day)} · ${point.day.tokens_display || "--"} · ${point.day.cost_estimate?.range_display || "--"} · ${formatInteger(point.day.threads)} 会话`)}</title>
    </g>
  `).join("");
  const topDay = visible.reduce((best, day) => Number(day.tokens) > Number(best.tokens) ? day : best, visible[0]);
  const today = findTodayUsage(visible) || visible.at(-1);
  const totalTokens = visible.reduce((sum, day) => sum + (Number(day.tokens) || 0), 0);
  const totalLow = visible.reduce((sum, day) => sum + (Number(day.cost_estimate?.low_usd) || 0), 0);
  const totalHigh = visible.reduce((sum, day) => sum + (Number(day.cost_estimate?.high_usd) || 0), 0);

  return `
    <div class="token-daily-chart">
      <svg class="token-daily-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="每日 Token 消耗折线图">
        <g class="token-daily-grid">${grid}</g>
        <path class="token-daily-area" d="${escapeAttr(areaPath)}"></path>
        <path class="token-daily-line" d="${escapeAttr(linePath)}"></path>
        <g class="token-daily-markers">${markers}</g>
        <g class="token-daily-labels">${labels}</g>
      </svg>
      <div class="token-daily-summary">
        ${dailySummaryItem("峰值", `${formatDayLabel(topDay.day)} · ${topDay.tokens_display || "--"}`, topDay.cost_estimate?.range_display || "--")}
        ${dailySummaryItem("今日", `${formatDayLabel(today.day)} · ${today.tokens_display || "--"}`, today.cost_estimate?.range_display || "--")}
        ${dailySummaryItem("近 14 次", formatCompactTokens(totalTokens), `${formatUsdRange(totalLow, totalHigh)} · ${visible.length} 天`)}
      </div>
    </div>
  `;
}

function dailySummaryItem(label, value, note) {
  return `
    <span>
      <b>${escapeHtml(label)}</b>
      <strong>${escapeHtml(value)}</strong>
      <em>${escapeHtml(note)}</em>
    </span>
  `;
}

function renderCodexBars(items, labelKey) {
  const visible = (Array.isArray(items) ? items : []).slice(0, 5);
  if (!visible.length) return `<div class="empty-state">暂无分布数据</div>`;
  return visible.map((item) => {
    const label = labelKey === "model"
      ? [item.model || "unknown", item.provider].filter(Boolean).join(" · ")
      : item.source || "unknown";
    const share = Math.max(0, Math.min(100, Number(item.share_pct) || 0));
    return `
      <div class="token-bar">
        <div>
          <strong>${escapeHtml(label)}</strong>
          <span>${escapeHtml(item.tokens_display || "--")} · ${escapeHtml(item.cost_estimate?.range_display || "--")} · ${escapeHtml(formatInteger(item.threads))} 会话</span>
        </div>
        <b>${escapeHtml(item.share_display || `${Math.round(share)}%`)}</b>
        <i><em style="width:${share}%"></em></i>
      </div>
    `;
  }).join("");
}

function renderCodexSessions(sessions) {
  const visible = (Array.isArray(sessions) ? sessions : []).slice(0, 6);
  if (!visible.length) return `<div class="empty-state">暂无高消耗会话</div>`;
  return visible.map((session) => {
    const title = String(session.title || "未命名会话").trim() || "未命名会话";
    const model = [session.model || "unknown", session.provider].filter(Boolean).join(" · ");
    return `
      <article class="token-session">
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(model)} · ${escapeHtml(session.source || "unknown")} · ${escapeHtml(session.cost_estimate?.range_display || "--")} · ${escapeHtml(session.created || "--")}</span>
        </div>
        <b>${escapeHtml(session.tokens_display || "--")}</b>
      </article>
    `;
  }).join("");
}

function renderHistory() {
  const checks = getChecksByTime();
  if (!historyCursorInitialized && checks.length) {
    historyCursorDate = new Date(checks.at(-1).at);
    historyCursorInitialized = true;
  }
  const period = getHistoryPeriod(historyViewMode, historyCursorDate);
  const periodChecks = checks.filter((check) => {
    const date = new Date(check.at);
    return date >= period.start && date < period.end;
  });
  renderHistoryControls(period);
  renderHistoryChart(periodChecks, period);
  renderHistoryList(periodChecks.slice().reverse());
}

function getChecksByTime() {
  return (state.checks || [])
    .filter((check) => check && check.at)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function renderHistoryControls(period) {
  $("#historyRangeLabel").textContent = formatPeriodLabel(period);
  for (const button of $$(".view-tab")) {
    const selected = button.dataset.view === historyViewMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  }
}

function renderHistoryChart(checks, period) {
  const chart = $("#historyChart");
  chart.className = `history-chart ${period.mode}-chart`;
  if (period.mode === "month") {
    chart.innerHTML = renderMonthCalendar(checks, period);
    return;
  }
  const buckets = period.mode === "day"
    ? buildDayBuckets(checks, period)
    : buildWeekBuckets(checks, period);
  chart.innerHTML = buckets.map(renderHistoryBucket).join("");
}

function buildWeekBuckets(checks, period) {
  const labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return Array.from({ length: 7 }, (_, index) => {
    const start = addDays(period.start, index);
    const end = addDays(start, 1);
    return {
      label: labels[index],
      sublabel: formatShortDate(start),
      check: lastCheckInRange(checks, start, end)
    };
  });
}

function buildDayBuckets(checks, period) {
  return Array.from({ length: 12 }, (_, index) => {
    const start = new Date(period.start.getTime() + index * 2 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
    return {
      label: `${pad2(index * 2)}:00`,
      sublabel: `${pad2(index * 2)}-${pad2(index * 2 + 2)}`,
      check: lastCheckInRange(checks, start, end)
    };
  });
}

function lastCheckInRange(checks, start, end) {
  let last = null;
  for (const check of checks) {
    const date = new Date(check.at);
    if (date >= start && date < end) last = check;
  }
  return last;
}

function renderHistoryBucket(bucket) {
  const check = bucket.check;
  if (!check) {
    return `
      <div class="history-bucket empty">
        <span class="bucket-bars"></span>
        <span class="bucket-label">${escapeHtml(bucket.label)}</span>
        <small>${escapeHtml(bucket.sublabel)}</small>
      </div>
    `;
  }
  const primary = check.usage?.primaryWindow;
  const secondary = check.usage?.secondaryWindow;
  const p = safePercent(primary?.remainingPercent);
  const s = safePercent(secondary?.remainingPercent);
  const title = `${bucket.label} ${bucket.sublabel} · ${formatFullDateTime(check.at)} · 5H ${formatPercent(p)} · WEEK ${formatPercent(s)}`;
  return `
    <button class="history-bucket ${escapeAttr(check.status)}" type="button" aria-label="${escapeAttr(title)}">
      <span class="bucket-bars">
        <i class="bar-primary" style="height:${p}%"></i>
        <i class="bar-secondary" style="height:${s}%"></i>
      </span>
      <span class="point-dot"></span>
      <span class="bucket-label">${escapeHtml(bucket.label)}</span>
      <small>${escapeHtml(bucket.sublabel)}</small>
      ${renderPointTooltip(check)}
    </button>
  `;
}

function renderMonthCalendar(checks, period) {
  const dayNames = ["一", "二", "三", "四", "五", "六", "日"];
  const days = [];
  const leading = (period.start.getDay() || 7) - 1;
  for (let i = 0; i < leading; i += 1) days.push(`<div class="calendar-day blank"></div>`);
  for (let date = new Date(period.start); date < period.end; date = addDays(date, 1)) {
    const start = new Date(date);
    const end = addDays(start, 1);
    days.push(renderCalendarDay(start, lastCheckInRange(checks, start, end)));
  }
  return `
    <div class="calendar-weekdays">
      ${dayNames.map((day) => `<span>${day}</span>`).join("")}
    </div>
    <div class="calendar-grid">
      ${days.join("")}
    </div>
  `;
}

function renderCalendarDay(date, check) {
  if (!check) {
    return `
      <div class="calendar-day empty">
        <span>${date.getDate()}</span>
        <i class="calendar-ring empty-ring"></i>
      </div>
    `;
  }
  const primary = check.usage?.primaryWindow;
  const secondary = check.usage?.secondaryWindow;
  const p = safePercent(primary?.remainingPercent);
  const s = safePercent(secondary?.remainingPercent);
  const title = `${formatDateOnly(date)} · ${formatFullDateTime(check.at)} · 5H ${formatPercent(p)} · WEEK ${formatPercent(s)}`;
  return `
    <button class="calendar-day has-data ${escapeAttr(check.status)}" type="button" aria-label="${escapeAttr(title)}">
      <span>${date.getDate()}</span>
      <i class="calendar-ring" style="--primary:${p}; --secondary:${s}">
        <em></em>
      </i>
      ${renderPointTooltip(check)}
    </button>
  `;
}

function renderPointTooltip(check) {
  const primary = check.usage?.primaryWindow;
  const secondary = check.usage?.secondaryWindow;
  const p = safePercent(primary?.remainingPercent);
  const s = safePercent(secondary?.remainingPercent);
  return `
    <span class="point-tooltip" role="presentation">
      <strong>${escapeHtml(formatFullDateTime(check.at))}</strong>
      <small>${escapeHtml(REASON_TEXT[check.reason] || check.reason || "手动")} · ${escapeHtml(STATUS_TEXT[check.status] || check.status)}</small>
      ${tooltipBar("5H", p, primary)}
      ${tooltipBar("WEEK", s, secondary)}
    </span>
  `;
}

function tooltipBar(label, remaining, window) {
  const used = safePercent(window?.usedPercent);
  return `
    <span class="tooltip-row">
      <span>${label}</span>
      <b>${formatPercent(remaining)}</b>
      <i><em style="width:${remaining}%"></em></i>
      <small>used ${formatPercent(used)} · reset ${escapeHtml(window?.resetAfterLabel || formatDateTime(window?.resetAt))}</small>
    </span>
  `;
}

function renderHistoryList(checks) {
  const toggle = $("#toggleHistoryListButton");
  toggle.hidden = checks.length <= 3;
  toggle.textContent = historyListExpanded ? "收起列表" : `展开列表 · ${checks.length}`;
  $("#historyList").classList.toggle("is-collapsed", !historyListExpanded);
  const visibleChecks = historyListExpanded ? checks : checks.slice(0, 3);
  $("#historyList").innerHTML = visibleChecks.length
    ? visibleChecks.map(renderHistoryRow).join("")
    : `<div class="empty-state">当前视图暂无同步历史</div>`;
}

function renderHistoryRow(check) {
  const primary = check.usage?.primaryWindow;
  const secondary = check.usage?.secondaryWindow;
  return `
    <article class="history-row ${escapeAttr(check.status)}">
      <div class="history-time">
        <time datetime="${escapeAttr(check.at)}">${escapeHtml(formatFullDateTime(check.at))}</time>
        <span>${escapeHtml(REASON_TEXT[check.reason] || check.reason || "手动")}</span>
      </div>
      <div class="history-values">
        ${historyValue("5H", primary)}
        ${historyValue("WEEK", secondary)}
      </div>
      <span class="history-state">${escapeHtml(STATUS_TEXT[check.status] || check.status)}</span>
    </article>
  `;
}

function historyValue(label, window) {
  const remaining = safePercent(window?.remainingPercent);
  return `
    <span class="history-value">
      <b>${label}</b>
      <strong>${formatPercent(remaining)}</strong>
      <i><em style="width:${remaining}%"></em></i>
      <small>used ${formatPercent(window?.usedPercent)} · reset ${escapeHtml(window?.resetAfterLabel || formatDateTime(window?.resetAt))}</small>
    </span>
  `;
}

function setHistoryView(view) {
  if (!["day", "week", "month"].includes(view)) return;
  historyViewMode = view;
  historyListExpanded = false;
  renderHistory();
  syncIcons();
}

function shiftHistoryPeriod(delta) {
  const next = new Date(historyCursorDate);
  if (historyViewMode === "day") next.setDate(next.getDate() + delta);
  if (historyViewMode === "week") next.setDate(next.getDate() + delta * 7);
  if (historyViewMode === "month") next.setMonth(next.getMonth() + delta);
  historyCursorDate = next;
  historyListExpanded = false;
  renderHistory();
  syncIcons();
}

function toggleHistoryList() {
  historyListExpanded = !historyListExpanded;
  renderHistory();
  syncIcons();
}

function getHistoryPeriod(mode, cursor) {
  const date = new Date(cursor);
  if (mode === "day") {
    const start = startOfDay(date);
    return { mode, start, end: addDays(start, 1) };
  }
  if (mode === "month") {
    const start = new Date(date.getFullYear(), date.getMonth(), 1);
    return { mode, start, end: new Date(date.getFullYear(), date.getMonth() + 1, 1) };
  }
  const start = startOfWeek(date);
  return { mode: "week", start, end: addDays(start, 7) };
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date) {
  const start = startOfDay(date);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatPeriodLabel(period) {
  if (period.mode === "day") return formatDateOnly(period.start);
  if (period.mode === "month") {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit" }).format(period.start);
  }
  return `${formatDateOnly(period.start)} - ${formatDateOnly(addDays(period.end, -1))}`;
}

function openSettings() {
  if (!state) return;
  fillSettingsForm(state.config);
  $("#settingsDialog").showModal();
  syncIcons();
}

function closeSettings() {
  $("#settingsDialog").close();
}

function fillSettingsForm(config) {
  const form = $("#settingsForm");
  for (const input of $$("input, select", form)) {
    if (!input.name) continue;
    const value = getByPath(config, input.name);
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value ?? "";
  }
}

function getByPath(object, path) {
  return path.split(".").reduce((cursor, part) => cursor?.[part], object);
}

async function saveSettings(event) {
  event.preventDefault();
  const config = structuredClone(state.config);
  for (const input of $$("input, select", $("#settingsForm"))) {
    if (!input.name) continue;
    setByPath(config, input.name, readInput(input));
  }
  try {
    state = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config })
    });
    closeSettings();
    render();
    refreshCodexUsage({ quiet: true, force: true });
    showToast("设置已保存");
  } catch (error) {
    showToast(error.message);
  }
}

function readInput(input) {
  if (input.type === "checkbox") return input.checked;
  if (input.type === "number") return Number(input.value);
  return input.value;
}

function setByPath(object, path, value) {
  const parts = path.split(".");
  let cursor = object;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ||= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

async function clearHistory() {
  if (!state?.checks?.length) return;
  if (!confirm("清空所有同步历史？")) return;
  try {
    state = await api("/api/checks", { method: "DELETE" });
    historyListExpanded = false;
    render();
    showToast("历史已清空");
  } catch (error) {
    showToast(error.message);
  }
}

async function exportData() {
  try {
    const data = await api("/api/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gpt-pro-monitor-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("数据已导出");
  } catch (error) {
    showToast(error.message);
  }
}

function formatPlanName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "--";
  const friendly = PLAN_TEXT[raw.toLowerCase()];
  return friendly || raw;
}

function formatUserName(account) {
  const name = String(account?.name || "").trim();
  if (name) return name;
  const email = String(account?.email || "").trim();
  if (email) return email.split("@")[0] || email;
  const userId = String(account?.userId || "").trim();
  if (userId) return userId.replace(/^user-/, "").slice(0, 12);
  return "--";
}

function safePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Math.round(Number(value))}%`;
}

function formatInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return new Intl.NumberFormat("zh-CN").format(number);
}

function formatCompactTokens(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 100_000_000) return `${trimNumber(number / 100_000_000, 2)}亿`;
  if (number >= 10_000) return `${trimNumber(number / 10_000, 2)}万`;
  return formatInteger(Math.round(number));
}

function formatUsdRange(low, high) {
  return `${formatUsd(low)}-${formatUsd(high)}`;
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "$0";
  if (number >= 1000) return `$${trimNumber(number / 1000, number >= 10000 ? 1 : 2)}K`;
  if (number >= 10) return `$${number.toFixed(2)}`;
  if (number >= 1) return `$${number.toFixed(3)}`;
  return `$${number.toFixed(4)}`;
}

function svgNumber(value) {
  return trimNumber(value, 3);
}

function trimNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number(number.toFixed(digits)).toString();
}

function formatMonthLabel(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value || "--";
  return `${match[1]}年${match[2]}月`;
}

function formatDayLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return value || "--";
  return `${match[2]}/${match[3]}`;
}

function localDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatFullDateTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function formatDateOnly(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function syncIcons() {
  for (const element of $$("i[data-lucide]")) {
    const name = element.dataset.lucide;
    const paths = ICONS[name];
    if (!paths || element.dataset.ready === "true") continue;
    element.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          ${paths}
        </g>
      </svg>
    `;
    element.dataset.ready = "true";
  }
}
