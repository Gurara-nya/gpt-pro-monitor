"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeSessionQuery,
  querySessions,
  summarizeSessions
} = require("../lib/session-query");

function session(overrides = {}) {
  const tokens = overrides.tokens ?? 100;
  return {
    id: overrides.id || "session-a",
    title: overrides.title || "Alpha telemetry",
    cwd: overrides.cwd || "F:/workspace/alpha",
    model: overrides.model || "gpt-5.1-codex",
    provider: overrides.provider || "openai",
    source: overrides.source || "codex",
    month: overrides.month || "2026-07",
    day: overrides.day || "2026-07-10",
    created_at: overrides.created_at || "2026-07-10T01:00:00.000Z",
    updated_at: overrides.updated_at || "2026-07-10T02:00:00.000Z",
    tokens,
    usage_split: overrides.usage_split || {
      input_tokens: Math.floor(tokens * 0.7),
      cached_input_tokens: Math.floor(tokens * 0.2),
      output_tokens: Math.floor(tokens * 0.3),
      reasoning_output_tokens: 0,
      total_tokens: tokens
    },
    cost_estimate: overrides.cost_estimate === undefined ? {
      low_usd: tokens / 2000,
      high_usd: tokens / 1000,
      midpoint_usd: tokens / 1500,
      priced_tokens: tokens,
      unpriced_tokens: 0
    } : overrides.cost_estimate
  };
}

const sessions = [
  session({ id: "alpha", tokens: 100, title: "Alpha monitor" }),
  session({
    id: "beta",
    tokens: 300,
    title: "Beta analysis",
    cwd: "F:/workspace/beta",
    created_at: "2026-07-09T01:00:00.000Z",
    updated_at: "2026-07-12T02:00:00.000Z",
    cost_estimate: { low_usd: 0.03, high_usd: 0.05, midpoint_usd: 0.04, priced_tokens: 300 }
  }),
  session({
    id: "gamma",
    tokens: 200,
    title: "Gamma report",
    cwd: "F:/workspace/gamma",
    month: "2026-06",
    day: "2026-06-28",
    created_at: "2026-06-28T01:00:00.000Z",
    updated_at: "2026-06-29T02:00:00.000Z",
    provider: "sub2api",
    cost_estimate: { low_usd: 0.3, high_usd: 0.4, midpoint_usd: 0.35, priced_tokens: 200 }
  })
];

test("normalizes invalid query values and caps page size", () => {
  assert.deepEqual(normalizeSessionQuery({
    q: "  alpha  ",
    month: "July",
    sort: "unknown",
    page: -2,
    pageSize: 999
  }), {
    q: "alpha",
    month: "all",
    sort: "tokens_desc",
    page: 1,
    pageSize: 50
  });
});

test("searches across multiple fields with all query terms", () => {
  const result = querySessions(sessions, { q: "alpha gpt-5.1", pageSize: 10 });
  assert.deepEqual(result.items.map((item) => item.id), ["alpha"]);
  assert.equal(querySessions(sessions, { q: "sub2api gamma" }).pagination.totalItems, 1);
  assert.equal(querySessions(sessions, { q: "missing" }).pagination.totalItems, 0);
});

test("filters months and returns descending month facets", () => {
  const result = querySessions(sessions, { month: "2026-07" });
  assert.equal(result.pagination.totalItems, 2);
  assert.deepEqual(result.months, ["2026-07", "2026-06"]);
});

test("supports every session sort", () => {
  assert.deepEqual(querySessions(sessions, { sort: "tokens_desc" }).items.map((item) => item.id), ["beta", "gamma", "alpha"]);
  assert.deepEqual(querySessions(sessions, { sort: "cost_desc" }).items.map((item) => item.id), ["gamma", "alpha", "beta"]);
  assert.deepEqual(querySessions(sessions, { sort: "updated_desc" }).items.map((item) => item.id), ["beta", "alpha", "gamma"]);
  assert.deepEqual(querySessions(sessions, { sort: "created_desc" }).items.map((item) => item.id), ["alpha", "beta", "gamma"]);
});

test("clamps pagination and returns a stable page", () => {
  const result = querySessions(sessions, { page: 9, pageSize: 2 });
  assert.deepEqual(result.pagination, { page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });
  assert.deepEqual(result.items.map((item) => item.id), ["alpha"]);
});

test("summarizes matching token splits and estimated cost", () => {
  const summary = summarizeSessions(sessions.slice(0, 2));
  assert.equal(summary.sessions, 2);
  assert.equal(summary.usage_split.total_tokens, 400);
  assert.equal(summary.usage_split.input_tokens, 280);
  assert.equal(summary.cost_estimate.priced_sessions, 2);
  assert.equal(summary.cost_estimate.priced_tokens, 400);
});

test("handles empty sessions and token fallbacks", () => {
  assert.deepEqual(querySessions([], {}).pagination, {
    page: 1,
    pageSize: 20,
    totalItems: 0,
    totalPages: 1
  });
  const fallback = summarizeSessions([session({
    id: "fallback",
    tokens: 42,
    usage_split: {},
    cost_estimate: null
  })]);
  assert.equal(fallback.usage_split.total_tokens, 42);
  assert.equal(fallback.cost_estimate, null);
});
