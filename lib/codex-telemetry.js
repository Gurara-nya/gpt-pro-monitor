"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const readline = require("node:readline");
const path = require("node:path");

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

function nonnegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

function normalizeTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const usage = Object.fromEntries(USAGE_KEYS.map((key) => [key, nonnegativeInteger(value[key])]));
  if (!usage.total_tokens && (usage.input_tokens || usage.output_tokens)) {
    usage.total_tokens = usage.input_tokens + usage.output_tokens;
  }
  usage.cached_input_tokens = Math.min(usage.cached_input_tokens, usage.input_tokens);
  usage.reasoning_output_tokens = Math.min(usage.reasoning_output_tokens, usage.output_tokens);
  return usage.total_tokens ? usage : null;
}

function extractTokenUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  const direct = normalizeTokenUsage(value.total_token_usage || value.token_usage);
  if (direct) return direct;
  return extractTokenUsage(value.info, depth + 1) || extractTokenUsage(value.payload, depth + 1);
}

function usageDelta(current, previous) {
  const totalDelta = nonnegativeInteger(current?.total_tokens) - nonnegativeInteger(previous?.total_tokens);
  if (totalDelta <= 0) return null;
  const delta = {};
  for (const key of USAGE_KEYS) {
    delta[key] = Math.max(0, nonnegativeInteger(current?.[key]) - nonnegativeInteger(previous?.[key]));
  }
  delta.total_tokens = totalDelta;
  delta.cached_input_tokens = Math.min(delta.cached_input_tokens, delta.input_tokens);
  delta.reasoning_output_tokens = Math.min(delta.reasoning_output_tokens, delta.output_tokens);
  return delta;
}

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function addUsage(target, source) {
  for (const key of USAGE_KEYS) target[key] += nonnegativeInteger(source?.[key]);
  return target;
}

function timestampParts(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return { at: "", day: "", month: "" };
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  const day = local.toISOString().slice(0, 10);
  return { at: date.toISOString(), day, month: day.slice(0, 7) };
}

function threadIdFromPath(filePath) {
  const match = path.basename(filePath || "").match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/i);
  return match ? match[1] : "";
}

function fallbackCreatedAt(filePath) {
  const match = path.basename(filePath || "").match(/^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/i);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}` : "";
}

function eventIdentity(threadId, usage) {
  const state = USAGE_KEYS.map((key) => nonnegativeInteger(usage?.[key])).join(":");
  return crypto.createHash("sha256").update(`${threadId}\0${state}`).digest("hex");
}

async function parseRolloutLines(lines, options = {}) {
  const filePath = String(options.filePath || "");
  let threadId = String(options.threadId || threadIdFromPath(filePath));
  let source = "";
  let model = "";
  let provider = "";
  let cwd = "";
  let createdAt = fallbackCreatedAt(filePath);
  let updatedAt = "";
  let previousUsage = emptyUsage();
  let lastCumulativeUsage = null;
  let tokenCountEvents = 0;
  let duplicateEvents = 0;
  const events = [];
  const usageSplit = emptyUsage();

  for await (const lineValue of lines) {
    const line = String(lineValue || "");
    if (!line.includes("token_count") && !line.includes("session_meta") && !line.includes("turn_context")) continue;
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
      if (payload.source) source = typeof payload.source === "string" ? payload.source : JSON.stringify(payload.source);
      if (payload.model_provider) provider = String(payload.model_provider);
      if (payload.cwd) cwd = String(payload.cwd);
      if (payload.timestamp || event.timestamp) {
        createdAt ||= String(payload.timestamp || event.timestamp);
        updatedAt = String(payload.timestamp || event.timestamp);
      }
      continue;
    }

    if (event.type === "turn_context") {
      if (payload.model) model = String(payload.model);
      if (payload.cwd && !cwd) cwd = String(payload.cwd);
      continue;
    }

    if (payload.type !== "token_count") continue;
    const cumulative = extractTokenUsage(payload);
    if (!cumulative) continue;
    tokenCountEvents += 1;
    const delta = usageDelta(cumulative, previousUsage);
    previousUsage = cumulative;
    lastCumulativeUsage = cumulative;
    if (!delta) {
      duplicateEvents += 1;
      continue;
    }
    const parts = timestampParts(event.timestamp || updatedAt || createdAt);
    updatedAt = parts.at || updatedAt;
    const telemetryEvent = {
      eventId: eventIdentity(threadId, cumulative),
      threadId,
      at: parts.at,
      day: parts.day,
      month: parts.month,
      model,
      provider,
      source,
      usageSplit: delta,
      cumulativeUsage: cumulative
    };
    events.push(telemetryEvent);
    addUsage(usageSplit, delta);
  }

  if (!threadId || !events.length) return null;
  const createdParts = timestampParts(createdAt || events[0]?.at);
  return {
    threadId,
    filePath,
    source,
    model: events.at(-1)?.model || model,
    provider,
    cwd,
    createdAt: createdParts.at || createdAt,
    updatedAt: updatedAt || events.at(-1)?.at || "",
    day: createdParts.day || events[0]?.day || "",
    month: createdParts.month || events[0]?.month || "",
    usageSplit,
    tokens: usageSplit.total_tokens,
    lastCumulativeUsage,
    lastEventAt: events.at(-1)?.at || "",
    tokenCountEvents,
    duplicateEvents,
    events
  };
}

async function readRolloutTelemetry(filePath) {
  let sizeBefore = 0;
  try {
    sizeBefore = (await fs.promises.stat(filePath)).size;
  } catch {
    return null;
  }
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let record;
  try {
    record = await parseRolloutLines(lines, { filePath });
  } catch {
    stream.destroy();
    return null;
  }
  let sizeAfter = sizeBefore;
  try {
    sizeAfter = (await fs.promises.stat(filePath)).size;
  } catch {
    // The parsed snapshot remains usable if an active rollout is moved concurrently.
  }
  if (!record) return null;
  return {
    ...record,
    fileSize: sizeAfter,
    grewDuringRead: sizeAfter !== sizeBefore
  };
}

module.exports = {
  USAGE_KEYS,
  addUsage,
  emptyUsage,
  eventIdentity,
  extractTokenUsage,
  normalizeTokenUsage,
  parseRolloutLines,
  readRolloutTelemetry,
  timestampParts,
  usageDelta
};
