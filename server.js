const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");
const { existsSync, statSync } = require("node:fs");
const { mkdir, readFile, readdir, rename, writeFile } = require("node:fs/promises");
const { promisify } = require("node:util");
const { querySessions } = require("./lib/session-query");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const OUTPUT_DIR = path.join(ROOT, "output");
const CODEX_USAGE_OUTPUT_DIR = path.join(OUTPUT_DIR, "codex-usage");
const USERS_DIR = path.join(DATA_DIR, "users");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CHECKS_FILE = path.join(DATA_DIR, "checks.json");
const CODEX_USAGE_CACHE_FILE = path.join(DATA_DIR, "codex-usage-cache.json");
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_CHECK_HISTORY = 1000;
const CODEX_USAGE_CACHE_MS = 6 * 60 * 60 * 1000;
const CODEX_USAGE_STARTUP_REFRESH_DELAY_MS = 30 * 1000;
const SUB2API_CACHE_HISTORY_MAX_DAYS = 730;
const DEFAULT_USAGE_USER_ID = "gurara";
const CODEX_USAGE_SCRIPT = path.join(ROOT, "scripts", "codex-usage", "scripts", "generate_codex_usage_report.py");
const CODEX_USAGE_REPORT_FILE = "latest.html";
const CODEX_USAGE_JSON_FILE = "latest.json";
const CODEX_USAGE_MD_FILE = "latest.md";
const CODEX_SESSION_DIRS = ["sessions", "archived_sessions"];
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_BASE_PATH = "";
const BASE_PATH_ALIASES = ["/monitor"];
const AUTH_REALM = "GPT Pro Monitor";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 240;
const REFRESH_RATE_LIMIT_MAX = 12;
const execFileAsync = promisify(execFile);
const ALLOWED_USAGE_ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage"
];
const OPENAI_PRICE_SOURCE = {
  name: "OpenAI API Pricing",
  url: "https://openai.com/api/pricing/",
  checkedAt: "2026-05-24",
  unit: "USD / 1M tokens",
  note: "优先使用本地 rollout JSONL 的 token_count 输入/缓存输入/输出拆分；缺失时回退为总 token 区间估算，未计入 Batch、Regional、长上下文或工具费用差异。"
};
const CODEX_SOURCE_LABELS = {
  vscode: "Codex 桌面端",
  exec: "自动执行",
  cli: "命令行"
};
const DEFAULT_CODEX_USAGE = {
  enabled: true,
  dbPath: "~/.codex/state_5.sqlite",
  uploadedFileName: "",
  uploadedAt: null,
  topSessions: 10
};
const DEFAULT_SUB2API = {
  enabled: false,
  label: "Sub2API",
  baseUrl: "http://192.168.31.114:7999",
  apiKeyEnv: "SUB2API_API_KEY",
  apiKeyPath: "",
  adminEmail: "",
  adminPasswordEnv: "SUB2API_ADMIN_PASSWORD",
  adminPasswordPath: "",
  adminUsageLimit: 50000,
  lookbackDays: 120,
  startDate: ""
};
const DEFAULT_USAGE_USER = {
  id: DEFAULT_USAGE_USER_ID,
  label: "Gurara",
  enabled: true,
  codexUsage: DEFAULT_CODEX_USAGE,
  sub2api: {
    ...DEFAULT_SUB2API,
    enabled: true,
    apiKeyPath: "data/sub2api.key",
    startDate: "2026-04-14"
  }
};
const MODEL_PRICING_USD_PER_MILLION = {
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2 },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 }
};
const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

const DEFAULT_CONFIG = {
  version: 4,
  port: DEFAULT_PORT,
  account: {
    id: "primary",
    label: "Codex",
    planName: "ChatGPT Pro",
    enabled: true,
    authPath: "~/.codex/auth.json",
    endpoint: "https://chatgpt.com/backend-api/wham/usage"
  },
  schedule: {
    enabled: true,
    intervalMinutes: 30,
    lastRunAt: null,
    nextRunAt: null
  },
  codexUsage: {
    ...DEFAULT_CODEX_USAGE
  },
  sub2api: {
    ...DEFAULT_SUB2API
  },
  activeUsageUserId: DEFAULT_USAGE_USER_ID,
  usageUsers: [DEFAULT_USAGE_USER],
  appearance: {
    accentColor: "#1d7f64",
    density: "comfortable",
    reduceMotion: false
  }
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

let schedulerBusy = false;
let codexUsageSchedulerBusy = false;
const rateLimitBuckets = new Map();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanString(value, fallback, max = 200) {
  const text = String(value ?? fallback ?? "").trim();
  return text.slice(0, max);
}

function normalizeBasePath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "/") return "";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\/+/g, "/").replace(/\/+$/, "");
}

function getBasePath() {
  return normalizeBasePath(process.env.GPT_MONITOR_BASE_PATH || DEFAULT_BASE_PATH);
}

function pathMatchesBasePath(pathname, basePath) {
  return Boolean(basePath) && (pathname === basePath || pathname.startsWith(`${basePath}/`));
}

function matchingBasePath(pathname) {
  const pathValue = String(pathname || "/") || "/";
  const configured = getBasePath();
  if (pathMatchesBasePath(pathValue, configured)) return configured;
  return BASE_PATH_ALIASES.find((alias) => pathMatchesBasePath(pathValue, alias)) || "";
}

function stripBasePath(pathname) {
  const pathValue = String(pathname || "/") || "/";
  const basePath = matchingBasePath(pathValue);
  if (!basePath) return pathValue;
  if (pathValue === basePath) return "/";
  if (pathValue.startsWith(`${basePath}/`)) return pathValue.slice(basePath.length) || "/";
  return pathValue;
}

function withBasePath(pathname) {
  const pathValue = String(pathname || "/");
  const normalized = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const basePath = getBasePath();
  if (!basePath || normalized === basePath || normalized.startsWith(`${basePath}/`)) return normalized;
  return `${basePath}${normalized}`;
}

function cleanId(value, fallbackPrefix) {
  const raw = String(value || "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || `${fallbackPrefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function isAllowedUsageEndpoint(value) {
  try {
    const url = new URL(value);
    return ALLOWED_USAGE_ENDPOINTS.some((allowed) => value === allowed) &&
      url.protocol === "https:" &&
      url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

function isValidDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && localDateKey(date) === value;
}

function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  const isLegacy = source.version < 3;
  const config = clone(DEFAULT_CONFIG);

  config.port = clamp(Math.round(toNumber(source.port, DEFAULT_PORT)), 1024, 65535);

  const account = source.account || {};
  config.account = {
    ...DEFAULT_CONFIG.account,
    id: cleanId(account.id, "account"),
    label: cleanString(account.label || account.email, DEFAULT_CONFIG.account.label, 60),
    planName: cleanString(account.planName, DEFAULT_CONFIG.account.planName, 80),
    enabled: isLegacy ? true : account.enabled !== false,
    authPath: cleanString(account.authPath, DEFAULT_CONFIG.account.authPath, 500),
    endpoint: isAllowedUsageEndpoint(account.endpoint) ? account.endpoint : DEFAULT_CONFIG.account.endpoint
  };

  const schedule = source.schedule || {};
  config.schedule = {
    ...DEFAULT_CONFIG.schedule,
    enabled: schedule.enabled !== false,
    intervalMinutes: clamp(Math.round(toNumber(schedule.intervalMinutes, 30)), 5, 1440),
    lastRunAt: validIsoOrNull(schedule.lastRunAt),
    nextRunAt: validIsoOrNull(schedule.nextRunAt)
  };
  if (!config.schedule.enabled) config.schedule.nextRunAt = null;

  const legacyCodexUsage = normalizeCodexUsageConfig(source.codexUsage || DEFAULT_CODEX_USAGE);
  const legacySub2Api = normalizeSub2ApiConfig(source.sub2api || DEFAULT_SUB2API);
  config.usageUsers = normalizeUsageUsers(source.usageUsers, {
    codexUsage: legacyCodexUsage,
    sub2api: legacySub2Api
  });
  const requestedUsageUserId = cleanId(source.activeUsageUserId || DEFAULT_USAGE_USER_ID, "user");
  config.activeUsageUserId = config.usageUsers.some((user) => user.id === requestedUsageUserId)
    ? requestedUsageUserId
    : config.usageUsers[0].id;
  const activeUsageUser = getUsageUser(config, config.activeUsageUserId);
  config.codexUsage = activeUsageUser.codexUsage;
  config.sub2api = activeUsageUser.sub2api;

  const appearance = source.appearance || {};
  const accent = appearance.accentColor || appearance.seedColor || DEFAULT_CONFIG.appearance.accentColor;
  config.appearance = {
    ...DEFAULT_CONFIG.appearance,
    accentColor: /^#[0-9a-f]{6}$/i.test(accent) ? accent : DEFAULT_CONFIG.appearance.accentColor,
    density: ["compact", "comfortable", "roomy"].includes(appearance.density)
      ? appearance.density
      : DEFAULT_CONFIG.appearance.density,
    reduceMotion: Boolean(appearance.reduceMotion)
  };

  return config;
}

function normalizeUsageUsers(users, legacy = {}) {
  const sourceUsers = Array.isArray(users) && users.length
    ? users
    : [{
        ...DEFAULT_USAGE_USER,
        codexUsage: legacy.codexUsage || DEFAULT_USAGE_USER.codexUsage,
        sub2api: legacy.sub2api || DEFAULT_USAGE_USER.sub2api
      }];
  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < sourceUsers.length; index += 1) {
    const user = normalizeUsageUser(sourceUsers[index], index, legacy);
    let id = user.id;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    normalized.push({ ...user, id });
  }
  return normalized.length ? normalized : [normalizeUsageUser(DEFAULT_USAGE_USER, 0, legacy)];
}

function normalizeUsageUser(input, index = 0, legacy = {}) {
  const source = input && typeof input === "object" ? input : {};
  const isDefault = index === 0;
  const base = isDefault ? DEFAULT_USAGE_USER : {
    id: `user-${index + 1}`,
    label: `User ${index + 1}`,
    enabled: true,
    codexUsage: DEFAULT_CODEX_USAGE,
    sub2api: DEFAULT_SUB2API
  };
  return {
    id: cleanId(source.id || source.label || base.id, "user"),
    label: cleanString(source.label || base.label, base.label, 80),
    enabled: source.enabled !== false,
    codexUsage: normalizeCodexUsageConfig(source.codexUsage || legacy.codexUsage || base.codexUsage),
    sub2api: normalizeSub2ApiConfig(source.sub2api || legacy.sub2api || base.sub2api)
  };
}

function normalizeCodexUsageConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    ...DEFAULT_CODEX_USAGE,
    enabled: source.enabled !== false,
    dbPath: cleanString(source.dbPath, DEFAULT_CODEX_USAGE.dbPath, 500),
    uploadedFileName: cleanString(source.uploadedFileName, "", 240),
    uploadedAt: validIsoOrNull(source.uploadedAt),
    topSessions: clamp(Math.round(toNumber(source.topSessions, DEFAULT_CODEX_USAGE.topSessions)), 1, 50)
  };
}

function normalizeSub2ApiConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    ...DEFAULT_SUB2API,
    enabled: source.enabled === true,
    label: cleanString(source.label, DEFAULT_SUB2API.label, 80) || DEFAULT_SUB2API.label,
    baseUrl: isValidHttpUrl(source.baseUrl) ? cleanString(source.baseUrl, DEFAULT_SUB2API.baseUrl, 500) : DEFAULT_SUB2API.baseUrl,
    apiKeyEnv: cleanString(source.apiKeyEnv, DEFAULT_SUB2API.apiKeyEnv, 120) || DEFAULT_SUB2API.apiKeyEnv,
    apiKeyPath: cleanString(source.apiKeyPath, DEFAULT_SUB2API.apiKeyPath, 500),
    adminEmail: cleanString(source.adminEmail, DEFAULT_SUB2API.adminEmail, 200),
    adminPasswordEnv: cleanString(source.adminPasswordEnv, DEFAULT_SUB2API.adminPasswordEnv, 120) ||
      DEFAULT_SUB2API.adminPasswordEnv,
    adminPasswordPath: cleanString(source.adminPasswordPath, DEFAULT_SUB2API.adminPasswordPath, 500),
    adminUsageLimit: clamp(Math.round(toNumber(source.adminUsageLimit, DEFAULT_SUB2API.adminUsageLimit)), 100, 100000),
    lookbackDays: clamp(
      Math.round(toNumber(source.lookbackDays, DEFAULT_SUB2API.lookbackDays)),
      1,
      SUB2API_CACHE_HISTORY_MAX_DAYS
    ),
    startDate: isValidDateKey(source.startDate) ? source.startDate : ""
  };
}

function getUsageUser(config, userId) {
  const users = Array.isArray(config?.usageUsers) ? config.usageUsers : [];
  return users.find((user) => user.id === userId) ||
    users.find((user) => user.id === config?.activeUsageUserId) ||
    users[0] ||
    normalizeUsageUser(DEFAULT_USAGE_USER);
}

function findUsageUser(config, userId) {
  const id = cleanId(userId || "", "user");
  return (Array.isArray(config?.usageUsers) ? config.usageUsers : []).find((user) => user.id === id) || null;
}

function validIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function ensureDataFiles() {
  await mkdir(USERS_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) await writeJson(CONFIG_FILE, DEFAULT_CONFIG);
  if (!existsSync(CHECKS_FILE)) await writeJson(CHECKS_FILE, []);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return clone(fallback);
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

async function loadConfig() {
  return normalizeConfig(await readJson(CONFIG_FILE, DEFAULT_CONFIG));
}

async function saveConfig(config) {
  const normalized = normalizeConfig(config);
  await writeJson(CONFIG_FILE, normalized);
  return normalized;
}

async function loadChecks() {
  const raw = await readJson(CHECKS_FILE, []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCheck).filter(Boolean).slice(-MAX_CHECK_HISTORY);
}

async function saveChecks(checks) {
  await writeJson(CHECKS_FILE, checks.map(normalizeCheck).filter(Boolean).slice(-MAX_CHECK_HISTORY));
}

function normalizeCheck(check) {
  if (!check || typeof check !== "object") return null;
  if (check.detail?.composerFound !== undefined || check.detail?.loginRequired !== undefined) return null;
  const at = new Date(check.at || check.checkedAt || Date.now());
  if (Number.isNaN(at.getTime())) return null;
  const status = normalizeStatus(check.status);
  return {
    id: String(check.id || crypto.randomUUID()),
    at: at.toISOString(),
    reason: String(check.reason || "manual").slice(0, 40),
    status,
    message: String(check.message || statusText(status)).slice(0, 300),
    latencyMs: Math.max(0, Math.round(toNumber(check.latencyMs, 0))),
    planType: String(check.planType || "").slice(0, 80),
    account: normalizeAccount(check.account),
    allowed: check.allowed === undefined ? null : Boolean(check.allowed),
    limitReached: check.limitReached === undefined ? null : Boolean(check.limitReached),
    usage: check.usage && typeof check.usage === "object" ? check.usage : null,
    detail: check.detail && typeof check.detail === "object" ? check.detail : {}
  };
}

function normalizeAccount(account) {
  if (!account || typeof account !== "object") return null;
  return {
    name: String(account.name || "").slice(0, 120),
    email: String(account.email || "").slice(0, 200),
    userId: String(account.userId || "").slice(0, 120),
    accountId: String(account.accountId || "").slice(0, 120)
  };
}

function normalizeStatus(status) {
  const raw = String(status || "failed");
  const map = {
    ok: "success",
    success: "success",
    limited: "quota_limited",
    quota_limited: "quota_limited",
    disabled: "disabled",
    failed: "failed",
    error: "failed",
    auth_error: "auth_error"
  };
  return map[raw] || "failed";
}

function statusText(status) {
  return {
    success: "用量已同步",
    quota_limited: "已达到 Codex 用量限制",
    auth_error: "Codex 登录态不可用",
    disabled: "监控已停用",
    failed: "同步失败"
  }[status] || "未知状态";
}

async function getState() {
  const [config, checks] = await Promise.all([loadConfig(), loadChecks()]);
  const computed = computeStats(config, checks);
  return {
    generatedAt: new Date().toISOString(),
    config,
    computed: publicComputedStats(computed),
    checks: checks.slice().reverse().slice(0, 200).map(publicHistoryCheck)
  };
}

function publicUsageWindow(window) {
  if (!window || typeof window !== "object") return null;
  return {
    label: cleanString(window.label, "", 80),
    usedPercent: toNullableNumber(window.usedPercent),
    remainingPercent: toNullableNumber(window.remainingPercent),
    resetAt: validIsoOrNull(window.resetAt),
    resetAfterSeconds: toNullableNumber(window.resetAfterSeconds),
    resetAfterLabel: cleanString(window.resetAfterLabel, "", 80),
    windowSeconds: toNullableNumber(window.windowSeconds),
    windowLabel: cleanString(window.windowLabel, "", 80)
  };
}

function publicUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    planType: cleanString(usage.planType, "", 80),
    primaryWindow: publicUsageWindow(usage.primaryWindow),
    secondaryWindow: publicUsageWindow(usage.secondaryWindow)
  };
}

function publicHistoryCheck(check) {
  if (!check) return null;
  return {
    id: check.id,
    at: check.at,
    reason: check.reason,
    status: check.status,
    usage: publicUsage(check.usage)
  };
}

function publicComputedCheck(check) {
  if (!check) return null;
  return {
    ...publicHistoryCheck(check),
    message: check.message,
    latencyMs: check.latencyMs,
    planType: check.planType,
    account: check.account
  };
}

function publicComputedStats(computed) {
  return {
    ...computed,
    latestCheck: publicComputedCheck(computed.latestCheck),
    previousCheck: publicComputedCheck(computed.previousCheck),
    quota: publicUsage(computed.quota)
  };
}

async function getCodexUsageState({ force = false, userId = null } = {}) {
  const config = await loadConfig();
  const user = getUsageUser(config, userId || config.activeUsageUserId);
  if (!user.enabled) {
    return {
      status: "disabled",
      generatedAt: new Date().toISOString(),
      message: "该用户数据已停用",
      report: null,
      user: publicUsageUser(user)
    };
  }

  const configKey = codexUsageConfigKey(user);
  const cache = await loadAnyCodexUsageCache(user.id);
  if (!force) {
    if (cache?.result?.report) {
      const cachedResult = attachUsageUser(cache.result, user);
      if (cache.configKey !== configKey) {
        return {
          ...cachedResult,
          status: cachedResult.status === "ok" ? "stale" : cachedResult.status,
          message: `${cachedResult.message || "显示本地缓存"}；数据源配置已变化，手动刷新后更新`
        };
      }
      return cachedResult;
    }
    return {
      status: "empty",
      generatedAt: new Date().toISOString(),
      message: "暂无本地缓存；上传 Codex SQLite 或保存 Sub2API key 后刷新",
      report: null,
      user: publicUsageUser(user)
    };
  }

  try {
    const result = attachUsageUser(await buildCodexUsageState(user), user);
    await writeJson(codexUsageCacheFile(user.id), {
      configKey,
      cachedAt: result.generatedAt,
      result
    });
    return result;
  } catch (error) {
    const generatedAt = new Date().toISOString();
    if (cache?.result?.report) {
      return {
        ...attachUsageUser(cache.result, user),
        status: "stale",
        generatedAt,
        message: `Codex Token 数据刷新失败，显示缓存：${error.message}`
      };
    }
    return {
      status: error.codexUsageStatus || "error",
      generatedAt,
      message: error.message || "Codex Token 数据不可用",
      report: null,
      user: publicUsageUser(user)
    };
  }
}

async function loadCodexUsageCache(userId) {
  const cache = await readJson(codexUsageCacheFile(userId), null);
  if (!cache || typeof cache !== "object" || !cache.result) return null;
  return cache;
}

async function loadAnyCodexUsageCache(userId) {
  const cache = await loadCodexUsageCache(userId);
  if (cache) return cache;
  if (userId !== DEFAULT_USAGE_USER_ID) return null;
  const legacy = await readJson(CODEX_USAGE_CACHE_FILE, null);
  return legacy && typeof legacy === "object" && legacy.result ? legacy : null;
}

function isFreshCodexUsageCache(cache, configKey) {
  if (!cache || cache.configKey !== configKey) return false;
  const cachedAt = new Date(cache.cachedAt || cache.result.generatedAt || 0);
  if (Number.isNaN(cachedAt.getTime())) return false;
  return Date.now() - cachedAt.getTime() < CODEX_USAGE_CACHE_MS;
}

function isRecentCodexUsageCache(cache) {
  if (!cache) return false;
  const cachedAt = new Date(cache.cachedAt || cache.result?.generatedAt || 0);
  if (Number.isNaN(cachedAt.getTime())) return false;
  return Date.now() - cachedAt.getTime() < CODEX_USAGE_CACHE_MS;
}

async function refreshScheduledCodexUsage(reason = "scheduled") {
  if (codexUsageSchedulerBusy) return;
  codexUsageSchedulerBusy = true;
  try {
    const config = await loadConfig();
    const users = Array.isArray(config.usageUsers) ? config.usageUsers : [];
    for (const user of users) {
      if (!user || user.enabled === false) continue;
      const cache = await loadAnyCodexUsageCache(user.id);
      if (isRecentCodexUsageCache(cache)) continue;
      console.log(`[codex-usage] refreshing ${user.id || DEFAULT_USAGE_USER_ID} (${reason})`);
      await getCodexUsageState({ force: true, userId: user.id });
    }
  } catch (error) {
    console.error(`[codex-usage] ${error.message}`);
  } finally {
    codexUsageSchedulerBusy = false;
  }
}

function codexUsageConfigKey(user) {
  const usageConfig = user.codexUsage || DEFAULT_CODEX_USAGE;
  const sub2api = user.sub2api || DEFAULT_SUB2API;
  const dbPath = resolveUserPath(usageConfig.dbPath, DEFAULT_CODEX_USAGE.dbPath);
  const apiKeyPath = sub2api.apiKeyPath ? resolveUserPath(sub2api.apiKeyPath, "") : "";
  const adminPasswordPath = sub2api.adminPasswordPath ? resolveUserPath(sub2api.adminPasswordPath, "") : "";
  return JSON.stringify({
    reportSchema: "usage-users-v1",
    userId: user.id,
    codexUsage: {
      enabled: usageConfig.enabled !== false,
      dbPath,
      dbFile: fileSignature(dbPath),
      topSessions: usageConfig.topSessions
    },
    sub2api: {
      enabled: sub2api.enabled === true,
      label: sub2api.label,
      baseUrl: sub2api.baseUrl,
      apiKeyEnv: sub2api.apiKeyEnv,
      apiKeyPath: sub2api.apiKeyPath,
      apiKeyFile: fileSignature(apiKeyPath),
      adminEmail: sub2api.adminEmail,
      adminEmailEnv: process.env.SUB2API_ADMIN_EMAIL || "",
      adminPasswordEnv: sub2api.adminPasswordEnv,
      adminPasswordPath: sub2api.adminPasswordPath,
      adminPasswordFile: fileSignature(adminPasswordPath),
      adminPasswordPresent: Boolean(
        (sub2api.adminPasswordEnv && process.env[sub2api.adminPasswordEnv]) ||
        sub2api.adminPasswordPath
      ),
      adminUsageLimit: sub2api.adminUsageLimit,
      lookbackDays: sub2api.lookbackDays,
      startDate: sub2api.startDate,
      envKeyPresent: Boolean(sub2api.apiKeyEnv && process.env[sub2api.apiKeyEnv])
    }
  });
}

function fileSignature(filePath) {
  if (!filePath) return { exists: false };
  try {
    const stat = statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs)
    };
  } catch {
    return { exists: false };
  }
}

async function buildCodexUsageState(user) {
  const usageConfig = user.codexUsage || DEFAULT_CODEX_USAGE;
  const jsonPath = codexUsageReportJsonFile(user.id);
  const paths = resolveCodexUsagePaths(usageConfig);
  await mkdir(path.dirname(jsonPath), { recursive: true });
  let report;
  let usageDetails = null;
  if (usageConfig.enabled !== false && paths.dbPath && existsSync(paths.dbPath)) {
    await runCodexUsageReport(usageConfig, {
      renderer: "data",
      jsonPath,
      noSnapshot: true,
      timeoutMs: 45000
    });
    report = JSON.parse(await readFile(jsonPath, "utf8"));
    if (!report || typeof report !== "object" || !report.summary) {
      throw Object.assign(new Error("Codex Token 报告 JSON 结构不完整"), { codexUsageStatus: "error" });
    }
    usageDetails = await loadCodexTokenUsageDetails(usageConfig);
  } else {
    report = createEmptyCodexUsageReport(user, paths.dbPath, usageConfig.enabled === false ? "disabled" : "missing_db");
  }
  enrichCodexUsageCosts(report, usageDetails);
  enrichReportWithCodexSessions(report, usageDetails);
  await enrichReportWithSub2Api(report, user.sub2api);
  await writeJson(jsonPath, report);
  return {
    status: "ok",
    generatedAt: new Date().toISOString(),
    message: "Codex Token 数据已同步",
    report
  };
}

async function generateCodexUsageHtmlReport({ userId = null } = {}) {
  const config = await loadConfig();
  const user = getUsageUser(config, userId || config.activeUsageUserId);
  const usageConfig = user.codexUsage || DEFAULT_CODEX_USAGE;
  if (!usageConfig.enabled) {
    return {
      status: "disabled",
      generatedAt: new Date().toISOString(),
      message: "Codex Token 消耗面板已停用",
      reportUrl: null,
      user: publicUsageUser(user)
    };
  }

  const outDir = codexUsageOutputDir(user.id);
  await mkdir(outDir, { recursive: true });
  const htmlPath = path.join(outDir, CODEX_USAGE_REPORT_FILE);
  const jsonPath = path.join(outDir, CODEX_USAGE_JSON_FILE);
  const mdPath = path.join(outDir, CODEX_USAGE_MD_FILE);
  const snapshotPath = path.join(outDir, "latest.snapshot.sqlite");

  await runCodexUsageReport(usageConfig, {
    renderer: "standalone",
    outPath: htmlPath,
    jsonPath,
    mdPath,
    snapshotPath,
    timeoutMs: 120000
  });

  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  const usageDetails = await loadCodexTokenUsageDetails(usageConfig);
  enrichCodexUsageCosts(report, usageDetails);
  enrichReportWithCodexSessions(report, usageDetails);
  await enrichReportWithSub2Api(report, user.sub2api);
  await writeJson(jsonPath, report);
  const result = attachUsageUser({
    status: "ok",
    generatedAt: new Date().toISOString(),
    message: "Codex Token HTML 报告已生成",
    report
  }, user);
  await writeJson(codexUsageCacheFile(user.id), {
    configKey: codexUsageConfigKey(user),
    cachedAt: result.generatedAt,
    result
  });

  return {
    status: "ok",
    generatedAt: result.generatedAt,
    message: result.message,
    reportUrl: withBasePath(`/codex-usage/${encodeURIComponent(user.id)}/${CODEX_USAGE_REPORT_FILE}`),
    outputPath: htmlPath,
    user: publicUsageUser(user)
  };
}

function codexUsageUserDir(userId) {
  return path.join(USERS_DIR, cleanId(userId || DEFAULT_USAGE_USER_ID, "user"));
}

function codexUsageCacheFile(userId) {
  return path.join(codexUsageUserDir(userId), "codex-usage-cache.json");
}

function codexUsageReportJsonFile(userId) {
  return path.join(codexUsageUserDir(userId), "codex-usage-report.json");
}

function codexUploadedDbFile(userId) {
  return path.join(codexUsageUserDir(userId), "state_5.sqlite");
}

function sub2ApiKeyFile(userId) {
  return path.join(codexUsageUserDir(userId), "sub2api.key");
}

function codexUsageOutputDir(userId) {
  return path.join(CODEX_USAGE_OUTPUT_DIR, cleanId(userId || DEFAULT_USAGE_USER_ID, "user"));
}

function publicUsageUser(user) {
  return {
    id: user.id,
    label: user.label,
    enabled: user.enabled !== false,
    codexUsage: {
      enabled: user.codexUsage?.enabled !== false,
      dbPath: user.codexUsage?.dbPath || "",
      uploadedFileName: user.codexUsage?.uploadedFileName || "",
      uploadedAt: user.codexUsage?.uploadedAt || null,
      topSessions: user.codexUsage?.topSessions || DEFAULT_CODEX_USAGE.topSessions
    },
    sub2api: {
      enabled: user.sub2api?.enabled === true,
      label: user.sub2api?.label || DEFAULT_SUB2API.label,
      baseUrl: user.sub2api?.baseUrl || DEFAULT_SUB2API.baseUrl,
      apiKeyEnv: user.sub2api?.apiKeyEnv || DEFAULT_SUB2API.apiKeyEnv,
      apiKeyPath: user.sub2api?.apiKeyPath || "",
      adminEmail: user.sub2api?.adminEmail || "",
      adminPasswordEnv: user.sub2api?.adminPasswordEnv || DEFAULT_SUB2API.adminPasswordEnv,
      adminPasswordPath: user.sub2api?.adminPasswordPath || "",
      adminUsageLimit: user.sub2api?.adminUsageLimit || DEFAULT_SUB2API.adminUsageLimit,
      lookbackDays: user.sub2api?.lookbackDays || DEFAULT_SUB2API.lookbackDays,
      startDate: user.sub2api?.startDate || ""
    }
  };
}

function attachUsageUser(result, user) {
  return {
    ...result,
    user: publicUsageUser(user)
  };
}

function publicCodexUsageState(result) {
  if (!result || typeof result !== "object") return result;
  if (!result.report || typeof result.report !== "object") return result;
  const report = { ...result.report };
  delete report.sessions;
  return {
    ...result,
    report
  };
}

async function getCodexUsageSessionsState(searchParams) {
  const userId = searchParams.get("userId");
  const result = await getCodexUsageState({ userId });
  const sessions = Array.isArray(result?.report?.sessions) ? result.report.sessions : [];
  const page = querySessions(sessions, {
    q: searchParams.get("q"),
    month: searchParams.get("month"),
    sort: searchParams.get("sort"),
    page: searchParams.get("page"),
    pageSize: searchParams.get("pageSize")
  });
  return {
    status: result.status,
    generatedAt: result.generatedAt,
    message: result.message,
    user: result.user,
    ...page
  };
}

function createEmptyCodexUsageReport(user, dbPath, codexStatus) {
  const now = new Date();
  const usageSplit = createUsageGroup().usageSplit;
  return {
    meta: {
      title: `${user.label || "User"} Codex Token 使用报告`,
      generated_at: now.toISOString(),
      source_db_path: dbPath || "",
      queried_db_path: "",
      snapshot_path: "",
      snapshot_enabled: false,
      codex_status: codexStatus,
      available_columns: []
    },
    summary: {
      threads: 0,
      threads_display: "0",
      total_tokens: 0,
      total_tokens_display: "0",
      total_tokens_full: "0",
      avg_tokens: 0,
      avg_tokens_display: "0",
      avg_display: "0",
      max_tokens: 0,
      max_tokens_display: "0",
      zero_threads: 0,
      active_threads: 0,
      archived_threads: 0,
      usage_split: usageSplit
    },
    monthly: [],
    daily: [],
    daily_top: [],
    sources: [],
    models: [],
    top_sessions: [],
    month_views: [],
    default_month: localDateKey(now).slice(0, 7),
    sessions: [],
    session_summary: buildSessionSummaryFromRows([])
  };
}

async function runCodexUsageReport(usageConfig, options) {
  const paths = resolveCodexUsagePaths(usageConfig);
  assertReadablePath(paths.dbPath, "Codex SQLite 数据库");
  assertReadablePath(paths.skillScript, "codex-usage 生成脚本");

  const args = [
    paths.skillScript,
    "--db",
    paths.dbPath,
    "--top",
    String(usageConfig.topSessions),
    "--renderer",
    options.renderer
  ];
  if (options.outPath) args.push("--out", options.outPath);
  if (options.jsonPath) args.push("--json-out", options.jsonPath);
  if (options.mdPath) args.push("--md-out", options.mdPath);
  if (options.snapshotPath) args.push("--snapshot", options.snapshotPath);
  if (options.noSnapshot) args.push("--no-snapshot");

  try {
    await execFileAsync(process.env.PYTHON || "python", args, {
      cwd: ROOT,
      encoding: "utf8",
      timeout: options.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      }
    });
  } catch (error) {
    const details = String(error.stderr || error.stdout || error.message || "").trim();
    const message = details || "codex-usage 脚本执行失败";
    const status = error.code === "ENOENT" ? "unavailable" : "error";
    throw Object.assign(new Error(message), { codexUsageStatus: status });
  }
}

function resolveCodexUsagePaths(usageConfig) {
  return {
    dbPath: resolveUserPath(usageConfig.dbPath, DEFAULT_CODEX_USAGE.dbPath),
    skillScript: CODEX_USAGE_SCRIPT
  };
}

function assertReadablePath(filePath, label) {
  if (!existsSync(filePath)) {
    throw Object.assign(new Error(`${label}不存在：${filePath}`), { codexUsageStatus: "unavailable" });
  }
}

async function loadCodexTokenUsageDetails(usageConfig) {
  const paths = resolveCodexUsagePaths(usageConfig);
  const codexHomes = uniquePaths([
    path.dirname(paths.dbPath),
    resolveUserPath(process.env.CODEX_HOME || "~/.codex", "~/.codex")
  ]);
  const sessionIndex = await loadCodexSessionIndex(codexHomes);
  const files = [];
  for (const homeDir of codexHomes) {
    for (const dirName of CODEX_SESSION_DIRS) {
      files.push(...await listJsonlFiles(path.join(homeDir, dirName)));
    }
  }

  const byThreadId = new Map();
  for (const filePath of uniquePaths(files)) {
    const record = await readCodexSessionUsage(filePath);
    if (!record?.threadId || !record.usageSplit?.total_tokens) continue;
    const previous = byThreadId.get(record.threadId);
    if (!previous || String(record.lastEventAt || "") >= String(previous.lastEventAt || "")) {
      byThreadId.set(record.threadId, record);
    }
  }

  const records = [...byThreadId.values()];
  for (const record of records) {
    const indexed = sessionIndex.get(record.threadId);
    if (!indexed) continue;
    record.title = record.title || indexed.title;
    record.updatedAt = record.updatedAt || indexed.updatedAt;
  }
  const indexes = buildCodexUsageIndexes(records);
  return {
    records,
    byThreadId,
    ...indexes,
    coverage: {
      source: "rollout_jsonl_token_count",
      session_files: files.length,
      split_threads: records.length,
      split_tokens: indexes.total.usageSplit.total_tokens,
      input_tokens: indexes.total.usageSplit.input_tokens,
      cached_input_tokens: indexes.total.usageSplit.cached_input_tokens,
      output_tokens: indexes.total.usageSplit.output_tokens,
      reasoning_output_tokens: indexes.total.usageSplit.reasoning_output_tokens
    }
  };
}

async function loadCodexSessionIndex(codexHomes) {
  const byThreadId = new Map();
  for (const homeDir of codexHomes) {
    const filePath = path.join(homeDir, "session_index.jsonl");
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      const id = String(item.id || item.thread_id || "").trim();
      if (!id) continue;
      byThreadId.set(id, {
        title: String(item.thread_name || item.title || "").trim(),
        updatedAt: validIsoOrNull(item.updated_at || item.updatedAt)
      });
    }
  }
  return byThreadId;
}

async function listJsonlFiles(rootDir) {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(filePath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
      files.push(filePath);
    }
  }
  return files;
}

async function readCodexSessionUsage(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let threadId = threadIdFromRolloutPath(filePath);
  let source = "";
  let model = "";
  let provider = "";
  let created = rolloutDateFromPath(filePath);
  let createdAt = created?.localDateTime || "";
  let updatedAt = "";
  let cwd = "";
  let finalUsage = null;
  let lastEventAt = "";
  let tokenCountEvents = 0;

  for (const line of text.split(/\r?\n/)) {
    if (
      !line.includes("token_count") &&
      !line.includes("session_meta") &&
      !line.includes("turn_context")
    ) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = event && typeof event === "object" ? event.payload : null;
    if (!payload || typeof payload !== "object") continue;

    if (event.type === "session_meta") {
      if (payload.id) threadId = String(payload.id);
      if (payload.source) source = String(payload.source);
      if (payload.model_provider) provider = String(payload.model_provider);
      if (payload.cwd) cwd = String(payload.cwd);
      if (payload.timestamp) {
        createdAt ||= String(payload.timestamp);
        updatedAt = String(payload.timestamp);
        if (!created) created = localDatePartsFromTimestamp(payload.timestamp);
      }
      continue;
    }

    if (event.type === "turn_context") {
      if (payload.model) model = String(payload.model);
      if (payload.cwd && !cwd) cwd = String(payload.cwd);
      continue;
    }

    if (payload.type === "token_count") {
      const usage = extractTokenUsage(payload);
      if (!usage) continue;
      finalUsage = usage;
      lastEventAt = String(event.timestamp || lastEventAt || "");
      updatedAt = lastEventAt || updatedAt;
      tokenCountEvents += 1;
    }
  }

  if (!threadId || !finalUsage) return null;
  const day = created?.day || "";
  return {
    threadId,
    filePath,
    day,
    month: day ? day.slice(0, 7) : "",
    source,
    sourceLabel: sourceLabel(source),
    model,
    modelKey: normalizeModelKey(model),
    provider,
    cwd,
    createdAt: validIsoOrNull(createdAt) || createdAt,
    updatedAt: validIsoOrNull(updatedAt) || updatedAt,
    usageSplit: finalUsage,
    tokens: finalUsage.total_tokens,
    lastEventAt,
    tokenCountEvents
  };
}

function extractTokenUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const direct = normalizeTokenUsage(value.total_token_usage || value.token_usage);
  if (direct) return direct;
  return extractTokenUsage(value.info, depth + 1) || extractTokenUsage(value.payload, depth + 1);
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const usage = {
    input_tokens: nonnegativeInteger(value.input_tokens),
    cached_input_tokens: nonnegativeInteger(value.cached_input_tokens),
    output_tokens: nonnegativeInteger(value.output_tokens),
    reasoning_output_tokens: nonnegativeInteger(value.reasoning_output_tokens),
    total_tokens: nonnegativeInteger(value.total_tokens)
  };
  if (!usage.total_tokens && (usage.input_tokens || usage.output_tokens)) {
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  return usage.total_tokens ? usage : null;
}

function buildCodexUsageIndexes(records) {
  const indexes = {
    total: createUsageGroup(),
    byMonth: new Map(),
    byDay: new Map(),
    byModel: new Map(),
    bySource: new Map()
  };
  for (const record of records) {
    addRecordToGroup(indexes.total, record);
    addRecordToIndex(indexes.byMonth, record.month, record);
    addRecordToIndex(indexes.byDay, record.day, record);
    addRecordToIndex(indexes.byModel, record.modelKey || normalizeModelKey(record.model), record);
    addRecordToIndex(indexes.bySource, record.sourceLabel || sourceLabel(record.source), record);
  }
  return indexes;
}

function createUsageGroup() {
  return {
    records: [],
    usageSplit: {
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0
    }
  };
}

function addRecordToIndex(index, key, record) {
  if (!key) return;
  if (!index.has(key)) index.set(key, createUsageGroup());
  addRecordToGroup(index.get(key), record);
}

function addRecordToGroup(group, record) {
  group.records.push(record);
  addUsageSplit(group.usageSplit, record.usageSplit);
}

function addUsageSplit(target, source) {
  if (!target || !source) return target;
  for (const key of ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"]) {
    target[key] = nonnegativeInteger(target[key]) + nonnegativeInteger(source[key]);
  }
  return target;
}

function uniquePaths(values) {
  return [...new Set(values.filter(Boolean).map((value) => path.resolve(String(value))))];
}

function threadIdFromRolloutPath(filePath) {
  const match = path.basename(filePath).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match ? match[1] : "";
}

function rolloutDateFromPath(filePath) {
  const match = path.basename(filePath).match(/^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/i);
  if (!match) return null;
  return {
    day: match[1],
    localDateTime: `${match[1]}T${match[2]}:${match[3]}:${match[4]}`
  };
}

function localDatePartsFromTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return { day: local.toISOString().slice(0, 10) };
}

function sourceLabel(value) {
  const source = String(value || "").trim();
  if (!source) return "未知来源";
  if (source.startsWith("{")) return "子 Agent";
  return CODEX_SOURCE_LABELS[source.toLowerCase()] || source;
}

function nonnegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

function enrichCodexUsageCosts(report, usageDetails = null) {
  if (!report || typeof report !== "object") return report;
  const splitCoverage = codexUsageSplitCoverage(usageDetails, report.summary?.total_tokens);
  const effectiveUsageDetails = splitCoverage?.full_coverage ? usageDetails : null;
  report.pricing = {
    source: OPENAI_PRICE_SOURCE,
    models: MODEL_PRICING_USD_PER_MILLION,
    split_coverage: splitCoverage
  };

  annotateAggregateRows(report.models, effectiveUsageDetails?.byModel, "model");
  annotateAggregateRows(report.sources, effectiveUsageDetails?.bySource, "source");
  annotateSessionCosts(report.top_sessions, effectiveUsageDetails);
  annotateGroupCost(report.summary, effectiveUsageDetails?.total, () => aggregateCostEstimate(report.models, report.summary.total_tokens));

  for (const view of report.month_views || []) {
    const monthGroup = effectiveUsageDetails?.byMonth?.get(view.month);
    annotateAggregateRows(view.models, groupIndex(monthGroup, "model"), "model");
    annotateAggregateRows(view.sources, groupIndex(monthGroup, "source"), "source");
    annotateSessionCosts(view.top_sessions, effectiveUsageDetails);
    annotateGroupCost(view, monthGroup, () => aggregateCostEstimate(view.models, view.tokens));
    annotateDailyCosts(view.days, effectiveUsageDetails, view.cost_estimate, view.tokens);
  }
  annotateDailyCosts(report.daily, effectiveUsageDetails, report.summary.cost_estimate, report.summary.total_tokens);
  return report;
}

function enrichReportWithCodexSessions(report, usageDetails = null) {
  if (!report || typeof report !== "object") return report;
  const records = Array.isArray(usageDetails?.records) ? usageDetails.records : [];
  const sessions = buildCodexSessionList(records, report);
  report.sessions = sessions;
  report.session_summary = buildCodexSessionSummary(records, sessions);
  return report;
}

function buildCodexSessionList(records, report) {
  const topById = new Map(
    (Array.isArray(report?.top_sessions) ? report.top_sessions : [])
      .filter((item) => item?.id)
      .map((item) => [String(item.id), item])
  );
  return records.map((record) => {
    const id = String(record.threadId || "").trim();
    const top = topById.get(id) || {};
    const usageSplit = usageSplitPayload(record.usageSplit);
    const model = String(record.model || top.model || "unknown");
    const costEstimate = costEstimateForUsageSplit(usageSplit, model) ||
      costEstimateForTokens(record.tokens, model);
    const title = cleanString(record.title || top.title, "未命名会话", 240) || "未命名会话";
    const cwd = cleanString(record.cwd || top.cwd, "", 500);
    const source = cleanString(record.sourceLabel || top.source || sourceLabel(record.source), "未知来源", 120);
    const provider = cleanString(record.provider || top.provider, "", 80);
    const createdAt = safeIsoString(record.createdAt);
    const updatedAt = safeIsoString(record.updatedAt || record.lastEventAt);
    return {
      id,
      title,
      day: record.day || "",
      month: record.month || "",
      created_at: createdAt,
      created: top.created || record.day || "",
      updated_at: updatedAt,
      updated: top.updated || "",
      model,
      model_key: normalizeModelKey(model),
      provider,
      source,
      cwd,
      rollout_path: cleanString(record.filePath || top.rollout_path, "", 800),
      tokens: nonnegativeInteger(record.tokens),
      tokens_display: formatCompactTokensForReport(record.tokens),
      tokens_full: formatIntegerForReport(record.tokens),
      usage_split: usageSplit,
      cost_estimate: costEstimate,
      token_count_events: nonnegativeInteger(record.tokenCountEvents)
    };
  }).sort((left, right) => {
    const tokenDelta = nonnegativeInteger(right.tokens) - nonnegativeInteger(left.tokens);
    if (tokenDelta) return tokenDelta;
    return String(right.updated_at || right.created_at || "").localeCompare(String(left.updated_at || left.created_at || ""));
  });
}

function buildCodexSessionSummary(records, sessions) {
  return buildSessionSummaryFromRows(sessions);
}

function buildSessionSummaryFromRows(sessions) {
  const usageSplit = createUsageGroup().usageSplit;
  for (const session of sessions) addUsageSplit(usageSplit, session.usage_split);
  const costEstimate = combineCostEstimates(
    sessions.map((session) => session.cost_estimate).filter(Boolean),
    usageSplit
  );
  return {
    sessions: sessions.length,
    tokens: usageSplit.total_tokens,
    tokens_display: formatCompactTokensForReport(usageSplit.total_tokens),
    tokens_full: formatIntegerForReport(usageSplit.total_tokens),
    usage_split: usageSplitPayload(usageSplit),
    cost_estimate: costEstimate
  };
}

function safeIsoString(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

async function enrichReportWithSub2Api(report, sub2apiConfig = DEFAULT_CONFIG.sub2api) {
  if (!report || typeof report !== "object") return report;
  report.integrations = report.integrations && typeof report.integrations === "object" ? report.integrations : {};
  const config = {
    ...DEFAULT_CONFIG.sub2api,
    ...(sub2apiConfig || {})
  };
  if (!config.enabled) {
    report.integrations.sub2api = {
      status: "disabled",
      enabled: false,
      message: "Sub2API integration is disabled"
    };
    return report;
  }

  const apiKey = await readSub2ApiKey(config);
  if (!apiKey) {
    report.integrations.sub2api = {
      status: "missing_key",
      enabled: true,
      label: config.label,
      baseUrl: config.baseUrl,
      apiKeyEnv: config.apiKeyEnv,
      apiKeyPath: config.apiKeyPath,
      message: `Set ${config.apiKeyEnv || "SUB2API_API_KEY"} or configure a key file`
    };
    return report;
  }

  try {
    const usage = await fetchSub2ApiUsage(config, apiKey);
    mergeSub2ApiUsageIntoReport(report, usage);
    report.integrations.sub2api = {
      status: "ok",
      enabled: true,
      label: usage.label,
      baseUrl: config.baseUrl,
      startDate: usage.startDate,
      endDate: usage.endDate,
      days: usage.days.length,
      nonzeroDays: usage.days.filter((day) => day.tokens > 0).length,
      requests: usage.total.requests,
      total_tokens: usage.total.usageSplit.total_tokens,
      total_tokens_display: formatCompactTokensForReport(usage.total.usageSplit.total_tokens),
      actual_cost: roundCurrency(usage.total.cost),
      actual_cost_display: formatUsd(usage.total.cost),
      balance: usage.balance,
      remaining: usage.remaining,
      planName: usage.planName,
      admin_usage: usage.adminUsage ? {
        status: usage.adminUsage.status,
        message: usage.adminUsage.message,
        requests: usage.adminUsage.items?.length || 0,
        total: usage.adminUsage.total || 0,
        limit: usage.adminUsage.limit || null
      } : null,
      message: "Sub2API usage merged"
    };
  } catch (error) {
    report.integrations.sub2api = {
      status: "error",
      enabled: true,
      label: config.label,
      baseUrl: config.baseUrl,
      message: error.message || "Sub2API usage fetch failed"
    };
  }
  return report;
}

async function readSub2ApiKey(config) {
  const envName = String(config.apiKeyEnv || "").trim();
  const envKey = envName ? String(process.env[envName] || "").trim() : "";
  if (envKey) return envKey;
  const keyPath = String(config.apiKeyPath || "").trim();
  if (!keyPath) return "";
  try {
    return (await readFile(resolveUserPath(keyPath, ""), "utf8")).trim();
  } catch {
    return "";
  }
}

async function fetchSub2ApiUsage(config, apiKey) {
  const endDate = localDateKey(new Date());
  const startDate = config.startDate || addDaysToDateKey(endDate, -Math.max(0, nonnegativeInteger(config.lookbackDays) - 1));
  const days = [];
  let balance = null;
  let remaining = null;
  let planName = "";
  for (const day of dateKeysBetween(startDate, endDate)) {
    const payload = await fetchSub2ApiDay(config.baseUrl, apiKey, day);
    if (payload && typeof payload === "object") {
      if (payload.balance !== undefined) balance = payload.balance;
      if (payload.remaining !== undefined) remaining = payload.remaining;
      if (payload.planName) planName = String(payload.planName);
    }
    days.push(normalizeSub2ApiDay(day, payload));
  }
  const total = aggregateSub2ApiDays(days);
  const adminUsage = await fetchSub2ApiAdminUsage(config, startDate, endDate).catch((error) => ({
    status: "error",
    message: error.message || "Sub2API admin usage fetch failed",
    items: [],
    total: 0
  }));
  return {
    label: config.label || DEFAULT_CONFIG.sub2api.label,
    startDate,
    endDate,
    balance,
    remaining,
    planName,
    days,
    total,
    adminUsage
  };
}

async function fetchSub2ApiAdminUsage(config, startDate, endDate) {
  const credentials = await readSub2ApiAdminCredentials(config);
  if (!credentials.email || !credentials.password) {
    return {
      status: "disabled",
      message: "Sub2API admin credentials are not configured",
      items: [],
      total: 0
    };
  }
  const token = await loginSub2ApiAdmin(config.baseUrl, credentials);
  const pageSize = 200;
  const limit = clamp(Math.round(toNumber(config.adminUsageLimit, DEFAULT_CONFIG.sub2api.adminUsageLimit)), 100, 100000);
  const items = [];
  let total = 0;
  let pages = 1;
  for (let page = 1; page <= pages && items.length < limit; page += 1) {
    const payload = await fetchSub2ApiAdminUsagePage(config.baseUrl, token, {
      page,
      pageSize,
      startDate,
      endDate
    });
    const data = payload?.data || payload;
    const pageItems = Array.isArray(data?.items) ? data.items : [];
    total = nonnegativeInteger(data?.total);
    pages = Math.max(1, nonnegativeInteger(data?.pages) || Math.ceil(total / pageSize) || 1);
    items.push(...pageItems);
    if (!pageItems.length) break;
  }
  return {
    status: items.length < total ? "truncated" : "ok",
    message: items.length < total
      ? `Sub2API admin usage truncated at ${items.length}/${total} requests`
      : "Sub2API admin request usage loaded",
    items,
    total,
    limit
  };
}

async function readSub2ApiAdminCredentials(config) {
  const email = cleanString(
    process.env.SUB2API_ADMIN_EMAIL || config.adminEmail,
    "",
    200
  );
  const envName = String(config.adminPasswordEnv || DEFAULT_CONFIG.sub2api.adminPasswordEnv || "").trim();
  const envPassword = envName ? String(process.env[envName] || "").trim() : "";
  if (email && envPassword) return { email, password: envPassword };
  const passwordPath = String(config.adminPasswordPath || "").trim();
  if (!email || !passwordPath) return { email, password: "" };
  try {
    return {
      email,
      password: (await readFile(resolveUserPath(passwordPath, ""), "utf8")).trim()
    };
  } catch {
    return { email, password: "" };
  }
}

async function loginSub2ApiAdmin(baseUrl, credentials) {
  const url = new URL("/api/v1/auth/login", baseUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": "gpt-monitor/sub2api-admin"
    },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password
    })
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const token = payload?.data?.access_token || payload?.access_token;
  if (!response.ok || !token) {
    const message = payload?.message || payload?.error?.message || text.slice(0, 180) || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Sub2API admin login failed: ${message}`), {
      statusCode: response.status
    });
  }
  return String(token);
}

async function fetchSub2ApiAdminUsagePage(baseUrl, token, options) {
  const url = new URL("/api/v1/admin/usage", baseUrl);
  url.searchParams.set("page", String(options.page));
  url.searchParams.set("page_size", String(options.pageSize));
  url.searchParams.set("start_date", options.startDate);
  url.searchParams.set("end_date", options.endDate);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "User-Agent": "gpt-monitor/sub2api-admin"
    }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error?.message || text.slice(0, 180) || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Sub2API admin usage failed: ${message}`), {
      statusCode: response.status
    });
  }
  return payload;
}

async function fetchSub2ApiDay(baseUrl, apiKey, day) {
  const url = new URL("/v1/usage", baseUrl);
  url.searchParams.set("start_date", day);
  url.searchParams.set("end_date", day);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Accept": "application/json",
        "User-Agent": "gpt-monitor/sub2api"
      }
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = payload?.error?.message || payload?.message || text.slice(0, 180) || `HTTP ${response.status}`;
      throw Object.assign(new Error(`Sub2API usage endpoint failed for ${day}: ${message}`), {
        statusCode: response.status
      });
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSub2ApiDay(day, payload) {
  const rows = Array.isArray(payload?.model_stats) ? payload.model_stats : [];
  const models = rows.map((row) => normalizeSub2ApiModelRow(day, row)).filter(Boolean);
  const aggregate = aggregateSub2ApiModelRows(models);
  return {
    day,
    requests: aggregate.requests,
    tokens: aggregate.usageSplit.total_tokens,
    usageSplit: aggregate.usageSplit,
    cost: aggregate.cost,
    costEstimate: sub2ApiCostEstimate(aggregate.cost, aggregate.usageSplit),
    models
  };
}

function normalizeSub2ApiModelRow(day, row) {
  if (!row || typeof row !== "object") return null;
  const usageSplit = sub2ApiUsageSplit(row);
  const requests = nonnegativeInteger(row.requests);
  const cost = toNumber(row.actual_cost ?? row.cost, 0);
  return {
    day,
    model: String(row.model || "unknown"),
    requests,
    tokens: usageSplit.total_tokens,
    usageSplit,
    cost,
    costEstimate: sub2ApiCostEstimate(cost, usageSplit)
  };
}

function sub2ApiUsageSplit(row) {
  const rawInput = nonnegativeInteger(row.input_tokens);
  const cacheCreation = nonnegativeInteger(row.cache_creation_tokens);
  const cacheRead = nonnegativeInteger(row.cache_read_tokens);
  const output = nonnegativeInteger(row.output_tokens);
  const total = nonnegativeInteger(row.total_tokens) || rawInput + cacheCreation + cacheRead + output;
  return {
    input_tokens: rawInput + cacheCreation + cacheRead,
    cached_input_tokens: cacheRead,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: total
  };
}

function aggregateSub2ApiDays(days) {
  const aggregate = createExternalUsageAggregate();
  for (const day of days || []) addExternalAggregate(aggregate, day);
  return aggregate;
}

function aggregateSub2ApiModelRows(rows) {
  const aggregate = createExternalUsageAggregate();
  for (const row of rows || []) addExternalAggregate(aggregate, row);
  return aggregate;
}

function createExternalUsageAggregate() {
  return {
    requests: 0,
    usageSplit: createUsageGroup().usageSplit,
    cost: 0
  };
}

function addExternalAggregate(target, source) {
  if (!target || !source) return target;
  target.requests += nonnegativeInteger(source.requests);
  addUsageSplit(target.usageSplit, source.usageSplit);
  target.cost += toNumber(source.cost, 0);
  return target;
}

function sub2ApiCostEstimate(cost, usageSplit) {
  const usage = normalizeTokenUsage(usageSplit);
  const amount = toNumber(cost, 0);
  if (!usage?.total_tokens && !amount) return null;
  return formatCostEstimate({
    low: amount,
    high: amount,
    midpoint: amount,
    pricedTokens: usage?.total_tokens || 0,
    unpricedTokens: 0,
    model: "sub2api",
    usageSplit: usage || createUsageGroup().usageSplit,
    exact: true,
    basis: "sub2api_actual_cost"
  });
}

function mergeSub2ApiUsageIntoReport(report, usage) {
  if (!usage?.days?.length) return report;
  const sourceLabelValue = usage.label || DEFAULT_CONFIG.sub2api.label;
  report.models = Array.isArray(report.models) ? report.models : [];
  report.sources = Array.isArray(report.sources) ? report.sources : [];
  report.daily = Array.isArray(report.daily) ? report.daily : [];
  report.month_views = Array.isArray(report.month_views) ? report.month_views : [];

  for (const day of usage.days) {
    const month = day.day.slice(0, 7);
    const view = ensureMonthView(report, month);
    mergeExternalIntoReportRow(ensureDailyRow(view.days, day.day), day);
    mergeExternalIntoReportRow(ensureDailyRow(report.daily, day.day), day);
    mergeExternalIntoReportRow(ensureSourceRow(view.sources, sourceLabelValue), day);
    mergeExternalIntoReportRow(ensureSourceRow(report.sources, sourceLabelValue), day);

    for (const model of day.models) {
      mergeExternalIntoReportRow(ensureModelRow(view.models, model.model), model);
      mergeExternalIntoReportRow(ensureModelRow(report.models, model.model), model);
    }
  }

  recomputeReportUsageDisplays(report);
  mergeSub2ApiSessionsIntoReport(report, usage);
  return report;
}

function mergeSub2ApiSessionsIntoReport(report, usage) {
  report.sessions = Array.isArray(report.sessions) ? report.sessions : [];
  const rows = Array.isArray(usage.adminUsage?.items) && usage.adminUsage.items.length
    ? usage.adminUsage.items.map((item) => sub2ApiAdminUsageSession(item, usage.label)).filter(Boolean)
    : sub2ApiAggregateSessions(usage);
  const existingIds = new Set(report.sessions.map((session) => String(session.id || "")));
  for (const row of rows) {
    if (!row?.id || existingIds.has(row.id)) continue;
    existingIds.add(row.id);
    report.sessions.push(row);
  }
  report.session_summary = buildSessionSummaryFromRows(report.sessions);
}

function sub2ApiAdminUsageSession(item, label) {
  if (!item || typeof item !== "object") return null;
  const requestId = cleanString(item.request_id || item.id, "", 160);
  const model = cleanString(item.model, "unknown", 160);
  const createdAt = safeIsoString(item.created_at);
  const day = createdAt ? localDateKey(new Date(createdAt)) : String(item.created_at || "").slice(0, 10);
  const usageSplit = sub2ApiUsageSplit(item);
  const cost = toNumber(item.actual_cost ?? item.total_cost ?? item.cost, 0);
  const endpoint = [item.inbound_endpoint, item.upstream_endpoint]
    .filter(Boolean)
    .map((value) => cleanString(value, "", 120))
    .join(" -> ");
  const requestType = [item.request_type, item.stream ? "stream" : ""].filter(Boolean).join(" / ");
  const titleParts = [
    label || DEFAULT_CONFIG.sub2api.label,
    model,
    shortIdForTitle(requestId)
  ].filter(Boolean);
  return {
    id: `sub2api:${item.id || requestId || crypto.randomUUID()}`,
    title: titleParts.join(" · "),
    day,
    month: day ? day.slice(0, 7) : "",
    created_at: createdAt,
    created: item.created_at || "",
    updated_at: createdAt,
    updated: item.created_at || "",
    model,
    model_key: normalizeModelKey(model),
    provider: "sub2api",
    source: label || DEFAULT_CONFIG.sub2api.label,
    cwd: endpoint,
    rollout_path: "",
    tokens: usageSplit.total_tokens,
    tokens_display: formatCompactTokensForReport(usageSplit.total_tokens),
    tokens_full: formatIntegerForReport(usageSplit.total_tokens),
    usage_split: usageSplitPayload(usageSplit),
    cost_estimate: sub2ApiCostEstimate(cost, usageSplit),
    requests: 1,
    request_id: requestId,
    request_type: requestType,
    duration_ms: nonnegativeInteger(item.duration_ms),
    first_token_ms: nonnegativeInteger(item.first_token_ms),
    api_key_id: item.api_key_id ?? null,
    account_id: item.account_id ?? null,
    group_id: item.group_id ?? null
  };
}

function sub2ApiAggregateSessions(usage) {
  const rows = [];
  const label = usage.label || DEFAULT_CONFIG.sub2api.label;
  for (const day of usage.days || []) {
    for (const model of day.models || []) {
      const usageSplit = usageSplitPayload(model.usageSplit);
      rows.push({
        id: `sub2api-aggregate:${day.day}:${model.model}`,
        title: `${label} 统计 · ${day.day} · ${model.model || "unknown"}`,
        day: day.day,
        month: day.day ? day.day.slice(0, 7) : "",
        created_at: safeIsoString(`${day.day}T00:00:00`),
        created: day.day,
        updated_at: safeIsoString(`${day.day}T23:59:59`),
        updated: day.day,
        model: String(model.model || "unknown"),
        model_key: normalizeModelKey(model.model),
        provider: "sub2api",
        source: label,
        cwd: "按日 / 模型聚合统计",
        rollout_path: "",
        tokens: usageSplit.total_tokens,
        tokens_display: formatCompactTokensForReport(usageSplit.total_tokens),
        tokens_full: formatIntegerForReport(usageSplit.total_tokens),
        usage_split: usageSplit,
        cost_estimate: model.costEstimate || sub2ApiCostEstimate(model.cost, usageSplit),
        requests: nonnegativeInteger(model.requests)
      });
    }
  }
  return rows;
}

function shortIdForTitle(value) {
  const id = String(value || "");
  if (!id) return "";
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}

function mergeExternalIntoReportRow(row, aggregate) {
  if (!row || !aggregate) return row;
  const existingUsage = normalizeTokenUsage(row.usage_split) || createUsageGroup().usageSplit;
  const combinedUsage = addUsageSplit({ ...existingUsage }, aggregate.usageSplit);
  const existingRequests = nonnegativeInteger(row.requests);
  const addedRequests = nonnegativeInteger(aggregate.requests);
  row.requests = existingRequests + addedRequests;
  row.threads = nonnegativeInteger(row.threads) + addedRequests;
  row.tokens = nonnegativeInteger(row.tokens) + nonnegativeInteger(aggregate.tokens ?? aggregate.usageSplit?.total_tokens);
  row.usage_split = usageSplitPayload(combinedUsage);
  row.cost_estimate = combineCostEstimates([
    row.cost_estimate,
    aggregate.costEstimate || sub2ApiCostEstimate(aggregate.cost, aggregate.usageSplit)
  ], combinedUsage);
  return row;
}

function ensureMonthView(report, month) {
  let view = report.month_views.find((item) => item.month === month);
  if (!view) {
    view = {
      month,
      threads: 0,
      tokens: 0,
      tokens_display: "0",
      tokens_full: "0",
      avg_tokens: 0,
      avg_display: "0",
      share_pct: 0,
      share_display: "0.00%",
      days: buildMonthDays(month),
      models: [],
      sources: [],
      top_sessions: []
    };
    report.month_views.push(view);
  }
  view.days = Array.isArray(view.days) ? view.days : buildMonthDays(month);
  view.models = Array.isArray(view.models) ? view.models : [];
  view.sources = Array.isArray(view.sources) ? view.sources : [];
  view.top_sessions = Array.isArray(view.top_sessions) ? view.top_sessions : [];
  return view;
}

function buildMonthDays(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!match) return [];
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const count = new Date(year, monthIndex + 1, 0).getDate();
  const rows = [];
  for (let day = 1; day <= count; day += 1) {
    const key = `${match[1]}-${match[2]}-${String(day).padStart(2, "0")}`;
    rows.push(createDailyRow(key));
  }
  return rows;
}

function ensureDailyRow(rows, day) {
  let row = rows.find((item) => item.day === day);
  if (!row) {
    row = createDailyRow(day);
    rows.push(row);
  }
  return row;
}

function createDailyRow(day) {
  return {
    day,
    label: String(day || "").slice(-2),
    threads: 0,
    requests: 0,
    tokens: 0,
    tokens_display: "0",
    tokens_full: "0",
    avg_tokens: 0,
    avg_display: "0",
    share_pct: 0,
    share_display: "0.00%"
  };
}

function ensureModelRow(rows, model) {
  const key = normalizeModelKey(model) || String(model || "unknown");
  let row = rows.find((item) => normalizeModelKey(item.model) === key);
  if (!row) {
    row = {
      model: String(model || "unknown"),
      provider: "sub2api",
      threads: 0,
      requests: 0,
      tokens: 0,
      tokens_display: "0",
      tokens_full: "0",
      share_pct: 0,
      share_display: "0.00%"
    };
    rows.push(row);
  }
  return row;
}

function ensureSourceRow(rows, source) {
  const key = String(source || "Sub2API");
  let row = rows.find((item) => String(item.source || "") === key);
  if (!row) {
    row = {
      source: key,
      threads: 0,
      requests: 0,
      tokens: 0,
      tokens_display: "0",
      tokens_full: "0",
      share_pct: 0,
      share_display: "0.00%"
    };
    rows.push(row);
  }
  return row;
}

function recomputeReportUsageDisplays(report) {
  report.month_views.sort((left, right) => String(left.month).localeCompare(String(right.month)));
  for (const view of report.month_views) {
    view.days = (Array.isArray(view.days) ? view.days : []).sort((left, right) => String(left.day).localeCompare(String(right.day)));
    recomputeRows(view.days, sumRowTokens(view.days));
    recomputeRows(view.models, sumRowTokens(view.models));
    recomputeRows(view.sources, sumRowTokens(view.sources));
    const viewUsage = sumUsageSplits(view.days);
    const viewCosts = view.days.map((day) => day.cost_estimate).filter(Boolean);
    view.tokens = viewUsage.total_tokens;
    view.threads = sumRowThreads(view.days);
    view.requests = sumRowRequests(view.days);
    view.usage_split = usageSplitPayload(viewUsage);
    view.cost_estimate = combineCostEstimates(viewCosts, viewUsage);
    refreshUsageDisplayFields(view, view.tokens);
    view.models.sort((left, right) => nonnegativeInteger(right.tokens) - nonnegativeInteger(left.tokens));
    view.sources.sort((left, right) => nonnegativeInteger(right.tokens) - nonnegativeInteger(left.tokens));
  }
  recomputeRows(report.month_views, sumRowTokens(report.month_views));

  const daily = report.month_views.flatMap((view) => view.days || [])
    .filter((day) => nonnegativeInteger(day.tokens) > 0)
    .sort((left, right) => String(left.day).localeCompare(String(right.day)));
  report.daily = daily;
  report.daily_top = daily.slice().sort((left, right) => nonnegativeInteger(right.tokens) - nonnegativeInteger(left.tokens)).slice(0, 10);
  report.monthly = report.month_views.map((view) => ({
    month: view.month,
    threads: nonnegativeInteger(view.threads),
    requests: nonnegativeInteger(view.requests),
    tokens: nonnegativeInteger(view.tokens),
    tokens_display: view.tokens_display,
    tokens_full: view.tokens_full,
    share_pct: view.share_pct,
    share_display: view.share_display,
    avg_tokens: view.avg_tokens,
    avg_display: view.avg_display
  }));

  const summaryUsage = sumUsageSplits(report.month_views);
  const summaryCosts = report.month_views.map((view) => view.cost_estimate).filter(Boolean);
  report.summary = report.summary && typeof report.summary === "object" ? report.summary : {};
  report.summary.threads = sumRowThreads(report.month_views);
  report.summary.requests = sumRowRequests(report.month_views);
  report.summary.total_tokens = summaryUsage.total_tokens;
  report.summary.usage_split = usageSplitPayload(summaryUsage);
  report.summary.cost_estimate = combineCostEstimates(summaryCosts, summaryUsage);
  refreshSummaryDisplayFields(report.summary);

  recomputeRows(report.models, report.summary.total_tokens);
  recomputeRows(report.sources, report.summary.total_tokens);
  report.models.sort((left, right) => nonnegativeInteger(right.tokens) - nonnegativeInteger(left.tokens));
  report.sources.sort((left, right) => nonnegativeInteger(right.tokens) - nonnegativeInteger(left.tokens));
  report.default_month = report.month_views.findLast?.((view) => nonnegativeInteger(view.tokens) > 0)?.month ||
    [...report.month_views].reverse().find((view) => nonnegativeInteger(view.tokens) > 0)?.month ||
    report.month_views.at(-1)?.month ||
    report.default_month;
}

function recomputeRows(rows, totalTokens) {
  for (const row of rows || []) refreshUsageDisplayFields(row, totalTokens);
}

function refreshUsageDisplayFields(row, totalTokens) {
  const tokens = nonnegativeInteger(row.tokens ?? row.total_tokens);
  const activity = nonnegativeInteger(row.threads);
  row.tokens = tokens;
  row.tokens_display = formatCompactTokensForReport(tokens);
  row.tokens_full = formatIntegerForReport(tokens);
  row.avg_tokens = activity ? Math.round(tokens / activity) : 0;
  row.avg_display = formatCompactTokensForReport(row.avg_tokens);
  const denominator = nonnegativeInteger(totalTokens);
  const share = denominator ? tokens / denominator * 100 : 0;
  row.share_pct = Math.round(share * 100) / 100;
  row.share_display = `${row.share_pct.toFixed(2)}%`;
  return row;
}

function refreshSummaryDisplayFields(summary) {
  const tokens = nonnegativeInteger(summary.total_tokens);
  const activity = nonnegativeInteger(summary.threads);
  summary.total_tokens = tokens;
  summary.total_tokens_display = formatCompactTokensForReport(tokens);
  summary.total_tokens_full = formatIntegerForReport(tokens);
  summary.avg_tokens = activity ? Math.round(tokens / activity) : 0;
  summary.avg_tokens_display = formatCompactTokensForReport(summary.avg_tokens);
  summary.avg_display = summary.avg_tokens_display;
  return summary;
}

function sumRowTokens(rows) {
  return (rows || []).reduce((sum, row) => sum + nonnegativeInteger(row.tokens ?? row.total_tokens), 0);
}

function sumRowThreads(rows) {
  return (rows || []).reduce((sum, row) => sum + nonnegativeInteger(row.threads), 0);
}

function sumRowRequests(rows) {
  return (rows || []).reduce((sum, row) => sum + nonnegativeInteger(row.requests), 0);
}

function sumUsageSplits(rows) {
  const usage = createUsageGroup().usageSplit;
  for (const row of rows || []) addUsageSplit(usage, row.usage_split);
  return usage;
}

function combineCostEstimates(estimates, usageSplit) {
  const rows = (estimates || []).filter(Boolean);
  if (!rows.length) return null;
  const components = {
    input_usd: 0,
    cached_input_usd: 0,
    output_usd: 0
  };
  let low = 0;
  let high = 0;
  let midpoint = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let exact = true;
  let hasComponents = false;
  for (const estimate of rows) {
    low += toNumber(estimate.low_usd, 0);
    high += toNumber(estimate.high_usd, 0);
    midpoint += toNumber(estimate.midpoint_usd, 0);
    pricedTokens += nonnegativeInteger(estimate.priced_tokens);
    unpricedTokens += nonnegativeInteger(estimate.unpriced_tokens);
    exact = exact && estimate.exact !== false;
    if (estimate.components) {
      hasComponents = true;
      components.input_usd += toNumber(estimate.components.input_usd, 0);
      components.cached_input_usd += toNumber(estimate.components.cached_input_usd, 0);
      components.output_usd += toNumber(estimate.components.output_usd, 0);
    }
  }
  return formatCostEstimate({
    low,
    high,
    midpoint,
    pricedTokens,
    unpricedTokens,
    model: "mixed",
    usageSplit,
    components: hasComponents ? components : null,
    exact,
    basis: "combined_usage"
  });
}

function formatIntegerForReport(value) {
  return new Intl.NumberFormat("en-US").format(nonnegativeInteger(value));
}

function formatCompactTokensForReport(value) {
  const number = nonnegativeInteger(value);
  if (!number) return "0";
  if (number >= 1_000_000_000) return `${trimNumber(number / 1_000_000_000, 2)}B`;
  if (number >= 1_000_000) return `${trimNumber(number / 1_000_000, 2)}M`;
  if (number >= 1_000) return `${trimNumber(number / 1_000, 2)}K`;
  return formatIntegerForReport(number);
}

function trimNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number(number.toFixed(digits)).toString();
}

function localDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDaysToDateKey(day, offset) {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return localDateKey(date);
}

function dateKeysBetween(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const days = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push(localDateKey(cursor));
  }
  return days;
}

function codexUsageSplitCoverage(usageDetails, reportTokens) {
  if (!usageDetails?.coverage) return null;
  const reportTotal = nonnegativeInteger(reportTokens);
  const splitTotal = nonnegativeInteger(usageDetails.coverage.split_tokens);
  const tokenDelta = Math.abs(splitTotal - reportTotal);
  const tolerance = Math.max(1000, Math.round(reportTotal * 0.002));
  return {
    ...usageDetails.coverage,
    report_tokens: reportTotal,
    token_delta: tokenDelta,
    full_coverage: splitTotal > 0 && (!reportTotal || tokenDelta <= tolerance)
  };
}

function annotateAggregateRows(items, index, keyType) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const key = keyType === "model"
      ? normalizeModelKey(item.model)
      : String(item.source || "").trim();
    const group = index?.get(key);
    annotateGroupCost(item, group, () => costEstimateForTokens(item.tokens, item.model));
  }
}

function annotateSessionCosts(items, usageDetails) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    const record = item?.id ? usageDetails?.byThreadId?.get(item.id) : null;
    if (record) {
      item.usage_split = usageSplitPayload(record.usageSplit);
      item.cost_estimate = costEstimateForUsageSplit(record.usageSplit, item.model || record.model);
    } else {
      item.cost_estimate = costEstimateForTokens(item.tokens, item.model);
    }
  }
}

function annotateGroupCost(target, group, fallbackFactory) {
  if (!target || typeof target !== "object") return;
  if (group?.usageSplit?.total_tokens) {
    target.usage_split = usageSplitPayload(group.usageSplit);
    target.cost_estimate = aggregateSplitCost(group.records);
    return;
  }
  target.cost_estimate = fallbackFactory ? fallbackFactory() : null;
}

function groupIndex(parentGroup, keyType) {
  if (!parentGroup?.records?.length) return null;
  const index = new Map();
  for (const record of parentGroup.records) {
    const key = keyType === "model"
      ? record.modelKey || normalizeModelKey(record.model)
      : record.sourceLabel || sourceLabel(record.source);
    addRecordToIndex(index, key, record);
  }
  return index;
}

function aggregateCostEstimate(modelRows, fallbackTokens = 0) {
  const rows = Array.isArray(modelRows) ? modelRows : [];
  let low = 0;
  let high = 0;
  let midpoint = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  for (const row of rows) {
    const estimate = row.cost_estimate || costEstimateForTokens(row.tokens, row.model);
    const tokens = Math.max(0, Math.round(toNumber(row.tokens, 0)));
    if (!estimate) {
      unpricedTokens += tokens;
      continue;
    }
    low += estimate.low_usd;
    high += estimate.high_usd;
    midpoint += estimate.midpoint_usd;
    pricedTokens += estimate.priced_tokens;
  }
  const fallback = Math.max(0, Math.round(toNumber(fallbackTokens, 0)));
  if (!pricedTokens && fallback) unpricedTokens = fallback;
  return formatCostEstimate({
    low,
    high,
    midpoint,
    pricedTokens,
    unpricedTokens,
    model: rows.length === 1 ? rows[0]?.model : "mixed"
  });
}

function annotateDailyCosts(days, usageDetails, aggregate, totalTokens) {
  if (!Array.isArray(days)) return;
  let hasSplit = false;
  for (const day of days) {
    const group = usageDetails?.byDay?.get(day.day);
    if (!group?.usageSplit?.total_tokens) continue;
    hasSplit = true;
    day.usage_split = usageSplitPayload(group.usageSplit);
    day.cost_estimate = aggregateSplitCost(group.records);
  }
  if (hasSplit || !aggregate || !aggregate.priced_tokens) return;
  const denominator = Math.max(1, Math.round(toNumber(totalTokens, 0)));
  const lowRate = aggregate.low_usd / denominator;
  const highRate = aggregate.high_usd / denominator;
  const midpointRate = aggregate.midpoint_usd / denominator;
  for (const day of days) {
    const tokens = Math.max(0, Math.round(toNumber(day.tokens, 0)));
    day.cost_estimate = formatCostEstimate({
      low: tokens * lowRate,
      high: tokens * highRate,
      midpoint: tokens * midpointRate,
      pricedTokens: tokens,
      unpricedTokens: aggregate.unpriced_tokens ? Math.round(tokens * aggregate.unpriced_tokens / denominator) : 0,
      model: "weighted"
    });
  }
}

function aggregateSplitCost(records) {
  const rows = Array.isArray(records) ? records : [];
  let total = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  const usageSplit = createUsageGroup().usageSplit;
  const components = {
    input_usd: 0,
    cached_input_usd: 0,
    output_usd: 0
  };
  for (const record of rows) {
    addUsageSplit(usageSplit, record.usageSplit);
    const estimate = costEstimateForUsageSplit(record.usageSplit, record.model);
    if (!estimate) {
      unpricedTokens += nonnegativeInteger(record.usageSplit?.total_tokens);
      continue;
    }
    total += estimate.midpoint_usd;
    pricedTokens += estimate.priced_tokens;
    components.input_usd += estimate.components?.input_usd || 0;
    components.cached_input_usd += estimate.components?.cached_input_usd || 0;
    components.output_usd += estimate.components?.output_usd || 0;
  }
  return formatCostEstimate({
    low: total,
    high: total,
    midpoint: total,
    pricedTokens,
    unpricedTokens,
    model: rows.length === 1 ? rows[0]?.model : "mixed",
    usageSplit,
    components,
    exact: unpricedTokens === 0,
    basis: "split_token_usage"
  });
}

function costEstimateForUsageSplit(usageSplit, modelValue) {
  const usage = normalizeTokenUsage(usageSplit);
  const modelKey = normalizeModelKey(modelValue);
  const pricing = MODEL_PRICING_USD_PER_MILLION[modelKey];
  if (!usage?.total_tokens || !pricing) return null;
  const cachedInput = Math.min(usage.cached_input_tokens, usage.input_tokens);
  const uncachedInput = Math.max(0, usage.input_tokens - cachedInput);
  const inputCost = uncachedInput / 1_000_000 * pricing.input;
  const cachedInputCost = cachedInput / 1_000_000 * (pricing.cachedInput ?? pricing.input);
  const outputCost = usage.output_tokens / 1_000_000 * pricing.output;
  const total = inputCost + cachedInputCost + outputCost;
  return formatCostEstimate({
    low: total,
    high: total,
    midpoint: total,
    pricedTokens: usage.total_tokens,
    unpricedTokens: 0,
    model: modelKey,
    rates: pricing,
    usageSplit: usage,
    components: {
      input_usd: roundCurrency(inputCost),
      cached_input_usd: roundCurrency(cachedInputCost),
      output_usd: roundCurrency(outputCost)
    },
    exact: true,
    basis: "split_token_usage"
  });
}

function costEstimateForTokens(tokensValue, modelValue) {
  const tokens = Math.max(0, Math.round(toNumber(tokensValue, 0)));
  const modelKey = normalizeModelKey(modelValue);
  const pricing = MODEL_PRICING_USD_PER_MILLION[modelKey];
  if (!tokens || !pricing) return null;
  const low = tokens / 1_000_000 * pricing.input;
  const high = tokens / 1_000_000 * pricing.output;
  return formatCostEstimate({
    low,
    high,
    midpoint: (low + high) / 2,
    pricedTokens: tokens,
    unpricedTokens: 0,
    model: modelKey,
    rates: pricing,
    basis: "estimated_total_tokens_range"
  });
}

function formatCostEstimate(data) {
  const low = Math.min(data.low || 0, data.high || 0);
  const high = Math.max(data.low || 0, data.high || 0);
  const midpoint = data.midpoint ?? ((low + high) / 2);
  const exact = Boolean(data.exact) || Math.abs(high - low) < 0.00005;
  const display = exact ? formatUsd(midpoint) : `${formatUsd(low)}-${formatUsd(high)}`;
  return {
    model: data.model || "",
    rates: data.rates || null,
    usage_split: data.usageSplit ? usageSplitPayload(data.usageSplit) : null,
    components: data.components || null,
    low_usd: roundCurrency(low),
    high_usd: roundCurrency(high),
    midpoint_usd: roundCurrency(midpoint),
    range_display: display,
    display,
    midpoint_display: formatUsd(midpoint),
    priced_tokens: Math.max(0, Math.round(toNumber(data.pricedTokens, 0))),
    unpriced_tokens: Math.max(0, Math.round(toNumber(data.unpricedTokens, 0))),
    exact,
    basis: data.basis || "estimated_total_tokens_range"
  };
}

function usageSplitPayload(usageSplit) {
  const usage = normalizeTokenUsage(usageSplit) || createUsageGroup().usageSplit;
  return {
    input_tokens: usage.input_tokens,
    cached_input_tokens: usage.cached_input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_output_tokens: usage.reasoning_output_tokens,
    total_tokens: usage.total_tokens
  };
}

function normalizeModelKey(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  if (!raw) return "";
  if (raw.includes("gpt-5.5")) return "gpt-5.5";
  if (raw.includes("gpt-5.4-mini")) return "gpt-5.4-mini";
  if (raw.includes("gpt-5.4-nano")) return "gpt-5.4-nano";
  if (raw.includes("gpt-5.4")) return "gpt-5.4";
  if (raw.includes("gpt-5.3-codex")) return "gpt-5.3-codex";
  if (raw.includes("gpt-5.2-codex")) return "gpt-5.2-codex";
  if (raw.includes("gpt-5.1-codex-max") || raw.includes("gpt-5.1-codex")) return "gpt-5.1-codex";
  if (raw.includes("gpt-5-codex")) return "gpt-5-codex";
  if (raw.includes("gpt-5.2")) return "gpt-5.2";
  if (raw.includes("gpt-5.1")) return "gpt-5.1";
  if (raw.includes("gpt-5-mini")) return "gpt-5-mini";
  if (raw.includes("gpt-5-nano")) return "gpt-5-nano";
  if (raw === "gpt-5" || raw.startsWith("gpt-5-")) return "gpt-5";
  return raw;
}

function roundCurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 10000) / 10000;
}

function formatUsd(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0";
  if (number >= 1000) return `$${(number / 1000).toFixed(number >= 10000 ? 1 : 2)}K`;
  if (number >= 10) return `$${number.toFixed(2)}`;
  if (number >= 1) return `$${number.toFixed(3)}`;
  if (number > 0) return `$${number.toFixed(4)}`;
  return "$0";
}

function computeStats(config, checks, now = new Date()) {
  const latest = checks[checks.length - 1] || null;
  const previous = checks.length > 1 ? checks[checks.length - 2] : null;
  const nextRunAt = config.schedule.nextRunAt || computeNextRunAt(config, latest, now);
  const status = overallStatus(config, latest);
  return {
    status,
    latestCheck: latest,
    previousCheck: previous,
    nextRunAt,
    total: checks.length,
    successful: checks.filter((check) => check.status === "success").length,
    failed: checks.filter((check) => check.status === "failed" || check.status === "auth_error").length,
    limited: checks.filter((check) => check.status === "quota_limited").length,
    quota: latest?.usage || null,
    account: latest?.account || null,
    deltas: computeDeltas(latest?.usage, previous?.usage),
    timeline: checks.slice(-48).map((check) => ({
      id: check.id,
      at: check.at,
      status: check.status,
      primaryRemaining: check.usage?.primaryWindow?.remainingPercent ?? null,
      secondaryRemaining: check.usage?.secondaryWindow?.remainingPercent ?? null
    }))
  };
}

function overallStatus(config, latest) {
  if (!config.account.enabled) return "disabled";
  if (!latest) return "unknown";
  return latest.status;
}

function computeDeltas(current, previous) {
  return {
    primaryRemaining: percentDelta(
      current?.primaryWindow?.remainingPercent,
      previous?.primaryWindow?.remainingPercent
    ),
    secondaryRemaining: percentDelta(
      current?.secondaryWindow?.remainingPercent,
      previous?.secondaryWindow?.remainingPercent
    )
  };
}

function percentDelta(current, previous) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  const delta = Number(current) - Number(previous);
  return Number.isFinite(delta) ? Math.round(delta) : null;
}

function computeNextRunAt(config, latest, now = new Date()) {
  if (!config.account.enabled || !config.schedule.enabled) return null;
  const base = latest?.at ? new Date(latest.at) : now;
  return new Date(base.getTime() + config.schedule.intervalMinutes * 60 * 1000).toISOString();
}

function shouldRunScheduled(config, now = new Date()) {
  if (!config.account.enabled || !config.schedule.enabled) return false;
  if (!config.schedule.lastRunAt) return true;
  const elapsed = now.getTime() - new Date(config.schedule.lastRunAt).getTime();
  return elapsed >= config.schedule.intervalMinutes * 60 * 1000;
}

async function runProbe(reason = "manual") {
  const config = await loadConfig();
  const startedAt = Date.now();
  let check;

  if (!config.account.enabled) {
    check = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      reason,
      status: "disabled",
      message: statusText("disabled"),
      latencyMs: 0,
      usage: null,
      detail: {}
    };
  } else {
    try {
      const result = await fetchCodexUsage(config);
      check = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        reason,
        latencyMs: Date.now() - startedAt,
        ...result
      };
    } catch (error) {
      check = {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        reason,
        status: classifyError(error),
        message: error.message,
        latencyMs: Date.now() - startedAt,
        usage: null,
        detail: {
          name: error.name,
          statusCode: error.statusCode || null
        }
      };
    }
  }

  const checks = await loadChecks();
  checks.push(normalizeCheck(check));
  await saveChecks(checks);

  config.schedule.lastRunAt = check.at;
  config.schedule.nextRunAt = config.schedule.enabled
    ? new Date(new Date(check.at).getTime() + config.schedule.intervalMinutes * 60 * 1000).toISOString()
    : null;
  await saveConfig(config);

  return getState();
}

function classifyError(error) {
  if (error.statusCode === 401 || error.statusCode === 403 || /auth|token|login/i.test(error.message)) {
    return "auth_error";
  }
  return "failed";
}

async function fetchCodexUsage(config) {
  const auth = await loadCodexAuth(config.account.authPath);
  const response = await fetch(config.account.endpoint, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${auth.accessToken}`,
      ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
      "Accept": "application/json",
      "User-Agent": "gpt-monitor/0.2"
    }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.detail || payload?.error || text.slice(0, 180) || `HTTP ${response.status}`;
    throw Object.assign(new Error(`Codex usage endpoint failed: ${message}`), {
      statusCode: response.status
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Codex usage endpoint returned an empty response");
  }

  const rateLimit = payload.rate_limit || {};
  const limitReached = Boolean(rateLimit.limit_reached);
  const usage = {
    planType: payload.plan_type || "",
    allowed: rateLimit.allowed === undefined ? null : Boolean(rateLimit.allowed),
    limitReached,
    primaryWindow: readWindow(rateLimit.primary_window),
    secondaryWindow: readWindow(rateLimit.secondary_window),
    codeReview: readWindow(payload.code_review_rate_limit),
    additionalRateLimits: Array.isArray(payload.additional_rate_limits)
      ? payload.additional_rate_limits.map(readAdditionalLimit).filter(Boolean)
      : [],
    credits: readCredits(payload.credits)
  };
  const account = normalizeAccount({
    name: auth.profile?.name,
    email: payload.email || auth.profile?.email,
    userId: payload.user_id || auth.profile?.userId,
    accountId: payload.account_id || auth.accountId
  });

  return {
    status: limitReached ? "quota_limited" : "success",
    message: limitReached ? statusText("quota_limited") : statusText("success"),
    planType: usage.planType,
    account,
    allowed: usage.allowed,
    limitReached: usage.limitReached,
    usage,
    detail: {
      endpoint: config.account.endpoint,
      responseKeys: Object.keys(payload).slice(0, 30)
    }
  };
}

async function loadCodexAuth(authPath) {
  const file = resolveUserPath(authPath);
  let auth;
  try {
    auth = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`无法读取 Codex 登录文件：${file}`);
  }
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!accessToken) throw new Error(`Codex 登录文件中没有 access token：${file}`);
  return {
    accessToken,
    accountId,
    profile: readAuthProfile(auth),
    tokenExpiresAt: readJwtExpiration(accessToken)
  };
}

function resolveUserPath(value, fallback = DEFAULT_CONFIG.account.authPath) {
  const raw = cleanString(value, fallback, 500) || cleanString(fallback, "", 500);
  if (!raw) return "";
  const expandedHome = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const expandedEnv = expandedHome
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] || "")
    .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, name) => process.env[name] || "");
  return path.isAbsolute(expandedEnv) ? path.resolve(expandedEnv) : path.resolve(ROOT, expandedEnv);
}

function readJwtExpiration(token) {
  const payload = readJwtPayload(token);
  return payload?.exp ? new Date(payload.exp * 1000).toISOString() : null;
}

function readAuthProfile(auth) {
  const idPayload = readJwtPayload(auth.tokens?.id_token);
  const accessPayload = readJwtPayload(auth.tokens?.access_token);
  return {
    name: idPayload?.name || "",
    email: idPayload?.email || accessPayload?.["https://api.openai.com/profile"]?.email || "",
    userId: idPayload?.["https://api.openai.com/auth"]?.chatgpt_user_id ||
      accessPayload?.["https://api.openai.com/auth"]?.chatgpt_user_id ||
      ""
  };
}

function readJwtPayload(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function readAdditionalLimit(item) {
  if (!item || typeof item !== "object") return null;
  const limit = item.rate_limit || {};
  return {
    name: String(item.limit_name || item.metered_feature || "Additional limit").slice(0, 120),
    meteredFeature: String(item.metered_feature || "").slice(0, 120),
    allowed: limit.allowed === undefined ? null : Boolean(limit.allowed),
    limitReached: limit.limit_reached === undefined ? null : Boolean(limit.limit_reached),
    primaryWindow: readWindow(limit.primary_window),
    secondaryWindow: readWindow(limit.secondary_window)
  };
}

function readCredits(credits) {
  if (!credits || typeof credits !== "object") return null;
  return {
    hasCredits: Boolean(credits.has_credits),
    unlimited: Boolean(credits.unlimited),
    overageLimitReached: Boolean(credits.overage_limit_reached),
    balance: String(credits.balance ?? "0").slice(0, 80),
    approxLocalMessages: Array.isArray(credits.approx_local_messages) ? credits.approx_local_messages : null,
    approxCloudMessages: Array.isArray(credits.approx_cloud_messages) ? credits.approx_cloud_messages : null
  };
}

function readWindow(window) {
  if (!window || typeof window !== "object") return null;
  const used = asPercent(window.used_percent ?? window.usage_percent ?? window.usedPercent);
  const remainingRaw = asPercent(window.remaining_percent ?? window.remainingPercent);
  const remaining = remainingRaw === null && used !== null ? 100 - used : remainingRaw;
  const resetAfterSeconds = toNullableNumber(
    window.reset_after_seconds ??
    window.resets_in_seconds ??
    window.seconds_until_reset ??
    window.resetSeconds
  );
  const resetAt = readResetAt(window.reset_at ?? window.resets_at ?? window.resetAt);
  const windowSeconds = toNullableNumber(window.limit_window_seconds ?? window.window_seconds ?? window.windowSeconds);
  return {
    usedPercent: used,
    remainingPercent: remaining === null ? null : clamp(Math.round(remaining), 0, 100),
    resetAfterSeconds,
    resetAfterLabel: secondsToShort(resetAfterSeconds),
    resetAt,
    windowSeconds,
    windowLabel: secondsToWindowLabel(windowSeconds)
  };
}

function asPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return clamp(Math.round(number), 0, 100);
}

function toNullableNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readResetAt(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function secondsToShort(seconds) {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total < 0) return null;
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const remMinutes = minutes % 60;
  if (days > 0) return `${days}d ${remHours}h`;
  if (hours > 0) return `${hours}h ${remMinutes}m`;
  return `${remMinutes}m`;
}

function secondsToWindowLabel(seconds) {
  if (seconds === 18000) return "5h";
  if (seconds === 604800) return "7d";
  return secondsToShort(seconds);
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("Invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

async function readRawBody(req, maxBytes = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("Upload is too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isSqliteBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.slice(0, 16).toString("ascii") === "SQLite format 3\0";
}

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function getAccessSecret() {
  return String(process.env.GPT_MONITOR_ACCESS_TOKEN || process.env.GPT_MONITOR_PASSWORD || "").trim();
}

function getAccessUsername() {
  return String(process.env.GPT_MONITOR_USERNAME || "monitor");
}

function hashForCompare(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function constantTimeEqual(left, right) {
  const leftHash = hashForCompare(left);
  const rightHash = hashForCompare(right);
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function isAuthorized(req) {
  const secret = getAccessSecret();
  if (!secret) return true;
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) {
    return constantTimeEqual(header.slice("Bearer ".length).trim(), secret);
  }
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator === -1) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return constantTimeEqual(username, getAccessUsername()) && constantTimeEqual(password, secret);
  }
  return false;
}

function sendUnauthorized(res) {
  res.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "WWW-Authenticate": `Basic realm="${AUTH_REALM}", charset="UTF-8"`
  });
  res.end("Authentication required");
}

function requestOrigin(req) {
  const host = req.headers.host;
  if (!host) return null;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

function verifySameOrigin(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const fetchSite = String(req.headers["sec-fetch-site"] || "");
  if (fetchSite === "cross-site") {
    throw Object.assign(new Error("Cross-site requests are not allowed"), { statusCode: 403 });
  }
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = requestOrigin(req);
  if (expected && origin !== expected) {
    throw Object.assign(new Error("Request origin is not allowed"), { statusCode: 403 });
  }
}

function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function checkRateLimit(req) {
  const now = Date.now();
  const pathname = req.url ? stripBasePath(new URL(req.url, "http://localhost").pathname) : "";
  const isRefresh = req.url && (
    pathname.startsWith("/api/refresh") ||
    pathname.startsWith("/api/probe") ||
    pathname.startsWith("/api/codex-usage/refresh") ||
    pathname.startsWith("/api/codex-usage/report")
  );
  const max = isRefresh ? REFRESH_RATE_LIMIT_MAX : Number(process.env.GPT_MONITOR_RATE_LIMIT_MAX || RATE_LIMIT_MAX);
  const key = `${clientKey(req)}:${isRefresh ? "refresh" : "global"}`;
  const bucket = rateLimitBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt > RATE_LIMIT_WINDOW_MS) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  if (rateLimitBuckets.size > 1000) {
    for (const [entryKey, entry] of rateLimitBuckets) {
      if (now - entry.startedAt > RATE_LIMIT_WINDOW_MS * 2) rateLimitBuckets.delete(entryKey);
    }
  }
  return bucket.count <= max;
}

function sendJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  const acceptEncoding = String(res._monitorRequest?.headers?.["accept-encoding"] || "");
  const shouldGzip = body.length > 1024 && /\bgzip\b/i.test(acceptEncoding);
  const responseBody = shouldGzip ? zlib.gzipSync(body) : body;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Accept-Encoding",
    ...(shouldGzip ? { "Content-Encoding": "gzip" } : {}),
    "Content-Length": responseBody.length
  });
  res.end(responseBody);
}

function sendError(res, error) {
  sendJson(res, error.statusCode || 500, {
    error: error.message || "Internal server error"
  });
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function serveCodexUsageReport(res, pathname) {
  const reportDir = path.resolve(CODEX_USAGE_OUTPUT_DIR);
  const baseRoute = `/${CODEX_USAGE_OUTPUT_DIR.split(path.sep).pop()}`;
  const relative = decodeURIComponent(pathname.slice(baseRoute.length).replace(/^\/+/, "")) || CODEX_USAGE_REPORT_FILE;
  const reportPath = path.resolve(reportDir, relative);
  if (!isInsidePath(reportDir, reportPath) || path.extname(reportPath).toLowerCase() !== ".html") {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(reportPath);
    res.setHeader("Content-Security-Policy", [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'none'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; "));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Codex usage report not found");
  }
}

function isInsidePath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function saveCodexDbUpload(req, userId) {
  const config = await loadConfig();
  const user = findUsageUser(config, userId);
  if (!user) throw Object.assign(new Error("Usage user not found"), { statusCode: 404 });
  const body = await readRawBody(req);
  if (!isSqliteBuffer(body)) {
    throw Object.assign(new Error("Uploaded file is not a SQLite database"), { statusCode: 400 });
  }
  const filePath = codexUploadedDbFile(user.id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body);
  const originalName = cleanString(String(req.headers["x-file-name"] || "state_5.sqlite"), "state_5.sqlite", 240);
  user.codexUsage = normalizeCodexUsageConfig({
    ...user.codexUsage,
    enabled: true,
    dbPath: path.relative(ROOT, filePath).replace(/\\/g, "/"),
    uploadedFileName: originalName,
    uploadedAt: new Date().toISOString()
  });
  config.activeUsageUserId = user.id;
  await saveConfig(config);
  return getCodexUsageState({ force: true, userId: user.id });
}

async function saveSub2ApiKey(req, userId) {
  const body = await parseBody(req);
  const key = String(body.apiKey || "").trim();
  if (!key) throw Object.assign(new Error("Sub2API API key is required"), { statusCode: 400 });
  const config = await loadConfig();
  const user = findUsageUser(config, userId);
  if (!user) throw Object.assign(new Error("Usage user not found"), { statusCode: 404 });
  const filePath = sub2ApiKeyFile(user.id);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${key}\n`, "utf8");
  user.sub2api = normalizeSub2ApiConfig({
    ...user.sub2api,
    enabled: body.enabled !== false,
    apiKeyPath: path.relative(ROOT, filePath).replace(/\\/g, "/"),
    baseUrl: body.baseUrl || user.sub2api?.baseUrl,
    startDate: body.startDate || user.sub2api?.startDate,
    lookbackDays: body.lookbackDays ?? user.sub2api?.lookbackDays
  });
  config.activeUsageUserId = user.id;
  await saveConfig(config);
  return getCodexUsageState({ force: true, userId: user.id });
}

async function handleApi(req, res, url) {
  const codexDbUploadMatch = /^\/api\/users\/([^/]+)\/codex-db$/.exec(url.pathname);
  if (req.method === "PUT" && codexDbUploadMatch) {
    return sendJson(res, 200, publicCodexUsageState(await saveCodexDbUpload(req, codexDbUploadMatch[1])));
  }
  const sub2ApiKeyMatch = /^\/api\/users\/([^/]+)\/sub2api-key$/.exec(url.pathname);
  if (req.method === "PUT" && sub2ApiKeyMatch) {
    return sendJson(res, 200, publicCodexUsageState(await saveSub2ApiKey(req, sub2ApiKeyMatch[1])));
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, await getState());
  }
  if (req.method === "GET" && url.pathname === "/api/codex-usage") {
    return sendJson(res, 200, publicCodexUsageState(await getCodexUsageState({
      userId: url.searchParams.get("userId")
    })));
  }
  if (req.method === "GET" && url.pathname === "/api/codex-usage/sessions") {
    return sendJson(res, 200, await getCodexUsageSessionsState(url.searchParams));
  }
  if (req.method === "POST" && url.pathname === "/api/codex-usage/refresh") {
    const body = await parseBody(req);
    return sendJson(res, 200, publicCodexUsageState(await getCodexUsageState({
      force: true,
      userId: body.userId || url.searchParams.get("userId")
    })));
  }
  if (req.method === "POST" && url.pathname === "/api/codex-usage/report") {
    const body = await parseBody(req);
    return sendJson(res, 200, await generateCodexUsageHtmlReport({
      userId: body.userId || url.searchParams.get("userId")
    }));
  }
  if (req.method === "GET" && url.pathname === "/api/export") {
    const [config, checks] = await Promise.all([loadConfig(), loadChecks()]);
    return sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      config,
      checks
    });
  }
  if (req.method === "POST" && (url.pathname === "/api/refresh" || url.pathname === "/api/probe")) {
    const body = await parseBody(req);
    return sendJson(res, 200, await runProbe(body.reason || "manual"));
  }
  if (req.method === "PUT" && url.pathname === "/api/config") {
    const body = await parseBody(req);
    const config = await saveConfig(body.config || body);
    if (!config.schedule.enabled) config.schedule.nextRunAt = null;
    return sendJson(res, 200, await getState());
  }
  if (req.method === "DELETE" && url.pathname === "/api/checks") {
    await saveChecks([]);
    const config = await loadConfig();
    config.schedule.lastRunAt = null;
    config.schedule.nextRunAt = config.schedule.enabled ? new Date().toISOString() : null;
    await saveConfig(config);
    return sendJson(res, 200, await getState());
  }
  throw Object.assign(new Error("API route not found"), { statusCode: 404 });
}

function createServer() {
  return http.createServer(async (req, res) => {
    res._monitorRequest = req;
    applySecurityHeaders(res);
    try {
      if (!checkRateLimit(req)) {
        throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
      }
      if (!isAuthorized(req)) {
        sendUnauthorized(res);
        return;
      }
      verifySameOrigin(req);
      const url = new URL(req.url, "http://localhost");
      const basePath = matchingBasePath(url.pathname);
      if (basePath && (req.method === "GET" || req.method === "HEAD") && url.pathname === basePath) {
        res.writeHead(308, {
          Location: `${basePath}/${url.search}`
        });
        res.end();
        return;
      }
      url.pathname = stripBasePath(url.pathname);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith(`/${CODEX_USAGE_OUTPUT_DIR.split(path.sep).pop()}/`)) {
        await serveCodexUsageReport(res, url.pathname);
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      sendError(res, error);
    }
  });
}

function isPublicBindHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return !["127.0.0.1", "localhost", "::1"].includes(normalized);
}

function startScheduler() {
  setInterval(async () => {
    if (schedulerBusy) return;
    schedulerBusy = true;
    try {
      const config = await loadConfig();
      if (shouldRunScheduled(config)) await runProbe("scheduled");
    } catch (error) {
      console.error(`[scheduler] ${error.message}`);
    } finally {
      schedulerBusy = false;
    }
  }, 15000);

  setInterval(() => {
    refreshScheduledCodexUsage("scheduled");
  }, CODEX_USAGE_CACHE_MS);

  setTimeout(async () => {
    try {
      const config = await loadConfig();
      const checks = await loadChecks();
      if (config.account.enabled && config.schedule.enabled && checks.length === 0) {
        await runProbe("startup");
      }
    } catch (error) {
      console.error(`[startup] ${error.message}`);
    }
  }, 1200);

  setTimeout(() => {
    refreshScheduledCodexUsage("startup");
  }, CODEX_USAGE_STARTUP_REFRESH_DELAY_MS);
}

async function main() {
  await ensureDataFiles();
  const config = await saveConfig(await loadConfig());
  const port = clamp(Math.round(toNumber(process.env.GPT_MONITOR_PORT || config.port, DEFAULT_PORT)), 1024, 65535);
  const host = cleanString(process.env.GPT_MONITOR_HOST, DEFAULT_HOST, 120);
  if (isPublicBindHost(host) && !getAccessSecret()) {
    throw new Error("Refusing to listen on a public host without GPT_MONITOR_ACCESS_TOKEN or GPT_MONITOR_PASSWORD");
  }
  createServer().listen(port, host, () => {
    const authMode = getAccessSecret() ? "protected" : "local-only";
    console.log(`GPT Pro Monitor running at http://${host}:${port} (${authMode})`);
  });
  startScheduler();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  normalizeConfig,
  computeStats,
  runProbe,
  fetchCodexUsage,
  getCodexUsageState,
  generateCodexUsageHtmlReport
};
