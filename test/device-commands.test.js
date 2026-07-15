"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDeviceAgentCommands, resolveMonitorPublicUrl } = require("../server");

test("public monitor URL preserves the request subpath when no URL is configured", () => {
  assert.equal(resolveMonitorPublicUrl({
    origin: "https://monitor.example",
    requestPathname: "/monitor/api/devices"
  }), "https://monitor.example/monitor");
});

test("public monitor URL treats a configured path as the complete external app root", () => {
  assert.equal(resolveMonitorPublicUrl({
    configuredUrl: "https://monitor.example/monitor/",
    origin: "http://127.0.0.1:8787",
    requestPathname: "/monitor/api/devices",
    configuredBasePath: "/monitor"
  }), "https://monitor.example/monitor");

  assert.equal(resolveMonitorPublicUrl({
    configuredUrl: "https://monitor.example/gateway/gpt/",
    origin: "http://127.0.0.1:8787",
    requestPathname: "/monitor/api/devices",
    configuredBasePath: "/monitor"
  }), "https://monitor.example/gateway/gpt");
});

test("public monitor URL appends the configured base path only to a bare origin", () => {
  assert.equal(resolveMonitorPublicUrl({
    configuredUrl: "https://monitor.example/",
    origin: "http://127.0.0.1:8787",
    requestPathname: "/api/devices",
    configuredBasePath: "/monitor"
  }), "https://monitor.example/monitor");
});

test("device bootstrap commands download from and configure the same reachable URL", () => {
  const commands = buildDeviceAgentCommands(
    "https://monitor.example/monitor/",
    "user one",
    "desktop-1",
    "secret-token"
  );

  for (const command of [commands.windows, commands.unix]) {
    assert.match(command, /https:\/\/monitor\.example\/monitor\/api\/device-agent\/v1\?userId=user%20one/);
    assert.match(command, /secret-token/);
    assert.match(command, /--install/);
    assert.doesNotMatch(command, /monitor\/monitor/);
  }
  assert.match(commands.windows, /--url "https:\/\/monitor\.example\/monitor"/);
  assert.match(commands.windows, /\$ErrorActionPreference='Stop'/);
  assert.match(commands.windows, /\[guid\]::NewGuid\(\)/);
  assert.match(commands.windows, /Invoke-WebRequest[^;]+-ErrorAction Stop/);
  assert.match(commands.windows, /\$LASTEXITCODE -ne 0/);
  assert.match(commands.windows, /finally \{ Remove-Item -LiteralPath \$p -Force/);
  assert.doesNotMatch(commands.windows, /Join-Path \$env:TEMP 'gpt-monitor-agent\.js'/);
  assert.match(commands.unix, /--url 'https:\/\/monitor\.example\/monitor'/);
  assert.match(commands.manual, /^node \.\/device-agent\.js /);
});
