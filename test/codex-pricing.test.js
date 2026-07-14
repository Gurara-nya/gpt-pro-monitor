"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estimateSplitCost,
  estimateTotalTokenRange,
  normalizeModelKey,
  normalizePricingOverrides,
  resolvePricing
} = require("../lib/codex-pricing");

test("GPT-5.6 model aliases resolve to the dated official catalog", () => {
  assert.equal(normalizeModelKey("openai/gpt-5.6-sol-2026-07"), "gpt-5.6-sol");
  assert.deepEqual(
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((model) => {
      const price = resolvePricing(model, "2026-07-14");
      return [price.input, price.cachedInput, price.output];
    }),
    [[5, 0.5, 30], [2.5, 0.25, 15], [1, 0.1, 6]]
  );
});

test("cached input is removed from uncached input and reasoning is not charged twice", () => {
  const cost = estimateSplitCost({
    input_tokens: 200_000,
    cached_input_tokens: 80_000,
    output_tokens: 100_000,
    reasoning_output_tokens: 80_000,
    total_tokens: 300_000
  }, "gpt-5.6-luna");
  assert.ok(Math.abs(cost.midpoint - 0.728) < 1e-12);
  assert.equal(cost.pricedTokens, 300_000);
});

test("GPT-5.6 requests over 272k input use 2x input and 1.5x output", () => {
  const cost = estimateSplitCost({
    input_tokens: 300_000,
    cached_input_tokens: 0,
    output_tokens: 100_000,
    total_tokens: 400_000
  }, "gpt-5.6-terra");
  assert.equal(cost.longContext, true);
  assert.equal(cost.midpoint, 3.75);
});

test("custom prices apply by model and effective date", () => {
  const overrides = normalizePricingOverrides([
    { model: "gpt-5.6-luna", input: 2, cachedInput: 0.2, output: 8, effectiveDate: "2026-07-10" },
    { model: "gpt-5.6-luna", input: 3, cachedInput: 0.3, output: 9, effectiveDate: "2026-08-01" }
  ]);
  assert.equal(resolvePricing("gpt-5.6-luna", "2026-07-14", overrides).input, 2);
  assert.equal(resolvePricing("gpt-5.6-luna", "2026-08-02", overrides).input, 3);
});

test("total-only estimates return a range and unknown models stay unpriced", () => {
  const range = estimateTotalTokenRange(1_000_000, "gpt-5.6-terra");
  assert.deepEqual([range.low, range.high], [0.25, 15]);
  assert.equal(estimateTotalTokenRange(1000, "private-model"), null);
});
