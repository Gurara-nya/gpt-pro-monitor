const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir, readFile, readdir, rename, writeFile } = require("node:fs/promises");
const { promisify } = require("node:util");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const OUTPUT_DIR = path.join(ROOT, "output");
const CODEX_USAGE_OUTPUT_DIR = path.join(OUTPUT_DIR, "codex-usage");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const CHECKS_FILE = path.join(DATA_DIR, "checks.json");
const CODEX_USAGE_CACHE_FILE = path.join(DATA_DIR, "codex-usage-cache.json");
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CHECK_HISTORY = 1000;
const CODEX_USAGE_CACHE_MS = 5 * 60 * 1000;
const CODEX_USAGE_SCRIPT = path.join("scripts", "generate_codex_usage_report.py");
const CODEX_USAGE_REPORT_FILE = "latest.html";
const CODEX_USAGE_JSON_FILE = "latest.json";
const CODEX_USAGE_MD_FILE = "latest.md";
const CODEX_SESSION_DIRS = ["sessions", "archived_sessions"];
const DEFAULT_HOST = "127.0.0.1";
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
  codexUsage: {
    enabled: true,
    dbPath: "~/.codex/state_5.sqlite",
    skillPath: "~/.codex/skills/codex-usage",
    topSessions: 10
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

  const codexUsage = source.codexUsage || {};
  config.codexUsage = {
    ...DEFAULT_CONFIG.codexUsage,
    enabled: codexUsage.enabled !== false,
    dbPath: cleanString(codexUsage.dbPath, DEFAULT_CONFIG.codexUsage.dbPath, 500) || DEFAULT_CONFIG.codexUsage.dbPath,
    skillPath: cleanString(codexUsage.skillPath, DEFAULT_CONFIG.codexUsage.skillPath, 500) ||
      DEFAULT_CONFIG.codexUsage.skillPath,
    topSessions: clamp(Math.round(toNumber(codexUsage.topSessions, DEFAULT_CONFIG.codexUsage.topSessions)), 1, 50)
  };

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
  return {
    generatedAt: new Date().toISOString(),
    config,
    computed: computeStats(config, checks),
    checks: checks.slice().reverse().slice(0, 200)
  };
}

async function getCodexUsageState({ force = false } = {}) {
  const config = await loadConfig();
  const usageConfig = config.codexUsage || DEFAULT_CONFIG.codexUsage;
  if (!usageConfig.enabled) {
    return {
      status: "disabled",
      generatedAt: new Date().toISOString(),
      message: "Codex Token 消耗面板已停用",
      report: null
    };
  }

  const configKey = codexUsageConfigKey(usageConfig);
  const cache = await loadCodexUsageCache();
  if (!force && isFreshCodexUsageCache(cache, configKey)) {
    return cache.result;
  }

  try {
    const result = await buildCodexUsageState(usageConfig);
    await writeJson(CODEX_USAGE_CACHE_FILE, {
      configKey,
      cachedAt: result.generatedAt,
      result
    });
    return result;
  } catch (error) {
    const generatedAt = new Date().toISOString();
    if (cache?.result?.report) {
      return {
        ...cache.result,
        status: "stale",
        generatedAt,
        message: `Codex Token 数据刷新失败，显示缓存：${error.message}`
      };
    }
    return {
      status: error.codexUsageStatus || "error",
      generatedAt,
      message: error.message || "Codex Token 数据不可用",
      report: null
    };
  }
}

async function loadCodexUsageCache() {
  const cache = await readJson(CODEX_USAGE_CACHE_FILE, null);
  if (!cache || typeof cache !== "object" || !cache.result) return null;
  return cache;
}

function isFreshCodexUsageCache(cache, configKey) {
  if (!cache || cache.configKey !== configKey) return false;
  const cachedAt = new Date(cache.cachedAt || cache.result.generatedAt || 0);
  if (Number.isNaN(cachedAt.getTime())) return false;
  return Date.now() - cachedAt.getTime() < CODEX_USAGE_CACHE_MS;
}

function codexUsageConfigKey(usageConfig) {
  return JSON.stringify({
    dbPath: usageConfig.dbPath,
    skillPath: usageConfig.skillPath,
    topSessions: usageConfig.topSessions
  });
}

async function buildCodexUsageState(usageConfig) {
  const jsonPath = path.join(DATA_DIR, "codex-usage-report.json");
  await runCodexUsageReport(usageConfig, {
    renderer: "data",
    jsonPath,
    noSnapshot: true,
    timeoutMs: 45000
  });
  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  if (!report || typeof report !== "object" || !report.summary) {
    throw Object.assign(new Error("Codex Token 报告 JSON 结构不完整"), { codexUsageStatus: "error" });
  }
  const usageDetails = await loadCodexTokenUsageDetails(usageConfig);
  enrichCodexUsageCosts(report, usageDetails);
  await writeJson(jsonPath, report);
  return {
    status: "ok",
    generatedAt: new Date().toISOString(),
    message: "Codex Token 数据已同步",
    report
  };
}

async function generateCodexUsageHtmlReport() {
  const config = await loadConfig();
  const usageConfig = config.codexUsage || DEFAULT_CONFIG.codexUsage;
  if (!usageConfig.enabled) {
    return {
      status: "disabled",
      generatedAt: new Date().toISOString(),
      message: "Codex Token 消耗面板已停用",
      reportUrl: null
    };
  }

  await mkdir(CODEX_USAGE_OUTPUT_DIR, { recursive: true });
  const htmlPath = path.join(CODEX_USAGE_OUTPUT_DIR, CODEX_USAGE_REPORT_FILE);
  const jsonPath = path.join(CODEX_USAGE_OUTPUT_DIR, CODEX_USAGE_JSON_FILE);
  const mdPath = path.join(CODEX_USAGE_OUTPUT_DIR, CODEX_USAGE_MD_FILE);
  const snapshotPath = path.join(CODEX_USAGE_OUTPUT_DIR, "latest.snapshot.sqlite");

  await runCodexUsageReport(usageConfig, {
    renderer: "html-doc",
    outPath: htmlPath,
    jsonPath,
    mdPath,
    snapshotPath,
    timeoutMs: 120000
  });

  const report = JSON.parse(await readFile(jsonPath, "utf8"));
  const usageDetails = await loadCodexTokenUsageDetails(usageConfig);
  enrichCodexUsageCosts(report, usageDetails);
  await writeJson(jsonPath, report);
  const result = {
    status: "ok",
    generatedAt: new Date().toISOString(),
    message: "Codex Token HTML 报告已生成",
    report
  };
  await writeJson(CODEX_USAGE_CACHE_FILE, {
    configKey: codexUsageConfigKey(usageConfig),
    cachedAt: result.generatedAt,
    result
  });

  return {
    status: "ok",
    generatedAt: result.generatedAt,
    message: result.message,
    reportUrl: `/${CODEX_USAGE_OUTPUT_DIR.split(path.sep).pop()}/${CODEX_USAGE_REPORT_FILE}`,
    outputPath: htmlPath
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
  if (options.renderer === "html-doc") {
    assertReadablePath(paths.htmlDocDir, "html-doc skill 目录");
    args.push("--html-doc-dir", paths.htmlDocDir);
  }

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
  let skillDir = resolveUserPath(usageConfig.skillPath, DEFAULT_CONFIG.codexUsage.skillPath);
  if (path.basename(skillDir).toLowerCase() === "skill.md") {
    skillDir = path.dirname(skillDir);
  }
  const htmlDocDir = resolveUserPath(
    process.env.HTML_DOC_SKILL_DIR || "~/.codex/skills/html-doc",
    "~/.codex/skills/html-doc"
  );
  return {
    dbPath: resolveUserPath(usageConfig.dbPath, DEFAULT_CONFIG.codexUsage.dbPath),
    skillDir,
    skillScript: path.join(skillDir, CODEX_USAGE_SCRIPT),
    htmlDocDir
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
      if (payload.timestamp && !created) created = localDatePartsFromTimestamp(payload.timestamp);
      continue;
    }

    if (event.type === "turn_context") {
      if (payload.model) model = String(payload.model);
      continue;
    }

    if (payload.type === "token_count") {
      const usage = extractTokenUsage(payload);
      if (!usage) continue;
      finalUsage = usage;
      lastEventAt = String(event.timestamp || lastEventAt || "");
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
  const expandedHome = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const expandedEnv = expandedHome
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] || "")
    .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, name) => process.env[name] || "");
  return path.resolve(expandedEnv);
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
  const isRefresh = req.url && (
    req.url.startsWith("/api/refresh") ||
    req.url.startsWith("/api/probe") ||
    req.url.startsWith("/api/codex-usage/refresh") ||
    req.url.startsWith("/api/codex-usage/report")
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

async function serveCodexUsageReport(res) {
  const reportDir = path.resolve(CODEX_USAGE_OUTPUT_DIR);
  const reportPath = path.resolve(reportDir, CODEX_USAGE_REPORT_FILE);
  if (!isInsidePath(reportDir, reportPath)) {
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

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, await getState());
  }
  if (req.method === "GET" && url.pathname === "/api/codex-usage") {
    return sendJson(res, 200, await getCodexUsageState());
  }
  if (req.method === "POST" && url.pathname === "/api/codex-usage/refresh") {
    return sendJson(res, 200, await getCodexUsageState({ force: true }));
  }
  if (req.method === "POST" && url.pathname === "/api/codex-usage/report") {
    return sendJson(res, 200, await generateCodexUsageHtmlReport());
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
      if (req.method === "GET" && url.pathname === `/${CODEX_USAGE_OUTPUT_DIR.split(path.sep).pop()}/${CODEX_USAGE_REPORT_FILE}`) {
        await serveCodexUsageReport(res);
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
  fetchCodexUsage,
  getCodexUsageState,
  generateCodexUsageHtmlReport
};
