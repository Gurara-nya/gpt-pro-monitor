const { readFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), ".codex", "auth.json");

const ENDPOINTS = [
  { name: "chatgpt_wham_usage", url: "https://chatgpt.com/backend-api/wham/usage", auth: "chatgpt" },
  { name: "chatgpt_codex_usage", url: "https://chatgpt.com/backend-api/codex/usage", auth: "chatgpt" },
  { name: "chatgpt_codex_models", url: "https://chatgpt.com/backend-api/codex/models", auth: "chatgpt" },
  { name: "chatgpt_models", url: "https://chatgpt.com/backend-api/models", auth: "chatgpt" },
  { name: "chatgpt_me", url: "https://chatgpt.com/backend-api/me", auth: "chatgpt" },
  { name: "chatgpt_accounts", url: "https://chatgpt.com/backend-api/accounts", auth: "chatgpt" },
  { name: "chatgpt_conversations_limit_1", url: "https://chatgpt.com/backend-api/conversations?offset=0&limit=1&order=updated", auth: "chatgpt" },
  { name: "chatgpt_settings_user", url: "https://chatgpt.com/backend-api/settings/user", auth: "chatgpt" },
  { name: "chatgpt_system_hints", url: "https://chatgpt.com/backend-api/system_hints", auth: "chatgpt" },
  { name: "chatgpt_session", url: "https://chatgpt.com/api/auth/session", auth: "none" },
  { name: "api_v1_models", url: "https://api.openai.com/v1/models", auth: "bearer" },
  { name: "api_v1_me", url: "https://api.openai.com/v1/me", auth: "bearer" },
  { name: "api_v1_user", url: "https://api.openai.com/v1/user", auth: "bearer" },
  { name: "api_v1_dashboard_billing_credit_grants", url: "https://api.openai.com/dashboard/billing/credit_grants", auth: "bearer" },
  { name: "api_v1_usage_costs", url: "https://api.openai.com/v1/usage/costs?start_time=1779519600&limit=1", auth: "bearer" },
  { name: "api_v1_organization_projects", url: "https://api.openai.com/v1/organization/projects", auth: "bearer" },
  { name: "api_v1_responses_models_probe", url: "https://api.openai.com/v1/responses", auth: "bearer" }
];

function redact(value) {
  if (value === null || value === undefined) return value;
  const text = String(value);
  if (text.length <= 12) return "<redacted>";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

async function loadAuth() {
  const auth = JSON.parse(await readFile(AUTH_PATH, "utf8"));
  const accessToken = auth.tokens?.access_token;
  const accountId = auth.tokens?.account_id;
  if (!accessToken) throw new Error(`No access token found in ${AUTH_PATH}`);
  return { accessToken, accountId };
}

function buildHeaders(endpoint, auth) {
  const headers = {
    "Accept": "application/json",
    "User-Agent": "gpt-monitor-endpoint-probe"
  };
  if (endpoint.auth === "chatgpt" || endpoint.auth === "bearer") {
    headers.Authorization = `Bearer ${auth.accessToken}`;
  }
  if (endpoint.auth === "chatgpt" && auth.accountId) {
    headers["ChatGPT-Account-ID"] = auth.accountId;
  }
  return headers;
}

function summarizeJson(payload) {
  if (!payload || typeof payload !== "object") return null;
  const summary = {
    type: Array.isArray(payload) ? "array" : "object",
    topLevelKeys: Array.isArray(payload) ? [] : Object.keys(payload).slice(0, 40)
  };
  if (Array.isArray(payload)) summary.length = payload.length;
  if (Array.isArray(payload.data)) {
    summary.dataLength = payload.data.length;
    summary.firstDataKeys = payload.data[0] && typeof payload.data[0] === "object"
      ? Object.keys(payload.data[0]).slice(0, 30)
      : [];
    summary.firstDataObject = summarizePublicObject(payload.data[0]);
  }
  if (payload.rate_limit) {
    summary.rateLimitKeys = Object.keys(payload.rate_limit);
  }
  if (payload.models && Array.isArray(payload.models)) {
    summary.modelsLength = payload.models.length;
  }
  return summary;
}

function summarizePublicObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allow = ["id", "object", "created", "owned_by", "type", "status", "name"];
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allow.includes(key))
      .slice(0, 12)
  );
}

async function probe(endpoint, auth) {
  const startedAt = Date.now();
  let response;
  let text = "";
  try {
    response = await fetch(endpoint.url, {
      method: "GET",
      headers: buildHeaders(endpoint, auth)
    });
    text = await response.text();
  } catch (error) {
    return {
      name: endpoint.name,
      url: endpoint.url,
      ok: false,
      error: error.message,
      latencyMs: Date.now() - startedAt
    };
  }

  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  return {
    name: endpoint.name,
    url: endpoint.url,
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type") || "",
    latencyMs: Date.now() - startedAt,
    json: summarizeJson(payload),
    bodyPreview: payload ? undefined : text.slice(0, 160)
  };
}

async function main() {
  const auth = await loadAuth();
  const results = [];
  for (const endpoint of ENDPOINTS) {
    results.push(await probe(endpoint, auth));
  }
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    auth: {
      accessTokenPresent: Boolean(auth.accessToken),
      accountIdPresent: Boolean(auth.accountId)
    },
    results
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exit(1);
});
