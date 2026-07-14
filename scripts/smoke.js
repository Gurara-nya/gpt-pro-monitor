const assert = require("node:assert/strict");

const baseUrl = (process.env.GPT_MONITOR_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
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
  assert.equal(Array.isArray(state.config.usageUsers), true);
  assert.equal(typeof state.config.activeUsageUserId, "string");
  assert.equal(typeof state.computed.status, "string");
  assert.equal(state.checks.every((check) => check.detail === undefined && check.account === undefined), true);

  const userId = state.config.activeUsageUserId;
  const usage = await request(`/api/codex-usage?userId=${encodeURIComponent(userId)}`);
  if (usage.report) {
    assert.equal(usage.report.sessions, undefined);
    assert.equal(usage.report.device_views, undefined);
    assert.equal(Array.isArray(usage.report.device_breakdown), true);
    assert.equal(typeof usage.report.device_breakdown_by_month, "object");
    for (const month of usage.report.month_views || []) {
      assert.equal(Array.isArray(usage.report.device_breakdown_by_month[month.month]), true);
    }
  }

  const devices = await request(`/api/devices?userId=${encodeURIComponent(userId)}`);
  assert.equal(Array.isArray(devices.devices), true);
  assert.equal(devices.devices.some((device) => device.builtIn), true);
  const localUsage = await request(`/api/codex-usage?userId=${encodeURIComponent(userId)}&deviceId=local`);
  if (localUsage.report) assert.equal(localUsage.report.selected_device_id, "local");

  const sessions = await request(
    `/api/codex-usage/sessions?userId=${encodeURIComponent(userId)}&deviceId=all&sort=tokens_desc&page=1&pageSize=2`
  );
  assert.equal(Array.isArray(sessions.items), true);
  assert.equal(Array.isArray(sessions.months), true);
  assert.equal(typeof sessions.summary, "object");
  assert.equal(sessions.items.length <= 2, true);
  assert.equal(sessions.pagination.pageSize, 2);
  assert.equal(typeof sessions.pagination.totalItems, "number");

  const exported = await request("/api/export");
  assert.equal(typeof exported.config.account.label, "string");
  assert.equal(Array.isArray(exported.config.usageUsers), true);
  assert.equal(Array.isArray(exported.checks), true);

  let smokeDevice;
  try {
    smokeDevice = await request("/api/devices", {
      method: "POST",
      body: JSON.stringify({ userId, name: `smoke-${Date.now()}` })
    });
    assert.equal(typeof smokeDevice.token, "string");
    const ingestResponse = await fetch(`${baseUrl}/api/device-ingest/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${smokeDevice.token}` },
      body: JSON.stringify({ schemaVersion: 1, userId, batchId: `smoke-${Date.now()}`, cursor: "smoke", events: [], snapshots: [] })
    });
    assert.equal(ingestResponse.ok, true, `device ingest returned ${ingestResponse.status}`);
    const ingest = await ingestResponse.json();
    assert.equal(ingest.accepted, 0);
    const exportWithDevice = await request("/api/export");
    assert.equal(JSON.stringify(exportWithDevice).includes(smokeDevice.token), false);
  } finally {
    if (smokeDevice?.device?.id) {
      await request(`/api/devices/${encodeURIComponent(smokeDevice.device.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ userId })
      });
    }
  }

  const html = await fetch(baseUrl, { headers: authHeaders() }).then((response) => response.text());
  assert.match(html, /GPT Pro Monitor/);
  assert.doesNotMatch(html, /unpkg\.com|cdn\.jsdelivr\.net/);

  const helpResponse = await fetch(`${baseUrl}/help`, { headers: authHeaders() });
  assert.equal(helpResponse.ok, true, `/help returned ${helpResponse.status}`);
  assert.match(await helpResponse.text(), /远程设备接入/);
  const agentResponse = await fetch(`${baseUrl}/downloads/device-agent.js`, { headers: authHeaders() });
  assert.equal(agentResponse.ok, true, `/downloads/device-agent.js returned ${agentResponse.status}`);
  assert.match(agentResponse.headers.get("content-disposition") || "", /device-agent\.js/);
  assert.match(await agentResponse.text(), /device-agent-state\.json/);

  const origin = new URL(baseUrl).origin;
  const aliasResponse = await fetch(`${origin}/monitor/`, { headers: authHeaders() });
  assert.equal(aliasResponse.ok, true, `/monitor/ returned ${aliasResponse.status}`);
  assert.match(await aliasResponse.text(), /GPT Pro Monitor/);
  const aliasHelpResponse = await fetch(`${origin}/monitor/help`, { headers: authHeaders() });
  assert.equal(aliasHelpResponse.ok, true, `/monitor/help returned ${aliasHelpResponse.status}`);
  assert.match(await aliasHelpResponse.text(), /远程设备接入/);

  if (accessSecret) {
    const unauthorized = await fetch(`${baseUrl}/api/state`);
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") || "", /^Basic /);
  }

  console.log(`Smoke checks passed for ${baseUrl}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
