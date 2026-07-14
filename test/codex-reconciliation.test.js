"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  aggregateSplitCost,
  capTelemetryEvents,
  codexUsageSplitCoverage
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
