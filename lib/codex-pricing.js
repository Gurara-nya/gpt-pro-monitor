"use strict";

const PRICE_CATALOG_VERSION = "2026-07-14";
const LONG_CONTEXT_THRESHOLD = 272000;

const OFFICIAL_PRICING_USD_PER_MILLION = Object.freeze({
  "gpt-5.6-sol": { input: 5, cachedInput: 0.5, output: 30, effectiveDate: "2026-07-14", longContext: true },
  "gpt-5.6-terra": { input: 2.5, cachedInput: 0.25, output: 15, effectiveDate: "2026-07-14", longContext: true },
  "gpt-5.6-luna": { input: 1, cachedInput: 0.1, output: 6, effectiveDate: "2026-07-14", longContext: true },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30, effectiveDate: "2026-05-24" },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15, effectiveDate: "2026-05-24" },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5, effectiveDate: "2026-05-24" },
  "gpt-5.4-nano": { input: 0.2, cachedInput: 0.02, output: 1.25, effectiveDate: "2026-05-24" },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14, effectiveDate: "2026-05-24" },
  "gpt-5.2-codex": { input: 1.75, cachedInput: 0.175, output: 14, effectiveDate: "2026-05-24" },
  "gpt-5.1-codex": { input: 1.25, cachedInput: 0.125, output: 10, effectiveDate: "2026-05-24" },
  "gpt-5-codex": { input: 1.25, cachedInput: 0.125, output: 10, effectiveDate: "2026-05-24" },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14, effectiveDate: "2026-05-24" },
  "gpt-5.1": { input: 1.25, cachedInput: 0.125, output: 10, effectiveDate: "2026-05-24" },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10, effectiveDate: "2026-05-24" },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2, effectiveDate: "2026-05-24" },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4, effectiveDate: "2026-05-24" }
});

function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizeModelKey(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
  if (!raw) return "";
  for (const key of [
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-5.5", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4",
    "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex", "gpt-5-codex",
    "gpt-5.2", "gpt-5.1", "gpt-5-mini", "gpt-5-nano"
  ]) {
    if (raw.includes(key) || (key === "gpt-5.1-codex" && raw.includes("gpt-5.1-codex-max"))) return key;
  }
  if (raw === "gpt-5" || raw.startsWith("gpt-5-")) return "gpt-5";
  return raw;
}

function normalizePricingOverrides(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 100).map((item) => {
    const model = normalizeModelKey(item?.model);
    const effectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(String(item?.effectiveDate || ""))
      ? String(item.effectiveDate)
      : "1970-01-01";
    return {
      model,
      input: nonnegative(item?.input),
      cachedInput: nonnegative(item?.cachedInput ?? item?.cached_input),
      output: nonnegative(item?.output),
      effectiveDate
    };
  }).filter((item) => item.model && item.input && item.output)
    .sort((left, right) => left.model.localeCompare(right.model) || left.effectiveDate.localeCompare(right.effectiveDate));
}

function resolvePricing(modelValue, at, overrides = []) {
  const model = normalizeModelKey(modelValue);
  const day = String(at || "9999-12-31").slice(0, 10);
  const official = OFFICIAL_PRICING_USD_PER_MILLION[model];
  const candidates = normalizePricingOverrides(overrides)
    .filter((item) => item.model === model && item.effectiveDate <= day);
  const override = candidates.at(-1);
  if (override) return { ...override, longContext: Boolean(official?.longContext), source: "custom" };
  return official ? { ...official, source: "official" } : null;
}

function estimateSplitCost(usage, modelValue, options = {}) {
  const input = nonnegative(usage?.input_tokens);
  const cachedInput = Math.min(nonnegative(usage?.cached_input_tokens), input);
  const uncachedInput = Math.max(0, input - cachedInput);
  const output = nonnegative(usage?.output_tokens);
  const pricedTokens = input + output;
  const pricing = resolvePricing(modelValue, options.at, options.overrides);
  if (!pricedTokens || !pricing) return null;
  const longContext = Boolean(pricing.longContext && input > LONG_CONTEXT_THRESHOLD);
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const inputCost = uncachedInput / 1_000_000 * pricing.input * inputMultiplier;
  const cachedInputCost = cachedInput / 1_000_000 * (pricing.cachedInput || pricing.input) * inputMultiplier;
  const outputCost = output / 1_000_000 * pricing.output * outputMultiplier;
  const total = inputCost + cachedInputCost + outputCost;
  return {
    model: normalizeModelKey(modelValue),
    rates: pricing,
    low: total,
    high: total,
    midpoint: total,
    pricedTokens,
    unpricedTokens: 0,
    components: {
      input_usd: inputCost,
      cached_input_usd: cachedInputCost,
      output_usd: outputCost
    },
    exact: true,
    longContext,
    basis: longContext ? "split_token_usage_long_context" : "split_token_usage"
  };
}

function estimateTotalTokenRange(tokensValue, modelValue, options = {}) {
  const tokens = nonnegative(tokensValue);
  const pricing = resolvePricing(modelValue, options.at, options.overrides);
  if (!tokens || !pricing) return null;
  const low = tokens / 1_000_000 * Math.min(pricing.input, pricing.cachedInput || pricing.input);
  let high = tokens / 1_000_000 * pricing.output;
  if (pricing.longContext && tokens > LONG_CONTEXT_THRESHOLD) {
    const thresholdInput = Math.min(tokens, LONG_CONTEXT_THRESHOLD + 1);
    const remainingOutput = Math.max(0, tokens - thresholdInput);
    const mixedLongContextHigh = thresholdInput / 1_000_000 * pricing.input * 2 +
      remainingOutput / 1_000_000 * pricing.output * 1.5;
    const allInputLongContextHigh = tokens / 1_000_000 * pricing.input * 2;
    high = Math.max(high, mixedLongContextHigh, allInputLongContextHigh);
  }
  return {
    model: normalizeModelKey(modelValue),
    rates: pricing,
    low,
    high,
    midpoint: (low + high) / 2,
    pricedTokens: tokens,
    unpricedTokens: 0,
    exact: false,
    basis: pricing.longContext && tokens > LONG_CONTEXT_THRESHOLD
      ? "estimated_total_tokens_range_long_context"
      : "estimated_total_tokens_range"
  };
}

module.exports = {
  LONG_CONTEXT_THRESHOLD,
  OFFICIAL_PRICING_USD_PER_MILLION,
  PRICE_CATALOG_VERSION,
  estimateSplitCost,
  estimateTotalTokenRange,
  normalizeModelKey,
  normalizePricingOverrides,
  resolvePricing
};
