"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const {
  aggregateSplitCost,
  attributeLocalSessions,
  capTelemetryEvents,
  codexUsageSplitCoverage,
  compactDeviceDailyByMonth,
  deviceBreakdownForPeriod,
  mergeDeviceState,
  reconcileCodexUsageDetails,
  reconcileRemoteDeviceUsage
} = require("../server");

function usage(input, output, cached = 0, reasoning = 0) {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output
  };
}

function remoteStateId(value) {
  const state = [
    value.input_tokens,
    value.cached_input_tokens,
    value.output_tokens,
    value.reasoning_output_tokens,
    value.total_tokens
  ].join(":");
  return createHash("sha256").update(state).digest("hex");
}

test("SQLite control total caps over-counted telemetry while preserving split invariants", () => {
  const events = [
    { usageSplit: usage(80, 20, 30, 10) },
    { usageSplit: usage(60, 40, 20, 30) }
  ];
  const capped = capTelemetryEvents(events, 150);
  assert.equal(capped.reduce((sum, event) => sum + event.usageSplit.total_tokens, 0), 150);
  assert.equal(capped[1].usageSplit.input_tokens + capped[1].usageSplit.output_tokens, 50);
  assert.ok(capped[1].usageSplit.cached_input_tokens <= capped[1].usageSplit.input_tokens);
  assert.ok(capped[1].usageSplit.reasoning_output_tokens <= capped[1].usageSplit.output_tokens);
});

test("fork inheritance is removed from both telemetry and the SQLite control total", () => {
  const rootEvent = {
    threadId: "root",
    threadHash: "r".repeat(64),
    at: "2026-07-14T00:00:00Z",
    day: "2026-07-14",
    month: "2026-07",
    model: "gpt-5.6-luna",
    modelKey: "gpt-5.6-luna",
    sourceLabel: "Codex",
    usageSplit: usage(120_000, 30_000, 50_000, 10_000)
  };
  const branchEvent = {
    ...rootEvent,
    threadId: "child",
    threadHash: "c".repeat(64),
    usageSplit: usage(24_000, 6_000, 10_000, 2_000)
  };
  const records = [
    {
      threadId: "root",
      events: [rootEvent],
      usageSplit: rootEvent.usageSplit,
      inheritedTokens: 0,
      sharedPrefixEvents: 0
    },
    {
      threadId: "child",
      events: [branchEvent],
      usageSplit: branchEvent.usageSplit,
      inheritedTokens: 150_000,
      sharedPrefixEvents: 5,
      forkParentThreadId: "root",
      forkMatchKind: "explicit_parent"
    }
  ];
  const report = {
    summary: { threads: 2, total_tokens: 330_000 },
    sessions: [
      { id: "root", tokens: 150_000, created: "2026-07-14", model: "gpt-5.6-luna", source: "Codex" },
      { id: "child", tokens: 180_000, created: "2026-07-14", model: "gpt-5.6-luna", source: "Codex" }
    ],
    models: [], sources: [], daily: [], monthly: [], month_views: []
  };
  const reconciled = reconcileCodexUsageDetails(report, {
    records,
    byThreadId: new Map(records.map((record) => [record.threadId, record])),
    total: { records: [rootEvent, branchEvent], usageSplit: usage(144_000, 36_000, 60_000, 12_000) },
    byMonth: new Map(), byDay: new Map(), byModel: new Map(), bySource: new Map(),
    coverage: {}, pricingOverrides: [],
    lineageAudit: { matchedForks: 1, explicitMatches: 1, sharedPrefixEvents: 5 }
  });
  const child = reconciled.byThreadId.get("child");
  assert.equal(child.rawSqliteTokens, 180_000);
  assert.equal(child.inheritedTokens, 150_000);
  assert.equal(child.sqliteTokens, 30_000);
  assert.equal(child.exactTokens, 30_000);
  assert.equal(child.estimatedTokens, 0);
  assert.equal(report.summary.total_tokens, 180_000);
  assert.equal(report.token_audit.shared_history_tokens_excluded, 150_000);
});

test("remote fork prefixes are assigned to the ancestor while branch additions stay on the device", () => {
  const rootHash = "a".repeat(64);
  const childHash = "b".repeat(64);
  const deltas = Array.from({ length: 5 }, (_, index) => ({
    at: `2026-07-14T00:0${index}:00Z`,
    usageSplit: usage(20_000, 5_000, 10_000, 1_000)
  }));
  const remote = [
    ...deltas.map((event, index) => {
      const cumulative = usage(20_000 * (index + 1), 5_000 * (index + 1), 10_000 * (index + 1), 1_000 * (index + 1));
      return {
      ...event,
      eventId: String(index).padStart(64, "0"),
      threadHash: childHash,
      parentThreadHash: rootHash,
      usageStateId: remoteStateId(cumulative),
      cumulativeTotalTokens: cumulative.total_tokens,
      registryOrder: 5 - index,
      deviceId: "remote",
      model: "gpt-5.6-luna",
      provider: "openai",
      sourceLabel: "Remote",
      day: "2026-07-14",
      month: "2026-07"
      };
    }).reverse(),
    {
      eventId: "f".repeat(64), threadHash: childHash, parentThreadHash: rootHash, deviceId: "remote",
      at: "2026-07-14T01:00:00Z", day: "2026-07-14", month: "2026-07",
      model: "gpt-5.6-luna", provider: "openai", sourceLabel: "Remote",
      usageStateId: remoteStateId(usage(124_000, 31_000, 62_000, 7_000)),
      cumulativeTotalTokens: 155_000,
      registryOrder: 6,
      usageSplit: usage(24_000, 6_000, 12_000, 2_000)
    }
  ];
  const result = reconcileRemoteDeviceUsage(
    remote,
    [{ threadHash: childHash, parentThreadHash: rootHash, deviceId: "remote", totalTokens: 155_000,
      updatedAt: "2026-07-14T01:00:00Z", model: "gpt-5.6-luna", provider: "openai" }],
    [{ threadId: "root", threadHash: rootHash, createdAt: "2026-07-13T00:00:00Z", rawEvents: deltas }],
    [],
    new Map([["remote", { id: "remote", name: "Remote" }]])
  );
  assert.equal(result.audit.sharedHistoryTokens, 125_000);
  assert.equal(result.audit.explicitForkThreads, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].usageSplit.total_tokens, 30_000);
});

test("a remote copy of the same local fork thread cannot restore its inherited prefix", () => {
  const rootHash = "1".repeat(64);
  const childHash = "2".repeat(64);
  const deltas = Array.from({ length: 5 }, (_, index) => {
    const cumulative = usage(20_000 * (index + 1), 5_000 * (index + 1), 10_000 * (index + 1), 1_000 * (index + 1));
    return {
      eventId: createHash("sha256").update(`${childHash}:${index}`).digest("hex"),
      threadId: childHash,
      threadHash: childHash,
      at: `2026-07-14T00:0${index}:00Z`,
      cumulativeUsage: cumulative,
      usageSplit: usage(20_000, 5_000, 10_000, 1_000)
    };
  });
  const parentEvents = deltas.map((event) => ({
    ...event,
    eventId: createHash("sha256").update(`${rootHash}:${event.at}`).digest("hex"),
    threadId: rootHash,
    threadHash: rootHash
  }));
  const remoteCopy = deltas.map((event, index) => ({
    ...event,
    parentThreadHash: rootHash,
    usageStateId: remoteStateId(event.cumulativeUsage),
    cumulativeTotalTokens: event.cumulativeUsage.total_tokens,
    registryOrder: index,
    deviceId: "remote",
    model: "gpt-5.6-luna",
    provider: "openai",
    day: "2026-07-14",
    month: "2026-07"
  }));

  const result = reconcileRemoteDeviceUsage(
    remoteCopy,
    [{ threadHash: childHash, parentThreadHash: rootHash, deviceId: "remote", totalTokens: 125_000,
      updatedAt: "2026-07-14T01:00:00Z", model: "gpt-5.6-luna", provider: "openai" }],
    [
      { threadId: rootHash, threadHash: rootHash, createdAt: "2026-07-13T00:00:00Z", rawEvents: parentEvents },
      { threadId: childHash, threadHash: childHash, parentThreadId: rootHash,
        createdAt: "2026-07-14T00:00:00Z", rawEvents: deltas }
    ],
    [],
    new Map([["remote", { id: "remote", name: "Remote" }]])
  );

  assert.equal(result.records.length, 0);
  assert.equal(result.audit.netTokens, 0);
});

test("a remote-owned event replaces the same local lineage reference", () => {
  const threadHash = "6".repeat(64);
  const eventId = "7".repeat(64);
  const split = usage(80, 20, 30, 5);
  const cumulative = usage(80, 20, 30, 5);
  const localReference = {
    eventId,
    threadId: threadHash,
    threadHash,
    at: "2026-07-14T00:00:00Z",
    cumulativeUsage: cumulative,
    usageSplit: split
  };
  const remote = {
    ...localReference,
    deviceId: "remote",
    usageStateId: remoteStateId(cumulative),
    cumulativeTotalTokens: cumulative.total_tokens,
    model: "gpt-5.6-luna",
    provider: "openai",
    day: "2026-07-14",
    month: "2026-07"
  };

  const result = reconcileRemoteDeviceUsage(
    [remote],
    [],
    [{ threadId: threadHash, threadHash, rawEvents: [localReference] }],
    [],
    new Map([["remote", { id: "remote", name: "Remote" }]])
  );

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].deviceId, "remote");
  assert.equal(result.records[0].usageSplit.total_tokens, 100);
  assert.equal(result.audit.netTokens, 100);
});

test("a remote SQLite-only snapshot remains visible as an estimated gap", () => {
  const threadHash = "3".repeat(64);
  const result = reconcileRemoteDeviceUsage(
    [],
    [{ threadHash, deviceId: "remote", totalTokens: 420_000,
      updatedAt: "2026-07-14T03:00:00Z", model: "gpt-5.6-terra", provider: "openai" }],
    [],
    [],
    new Map([["remote", { id: "remote", name: "Remote" }]])
  );

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].estimated, true);
  assert.equal(result.records[0].usageSplit.total_tokens, 420_000);
  assert.equal(result.records[0].day, "2026-07-14");
  assert.equal(result.audit.netTokens, 420_000);
});

test("a remote SQLite-only continuation keeps only the amount beyond local exact telemetry", () => {
  const threadHash = "8".repeat(64);
  const localUsage = usage(80_000, 20_000, 30_000, 5_000);
  const result = reconcileRemoteDeviceUsage(
    [],
    [{ threadHash, deviceId: "remote", totalTokens: 150_000,
      updatedAt: "2026-07-14T03:00:00Z", model: "gpt-5.6-terra", provider: "openai" }],
    [{ threadId: threadHash, threadHash, rawEvents: [{
      eventId: "9".repeat(64),
      at: "2026-07-14T02:00:00Z",
      cumulativeUsage: localUsage,
      usageSplit: localUsage
    }] }],
    [],
    new Map([["remote", { id: "remote", name: "Remote" }]])
  );

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].estimated, true);
  assert.equal(result.records[0].usageSplit.total_tokens, 50_000);
  assert.equal(result.audit.netTokens, 50_000);
});

test("legacy remote fork batches use event time when registry order is reversed", () => {
  const parentHash = "4".repeat(64);
  const childHash = "5".repeat(64);
  const makeEvents = (threadHash, parentThreadHash, day, orderOffset) => Array.from({ length: 5 }, (_, index) => ({
    eventId: createHash("sha256").update(`${threadHash}:${index}`).digest("hex"),
    threadHash,
    parentThreadHash,
    deviceId: "remote",
    at: `${day}T00:0${index}:00Z`,
    day,
    month: "2026-07",
    model: "gpt-5.6-luna",
    provider: "openai",
    sourceLabel: "Remote",
    registryOrder: orderOffset + (4 - index),
    usageSplit: usage(20_000, 5_000, 10_000, 1_000)
  })).reverse();
  const records = [
    ...makeEvents(parentHash, "", "2026-07-13", 0),
    ...makeEvents(childHash, parentHash, "2026-07-14", 10)
  ];

  const result = reconcileRemoteDeviceUsage(
    records,
    [],
    [],
    [],
    new Map([["remote", { id: "remote", name: "Remote" }]])
  );

  assert.equal(result.audit.rawTelemetryTokens, 250_000);
  assert.equal(result.audit.sharedHistoryTokens, 125_000);
  assert.equal(result.audit.netTokens, 125_000);
  assert.equal(result.audit.explicitForkThreads, 1);
});

test("mixed exact and SQLite-only usage combines exact cost with a model range", () => {
  const estimate = aggregateSplitCost([
    { model: "gpt-5.6-luna", at: "2026-07-14", usageSplit: usage(100_000, 10_000, 40_000, 5_000) },
    {
      model: "gpt-5.6-luna",
      at: "2026-07-14",
      estimated: true,
      tokens: 200_000,
      usageSplit: { ...usage(0, 0), total_tokens: 200_000 }
    }
  ]);
  assert.equal(estimate.basis, "mixed_exact_and_estimated");
  assert.equal(estimate.estimated_tokens, 200_000);
  assert.equal(estimate.priced_tokens, 310_000);
  assert.ok(estimate.high_usd > estimate.low_usd);
});

test("cost aggregation keeps raw event precision until the final display rounding", () => {
  const records = Array.from({ length: 100 }, () => ({
    model: "gpt-5.6-luna",
    at: "2026-07-14",
    usageSplit: usage(0, 1)
  }));
  const estimate = aggregateSplitCost(records);
  assert.equal(estimate.midpoint_usd, 0.0006);
  assert.equal(estimate.components.output_usd, 0.0006);
  assert.equal(estimate.low_usd, estimate.components.input_usd + estimate.components.cached_input_usd + estimate.components.output_usd);
});

test("unpriced usage is never marked exact just because both cost bounds are zero", () => {
  const estimate = aggregateSplitCost([{
    model: "private-model",
    at: "2026-07-14",
    usageSplit: usage(100, 20)
  }]);
  assert.equal(estimate.low_usd, 0);
  assert.equal(estimate.high_usd, 0);
  assert.equal(estimate.unpriced_tokens, 120);
  assert.equal(estimate.exact, false);
  assert.equal(estimate.display, "未定价");
});

test("coverage distinguishes parsed, priced, unparsed and unpriced tokens", () => {
  const exact = { model: "gpt-5.6-luna", usageSplit: usage(80, 20), at: "2026-07-14" };
  const estimated = {
    model: "gpt-5.6-luna",
    estimated: true,
    tokens: 100,
    usageSplit: { ...usage(0, 0), total_tokens: 100 },
    at: "2026-07-14"
  };
  const coverage = codexUsageSplitCoverage({
    records: [],
    coverage: { split_tokens: 100, split_threads: 1 },
    total: { records: [exact, estimated] }
  }, 200);
  assert.equal(coverage.split_coverage_percent, 50);
  assert.equal(coverage.priced_coverage_percent, 100);
  assert.equal(coverage.unparsed_tokens, 100);
  assert.equal(coverage.unpriced_tokens, 0);
});

test("device breakdown uses the selected month denominator and monthly coverage", () => {
  const devices = [{ id: "local", name: "Local" }, { id: "remote", name: "Remote" }];
  const cost = (tokens) => ({ midpoint_usd: tokens / 10, midpoint_display: `$${tokens / 10}` });
  const views = {
    local: {
      summary: { total_tokens: 70, usage_split: usage(60, 10), cost_estimate: cost(70) },
      month_views: [{ month: "2026-07", tokens: 20, usage_split: usage(15, 5), cost_estimate: cost(20) }]
    },
    remote: {
      summary: { total_tokens: 30, usage_split: usage(20, 10), cost_estimate: cost(30) },
      month_views: [{ month: "2026-07", tokens: 40, usage_split: usage(30, 10), cost_estimate: cost(40) }]
    }
  };
  const allView = {
    summary: { total_tokens: 100, cost_estimate: cost(100) },
    month_views: [{ month: "2026-07", tokens: 60, cost_estimate: cost(60) }]
  };
  const records = new Map([
    ["local", [{ month: "2026-07", usageSplit: usage(15, 5) }]],
    ["remote", [
      { month: "2026-07", usageSplit: usage(20, 10) },
      { month: "2026-07", estimated: true, usageSplit: usage(10, 0) }
    ]]
  ]);

  const cumulative = deviceBreakdownForPeriod(devices, views, records, allView);
  const july = deviceBreakdownForPeriod(devices, views, records, allView, "2026-07");
  assert.deepEqual(cumulative.map((item) => item.share_percent), [70, 30]);
  assert.deepEqual(july.map((item) => item.share_percent), [33.33, 66.67]);
  assert.deepEqual(july.map((item) => item.cost_share_percent), [33.33, 66.67]);
  assert.deepEqual(july.map((item) => item.coverage_percent), [100, 75]);
  assert.equal(july[1].period_month, "2026-07");
});

test("device daily projection keeps one compact series per enabled device and supports filtering", () => {
  const exactCost = (value) => ({
    low_usd: value,
    high_usd: value,
    midpoint_usd: value,
    range_display: `$${value}`,
    components: {
      input_usd: value / 2,
      cached_input_usd: value / 4,
      output_usd: value / 4
    },
    exact: true
  });
  const rangeCost = (low, high) => ({
    low_usd: low,
    high_usd: high,
    midpoint_usd: (low + high) / 2,
    range_display: `$${low}–$${high}`,
    exact: false
  });
  const report = {
    device_breakdown: [
      { id: "local", name: "Workstation", enabled: true, revoked: false, stale: false },
      { id: "remote", name: "Laptop", enabled: true, revoked: false, stale: true },
      { id: "revoked", name: "Old", enabled: false, revoked: true, stale: true }
    ],
    month_views: [{ month: "2026-07" }],
    device_views: {
      local: { month_views: [{ month: "2026-07", days: [
        { day: "2026-07-13", tokens: 30, usage_split: usage(20, 10, 5, 4), cost_estimate: exactCost(0.3) },
        { day: "2026-07-14", tokens: 50, usage_split: usage(35, 15, 10, 6), cost_estimate: exactCost(0.5) }
      ] }] },
      remote: { month_views: [{ month: "2026-07", days: [
        { day: "2026-07-13", tokens: 70, usage_split: usage(50, 20, 20, 8), cost_estimate: exactCost(0.7) },
        { day: "2026-07-14", tokens: 10, usage_split: usage(7, 3, 2, 1), cost_estimate: rangeCost(0.05, 0.15) }
      ] }] },
      revoked: { month_views: [{ month: "2026-07", days: [
        { day: "2026-07-14", tokens: 999 }
      ] }] }
    }
  };

  const all = compactDeviceDailyByMonth(report, "all");
  assert.deepEqual(all["2026-07"].map((series) => series.id), ["local", "remote"]);
  assert.deepEqual(all["2026-07"].map((series) => series.points.map((point) => point.tokens)), [[30, 50], [70, 10]]);
  assert.deepEqual(all["2026-07"][0].points[0].usage, [20, 5, 10]);
  assert.deepEqual(all["2026-07"][1].points[0].cost, [0.7, 0.7, 1]);
  assert.deepEqual(all["2026-07"][1].points[1].cost, [0.05, 0.15, 0]);
  assert.equal(all["2026-07"][1].stale, true);

  const selected = compactDeviceDailyByMonth(report, "remote");
  assert.deepEqual(selected["2026-07"].map((series) => series.id), ["remote"]);
});

test("local session rows are re-attributed after a remote device owns copied events", () => {
  const sessions = [{
    id: "thread-a",
    tokens: 100,
    tokens_display: "100",
    usage_split: usage(80, 20, 20, 5)
  }];
  const attributed = attributeLocalSessions(sessions, [{
    threadId: "thread-a",
    model: "gpt-5.6-luna",
    at: "2026-07-14T00:00:00Z",
    usageSplit: usage(30, 10, 5, 2)
  }]);
  assert.equal(attributed[0].tokens, 40);
  assert.equal(attributed[0].usage_split.total_tokens, 40);
  assert.equal(attributed[0].exact_tokens, 40);
  assert.equal(attributed[0].cost_estimate.exact, true);
});

test("live registration state overrides stale fields from the cached usage report", () => {
  const merged = mergeDeviceState({
    id: "remote",
    name: "Laptop",
    lastSeenAt: "2026-07-14T09:12:00.000Z",
    agentVersion: "2.0.0",
    agentPlatform: "linux",
    agentInstalled: true
  }, {
    id: "remote",
    name: "Old name",
    lastSeenAt: null,
    agentVersion: "",
    agentPlatform: "",
    agentInstalled: false,
    total_tokens: 123
  });
  assert.equal(merged.total_tokens, 123);
  assert.equal(merged.name, "Laptop");
  assert.equal(merged.agentVersion, "2.0.0");
  assert.equal(merged.agentInstalled, true);
});
