"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  deduplicateLineageRecords,
  extractParentThreadId,
  usageStateId
} = require("../lib/token-lineage");

function usage(total, cached = 0, output = 0, reasoning = 0) {
  const input = Math.max(0, total - output);
  return {
    input_tokens: input,
    cached_input_tokens: Math.min(cached, input),
    output_tokens: output,
    reasoning_output_tokens: Math.min(reasoning, output),
    total_tokens: total
  };
}

function events(deltas, day = "2026-07-14") {
  return deltas.map((tokens, index) => ({
    at: `${day}T00:${String(index).padStart(2, "0")}:00.000Z`,
    usageSplit: usage(tokens, Math.floor(tokens / 2), Math.floor(tokens / 10), Math.floor(tokens / 20))
  }));
}

function byId(result, id) {
  return result.records.find((record) => record.threadId === id);
}

test("usage state IDs normalize aliases and extraction finds explicit and nested parents", () => {
  assert.equal(usageStateId({ inputTokens: 80, cachedInputTokens: 20, outputTokens: 20, totalTokens: 100 }), "80:20:20:0:100");
  assert.equal(extractParentThreadId({ forked_from_id: " parent-a " }), "parent-a");
  assert.equal(extractParentThreadId({ forked_from_id: "", parent_thread_id: "parent-fallback" }), "parent-fallback");
  assert.equal(extractParentThreadId({ payload: { parentThreadId: "parent-b" } }), "parent-b");
  assert.equal(extractParentThreadId(JSON.stringify({
    subagent: { thread_spawn: { parent_thread_id: "parent-c" } }
  })), "parent-c");
});

test("explicit forks remove a pure copy and retain only branch additions", () => {
  const rootEvents = events([100_000, 50_000]);
  const result = deduplicateLineageRecords([
    { threadId: "root", createdAt: "2026-07-14T00:00:00Z", sqliteTokens: 150_000, events: rootEvents },
    { threadId: "copy", parentThreadId: "root", createdAt: "2026-07-14T01:00:00Z", sqliteTokens: 150_000, events: rootEvents },
    { threadId: "branch", parentThreadId: "root", createdAt: "2026-07-14T02:00:00Z", sqliteTokens: 180_000, events: events([100_000, 50_000, 30_000]) }
  ]);

  assert.equal(byId(result, "copy").rawEvents.length, 2);
  assert.equal(byId(result, "copy").events.length, 0);
  assert.equal(byId(result, "copy").inheritedTokens, 150_000);
  assert.equal(byId(result, "copy").branchTokens, 0);
  assert.equal(byId(result, "branch").sharedPrefixEvents, 2);
  assert.equal(byId(result, "branch").usageSplit.total_tokens, 30_000);
  assert.equal(byId(result, "branch").branchTokens, 30_000);
  assert.equal(result.audit.inheritedTokens, 300_000);
  assert.equal(result.audit.branchTokens, 180_000);
});

test("siblings, a continuing parent, and nested forks are reconciled independently", () => {
  const result = deduplicateLineageRecords([
    { threadId: "root", createdAt: "2026-07-14T00:00:00Z", sqliteTokens: 200_000, events: events([100_000, 50_000, 50_000]) },
    { threadId: "left", parentThreadId: "root", createdAt: "2026-07-14T01:00:00Z", sqliteTokens: 180_000, events: events([100_000, 50_000, 30_000]) },
    { threadId: "right", parentThreadId: "root", createdAt: "2026-07-14T02:00:00Z", sqliteTokens: 190_000, events: events([100_000, 50_000, 40_000]) },
    { threadId: "nested", parentThreadId: "left", createdAt: "2026-07-14T03:00:00Z", sqliteTokens: 200_000, events: events([100_000, 50_000, 30_000, 20_000]) }
  ]);

  assert.equal(byId(result, "root").branchTokens, 200_000);
  assert.equal(byId(result, "left").branchTokens, 30_000);
  assert.equal(byId(result, "right").branchTokens, 40_000);
  assert.equal(byId(result, "nested").branchTokens, 20_000);
  assert.equal(byId(result, "nested").sharedPrefixEvents, 3);
  assert.equal(result.audit.branchTokens, 290_000);
  assert.equal(result.audit.explicitMatches, 3);
});

test("unrelated records are never inferred by default and a missing explicit parent stays untouched", () => {
  const sameHistory = events([60_000, 60_000, 60_000, 60_000, 60_000]);
  const result = deduplicateLineageRecords([
    { threadId: "one", createdAt: "2026-07-14T00:00:00Z", events: sameHistory },
    { threadId: "two", createdAt: "2026-07-14T01:00:00Z", events: sameHistory },
    { threadId: "orphan", parentThreadId: "missing", createdAt: "2026-07-14T02:00:00Z", sqliteTokens: 300_000, events: sameHistory }
  ]);

  assert.equal(byId(result, "two").forkMatchKind, "none");
  assert.equal(byId(result, "two").inheritedTokens, 0);
  assert.equal(byId(result, "orphan").forkMatchKind, "explicit_parent_missing");
  assert.equal(byId(result, "orphan").branchTokens, 300_000);
  assert.equal(result.audit.missingParents, 1);
  assert.equal(result.audit.inferredMatches, 0);
});

test("opt-in inference requires at least five exact states and 100000 inherited tokens", () => {
  const qualifying = events([25_000, 25_000, 25_000, 25_000, 25_000]);
  const belowEventThreshold = events([50_000, 50_000, 50_000, 50_000]);
  const belowTokenThreshold = events([10_000, 10_000, 10_000, 10_000, 10_000]);
  const notExact = events([25_000, 25_000, 25_000, 24_999, 25_001, 10_000]);
  const result = deduplicateLineageRecords([
    { threadId: "parent", createdAt: "2026-07-14T00:00:00Z", events: qualifying },
    { threadId: "inferred", createdAt: "2026-07-14T01:00:00Z", events: [...qualifying, ...events([30_000], "2026-07-15")] },
    { threadId: "short-parent", createdAt: "2026-07-14T02:00:00Z", events: belowEventThreshold },
    { threadId: "short-copy", createdAt: "2026-07-14T03:00:00Z", events: belowEventThreshold },
    { threadId: "small-parent", createdAt: "2026-07-14T04:00:00Z", events: belowTokenThreshold },
    { threadId: "small-copy", createdAt: "2026-07-14T05:00:00Z", events: belowTokenThreshold },
    { threadId: "not-exact", createdAt: "2026-07-14T06:00:00Z", events: notExact }
  ], { inferUnlinked: true });

  assert.equal(byId(result, "inferred").forkMatchKind, "inferred_exact_prefix");
  assert.equal(byId(result, "inferred").forkParentThreadId, "parent");
  assert.equal(byId(result, "inferred").sharedPrefixEvents, 5);
  assert.equal(byId(result, "inferred").branchTokens, 30_000);
  assert.equal(byId(result, "short-copy").forkMatchKind, "none");
  assert.equal(byId(result, "small-copy").forkMatchKind, "none");
  assert.equal(byId(result, "not-exact").forkMatchKind, "none");
  assert.equal(result.audit.inferredMatches, 1);
  assert.deepEqual(result.audit.inference, {
    enabled: true,
    minPrefixEvents: 5,
    minInheritedTokens: 100_000
  });
});

test("provided cumulative states are preserved while missing states are rebuilt from deltas", () => {
  const first = usage(100_000, 20_000, 10_000, 5_000);
  const secondDelta = usage(50_000, 10_000, 5_000, 2_000);
  const secondCumulative = {
    input_tokens: first.input_tokens + secondDelta.input_tokens,
    cached_input_tokens: first.cached_input_tokens + secondDelta.cached_input_tokens,
    output_tokens: first.output_tokens + secondDelta.output_tokens,
    reasoning_output_tokens: first.reasoning_output_tokens + secondDelta.reasoning_output_tokens,
    total_tokens: 150_000
  };
  const result = deduplicateLineageRecords([{
    threadId: "mixed",
    events: [
      { usageSplit: first, cumulativeUsage: first },
      { usageSplit: secondDelta, cumulativeUsage: secondCumulative },
      { usageSplit: usage(25_000) }
    ]
  }]);
  const record = byId(result, "mixed");
  assert.equal(record.rawEvents[1].usageStateId, usageStateId(secondCumulative));
  assert.equal(record.rawEvents[2].cumulativeUsage.total_tokens, 175_000);
  assert.equal(record.rawUsageSplit.total_tokens, 175_000);
});
