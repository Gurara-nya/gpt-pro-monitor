"use strict";

const SESSION_SORTS = new Set([
  "tokens_desc",
  "cost_desc",
  "updated_desc",
  "created_desc"
]);

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nonnegativeNumber(value) {
  return Math.max(0, finiteNumber(value));
}

function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.min(number, max);
}

function normalizeSessionQuery(input = {}) {
  const requestedMonth = String(input.month || "all").trim();
  return {
    q: String(input.q || "").trim().slice(0, 200),
    month: /^\d{4}-\d{2}$/.test(requestedMonth) ? requestedMonth : "all",
    sort: SESSION_SORTS.has(input.sort) ? input.sort : "tokens_desc",
    page: positiveInteger(input.page, 1),
    pageSize: positiveInteger(input.pageSize, 20, 50)
  };
}

function sessionSearchText(session) {
  return [
    session?.title,
    session?.id,
    session?.cwd,
    session?.model,
    session?.provider,
    session?.source,
    session?.day,
    session?.month
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function dateValue(session, key) {
  const timestamp = new Date(session?.[key] || "").getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sessionCostValue(session) {
  const estimate = session?.cost_estimate || {};
  return finiteNumber(estimate.midpoint_usd ?? estimate.high_usd ?? estimate.low_usd);
}

function sessionTokenValue(session) {
  return nonnegativeNumber(session?.tokens ?? session?.usage_split?.total_tokens);
}

function stableFallback(left, right) {
  return sessionTokenValue(right) - sessionTokenValue(left) ||
    dateValue(right, "updated_at") - dateValue(left, "updated_at") ||
    String(left?.id || "").localeCompare(String(right?.id || ""));
}

function sortSessions(sessions, sort) {
  return sessions.slice().sort((left, right) => {
    if (sort === "cost_desc") {
      return sessionCostValue(right) - sessionCostValue(left) || stableFallback(left, right);
    }
    if (sort === "updated_desc") {
      return dateValue(right, "updated_at") - dateValue(left, "updated_at") || stableFallback(left, right);
    }
    if (sort === "created_desc") {
      return dateValue(right, "created_at") - dateValue(left, "created_at") || stableFallback(left, right);
    }
    return stableFallback(left, right);
  });
}

function summarizeSessions(sessions) {
  const usageSplit = Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
  const costEstimate = {
    low_usd: 0,
    high_usd: 0,
    midpoint_usd: 0,
    priced_tokens: 0,
    unpriced_tokens: 0
  };
  let pricedSessions = 0;

  for (const session of sessions) {
    for (const key of USAGE_KEYS.filter((item) => item !== "total_tokens")) {
      usageSplit[key] += nonnegativeNumber(session?.usage_split?.[key]);
    }
    const splitTotal = nonnegativeNumber(session?.usage_split?.total_tokens);
    usageSplit.total_tokens += splitTotal || sessionTokenValue(session);
    const estimate = session?.cost_estimate;
    if (!estimate) continue;
    pricedSessions += 1;
    for (const key of Object.keys(costEstimate)) {
      costEstimate[key] += nonnegativeNumber(estimate[key]);
    }
  }

  return {
    sessions: sessions.length,
    usage_split: usageSplit,
    cost_estimate: pricedSessions ? { ...costEstimate, priced_sessions: pricedSessions } : null
  };
}

function querySessions(sessions, input = {}) {
  const query = normalizeSessionQuery(input);
  const source = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const months = [...new Set(source.map((session) => session.month).filter((month) => /^\d{4}-\d{2}$/.test(month)))]
    .sort()
    .reverse();
  const needles = query.q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matched = source.filter((session) => {
    if (query.month !== "all" && session.month !== query.month) return false;
    if (!needles.length) return true;
    const searchText = sessionSearchText(session);
    return needles.every((needle) => searchText.includes(needle));
  });
  const sorted = sortSessions(matched, query.sort);
  const totalItems = sorted.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / query.pageSize));
  const page = Math.min(query.page, totalPages);
  const start = (page - 1) * query.pageSize;

  return {
    query: { ...query, page },
    items: sorted.slice(start, start + query.pageSize),
    months,
    summary: summarizeSessions(matched),
    pagination: {
      page,
      pageSize: query.pageSize,
      totalItems,
      totalPages
    }
  };
}

module.exports = {
  SESSION_SORTS,
  normalizeSessionQuery,
  querySessions,
  sortSessions,
  summarizeSessions
};
