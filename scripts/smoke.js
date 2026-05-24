const assert = require("node:assert/strict");

const baseUrl = process.env.GPT_MONITOR_BASE_URL || "http://127.0.0.1:8787";
const accessSecret = process.env.GPT_MONITOR_ACCESS_TOKEN || process.env.GPT_MONITOR_PASSWORD || "";
const accessUser = process.env.GPT_MONITOR_USERNAME || "monitor";

function authHeaders() {
  if (!accessSecret) return {};
  return {
    Authorization: `Basic ${Buffer.from(`${accessUser}:${accessSecret}`).toString("base64")}`
  };
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
    },
    ...options
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { text };
  }
  assert.equal(response.ok, true, `${path} returned ${response.status}: ${text}`);
  return payload;
}

async function main() {
  const state = await request("/api/state");
  assert.equal(typeof state.config.port, "number");
  assert.equal(typeof state.config.account.label, "string");
  assert.equal(typeof state.config.account.authPath, "string");
  assert.equal(typeof state.computed.status, "string");

  const exported = await request("/api/export");
  assert.equal(typeof exported.config.account.label, "string");

  const html = await fetch(baseUrl, { headers: authHeaders() }).then((response) => response.text());
  assert.match(html, /GPT Pro Monitor/);
  assert.doesNotMatch(html, /unpkg\.com|cdn\.jsdelivr\.net/);

  console.log(`Smoke checks passed for ${baseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
