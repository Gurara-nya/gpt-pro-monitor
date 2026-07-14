"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { AGENT_VERSION, agentMetadata, retryDelayMs, scanFile, systemdQuote } = require("../device-agent");

function row(type, payload, timestamp = "2026-07-14T00:00:00Z") {
  return JSON.stringify({ type, timestamp, payload });
}

function token(total, input, output, timestamp) {
  return row("event_msg", {
    type: "token_count",
    info: { total_token_usage: { input_tokens: input, cached_input_tokens: Math.floor(input / 2), output_tokens: output, reasoning_output_tokens: 1, total_tokens: total } }
  }, timestamp);
}

test("device agent performs a full scan once and then reads only appended bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-monitor-agent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout-2026-07-14T00-00-00-thread-agent.jsonl");
  await fs.writeFile(file, [
    row("session_meta", { id: "thread-agent", cwd: "C:/private", title: "secret" }),
    row("turn_context", { model: "gpt-5.6-luna" }),
    token(100, 80, 20, "2026-07-14T00:01:00Z")
  ].join("\n") + "\n");
  const first = await scanFile(file);
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].usage.total_tokens, 100);
  assert.equal(first.events[0].cwd, undefined);
  assert.equal(first.events[0].title, undefined);

  await fs.appendFile(file, token(150, 120, 30, "2026-07-14T00:02:00Z") + "\n");
  const second = await scanFile(file, first.cursor);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].usage.total_tokens, 50);
  assert.equal(second.cursor.offset, (await fs.stat(file)).size);
});

test("device agent keeps the filename thread ID and uploads hashed fork lineage", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-monitor-agent-fork-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "rollout-2026-07-14T00-00-00-current-thread.jsonl");
  await fs.writeFile(file, [
    row("session_meta", { id: "current-thread", forked_from_id: "ancestor-thread" }),
    token(100, 80, 20, "2026-07-14T00:01:00Z")
  ].join("\n") + "\n");
  const result = await scanFile(file);
  assert.equal(result.cursor.threadId, "current-thread");
  assert.equal(result.events[0].threadHash, require("node:crypto").createHash("sha256").update("current-thread").digest("hex"));
  assert.equal(result.events[0].parentThreadHash, require("node:crypto").createHash("sha256").update("ancestor-thread").digest("hex"));
  assert.match(result.events[0].usageStateId, /^[a-f0-9]{64}$/);
  assert.equal(result.events[0].cumulativeTotalTokens, 100);
  assert.equal(result.cursor.parserVersion, 3);
});

test("device agent exposes install metadata and bounded retry delays", () => {
  assert.equal(AGENT_VERSION, "2.1.0");
  assert.equal(agentMetadata().version, AGENT_VERSION);
  assert.equal(typeof agentMetadata().platform, "string");
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 300_000);
  assert.equal(retryDelayMs(3), 900_000);
  assert.equal(retryDelayMs(99), 900_000);
  assert.equal(systemdQuote('/tmp/a "b"'), '"/tmp/a \\"b\\""');
});
