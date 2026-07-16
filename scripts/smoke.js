const assert = require("node:assert/strict");

const baseUrl = (process.env.GPT_MONITOR_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const origin = new URL(baseUrl).origin;
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
    cache: "no-store",
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
    assert.equal(usage.report.daily, undefined);
    assert.equal(Array.isArray(usage.report.device_breakdown), true);
    assert.equal(typeof usage.report.device_breakdown_by_month, "object");
    assert.equal(typeof usage.report.device_daily_by_month, "object");
    assert.equal(typeof usage.report.token_audit, "object");
    assert.equal(typeof usage.report.token_audit.shared_history_tokens_excluded, "number");
    assert.equal(usage.report.token_audit.review_items, undefined);
    for (const series of Object.values(usage.report.device_daily_by_month).flat()) {
      for (const point of series.points || []) {
        assert.equal(Number.isInteger(point.d), true);
        assert.equal(Array.isArray(point.usage), true);
        assert.equal(point.usage.length, 3);
        assert.equal(point.cost === null || Array.isArray(point.cost), true);
        if (point.cost) assert.equal(point.cost.length, 3);
      }
    }
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

  const forks = await request(`/api/codex-usage/forks?userId=${encodeURIComponent(userId)}`);
  assert.equal(["assisted", "automatic"].includes(forks.reviewMode), true);
  assert.equal(typeof forks.summary, "object");
  assert.equal(Array.isArray(forks.items), true);
  assert.equal(forks.items.every((item) => typeof item.can_decide === "boolean"), true);

  const exported = await request("/api/export");
  assert.equal(typeof exported.config.account.label, "string");
  assert.equal(Array.isArray(exported.config.usageUsers), true);
  assert.equal(Array.isArray(exported.checks), true);

  let smokeDevice;
  let aliasSmokeDevice;
  try {
    smokeDevice = await request("/api/devices", {
      method: "POST",
      body: JSON.stringify({ userId, name: `smoke-${Date.now()}` })
    });
    assert.equal(typeof smokeDevice.token, "string");
    assert.match(smokeDevice.commands.windows, /--install/);
    assert.match(smokeDevice.commands.unix, /--install/);
    assert.match(smokeDevice.commands.manual, /--install/);
    const agentDownload = await fetch(
      `${baseUrl}/api/device-agent/v1?userId=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${smokeDevice.token}` } }
    );
    assert.equal(agentDownload.ok, true, `authenticated agent download returned ${agentDownload.status}`);
    assert.equal(agentDownload.headers.get("x-gpt-monitor-agent-version"), "2.1.1");
    assert.match(await agentDownload.text(), /AGENT_VERSION = "2\.1\.1"/);
    const aliasAgentDownload = await fetch(
      `${new URL(baseUrl).origin}/monitor/api/device-agent/v1?userId=${encodeURIComponent(userId)}`,
      { cache: "no-store", headers: { Authorization: `Bearer ${smokeDevice.token}` } }
    );
    assert.equal(aliasAgentDownload.ok, true, `subpath agent download returned ${aliasAgentDownload.status}`);
    assert.equal(aliasAgentDownload.headers.get("x-gpt-monitor-agent-version"), "2.1.1");
    const rejectedDownload = await fetch(`${baseUrl}/api/device-agent/v1?userId=${encodeURIComponent(userId)}`);
    assert.equal(rejectedDownload.status, 401);
    const ingestResponse = await fetch(`${baseUrl}/api/device-ingest/v1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${smokeDevice.token}` },
      body: JSON.stringify({
        schemaVersion: 1,
        userId,
        batchId: `smoke-${Date.now()}`,
        cursor: "smoke",
        events: [],
        snapshots: [],
        agent: { version: "2.0.0", platform: "linux", nodeVersion: "v22.17.0", installed: true }
      })
    });
    assert.equal(ingestResponse.ok, true, `device ingest returned ${ingestResponse.status}`);
    const ingest = await ingestResponse.json();
    assert.equal(ingest.accepted, 0);
    assert.equal(typeof ingest.serverTime, "string");
    const devicesAfterIngest = await request(`/api/devices?userId=${encodeURIComponent(userId)}&_=${Date.now()}`);
    const ingestedDevice = devicesAfterIngest.devices.find((device) => device.id === smokeDevice.device.id);
    assert.equal(ingestedDevice.agentVersion, "2.0.0");
    assert.equal(ingestedDevice.agentPlatform, "linux");
    assert.equal(ingestedDevice.agentInstalled, true);
    const exportWithDevice = await request("/api/export");
    assert.equal(JSON.stringify(exportWithDevice).includes(smokeDevice.token), false);

    const aliasCreateResponse = await fetch(`${origin}/monitor/api/devices`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ userId, name: `smoke-alias-${Date.now()}` })
    });
    assert.equal(aliasCreateResponse.ok, true, `/monitor/api/devices returned ${aliasCreateResponse.status}`);
    aliasSmokeDevice = await aliasCreateResponse.json();
    for (const command of [aliasSmokeDevice.commands.windows, aliasSmokeDevice.commands.unix]) {
      assert.match(command, /\/monitor\/api\/device-agent\/v1\?userId=/);
      assert.match(command, /--url ["']https?:\/\/[^"']+\/monitor["']/);
      assert.doesNotMatch(command, /\/monitor\/monitor/);
    }
    const aliasCommandDownload = await fetch(
      `${origin}/monitor/api/device-agent/v1?userId=${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${aliasSmokeDevice.token}` } }
    );
    assert.equal(aliasCommandDownload.ok, true, `alias command download returned ${aliasCommandDownload.status}`);
    assert.equal(aliasCommandDownload.headers.get("x-gpt-monitor-agent-version"), "2.1.1");
  } finally {
    if (smokeDevice?.device?.id) {
      await request(`/api/devices/${encodeURIComponent(smokeDevice.device.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ userId })
      });
    }
    if (aliasSmokeDevice?.device?.id) {
      await request(`/api/devices/${encodeURIComponent(aliasSmokeDevice.device.id)}`, {
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
  assert.match(await helpResponse.text(), /data-page="device-help"/);
  const agentResponse = await fetch(`${baseUrl}/downloads/device-agent.js`, { headers: authHeaders() });
  assert.equal(agentResponse.ok, true, `/downloads/device-agent.js returned ${agentResponse.status}`);
  assert.match(agentResponse.headers.get("content-disposition") || "", /device-agent\.js/);
  assert.match(await agentResponse.text(), /device-agent-state\.json/);

  const aliasResponse = await fetch(`${origin}/monitor/`, { headers: authHeaders() });
  assert.equal(aliasResponse.ok, true, `/monitor/ returned ${aliasResponse.status}`);
  assert.match(await aliasResponse.text(), /GPT Pro Monitor/);
  const aliasForksResponse = await fetch(
    `${origin}/monitor/api/codex-usage/forks?userId=${encodeURIComponent(userId)}`,
    { cache: "no-store", headers: authHeaders() }
  );
  assert.equal(aliasForksResponse.ok, true, `/monitor fork review returned ${aliasForksResponse.status}`);
  assert.equal(Array.isArray((await aliasForksResponse.json()).items), true);
  const aliasHelpResponse = await fetch(`${origin}/monitor/help`, { headers: authHeaders() });
  assert.equal(aliasHelpResponse.ok, true, `/monitor/help returned ${aliasHelpResponse.status}`);
  const aliasHelpHtml = await aliasHelpResponse.text();
  assert.match(aliasHelpHtml, /data-page="device-help"/);
  const aliasDownloadHref = aliasHelpHtml.match(/href="([^"]*downloads\/device-agent\.js)"/)?.[1];
  assert.equal(typeof aliasDownloadHref, "string");
  const aliasDownloadResponse = await fetch(new URL(aliasDownloadHref, `${origin}/monitor/help`), { headers: authHeaders() });
  assert.equal(aliasDownloadResponse.ok, true, `help agent download returned ${aliasDownloadResponse.status}`);
  assert.equal(aliasDownloadResponse.headers.get("x-gpt-monitor-agent-version"), "2.1.1");

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
