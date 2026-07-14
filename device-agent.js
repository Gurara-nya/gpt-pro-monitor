#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const AGENT_HOME = path.join(os.homedir(), ".gpt-monitor");
const CONFIG_FILE = path.join(AGENT_HOME, "device-agent.json");
const STATE_FILE = path.join(AGENT_HOME, "device-agent-state.json");
const INSTALLED_AGENT_FILE = path.join(AGENT_HOME, "device-agent.js");
const AGENT_VERSION = "2.1.0";
const WINDOWS_TASK_NAME = "GPT Monitor Device Agent";
const LINUX_SERVICE_FILE = path.join(os.homedir(), ".config", "systemd", "user", "gpt-monitor-agent.service");
const MACOS_PLIST_FILE = path.join(os.homedir(), "Library", "LaunchAgents", "com.gpt-monitor.device-agent.plist");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const MAX_BATCH = 500;
const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const TELEMETRY_MARKERS = [
  Buffer.from('"type":"session_meta"'),
  Buffer.from('"type":"turn_context"'),
  Buffer.from('"payload":{"type":"token_count"')
];

function args(argv) {
  const result = {};
  const flags = new Set(["once", "install", "status", "uninstall", "purge", "help"]);
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (flags.has(key)) result[key] = true;
    else result[key] = argv[++index];
  }
  return result;
}

function sha(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function normalizeUsage(value) {
  if (!value || typeof value !== "object") return null;
  const usage = Object.fromEntries(USAGE_KEYS.map((key) => [key, count(value[key])]));
  if (usage.input_tokens || usage.output_tokens) usage.total_tokens = usage.input_tokens + usage.output_tokens;
  usage.cached_input_tokens = Math.min(usage.cached_input_tokens, usage.input_tokens);
  usage.reasoning_output_tokens = Math.min(usage.reasoning_output_tokens, usage.output_tokens);
  return usage.total_tokens ? usage : null;
}

function extractUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  return normalizeUsage(value.total_token_usage || value.token_usage) ||
    extractUsage(value.info, depth + 1) || extractUsage(value.payload, depth + 1);
}

function usageDelta(current, previous = {}) {
  const total = count(current.total_tokens) - count(previous.total_tokens);
  if (total <= 0) return null;
  const result = Object.fromEntries(USAGE_KEYS.map((key) => [key, Math.max(0, count(current[key]) - count(previous[key]))]));
  result.total_tokens = total;
  result.cached_input_tokens = Math.min(result.cached_input_tokens, result.input_tokens);
  result.reasoning_output_tokens = Math.min(result.reasoning_output_tokens, result.output_tokens);
  return result;
}

function eventId(threadHash, cumulative) {
  const state = USAGE_KEYS.map((key) => count(cumulative[key])).join(":");
  return sha(`${threadHash}\0${state}`);
}

function usageStateId(cumulative) {
  const state = USAGE_KEYS.map((key) => count(cumulative?.[key])).join(":");
  return sha(state);
}

function parentThreadId(value, depth = 0) {
  if (!value || depth > 6) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try { return parentThreadId(JSON.parse(trimmed), depth + 1); } catch { return ""; }
  }
  if (typeof value !== "object") return "";
  for (const key of ["parent_thread_id", "parentThreadId", "forked_from_id", "forkedFromId"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  for (const key of ["thread_spawn", "subagent", "source", "metadata"]) {
    const found = parentThreadId(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temp, filePath);
}

async function atomicFile(filePath, contents, mode = 0o700) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(temp, contents, { mode });
  await fsp.rename(temp, filePath);
  await fsp.chmod(filePath, mode).catch(() => {});
}

function psQuote(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function xmlEscape(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function systemdQuote(value) {
  return `"${String(value || "").replace(/([\\"])/g, "\\$1")}"`;
}

function agentMetadata() {
  return {
    version: AGENT_VERSION,
    platform: process.platform,
    nodeVersion: process.versions.node,
    installed: path.resolve(__filename) === path.resolve(INSTALLED_AGENT_FILE)
  };
}

function retryDelayMs(failures) {
  return RETRY_DELAYS_MS[Math.min(Math.max(1, Number(failures) || 1) - 1, RETRY_DELAYS_MS.length - 1)];
}

function ensureSupportedNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 22) {
    throw new Error(`需要 Node.js 22 或更高版本；当前为 ${process.versions.node}`);
  }
}

async function installAgentFile() {
  await atomicFile(INSTALLED_AGENT_FILE, await fsp.readFile(__filename), 0o700);
}

function installWindowsAutostart() {
  const taskArgument = `"${INSTALLED_AGENT_FILE}"`;
  const command = [
    `$action = New-ScheduledTaskAction -Execute ${psQuote(process.execPath)} -Argument ${psQuote(taskArgument)} -WorkingDirectory ${psQuote(AGENT_HOME)}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)",
    "$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited",
    `Register-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Uploads Codex token telemetry to GPT Monitor.' -Force | Out-Null`,
    `Start-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)}`
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", command], {
    stdio: "inherit",
    windowsHide: true
  });
}

async function installLinuxAutostart() {
  const unit = `[Unit]\nDescription=GPT Monitor Device Agent\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart=${systemdQuote(process.execPath)} ${systemdQuote(INSTALLED_AGENT_FILE)}\nRestart=always\nRestartSec=60\n\n[Install]\nWantedBy=default.target\n`;
  await atomicFile(LINUX_SERVICE_FILE, unit, 0o600);
  execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  execFileSync("systemctl", ["--user", "enable", "--now", "gpt-monitor-agent.service"], { stdio: "inherit" });
}

async function installMacosAutostart() {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.gpt-monitor.device-agent</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(INSTALLED_AGENT_FILE)}</string></array>\n<key>WorkingDirectory</key><string>${xmlEscape(AGENT_HOME)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>StandardOutPath</key><string>${xmlEscape(path.join(AGENT_HOME, "device-agent.log"))}</string>\n<key>StandardErrorPath</key><string>${xmlEscape(path.join(AGENT_HOME, "device-agent-error.log"))}</string>\n</dict></plist>\n`;
  await atomicFile(MACOS_PLIST_FILE, plist, 0o600);
  try {
    execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, MACOS_PLIST_FILE], { stdio: "ignore" });
  } catch {}
  execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, MACOS_PLIST_FILE], { stdio: "inherit" });
}

async function installAutostart() {
  await installAgentFile();
  if (process.platform === "win32") installWindowsAutostart();
  else if (process.platform === "linux") await installLinuxAutostart();
  else if (process.platform === "darwin") await installMacosAutostart();
  else throw new Error(`暂不支持自动安装：${process.platform}`);
}

async function uninstallAutostart(purge = false) {
  if (process.platform === "win32") {
    const command = `Unregister-ScheduledTask -TaskName ${psQuote(WINDOWS_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`;
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], { stdio: "inherit", windowsHide: true });
  } else if (process.platform === "linux") {
    try { execFileSync("systemctl", ["--user", "disable", "--now", "gpt-monitor-agent.service"], { stdio: "inherit" }); } catch {}
    await fsp.rm(LINUX_SERVICE_FILE, { force: true });
    try { execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" }); } catch {}
  } else if (process.platform === "darwin") {
    try { execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, MACOS_PLIST_FILE], { stdio: "ignore" }); } catch {}
    await fsp.rm(MACOS_PLIST_FILE, { force: true });
  }
  if (purge) await Promise.all([
    fsp.rm(CONFIG_FILE, { force: true }),
    fsp.rm(STATE_FILE, { force: true }),
    fsp.rm(INSTALLED_AGENT_FILE, { force: true })
  ]);
}

async function showStatus() {
  const [config, state] = await Promise.all([readJson(CONFIG_FILE, {}), readJson(STATE_FILE, {})]);
  console.log(`GPT Monitor 设备采集器 v${AGENT_VERSION}`);
  console.log(`设备：${config.deviceId || "未配置"}`);
  console.log(`Monitor：${config.url || "未配置"}`);
  console.log(`Codex 目录：${config.codexHome || path.join(os.homedir(), ".codex")}`);
  console.log(`最后同步：${state.lastSyncedAt || "尚未同步"}`);
  console.log(`自动运行：${path.resolve(__filename) === path.resolve(INSTALLED_AGENT_FILE) ? "已从安装目录运行" : "请用 --install 安装"}`);
}

function showHelp() {
  console.log(`GPT Monitor 设备采集器 v${AGENT_VERSION}\n\n首次安装：\n  node device-agent.js --url <地址> --user <用户> --device <设备> --token <令牌> --install\n\n常用操作：\n  --once       立即同步一次\n  --status     查看配置与最后同步时间\n  --uninstall  移除自动运行，保留配置\n  --purge      与 --uninstall 同用并删除本地配置\n  --codex-home <目录>  指定 Codex 数据目录`);
}

async function configure(cli) {
  const existing = await readJson(CONFIG_FILE, {});
  const config = {
    url: String(cli.url || process.env.GPT_MONITOR_URL || existing.url || "").replace(/\/+$/, ""),
    userId: String(cli.user || process.env.GPT_MONITOR_USER || existing.userId || "gurara"),
    deviceId: String(cli.device || process.env.GPT_MONITOR_DEVICE || existing.deviceId || os.hostname()),
    token: String(cli.token || process.env.GPT_MONITOR_DEVICE_TOKEN || existing.token || ""),
    codexHome: path.resolve(String(cli["codex-home"] || process.env.CODEX_HOME || existing.codexHome || path.join(os.homedir(), ".codex"))),
    intervalMinutes: Math.max(1, Number(cli.interval || existing.intervalMinutes || 15))
  };
  if (!config.url || !config.token) {
    throw new Error("Missing --url or --token. Create a device in GPT Monitor and run the generated command.");
  }
  await atomicJson(CONFIG_FILE, config);
  return config;
}

async function listFiles(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(filePath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(filePath);
  }
  return files;
}

function idFromPath(filePath) {
  const match = path.basename(filePath).match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match ? match[1] : "";
}

function isTelemetryLine(line) {
  const head = line.subarray(0, Math.min(line.length, 4096));
  return TELEMETRY_MARKERS.some((marker) => head.indexOf(marker) !== -1);
}

async function* completeLines(filePath, start, end) {
  const stream = fs.createReadStream(filePath, { start, end });
  let fragments = [];
  let fragmentBytes = 0;

  for await (const chunk of stream) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline === -1) {
        const remainder = chunk.subarray(cursor);
        fragments.push(remainder);
        fragmentBytes += remainder.length;
        break;
      }
      const segment = chunk.subarray(cursor, newline);
      let line;
      if (fragments.length) {
        fragments.push(segment);
        line = Buffer.concat(fragments, fragmentBytes + segment.length);
        fragments = [];
        fragmentBytes = 0;
      } else {
        line = segment;
      }
      yield line;
      cursor = newline + 1;
    }
  }
}

async function scanFile(filePath, cursor = {}) {
  const stat = await fsp.stat(filePath);
  const fileThreadId = idFromPath(filePath);
  let offset = Math.min(count(cursor.offset), stat.size);
  if (stat.size < count(cursor.offset) || cursor.parserVersion !== 3 || (fileThreadId && cursor.threadId !== fileThreadId)) {
    offset = 0;
  }
  const state = offset ? { ...cursor } : {
    parserVersion: 3,
    offset: 0,
    threadId: fileThreadId,
    threadHash: sha(fileThreadId),
    parentThreadHash: "",
    model: "",
    provider: "",
    previousUsage: {}
  };
  if (stat.size === offset) return { events: [], cursor: state };
  const events = [];
  for await (let lineBuffer of completeLines(filePath, offset, stat.size - 1)) {
    offset += lineBuffer.length + 1;
    if (!isTelemetryLine(lineBuffer)) continue;
    if (lineBuffer.at(-1) === 13) lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
    let item;
    try { item = JSON.parse(lineBuffer.toString("utf8")); } catch { continue; }
    const payload = item?.payload;
    if (!payload || typeof payload !== "object") continue;
    if (item.type === "session_meta") {
      if (payload.id && !fileThreadId) {
        state.threadId = String(payload.id);
        state.threadHash = sha(state.threadId);
      }
      const parentId = parentThreadId(payload);
      if (parentId && parentId !== state.threadId) state.parentThreadHash = sha(parentId);
      if (!state.parentThreadHash && fileThreadId && payload.id && String(payload.id) !== fileThreadId) {
        state.parentThreadHash = sha(String(payload.id));
      }
      if (payload.model_provider) state.provider = String(payload.model_provider);
      continue;
    }
    if (item.type === "turn_context") {
      if (payload.model) state.model = String(payload.model);
      continue;
    }
    if (payload.type !== "token_count") continue;
    const cumulative = extractUsage(payload);
    if (!cumulative) continue;
    const delta = usageDelta(cumulative, state.previousUsage);
    state.previousUsage = cumulative;
    if (!delta) continue;
    const at = new Date(item.timestamp || Date.now()).toISOString();
    events.push({
      eventId: eventId(state.threadHash, cumulative),
      threadHash: state.threadHash,
      parentThreadHash: state.parentThreadHash || "",
      usageStateId: usageStateId(cumulative),
      cumulativeTotalTokens: count(cumulative.total_tokens),
      at,
      model: state.model || "unknown",
      provider: state.provider || "",
      usage: delta
    });
  }
  return { events, cursor: { ...state, offset } };
}

async function sqliteSnapshots(codexHome) {
  const dbPath = path.join(codexHome, "state_5.sqlite");
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare("SELECT id, tokens_used, updated_at, model, model_provider FROM threads WHERE tokens_used > 0").all().map((row) => ({
        threadHash: sha(row.id),
        totalTokens: count(row.tokens_used),
        updatedAt: new Date(Number(row.updated_at) * 1000).toISOString(),
        model: String(row.model || "unknown"),
        provider: String(row.model_provider || "")
      }));
    } finally {
      db.close();
    }
  } catch (error) {
    console.warn(`[device-agent] SQLite snapshots unavailable: ${error.message}`);
    return [];
  }
}

async function postBatch(config, payload) {
  const response = await fetch(`${config.url}/api/device-ingest/v1`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, userId: config.userId }),
    signal: AbortSignal.timeout(60_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

async function sync(config) {
  const previous = await readJson(STATE_FILE, { files: {}, sequence: 0 });
  const next = structuredClone(previous);
  const files = [
    ...await listFiles(path.join(config.codexHome, "sessions")),
    ...await listFiles(path.join(config.codexHome, "archived_sessions"))
  ];
  const events = [];
  for (const filePath of [...new Set(files)]) {
    const result = await scanFile(filePath, previous.files[filePath]);
    events.push(...result.events);
    next.files[filePath] = result.cursor;
  }
  const snapshots = await sqliteSnapshots(config.codexHome);
  const lineageByThreadHash = new Map(
    Object.values(next.files || {})
      .filter((item) => item?.threadHash && item?.parentThreadHash)
      .map((item) => [item.threadHash, item.parentThreadHash])
  );
  for (const snapshot of snapshots) {
    snapshot.parentThreadHash ||= lineageByThreadHash.get(snapshot.threadHash) || "";
  }
  const batches = Math.max(1, Math.ceil(Math.max(events.length, snapshots.length) / MAX_BATCH));
  let accepted = 0;
  let duplicates = 0;
  for (let index = 0; index < batches; index += 1) {
    next.sequence = count(next.sequence) + 1;
    const cursor = `${Date.now()}-${next.sequence}`;
    const result = await postBatch(config, {
      schemaVersion: 1,
      batchId: `${config.deviceId}-${cursor}`,
      cursor,
      agent: agentMetadata(),
      events: events.slice(index * MAX_BATCH, (index + 1) * MAX_BATCH),
      snapshots: snapshots.slice(index * MAX_BATCH, (index + 1) * MAX_BATCH)
    });
    accepted += count(result.accepted);
    duplicates += count(result.duplicates);
  }
  next.lastSyncedAt = new Date().toISOString();
  await atomicJson(STATE_FILE, next);
  const summary = { accepted, duplicates, files: files.length, lastSyncedAt: next.lastSyncedAt };
  console.log(`[device-agent] 同步成功 ${next.lastSyncedAt} · 新增 ${accepted} · 去重 ${duplicates} · 扫描 ${files.length} 个文件`);
  return summary;
}

async function main() {
  const cli = args(process.argv.slice(2));
  if (cli.help) return showHelp();
  if (cli.status) return showStatus();
  if (cli.uninstall) {
    await uninstallAutostart(cli.purge);
    console.log(`[device-agent] 已移除自动运行${cli.purge ? "并删除本地配置" : "，配置与同步游标已保留"}`);
    return;
  }
  ensureSupportedNode();
  const config = await configure(cli);

  if (cli.install) {
    console.log("[device-agent] 正在测试连接并导入现有用量…");
    await sync(config);
    await installAutostart();
    console.log(`[device-agent] 安装完成；已启用自动运行，每 ${config.intervalMinutes} 分钟同步一次。`);
    return;
  }

  let failures = 0;
  while (true) {
    try {
      await sync(config);
      failures = 0;
    } catch (error) {
      console.error(`[device-agent] sync failed: ${error.message}`);
      if (cli.once) throw error;
      failures += 1;
    }
    if (cli.once) break;
    const delay = failures ? retryDelayMs(failures) : (config.intervalMinutes * 60 * 1000 || DEFAULT_INTERVAL_MS);
    if (failures) console.log(`[device-agent] 将在 ${Math.round(delay / 60000)} 分钟后重试。`);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[device-agent] 操作失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  AGENT_VERSION,
  agentMetadata,
  eventId,
  normalizeUsage,
  parentThreadId,
  retryDelayMs,
  scanFile,
  sync,
  systemdQuote,
  usageStateId,
  usageDelta
};
