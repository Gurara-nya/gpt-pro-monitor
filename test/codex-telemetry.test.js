"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRolloutLines, usageDelta } = require("../lib/codex-telemetry");

function line(type, payload, timestamp = "2026-07-14T01:00:00.000Z") {
  return JSON.stringify({ type, timestamp, payload });
}

function token(usage, timestamp) {
  return line("event_msg", { type: "token_count", info: { total_token_usage: usage } }, timestamp);
}

test("cumulative token_count events become positive deltas and duplicates are ignored", async () => {
  const lines = [
    line("session_meta", { id: "thread-1", timestamp: "2026-07-14T00:00:00.000Z", source: "cli" }),
    line("turn_context", { model: "gpt-5.6-terra" }),
    token({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 }),
    token({ input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 }),
    token({ input_tokens: 180, cached_input_tokens: 50, output_tokens: 30, reasoning_output_tokens: 12, total_tokens: 210 }, "2026-07-14T02:00:00.000Z")
  ];
  const record = await parseRolloutLines(lines, { filePath: "rollout-2026-07-14T00-00-00-thread-1.jsonl" });
  assert.equal(record.events.length, 2);
  assert.equal(record.duplicateEvents, 1);
  assert.deepEqual(record.usageSplit, {
    input_tokens: 180,
    cached_input_tokens: 50,
    output_tokens: 30,
    reasoning_output_tokens: 12,
    total_tokens: 210
  });
});

test("events retain the model and day active when their delta was emitted", async () => {
  const record = await parseRolloutLines([
    line("session_meta", { id: "thread-model" }),
    line("turn_context", { model: "gpt-5.6-luna" }),
    token({ input_tokens: 20, output_tokens: 5, total_tokens: 25 }, "2026-07-13T23:59:00.000Z"),
    line("turn_context", { model: "gpt-5.6-sol" }),
    token({ input_tokens: 40, output_tokens: 15, total_tokens: 55 }, "2026-07-14T00:01:00.000Z")
  ]);
  assert.deepEqual(record.events.map((event) => event.model), ["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.deepEqual(record.events.map((event) => event.usageSplit.total_tokens), [25, 30]);
});

test("a cumulative reset is ignored but the next positive adjacent delta is counted", () => {
  assert.equal(usageDelta({ total_tokens: 50 }, { total_tokens: 100 }), null);
  assert.deepEqual(usageDelta(
    { input_tokens: 60, output_tokens: 10, total_tokens: 70 },
    { input_tokens: 40, output_tokens: 10, total_tokens: 50 }
  ), {
    input_tokens: 20,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 20
  });
});

test("reasoning output stays a subset and does not increase total tokens", async () => {
  const record = await parseRolloutLines([
    line("session_meta", { id: "thread-reasoning" }),
    token({ input_tokens: 80, output_tokens: 20, reasoning_output_tokens: 15, total_tokens: 100 })
  ]);
  assert.equal(record.usageSplit.total_tokens, 100);
  assert.equal(record.usageSplit.output_tokens, 20);
  assert.equal(record.usageSplit.reasoning_output_tokens, 15);
});
