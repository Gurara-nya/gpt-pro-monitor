const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json");
const BASE_URL = process.env.CHATGPT_BACKEND_BASE_URL || "https://chatgpt.com/backend-api";

const ENDPOINTS = [
  "/codex/usage",
  "/wham/usage"
];

function asPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number <= 1 ? Math.round(number * 100) : Math.round(number);
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

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function readWindow(window) {
  if (!window || typeof window !== "object") return null;
  const used =
    asPercent(window.used_percent) ??
    asPercent(window.usage_percent) ??
    asPercent(window.usedPercent) ??
    asPercent(window.usagePercent);
  const remaining =
    asPercent(window.remaining_percent) ??
    asPercent(window.remainingPercent) ??
    (used === null ? null : 100 - used);
  const resetSeconds =
    window.resets_in_seconds ??
    window.reset_in_seconds ??
    window.reset_after_seconds ??
    window.seconds_until_reset ??
    window.resetSeconds ??
    window.resetsInSeconds;
  const rawResetAt =
    window.resets_at ??
    window.reset_at ??
    window.resetAt ??
    null;
  const resetAt = typeof rawResetAt === "number" ? unixSecondsToIso(rawResetAt) : rawResetAt;
  return {
    usedPercent: used,
    remainingPercent: remaining === null ? null : Math.max(0, Math.min(100, remaining)),
    resetsIn: secondsToShort(resetSeconds),
    resetAt
  };
}

function summarizeUsage(payload) {
  if (!payload || typeof payload !== "object") return null;
  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? payload.rate_limits ?? payload.rateLimits ?? {};
  const primary =
    payload.primary_window ??
    payload.primaryWindow ??
    payload.five_hour_window ??
    payload.fiveHourWindow ??
    rateLimit.primary_window ??
    rateLimit.primaryWindow;
  const secondary =
    payload.secondary_window ??
    payload.secondaryWindow ??
    payload.weekly_window ??
    payload.weeklyWindow ??
    rateLimit.secondary_window ??
    rateLimit.secondaryWindow;
  const codeReview =
    payload.code_review_rate_limit ??
    payload.codeReviewRateLimit ??
    rateLimit.code_review_rate_limit ??
    rateLimit.codeReviewRateLimit;
  return {
    allowed: rateLimit.allowed ?? null,
    limitReached: rateLimit.limit_reached ?? rateLimit.limitReached ?? null,
    primaryWindow: readWindow(primary),
    secondaryWindow: readWindow(secondary),
    codeReview: readWindow(codeReview),
    additionalRateLimits: Array.isArray(payload.additional_rate_limits)
      ? payload.additional_rate_limits.map((item) => ({
          name: item.limit_name || item.name || item.metered_feature || "additional",
          allowed: item.rate_limit?.allowed ?? null,
          limitReached: item.rate_limit?.limit_reached ?? null,
          primaryWindow: readWindow(item.rate_limit?.primary_window),
          secondaryWindow: readWindow(item.rate_limit?.secondary_window)
        }))
      : [],
    topLevelKeys: Object.keys(payload).slice(0, 30)
  };
}

async function loadAuth() {
  const auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!accessToken) throw new Error(`No access token found in ${AUTH_PATH}`);
  return { accessToken, accountId };
}

async function testEndpoint(endpoint, auth) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${auth.accessToken}`,
      ...(auth.accountId ? { "ChatGPT-Account-ID": auth.accountId } : {}),
      "Accept": "application/json",
      "User-Agent": "gpt-monitor-codex-usage-probe"
    }
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  return {
    endpoint,
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    summary: summarizeUsage(payload),
    bodyPreview: payload ? undefined : text.slice(0, 240)
  };
}

async function main() {
  const auth = await loadAuth();
  const results = [];
  for (const endpoint of ENDPOINTS) {
    results.push(await testEndpoint(endpoint, auth));
  }
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    auth: {
      mode: "chatgpt",
      accountIdPresent: Boolean(auth.accountId),
      accessTokenPresent: true
    },
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    error: error.message
  }, null, 2));
  process.exit(1);
});
