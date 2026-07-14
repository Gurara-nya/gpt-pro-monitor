"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregateSplitCost,
  capTelemetryEvents,
  codexUsageSplitCoverage,
  deviceBreakdownForPeriod
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
