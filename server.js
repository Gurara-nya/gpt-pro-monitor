const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { existsSync } = require("node:fs");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CHECKS_FILE = path.join(DATA_DIR, "checks.json");
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CHECK_HISTORY = 1000;
const DEFAULT_HOST = "127.0.0.1";
const AUTH_REALM = "GPT Pro Monitor";
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 240;
const REFRESH_RATE_LIMIT_MAX = 12;
const ALLOWED_USAGE_ENDPOINTS = [
  "https://chatgpt.com/backend-api/wham/usage"
];
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
  version: 3,
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

function normalizeConfig(input) {
  const source = input && typeof input === "object" ? input : {};
  const isLegacy = source.version !== 3;
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

function validIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function ensureDataFiles() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) await writeJson(CONFIG_FILE, DEFAULT_CONFIG);
  if (!existsSync(CHECKS_FILE)) await writeJson(CHECKS_FILE, []);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
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
    allowed: check.allowed === undefined ? null : Boolean(check.allowed),
    limitReached: check.limitReached === undefined ? null : Boolean(check.limitReached),
    usage: check.usage && typeof check.usage === "object" ? check.usage : null,
    detail: check.detail && typeof check.detail === "object" ? check.detail : {}
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
  return {
    generatedAt: new Date().toISOString(),
    config,
    computed: computeStats(config, checks),
    checks: checks.slice().reverse().slice(0, 200)
  };
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

  return {
    status: limitReached ? "quota_limited" : "success",
    message: limitReached ? statusText("quota_limited") : statusText("success"),
    planType: usage.planType,
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
    tokenExpiresAt: readJwtExpiration(accessToken)
  };
}

function resolveUserPath(value) {
  const raw = cleanString(value, DEFAULT_CONFIG.account.authPath, 500);
  const expandedHome = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const expandedEnv = expandedHome.replace(/%([^%]+)%/g, (_, name) => process.env[name] || "");
  return path.resolve(expandedEnv);
}

function readJwtExpiration(token) {
  try {
    const part = String(token).split(".")[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    return payload.exp ? new Date(payload.exp * 1000).toISOString() : null;
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
  return clamp(Math.round(number <= 1 ? number * 100 : number), 0, 100);
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
  const isRefresh = req.url && (req.url.startsWith("/api/refresh") || req.url.startsWith("/api/probe"));
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
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
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

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, await getState());
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
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
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
  fetchCodexUsage
};
