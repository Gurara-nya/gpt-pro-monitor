#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const AGENT_HOME = path.join(os.homedir(), ".gpt-monitor");
const CONFIG_FILE = path.join(AGENT_HOME, "device-agent.json");
const STATE_FILE = path.join(AGENT_HOME, "device-agent-state.json");
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_BATCH = 500;
const USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const TELEMETRY_MARKERS = [
  Buffer.from('"type":"session_meta"'),
  Buffer.from('"type":"turn_context"'),
  Buffer.from('"payload":{"type":"token_count"')
];

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    if (key === "once") result.once = true;
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
  if (!usage.total_tokens) usage.total_tokens = usage.input_tokens + usage.output_tokens;
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
  if (stat.size < count(cursor.offset) || cursor.parserVersion !== 2 || (fileThreadId && cursor.threadId !== fileThreadId)) {
    offset = 0;
  }
  const state = offset ? { ...cursor } : {
    parserVersion: 2,
    offset: 0,
    threadId: fileThreadId,
    threadHash: sha(fileThreadId),
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
    body: JSON.stringify({ ...payload, userId: config.userId })
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
      events: events.slice(index * MAX_BATCH, (index + 1) * MAX_BATCH),
      snapshots: snapshots.slice(index * MAX_BATCH, (index + 1) * MAX_BATCH)
    });
    accepted += count(result.accepted);
    duplicates += count(result.duplicates);
  }
  next.lastSyncedAt = new Date().toISOString();
  await atomicJson(STATE_FILE, next);
  console.log(`[device-agent] ${next.lastSyncedAt} accepted=${accepted} duplicates=${duplicates} scanned=${files.length}`);
}

async function main() {
  const cli = args(process.argv.slice(2));
  const config = await configure(cli);
  do {
    try {
      await sync(config);
    } catch (error) {
      console.error(`[device-agent] sync failed: ${error.message}`);
      if (cli.once) throw error;
    }
    if (cli.once) break;
    await new Promise((resolve) => setTimeout(resolve, config.intervalMinutes * 60 * 1000 || DEFAULT_INTERVAL_MS));
  } while (true);
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = { eventId, normalizeUsage, scanFile, sync, usageDelta };
