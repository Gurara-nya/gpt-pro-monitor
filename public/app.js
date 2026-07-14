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
let codexSessionQuery = "";
let codexSessionMonth = "all";
let codexSessionSort = "tokens_desc";
let codexSessionPage = 1;
let codexSessionState = null;
let codexSessionLoading = false;
let codexSessionError = "";
let codexSessionSearchTimer = null;
let codexSessionAbortController = null;
let codexActiveTab = localStorage.getItem("gpt-monitor-codex-tab") === "sessions" ? "sessions" : "overview";
let selectedUsageUserId = localStorage.getItem("gpt-monitor-usage-user") || "";
let selectedDeviceId = localStorage.getItem("gpt-monitor-device") || "all";
let deviceSettingsState = [];
let settingsUsageUserId = "";
let toastTimer = null;
let historyViewMode = "week";
let historyCursorDate = new Date();
let historyCursorInitialized = false;
let historyListExpanded = false;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const APP_BASE_PATH = detectAppBasePath();
const CODEX_SESSION_MOBILE = window.matchMedia("(max-width: 560px)");

document.addEventListener("DOMContentLoaded", () => {
  wireEvents();
  setCodexTab(codexActiveTab, { load: false });
  refreshState({ quiet: true });
  refreshCodexUsage({ quiet: true });
  setInterval(() => refreshState({ quiet: true }), 30000);
});

function wireEvents() {
  $("#refreshButton").addEventListener("click", () => refreshUsage("manual"));
  $("#usageUserSelect").addEventListener("change", (event) => selectUsageUser(event.target.value));
  $("#deviceSelect").addEventListener("change", (event) => selectDevice(event.target.value));
  $("#codexUsageRefreshButton").addEventListener("click", () => refreshCodexUsage({ force: true }));
  $("#codexUsageReportButton").addEventListener("click", generateCodexUsageReport);
  $("#codexMonthSelect").addEventListener("change", (event) => {
    codexUsageMonth = event.target.value;
    renderCodexUsage();
  });
  $("#codexOverviewTab").addEventListener("click", () => setCodexTab("overview"));
  $("#codexSessionsTab").addEventListener("click", () => setCodexTab("sessions"));
  $(".token-tabs").addEventListener("keydown", handleCodexTabKeydown);
  $("#codexSessionSearch").addEventListener("input", (event) => {
    codexSessionQuery = event.target.value;
    codexSessionPage = 1;
    clearTimeout(codexSessionSearchTimer);
    codexSessionSearchTimer = setTimeout(() => refreshCodexSessions({ quiet: true }), 250);
  });
  $("#codexSessionMonthFilter").addEventListener("change", (event) => {
    codexSessionMonth = event.target.value;
    codexSessionPage = 1;
    refreshCodexSessions({ quiet: true });
  });
  $("#codexSessionSort").addEventListener("change", (event) => {
    codexSessionSort = event.target.value;
    codexSessionPage = 1;
    refreshCodexSessions({ quiet: true });
  });
  $("#codexSessionPrevButton").addEventListener("click", () => {
    if (codexSessionPage <= 1) return;
    codexSessionPage -= 1;
    refreshCodexSessions({ quiet: true, scroll: true });
  });
  $("#codexSessionNextButton").addEventListener("click", () => {
    const totalPages = Number(codexSessionState?.pagination?.totalPages) || 1;
    if (codexSessionPage >= totalPages) return;
    codexSessionPage += 1;
    refreshCodexSessions({ quiet: true, scroll: true });
  });
  CODEX_SESSION_MOBILE.addEventListener?.("change", handleCodexSessionBreakpoint);
  $("#settingsButton").addEventListener("click", openSettings);
  $("#closeSettingsButton").addEventListener("click", closeSettings);
  $("#cancelSettingsButton").addEventListener("click", closeSettings);
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#settingsUsageUserSelect").addEventListener("change", (event) => {
    settingsUsageUserId = event.target.value;
    fillUsageUserSettings(getUsageUserById(settingsUsageUserId));
    refreshDeviceSettings();
  });
  $("#addUsageUserButton").addEventListener("click", addUsageUser);
  $("#addPricingOverrideButton").addEventListener("click", () => appendPricingOverrideRow());
  $("#createDeviceButton").addEventListener("click", createDevice);
  $("#codexDbUploadButton").addEventListener("click", uploadCodexDb);
  $("#sub2ApiKeySaveButton").addEventListener("click", saveSub2ApiKey);
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
  const response = await fetch(appUrl(path), {
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

function detectAppBasePath() {
  const script = document.currentScript || document.querySelector('script[src$="app.js"], script[src$="/app.js"]');
  if (!script?.src) return "";
  try {
    const scriptUrl = new URL(script.src, window.location.href);
    const path = scriptUrl.pathname.replace(/\/app\.js$/, "");
    return path === "/" ? "" : path.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function appUrl(path) {
  const value = String(path || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return value;
  const normalized = value.startsWith("/") ? value : `/${value}`;
  if (!APP_BASE_PATH || normalized === APP_BASE_PATH || normalized.startsWith(`${APP_BASE_PATH}/`)) {
    return normalized;
  }
  return `${APP_BASE_PATH}${normalized}`;
}

function preferredCodexSessionPageSize() {
  return CODEX_SESSION_MOBILE.matches ? 10 : 20;
}

function setCodexTab(tab, { load = true, focus = false } = {}) {
  codexActiveTab = tab === "sessions" ? "sessions" : "overview";
  localStorage.setItem("gpt-monitor-codex-tab", codexActiveTab);
  renderCodexTabs();
  if (focus) {
    $(`#codex${codexActiveTab === "sessions" ? "Sessions" : "Overview"}Tab`)?.focus();
  }
  if (load && codexActiveTab === "sessions") {
    const loadedUserId = codexSessionState?.user?.id;
    if (!codexSessionState || loadedUserId !== currentUsageUserId()) {
      refreshCodexSessions({ quiet: true });
    }
  }
}

function renderCodexTabs() {
  const overviewSelected = codexActiveTab === "overview";
  const overviewTab = $("#codexOverviewTab");
  const sessionsTab = $("#codexSessionsTab");
  const overviewPanel = $("#codexOverviewPanel");
  const sessionsPanel = $("#codexSessionsPanel");
  if (!overviewTab || !sessionsTab || !overviewPanel || !sessionsPanel) return;
  overviewTab.setAttribute("aria-selected", overviewSelected ? "true" : "false");
  sessionsTab.setAttribute("aria-selected", overviewSelected ? "false" : "true");
  overviewTab.tabIndex = overviewSelected ? 0 : -1;
  sessionsTab.tabIndex = overviewSelected ? -1 : 0;
  overviewPanel.hidden = !overviewSelected;
  sessionsPanel.hidden = overviewSelected;
  $(".token-panel").dataset.activeTab = codexActiveTab;
}

function handleCodexTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === "ArrowLeft" || event.key === "Home" ? "overview" : "sessions";
  setCodexTab(next, { focus: true });
}

function handleCodexSessionBreakpoint() {
  codexSessionPage = 1;
  renderCodexSessionManager();
  if (codexActiveTab === "sessions") refreshCodexSessions({ quiet: true });
}

function usageUsers() {
  return Array.isArray(state?.config?.usageUsers) ? state.config.usageUsers : [];
}

function currentUsageUserId() {
  const users = usageUsers();
  if (users.some((user) => user.id === selectedUsageUserId)) return selectedUsageUserId;
  return state?.config?.activeUsageUserId || users[0]?.id || "gurara";
}

function syncSelectedUsageUserFromState() {
  const users = usageUsers();
  if (!users.length) return;
  if (!users.some((user) => user.id === selectedUsageUserId)) {
    selectedUsageUserId = state.config.activeUsageUserId || users[0].id;
    localStorage.setItem("gpt-monitor-usage-user", selectedUsageUserId);
  }
}

function getUsageUserById(id) {
  return usageUsers().find((user) => user.id === id) || usageUsers()[0] || null;
}

function selectUsageUser(userId) {
  if (!usageUsers().some((user) => user.id === userId)) return;
  codexSessionAbortController?.abort();
  selectedUsageUserId = userId;
  localStorage.setItem("gpt-monitor-usage-user", selectedUsageUserId);
  codexUsageMonth = "";
  codexSessionMonth = "all";
  codexSessionPage = 1;
  codexSessionState = null;
  codexSessionError = "";
  selectedDeviceId = "all";
  localStorage.setItem("gpt-monitor-device", selectedDeviceId);
  refreshCodexUsage({ quiet: true });
}

function currentDeviceId() {
  const devices = codexUsageState?.report?.device_breakdown || [];
  return selectedDeviceId === "all" || devices.some((device) => device.id === selectedDeviceId)
    ? selectedDeviceId
    : "all";
}

function selectDevice(deviceId) {
  selectedDeviceId = deviceId || "all";
  localStorage.setItem("gpt-monitor-device", selectedDeviceId);
  codexUsageMonth = "";
  codexSessionMonth = "all";
  codexSessionPage = 1;
  codexSessionState = null;
  refreshCodexUsage({ quiet: true });
}

async function refreshState({ quiet = false } = {}) {
  try {
    state = await api("/api/state");
    syncSelectedUsageUserFromState();
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
    const userId = currentUsageUserId();
    const deviceId = currentDeviceId();
    codexUsageState = await api(
      force ? "/api/codex-usage/refresh" : `/api/codex-usage?userId=${encodeURIComponent(userId)}&deviceId=${encodeURIComponent(deviceId)}`,
      {
        method: force ? "POST" : "GET",
        ...(force ? { body: JSON.stringify({ userId, deviceId }) } : {})
      }
    );
    renderCodexUsage();
    if (codexActiveTab === "sessions" && (force || codexSessionState?.user?.id !== userId)) {
      await refreshCodexSessions({ quiet: true });
    }
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

async function refreshCodexSessions({ quiet = false, scroll = false } = {}) {
  clearTimeout(codexSessionSearchTimer);
  codexSessionAbortController?.abort();
  const controller = new AbortController();
  codexSessionAbortController = controller;
  codexSessionLoading = true;
  codexSessionError = "";
  renderCodexSessionManager();

  const params = new URLSearchParams({
    userId: currentUsageUserId(),
    deviceId: currentDeviceId(),
    q: codexSessionQuery,
    month: codexSessionMonth,
    sort: codexSessionSort,
    page: String(codexSessionPage),
    pageSize: String(preferredCodexSessionPageSize())
  });

  try {
    const result = await api(`/api/codex-usage/sessions?${params.toString()}`, {
      signal: controller.signal
    });
    if (controller !== codexSessionAbortController) return;
    codexSessionState = result;
    codexSessionPage = Number(result.pagination?.page) || 1;
    codexSessionMonth = result.query?.month || codexSessionMonth;
    codexSessionSort = result.query?.sort || codexSessionSort;
    if (!quiet) showToast("会话数据已加载");
  } catch (error) {
    if (error.name === "AbortError") return;
    codexSessionError = error.message;
    if (!quiet) showToast(error.message);
  } finally {
    if (controller === codexSessionAbortController) {
      codexSessionLoading = false;
      renderCodexSessionManager();
      syncIcons();
      if (scroll) {
        $("#codexSessionsPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
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
    const result = await api("/api/codex-usage/report", {
      method: "POST",
      body: JSON.stringify({ userId: currentUsageUserId() })
    });
    if (result.status !== "ok") throw new Error(result.message || "报告生成失败");
    codexSessionState = null;
    await refreshCodexUsage({ quiet: true });
    if (reportWindow) reportWindow.location.href = appUrl(result.reportUrl);
    else window.location.href = appUrl(result.reportUrl);
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
  const windows = quotaWindows(quota);
  const grid = $("#windowGrid");
  grid.dataset.count = String(windows.length);
  grid.innerHTML = windows.length
    ? windows.map((window) => {
      const remaining = safePercent(window.remainingPercent);
      const icon = window.kind === "weekly" ? "calendar-clock" : "timer-reset";
      return `
        <article class="window-card" data-window="${escapeAttr(window.id || window.kind || "custom")}">
          <div class="window-head">
            <div>
              <span>${escapeHtml(window.label || "用量窗口")}</span>
              <h3>${formatPercent(window.remainingPercent)}</h3>
            </div>
            <i data-lucide="${icon}"></i>
          </div>
          <div class="window-meter" aria-label="剩余额度 ${formatPercent(window.remainingPercent)}"><span style="width:${remaining}%"></span></div>
          <dl class="window-facts">
            <div><dt>Used</dt><dd>${formatPercent(window.usedPercent)}</dd></div>
            <div><dt>Reset</dt><dd>${escapeHtml(window.resetAfterLabel || formatDateTime(window.resetAt))}</dd></div>
          </dl>
        </article>
      `;
    }).join("")
    : `<article class="window-card window-card-empty"><p>等待上游返回额度窗口</p></article>`;
}

function renderCodexUsage() {
  renderUsageUserSelect();
  renderDeviceSelect();
  renderCodexTabs();
  const select = $("#codexMonthSelect");
  const status = codexUsageState?.status || "loading";
  const report = codexUsageState?.report || null;
  $("#codexUsageStatus").textContent = codexUsageStatusText(codexUsageState);
  $(".token-panel").dataset.status = status;
  $("#codexUsageReportButton").disabled = !getUsageUserById(currentUsageUserId())?.codexUsage?.enabled;

  if (!report) {
    select.innerHTML = `<option>--</option>`;
    select.disabled = true;
    setCodexMetricValues("--", "--", "--", "--", "--", "--", {});
    $("#codexCostNote").textContent = codexCostNote(report);
    $("#codexDailyList").innerHTML = `<div class="empty-state">Token 数据暂不可用</div>`;
    $("#codexSourceList").innerHTML = `<div class="empty-state">Token 数据暂不可用</div>`;
    $("#codexModelList").innerHTML = `<div class="empty-state">Token 数据暂不可用</div>`;
    $("#codexTopSessions").innerHTML = `<div class="empty-state">${escapeHtml(codexUsageState?.message || "等待 Token 数据")}</div>`;
    $("#deviceBreakdownList").innerHTML = `<div class="empty-state">等待设备数据</div>`;
    $("#codexSessionCount").textContent = "默认收起";
    renderCodexSessionManager();
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
    selectedView ? `${formatInteger(selectedView.threads)} / ${selectedView?.avg_display || "--"}` : "--",
    {
      total: summary.usage_split,
      month: selectedView?.usage_split,
      today: today?.usage_split
    }
  );
  $("#codexCostNote").innerHTML = codexCostNote(report);
  renderDeviceBreakdown(report.device_breakdown || []);
  $("#codexDailyList").innerHTML = renderCodexDaily(selectedView?.days || []);
  setupDailyScroller($("#codexDailyList .token-daily-scroll"));
  $("#codexSourceList").innerHTML = renderCodexBars(selectedView?.sources || report.sources || [], "source");
  $("#codexModelList").innerHTML = renderCodexBars(selectedView?.models || report.models || [], "model");
  const sessions = selectedView?.top_sessions || report.top_sessions || [];
  $("#codexSessionCount").textContent = `${sessions.length} 个 · 默认收起`;
  $("#codexTopSessions").innerHTML = renderCodexSessions(sessions);
  renderCodexSessionManager();
}

function renderUsageUserSelect() {
  const select = $("#usageUserSelect");
  if (!select || !state) return;
  const users = usageUsers();
  selectedUsageUserId = currentUsageUserId();
  select.innerHTML = users.length
    ? users.map((user) => {
        const selected = user.id === selectedUsageUserId ? " selected" : "";
        return `<option value="${escapeAttr(user.id)}"${selected}>${escapeHtml(user.label || user.id)}</option>`;
      }).join("")
    : `<option value="gurara">Gurara</option>`;
  select.value = selectedUsageUserId;
  select.hidden = users.length <= 1;
}

function renderDeviceSelect() {
  const select = $("#deviceSelect");
  const devices = codexUsageState?.report?.device_breakdown || [];
  const allowed = new Set(devices.map((device) => device.id));
  if (selectedDeviceId !== "all" && !allowed.has(selectedDeviceId)) selectedDeviceId = "all";
  select.innerHTML = [
    `<option value="all">全部设备</option>`,
    ...devices.map((device) => `<option value="${escapeAttr(device.id)}">${escapeHtml(device.name || device.id)}${device.stale ? " · 过期" : ""}</option>`)
  ].join("");
  select.value = selectedDeviceId;
  select.hidden = devices.length <= 1;
}

function renderDeviceBreakdown(devices) {
  const list = $("#deviceBreakdownList");
  if (!Array.isArray(devices) || !devices.length) {
    list.innerHTML = `<div class="empty-state">暂无设备数据</div>`;
    return;
  }
  list.innerHTML = devices.map((device) => {
    const usage = device.usage_split || {};
    const sync = device.builtIn ? "本机实时数据" : (device.lastSeenAt ? formatFullDateTime(device.lastSeenAt) : "尚未同步");
    const stateLabel = device.revoked ? "已吊销" : device.stale ? "数据过期" : "正常";
    return `
      <article class="device-breakdown-row ${device.stale ? "is-stale" : ""}">
        <div class="device-breakdown-title">
          <strong>${escapeHtml(device.name || device.id)}</strong>
          <span>${escapeHtml(stateLabel)} · ${escapeHtml(sync)}</span>
        </div>
        <div class="device-share"><strong>${formatPercent(device.share_percent)}</strong><i><em style="width:${safePercent(device.share_percent)}%"></em></i><span>${formatCompactTokens(device.total_tokens)} Token</span></div>
        <dl>
          <div><dt>输入</dt><dd>${formatCompactTokens(usage.input_tokens)}</dd></div>
          <div><dt>缓存输入</dt><dd>${formatCompactTokens(usage.cached_input_tokens)}</dd></div>
          <div><dt>输出</dt><dd>${formatCompactTokens(usage.output_tokens)}</dd></div>
          <div><dt>API 等价成本</dt><dd>${escapeHtml(device.cost_estimate?.midpoint_display || "--")}</dd></div>
          <div><dt>拆分覆盖</dt><dd>${formatPercent(device.coverage_percent)}</dd></div>
        </dl>
      </article>
    `;
  }).join("");
}

function setupDailyScroller(scroll) {
  if (!scroll) return;
  requestAnimationFrame(() => {
    scroll.scrollLeft = scroll.scrollWidth - scroll.clientWidth;
  });

  scroll.addEventListener("wheel", (event) => {
    if (scroll.scrollWidth <= scroll.clientWidth) return;
    if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.preventDefault();
    scroll.scrollLeft += event.deltaY;
  }, { passive: false });

  let isDragging = false;
  let startX = 0;
  let startScrollLeft = 0;
  const finishDrag = (event) => {
    if (!isDragging) return;
    isDragging = false;
    scroll.classList.remove("is-dragging");
    if (scroll.hasPointerCapture?.(event.pointerId)) {
      scroll.releasePointerCapture(event.pointerId);
    }
  };

  scroll.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || scroll.scrollWidth <= scroll.clientWidth) return;
    isDragging = true;
    startX = event.clientX;
    startScrollLeft = scroll.scrollLeft;
    scroll.classList.add("is-dragging");
    scroll.setPointerCapture(event.pointerId);
  });
  scroll.addEventListener("pointermove", (event) => {
    if (!isDragging) return;
    scroll.scrollLeft = startScrollLeft - (event.clientX - startX);
  });
  scroll.addEventListener("pointerup", finishDrag);
  scroll.addEventListener("pointercancel", finishDrag);
  scroll.addEventListener("lostpointercapture", finishDrag);
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

function setCodexMetricValues(totalCost, monthCost, todayCost, totalTokens, monthTokens, threads, splits = {}) {
  $("#codexTotalCost").textContent = totalCost;
  $("#codexMonthCost").textContent = monthCost;
  $("#codexTodayCost").textContent = todayCost;
  $("#codexTotalCostDetail").textContent = formatUsageSplit(splits.total);
  $("#codexMonthCostDetail").textContent = formatUsageSplit(splits.month);
  $("#codexTodayCostDetail").textContent = formatUsageSplit(splits.today);
  $("#codexTotalTokens").textContent = totalTokens;
  $("#codexMonthTokens").textContent = monthTokens;
  $("#codexMonthThreads").textContent = threads;
}

function codexCostNote(report) {
  const source = report?.pricing?.source;
  if (!source) return "API 等价成本按 OpenAI 官方输入/缓存输入/输出价格估算，不是 ChatGPT 套餐账单。";
  const coverage = report?.pricing?.split_coverage;
  const split = coverage?.split_threads
    ? ` · 拆分覆盖 ${escapeHtml(formatPercent(coverage.split_coverage_percent))}（${escapeHtml(formatCompactTokens(coverage.split_tokens))}） · 已定价 ${escapeHtml(formatPercent(coverage.priced_coverage_percent))} · 未拆分 ${escapeHtml(formatCompactTokens(coverage.unparsed_tokens))} · 未定价 ${escapeHtml(formatCompactTokens(coverage.unpriced_tokens))}`
    : "";
  return `价格源：<a href="${escapeAttr(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.name)}</a> · ${escapeHtml(source.checkedAt || "")}${split} · ${escapeHtml(source.note)}`;
}

function findTodayUsage(days) {
  const key = localDateKey(new Date());
  return (Array.isArray(days) ? days : []).find((day) => day.day === key) || null;
}

function renderCodexDaily(days) {
  const visible = (Array.isArray(days) ? days : [])
    .filter((day) => Number(day.tokens) > 0);
  if (!visible.length) return `<div class="empty-state">本月暂无日消耗数据</div>`;
  const axisWidth = 92;
  const minWidth = 960;
  const height = 300;
  const left = 18;
  const right = 26;
  const top = 26;
  const bottom = 54;
  const pointSpacing = 72;
  const chartWidth = Math.max(minWidth - left - right, Math.max(1, visible.length - 1) * pointSpacing);
  const width = left + chartWidth + right;
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
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = baseY - ratio * chartHeight;
    const value = Math.round(yMax * ratio);
    return { y, value };
  });
  const grid = yTicks.map(({ y }) => {
    return `
      <g>
        <line x1="0" y1="${svgNumber(y)}" x2="${width - right}" y2="${svgNumber(y)}"></line>
      </g>
    `;
  }).join("");
  const axis = yTicks.map(({ y, value }) => `
    <g>
      <line x1="${axisWidth - 8}" y1="${svgNumber(y)}" x2="${axisWidth}" y2="${svgNumber(y)}"></line>
      <text x="${axisWidth - 12}" y="${svgNumber(y + 4)}">${escapeHtml(formatCompactTokens(value))}</text>
    </g>
  `).join("");
  const labelStep = Math.max(1, Math.ceil(visible.length / 7));
  const labels = points.map((point, index) => {
    if (index % labelStep !== 0 && index !== points.length - 1) return "";
    return `<text x="${svgNumber(point.x)}" y="${height - 18}" text-anchor="middle">${escapeHtml(formatDayLabel(point.day.day))}</text>`;
  }).join("");
  const markers = points.map((point) => `
    <g class="token-daily-point">
      <circle cx="${svgNumber(point.x)}" cy="${svgNumber(point.y)}" r="5"></circle>
      <title>${escapeHtml(`${formatDayLabel(point.day.day)} · ${point.day.tokens_display || "--"} · ${point.day.cost_estimate?.range_display || "--"} · ${formatUsageSplit(point.day.usage_split)} · ${formatInteger(point.day.threads)} 会话`)}</title>
    </g>
  `).join("");
  const topDay = visible.reduce((best, day) => Number(day.tokens) > Number(best.tokens) ? day : best, visible[0]);
  const today = findTodayUsage(visible) || visible.at(-1);
  const summaryDays = visible.slice(-14);
  const totalTokens = summaryDays.reduce((sum, day) => sum + (Number(day.tokens) || 0), 0);
  const totalLow = summaryDays.reduce((sum, day) => sum + (Number(day.cost_estimate?.low_usd) || 0), 0);
  const totalHigh = summaryDays.reduce((sum, day) => sum + (Number(day.cost_estimate?.high_usd) || 0), 0);

  return `
    <div class="token-daily-chart">
      <div class="token-daily-plot" style="--daily-axis-width:${axisWidth}px">
        <div class="token-daily-axis-frame" aria-hidden="true">
          <svg class="token-daily-axis" width="${axisWidth}" height="${height}" viewBox="0 0 ${axisWidth} ${height}" focusable="false">
            <g class="token-daily-axis-grid">${axis}</g>
          </svg>
        </div>
        <div class="token-daily-scroll" tabindex="0" role="region" aria-label="每日 Token 消耗时间轴">
          <svg class="token-daily-svg" width="${width}" height="${height}" style="min-width:${width}px" viewBox="0 0 ${width} ${height}" role="img" aria-label="每日 Token 消耗折线图">
            <g class="token-daily-grid">${grid}</g>
            <path class="token-daily-area" d="${escapeAttr(areaPath)}"></path>
            <path class="token-daily-line" d="${escapeAttr(linePath)}"></path>
            <g class="token-daily-markers">${markers}</g>
            <g class="token-daily-labels">${labels}</g>
          </svg>
        </div>
      </div>
      <div class="token-daily-summary">
        ${dailySummaryItem("峰值", `${formatDayLabel(topDay.day)} · ${topDay.tokens_display || "--"}`, `${topDay.cost_estimate?.range_display || "--"} · ${formatUsageSplit(topDay.usage_split)}`)}
        ${dailySummaryItem("今日", `${formatDayLabel(today.day)} · ${today.tokens_display || "--"}`, `${today.cost_estimate?.range_display || "--"} · ${formatUsageSplit(today.usage_split)}`)}
        ${dailySummaryItem("近 14 次", formatCompactTokens(totalTokens), `${formatUsdRange(totalLow, totalHigh)} · ${summaryDays.length} 天`)}
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
          <span>${escapeHtml(item.tokens_display || "--")} · ${escapeHtml(item.cost_estimate?.range_display || "--")} · ${escapeHtml(formatUsageSplit(item.usage_split))} · ${escapeHtml(formatInteger(item.threads))} 会话</span>
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
          <span>${escapeHtml(model)} · ${escapeHtml(session.source || "unknown")} · ${escapeHtml(session.cost_estimate?.range_display || "--")} · ${escapeHtml(formatUsageSplit(session.usage_split))} · ${escapeHtml(session.created || "--")}</span>
        </div>
        <b>${escapeHtml(session.tokens_display || "--")}</b>
      </article>
    `;
  }).join("");
}

function renderCodexSessionManager() {
  const search = $("#codexSessionSearch");
  const monthSelect = $("#codexSessionMonthFilter");
  const sortSelect = $("#codexSessionSort");
  const status = $("#codexSessionStatus");
  const list = $("#codexSessionList");
  const pagination = codexSessionState?.pagination || {};
  const items = Array.isArray(codexSessionState?.items) ? codexSessionState.items : [];
  if (document.activeElement !== search) search.value = codexSessionQuery;
  sortSelect.value = codexSessionSort;
  renderCodexSessionMonthOptions(monthSelect, codexSessionState?.months || []);
  list.setAttribute("aria-busy", codexSessionLoading ? "true" : "false");
  monthSelect.disabled = codexSessionLoading && !codexSessionState;
  sortSelect.disabled = codexSessionLoading && !codexSessionState;

  if (!codexSessionState) {
    $("#codexSessionSummary").innerHTML = "";
    list.innerHTML = `<div class="empty-state${codexSessionLoading ? " is-loading" : ""}">${escapeHtml(
      codexSessionLoading ? "正在载入会话…" : (codexSessionError || "打开会话标签后加载明细")
    )}</div>`;
    status.textContent = codexSessionLoading ? "正在加载分页会话" : (codexSessionError || "尚未加载会话");
    renderCodexSessionPagination({ page: 1, totalPages: 1, totalItems: 0 });
    return;
  }

  $("#codexSessionSummary").innerHTML = renderCodexSessionSummary(
    codexSessionState.summary,
    pagination.totalItems
  );
  list.innerHTML = items.length
    ? items.map(renderCodexManagedSession).join("")
    : `<div class="empty-state">没有匹配的会话</div>`;
  status.textContent = codexSessionLoading
    ? "正在更新会话列表"
    : codexSessionError || `${formatInteger(pagination.totalItems || 0)} 个匹配会话 · 每页 ${formatInteger(pagination.pageSize || preferredCodexSessionPageSize())} 条`;
  renderCodexSessionPagination(pagination);
}

function renderCodexSessionMonthOptions(select, months) {
  if (codexSessionMonth !== "all" && !months.includes(codexSessionMonth)) {
    codexSessionMonth = "all";
  }
  select.innerHTML = [
    `<option value="all"${codexSessionMonth === "all" ? " selected" : ""}>全部月份</option>`,
    ...months.map((month) => {
      const selected = month === codexSessionMonth ? " selected" : "";
      return `<option value="${escapeAttr(month)}"${selected}>${escapeHtml(formatMonthLabel(month))}</option>`;
    })
  ].join("");
}

function renderCodexSessionPagination(value) {
  const page = Number(value?.page) || 1;
  const totalPages = Number(value?.totalPages) || 1;
  const totalItems = Number(value?.totalItems) || 0;
  $("#codexSessionPrevButton").disabled = codexSessionLoading || page <= 1;
  $("#codexSessionNextButton").disabled = codexSessionLoading || page >= totalPages || totalItems === 0;
  $("#codexSessionPageInfo").textContent = `${totalItems ? `第 ${formatInteger(page)} / ${formatInteger(totalPages)} 页` : "暂无结果"} · ${formatInteger(totalItems)} 条`;
}

function renderCodexSessionSummary(summary, totalCount) {
  const usage = summary?.usage_split || {};
  const cost = summary?.cost_estimate;
  const costDisplay = cost ? formatUsdRange(cost.low_usd, cost.high_usd) : "--";
  const costNote = cost
    ? `${formatCompactTokens(cost.priced_tokens)} 已计价 Token`
    : "暂无费用估算";
  return `
    ${sessionSummaryItem("匹配会话", formatInteger(totalCount || 0), "汇总覆盖全部匹配结果")}
    ${sessionSummaryItem("总 Token", formatCompactTokens(usage.total_tokens), `入 ${formatCompactTokens(usage.input_tokens)} · 出 ${formatCompactTokens(usage.output_tokens)}`)}
    ${sessionSummaryItem("缓存输入", formatCompactTokens(usage.cached_input_tokens), "已包含在输入 Token 中")}
    ${sessionSummaryItem("总费用", costDisplay, costNote)}
  `;
}

function sessionSummaryItem(label, value, note) {
  return `
    <span>
      <b>${escapeHtml(label)}</b>
      <strong>${escapeHtml(value)}</strong>
      <em>${escapeHtml(note)}</em>
    </span>
  `;
}

function renderCodexManagedSession(session) {
  const title = String(session.title || "未命名会话").trim() || "未命名会话";
  const id = String(session.id || "").trim();
  const model = [session.model || "unknown", session.provider].filter(Boolean).join(" · ");
  const date = session.updated_at || session.created_at;
  const dateLabel = date ? formatFullDateTime(date) : (session.updated || session.created || session.day || "--");
  const usage = session.usage_split || {};
  const cost = session.cost_estimate?.range_display || (session.cost_estimate
    ? formatUsdRange(session.cost_estimate.low_usd, session.cost_estimate.high_usd)
    : "--");
  const requests = Number(session.requests) > 0 ? ` · ${formatInteger(session.requests)} 请求` : "";
  const duration = Number(session.duration_ms) > 0 ? ` · ${formatDurationMs(session.duration_ms)}` : "";
  const detailsOpen = CODEX_SESSION_MOBILE.matches ? "" : " open";
  return `
    <article class="managed-session">
      <div class="managed-session-main">
        <strong title="${escapeAttr(title)}">${escapeHtml(title)}</strong>
        <span>${escapeHtml(dateLabel)}</span>
      </div>
      <div class="managed-session-key-metrics" aria-label="会话总量与费用">
        ${sessionMetric("总", session.tokens_display || formatCompactTokens(session.tokens))}
        ${sessionMetric("费用", cost)}
      </div>
      <details class="managed-session-details"${detailsOpen}>
        <summary>Token 与来源详情</summary>
        <div class="managed-session-details-body">
          <div class="managed-session-context">
            <span>${escapeHtml(shortSessionId(id))} · ${escapeHtml(model)} · ${escapeHtml(session.source || "unknown")}${escapeHtml(requests)}${escapeHtml(duration)}</span>
            ${session.cwd ? `<small title="${escapeAttr(session.cwd)}">${escapeHtml(session.cwd)}</small>` : ""}
          </div>
          <div class="managed-session-metrics" aria-label="Token 拆分">
            ${sessionMetric("输入", formatCompactTokens(usage.input_tokens))}
            ${sessionMetric("缓存", formatCompactTokens(usage.cached_input_tokens))}
            ${sessionMetric("输出", formatCompactTokens(usage.output_tokens))}
          </div>
        </div>
      </details>
    </article>
  `;
}

function sessionMetric(label, value) {
  return `
    <span>
      <b>${escapeHtml(label)}</b>
      <strong>${escapeHtml(value || "--")}</strong>
    </span>
  `;
}

function shortSessionId(value) {
  const id = String(value || "");
  if (id.length <= 14) return id || "--";
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
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
  const windows = quotaWindows(check.usage);
  const title = `${bucket.label} ${bucket.sublabel} · ${formatFullDateTime(check.at)} · ${quotaWindowSummary(windows)}`;
  return `
    <button class="history-bucket ${escapeAttr(check.status)}" type="button" aria-label="${escapeAttr(title)}">
      <span class="bucket-bars" style="--window-count:${Math.max(1, windows.length)}">
        ${windows.map((window, index) => `<i class="bar-window bar-window-${index + 1}" style="height:${safePercent(window.remainingPercent)}%"></i>`).join("")}
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
        <i class="calendar-rings empty-ring"></i>
      </div>
    `;
  }
  const windows = quotaWindows(check.usage);
  const title = `${formatDateOnly(date)} · ${formatFullDateTime(check.at)} · ${quotaWindowSummary(windows)}`;
  return `
    <button class="calendar-day has-data ${escapeAttr(check.status)}" type="button" aria-label="${escapeAttr(title)}">
      <span>${date.getDate()}</span>
      <i class="calendar-rings">
        ${windows.slice(0, 4).map((window, index) => `<em style="--ring-index:${index}; --remaining:${safePercent(window.remainingPercent)}"></em>`).join("")}
      </i>
      ${renderPointTooltip(check)}
    </button>
  `;
}

function renderPointTooltip(check) {
  const windows = quotaWindows(check.usage);
  return `
    <span class="point-tooltip" role="presentation">
      <strong>${escapeHtml(formatFullDateTime(check.at))}</strong>
      <small>${escapeHtml(REASON_TEXT[check.reason] || check.reason || "手动")} · ${escapeHtml(STATUS_TEXT[check.status] || check.status)}</small>
      ${windows.length
        ? windows.map((window) => tooltipBar(quotaWindowShortLabel(window), safePercent(window.remainingPercent), window)).join("")
        : `<small>此记录没有额度窗口数据</small>`}
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
  const windows = quotaWindows(check.usage);
  return `
    <article class="history-row ${escapeAttr(check.status)}">
      <div class="history-time">
        <time datetime="${escapeAttr(check.at)}">${escapeHtml(formatFullDateTime(check.at))}</time>
        <span>${escapeHtml(REASON_TEXT[check.reason] || check.reason || "手动")}</span>
      </div>
      <div class="history-values">
        ${windows.length
          ? windows.map((window) => historyValue(quotaWindowShortLabel(window), window)).join("")
          : `<span class="history-value-empty">无窗口数据</span>`}
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

function quotaWindows(usage) {
  if (!usage || typeof usage !== "object") return [];
  if (Array.isArray(usage.windows)) return usage.windows.filter(Boolean);
  return [usage.primaryWindow, usage.secondaryWindow].filter(Boolean).map((window, index) => ({
    ...window,
    id: window.id || (index === 0 ? "primary" : "secondary"),
    kind: window.kind || "custom",
    label: window.label || window.windowLabel || (index === 0 ? "主窗口" : "次窗口"),
    shortLabel: window.shortLabel || window.windowLabel || (index === 0 ? "PRIMARY" : "SECONDARY")
  }));
}

function quotaWindowShortLabel(window) {
  return window?.shortLabel || window?.windowLabel || window?.label || "WINDOW";
}

function quotaWindowSummary(windows) {
  if (!windows.length) return "无窗口数据";
  return windows.map((window) => `${quotaWindowShortLabel(window)} ${formatPercent(window.remainingPercent)}`).join(" · ");
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
  settingsUsageUserId = currentUsageUserId();
  fillSettingsForm(state.config);
  $("#settingsDialog").showModal();
  syncIcons();
  refreshDeviceSettings();
}

function closeSettings() {
  $("#settingsDialog").close();
  $("#deviceCommandOutput").value = "";
  $("#deviceCommandField").hidden = true;
}

async function refreshDeviceSettings() {
  try {
    const result = await api(`/api/devices?userId=${encodeURIComponent(settingsUsageUserId || currentUsageUserId())}`);
    deviceSettingsState = result.devices || [];
    renderDeviceSettings();
  } catch (error) {
    $("#deviceSettingsList").innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  }
}

function renderDeviceSettings() {
  const list = $("#deviceSettingsList");
  list.innerHTML = deviceSettingsState.length ? deviceSettingsState.map((device) => `
    <article class="device-settings-row" data-device-id="${escapeAttr(device.id)}">
      <div><strong>${escapeHtml(device.name || device.id)}</strong><span>${device.builtIn ? "内置本机" : device.revoked ? "已吊销" : device.stale ? "数据过期" : "远端设备"} · ${device.lastSeenAt ? escapeHtml(formatFullDateTime(device.lastSeenAt)) : "尚未同步"}</span></div>
      <span>${escapeHtml(formatCompactTokens(device.total_tokens))} Token</span>
      <div class="device-settings-actions">
        <button class="text-button" type="button" data-device-action="rename">改名</button>
        ${device.builtIn ? "" : `<button class="text-button" type="button" data-device-action="rotate">轮换令牌</button><button class="text-button" type="button" data-device-action="toggle">${device.enabled && !device.revoked ? "吊销" : "启用"}</button>`}
      </div>
    </article>
  `).join("") : `<div class="empty-state">暂无设备</div>`;
  for (const button of $$('[data-device-action]', list)) {
    button.addEventListener("click", () => manageDevice(button.closest("[data-device-id]").dataset.deviceId, button.dataset.deviceAction));
  }
}

async function createDevice() {
  const name = $("#newDeviceName").value.trim();
  if (!name) return showToast("请输入设备名称");
  try {
    const result = await api("/api/devices", {
      method: "POST",
      body: JSON.stringify({ userId: settingsUsageUserId || currentUsageUserId(), name })
    });
    showDeviceCommand(result.command);
    $("#newDeviceName").value = "";
    await refreshDeviceSettings();
    showToast("设备已创建；令牌只显示这一次");
  } catch (error) {
    showToast(error.message);
  }
}

async function manageDevice(deviceId, action) {
  const userId = settingsUsageUserId || currentUsageUserId();
  const device = deviceSettingsState.find((item) => item.id === deviceId);
  try {
    if (action === "rename") {
      const name = prompt("设备名称", device?.name || deviceId);
      if (!name?.trim()) return;
      await api(`/api/devices/${encodeURIComponent(deviceId)}`, {
        method: "PATCH",
        body: JSON.stringify({ userId, name: name.trim() })
      });
    } else if (action === "rotate") {
      const result = await api(`/api/devices/${encodeURIComponent(deviceId)}/rotate-token`, {
        method: "POST",
        body: JSON.stringify({ userId })
      });
      showDeviceCommand(result.command);
      showToast("令牌已轮换；旧令牌立即失效");
    } else if (action === "toggle") {
      await api(`/api/devices/${encodeURIComponent(deviceId)}`, {
        method: "PATCH",
        body: JSON.stringify({ userId, enabled: !(device?.enabled && !device?.revoked) })
      });
    }
    await refreshDeviceSettings();
  } catch (error) {
    showToast(error.message);
  }
}

function showDeviceCommand(command) {
  $("#deviceCommandOutput").value = command || "";
  $("#deviceCommandField").hidden = false;
  $("#deviceCommandOutput").focus();
  $("#deviceCommandOutput").select();
}

function fillSettingsForm(config) {
  const form = $("#settingsForm");
  for (const input of $$("input, select", form)) {
    if (!input.name) continue;
    const value = getByPath(config, input.name);
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = value ?? "";
  }
  renderSettingsUsageUsers(config);
}

function renderSettingsUsageUsers(config) {
  const users = Array.isArray(config?.usageUsers) ? config.usageUsers : [];
  const select = $("#settingsUsageUserSelect");
  if (!users.length) {
    select.innerHTML = `<option value="gurara">Gurara</option>`;
    settingsUsageUserId = "gurara";
    fillUsageUserSettings(null);
    return;
  }
  if (!users.some((user) => user.id === settingsUsageUserId)) {
    settingsUsageUserId = config.activeUsageUserId || users[0].id;
  }
  select.innerHTML = users.map((user) => {
    const selected = user.id === settingsUsageUserId ? " selected" : "";
    return `<option value="${escapeAttr(user.id)}"${selected}>${escapeHtml(user.label || user.id)}</option>`;
  }).join("");
  select.value = settingsUsageUserId;
  fillUsageUserSettings(users.find((user) => user.id === settingsUsageUserId) || users[0]);
}

function fillUsageUserSettings(user) {
  const codex = user?.codexUsage || {};
  const sub2api = user?.sub2api || {};
  $("#settingsUsageUserLabel").value = user?.label || "";
  $("#settingsCodexDbPath").value = codex.dbPath || "";
  $("#settingsCodexTopSessions").value = codex.topSessions || 10;
  $("#settingsCodexEnabled").checked = codex.enabled !== false;
  renderPricingOverrideRows(codex.pricingOverrides);
  $("#settingsSub2ApiBaseUrl").value = sub2api.baseUrl || "http://192.168.31.114:7999";
  $("#settingsSub2ApiKey").value = "";
  $("#settingsSub2ApiStartDate").value = sub2api.startDate || "";
  $("#settingsSub2ApiLookbackDays").value = sub2api.lookbackDays || 120;
  $("#settingsSub2ApiEnabled").checked = sub2api.enabled === true;
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
  readUsageUserSettingsIntoConfig(config);
  try {
    state = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config })
    });
    syncSelectedUsageUserFromState();
    closeSettings();
    render();
    refreshCodexUsage({ quiet: true, force: true });
    showToast("设置已保存");
  } catch (error) {
    showToast(error.message);
  }
}

function readUsageUserSettingsIntoConfig(config) {
  const users = Array.isArray(config.usageUsers) ? config.usageUsers : [];
  const user = users.find((item) => item.id === settingsUsageUserId);
  if (!user) return;
  user.label = $("#settingsUsageUserLabel").value.trim() || user.label || user.id;
  user.codexUsage = {
    ...(user.codexUsage || {}),
    enabled: $("#settingsCodexEnabled").checked,
    dbPath: $("#settingsCodexDbPath").value.trim(),
    topSessions: Number($("#settingsCodexTopSessions").value) || 10,
    pricingOverrides: readPricingOverrideRows()
  };
  user.sub2api = {
    ...(user.sub2api || {}),
    enabled: $("#settingsSub2ApiEnabled").checked,
    baseUrl: $("#settingsSub2ApiBaseUrl").value.trim(),
    startDate: $("#settingsSub2ApiStartDate").value,
    lookbackDays: Number($("#settingsSub2ApiLookbackDays").value) || 120
  };
  config.activeUsageUserId = user.id;
  selectedUsageUserId = user.id;
  localStorage.setItem("gpt-monitor-usage-user", selectedUsageUserId);
}

function renderPricingOverrideRows(overrides) {
  const rows = Array.isArray(overrides) ? overrides : [];
  $("#pricingOverrideRows").innerHTML = "";
  for (const override of rows) appendPricingOverrideRow(override);
}

function appendPricingOverrideRow(override = {}) {
  const row = document.createElement("div");
  row.className = "pricing-override-row";
  row.innerHTML = `
    <label><span>模型</span><input data-price="model" value="${escapeAttr(override.model || "")}" placeholder="gpt-5.6-terra" autocomplete="off" /></label>
    <label><span>输入</span><input data-price="input" type="number" min="0" step="0.001" value="${escapeAttr(override.input ?? "")}" /></label>
    <label><span>缓存输入</span><input data-price="cachedInput" type="number" min="0" step="0.001" value="${escapeAttr(override.cachedInput ?? "")}" /></label>
    <label><span>输出</span><input data-price="output" type="number" min="0" step="0.001" value="${escapeAttr(override.output ?? "")}" /></label>
    <label><span>生效日期</span><input data-price="effectiveDate" type="date" value="${escapeAttr(override.effectiveDate || "")}" /></label>
    <button class="text-button pricing-remove" type="button" aria-label="删除此价格">删除</button>
  `;
  row.querySelector(".pricing-remove").addEventListener("click", () => row.remove());
  $("#pricingOverrideRows").append(row);
}

function readPricingOverrideRows() {
  return $$(".pricing-override-row", $("#pricingOverrideRows")).map((row) => ({
    model: row.querySelector('[data-price="model"]').value.trim(),
    input: Number(row.querySelector('[data-price="input"]').value),
    cachedInput: Number(row.querySelector('[data-price="cachedInput"]').value),
    output: Number(row.querySelector('[data-price="output"]').value),
    effectiveDate: row.querySelector('[data-price="effectiveDate"]').value
  })).filter((item) => item.model && item.input >= 0 && item.output > 0);
}

async function addUsageUser() {
  if (!state) return;
  const label = prompt("新用户名称", "新用户");
  if (!label?.trim()) return;
  const config = structuredClone(state.config);
  config.usageUsers = Array.isArray(config.usageUsers) ? config.usageUsers : [];
  const id = uniqueUsageUserId(label, config.usageUsers);
  const baseSub2Api = getUsageUserById(currentUsageUserId())?.sub2api || {};
  config.usageUsers.push({
    id,
    label: label.trim(),
    enabled: true,
    codexUsage: {
      enabled: true,
      dbPath: "",
      uploadedFileName: "",
      uploadedAt: null,
      topSessions: 10,
      pricingOverrides: []
    },
    sub2api: {
      enabled: false,
      label: "Sub2API",
      baseUrl: baseSub2Api.baseUrl || "http://192.168.31.114:7999",
      apiKeyEnv: "",
      apiKeyPath: "",
      adminEmail: "",
      adminPasswordEnv: "SUB2API_ADMIN_PASSWORD",
      adminPasswordPath: "",
      adminUsageLimit: 50000,
      lookbackDays: baseSub2Api.lookbackDays || 120,
      startDate: baseSub2Api.startDate || ""
    }
  });
  config.activeUsageUserId = id;
  try {
    state = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ config })
    });
    selectedUsageUserId = id;
    settingsUsageUserId = id;
    localStorage.setItem("gpt-monitor-usage-user", id);
    render();
    fillSettingsForm(state.config);
    await refreshCodexUsage({ quiet: true });
    showToast("用户已新增");
  } catch (error) {
    showToast(error.message);
  }
}

function uniqueUsageUserId(label, users) {
  const base = String(label || "user")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "user";
  const taken = new Set(users.map((user) => user.id));
  let id = base;
  let index = 2;
  while (taken.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

async function uploadCodexDb() {
  const file = $("#codexDbFile").files?.[0];
  if (!file) {
    showToast("请选择 SQLite 文件");
    return;
  }
  readUsageUserSettingsIntoConfig(state.config);
  const button = $("#codexDbUploadButton");
  button.disabled = true;
  try {
    const response = await fetch(appUrl(`/api/users/${encodeURIComponent(settingsUsageUserId)}/codex-db`), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-File-Name": file.name.replace(/[^\w.-]+/g, "_")
      },
      body: file
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    codexUsageState = payload;
    codexSessionState = null;
    state = await api("/api/state");
    syncSelectedUsageUserFromState();
    render();
    fillSettingsForm(state.config);
    if (codexActiveTab === "sessions") await refreshCodexSessions({ quiet: true });
    showToast("SQLite 已上传并刷新");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
}

async function saveSub2ApiKey() {
  const apiKey = $("#settingsSub2ApiKey").value.trim();
  if (!apiKey) {
    showToast("请输入 Sub2API API Key");
    return;
  }
  readUsageUserSettingsIntoConfig(state.config);
  const button = $("#sub2ApiKeySaveButton");
  button.disabled = true;
  try {
    const response = await fetch(appUrl(`/api/users/${encodeURIComponent(settingsUsageUserId)}/sub2api-key`), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        apiKey,
        enabled: $("#settingsSub2ApiEnabled").checked,
        baseUrl: $("#settingsSub2ApiBaseUrl").value.trim(),
        startDate: $("#settingsSub2ApiStartDate").value,
        lookbackDays: Number($("#settingsSub2ApiLookbackDays").value) || 120
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    codexUsageState = payload;
    codexSessionState = null;
    state = await api("/api/state");
    syncSelectedUsageUserFromState();
    render();
    fillSettingsForm(state.config);
    if (codexActiveTab === "sessions") await refreshCodexSessions({ quiet: true });
    showToast("Sub2API Key 已保存并刷新");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
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

function formatUsageSplit(split) {
  if (!split || typeof split !== "object") return "拆分暂无";
  const input = Number(split.input_tokens) || 0;
  const cached = Number(split.cached_input_tokens) || 0;
  const output = Number(split.output_tokens) || 0;
  if (!input && !output) return "拆分暂无";
  return `入 ${formatCompactTokens(input)} · 缓 ${formatCompactTokens(cached)} · 出 ${formatCompactTokens(output)}`;
}

function formatUsdRange(low, high) {
  const lowNumber = Number(low);
  const highNumber = Number(high);
  if (Number.isFinite(lowNumber) && Number.isFinite(highNumber) && Math.abs(lowNumber - highNumber) < 0.00005) {
    return formatUsd((lowNumber + highNumber) / 2);
  }
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

function formatDurationMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (number >= 60000) return `${trimNumber(number / 60000, 1)} 分`;
  if (number >= 1000) return `${trimNumber(number / 1000, 1)} 秒`;
  return `${Math.round(number)} ms`;
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
