"use strict";

const { createHash } = require("node:crypto");

const USAGE_KEYS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

function nonnegativeInteger(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number);
}

function usageValue(usage, snakeName, camelName) {
  if (!usage || typeof usage !== "object") return 0;
  return nonnegativeInteger(usage[snakeName] ?? usage[camelName]);
}

function normalizeUsage(usage) {
  const normalized = {
    input_tokens: usageValue(usage, "input_tokens", "inputTokens"),
    cached_input_tokens: usageValue(usage, "cached_input_tokens", "cachedInputTokens"),
    output_tokens: usageValue(usage, "output_tokens", "outputTokens"),
    reasoning_output_tokens: usageValue(usage, "reasoning_output_tokens", "reasoningOutputTokens"),
    total_tokens: usageValue(usage, "total_tokens", "totalTokens")
  };
  if (normalized.input_tokens || normalized.output_tokens) {
    normalized.total_tokens = normalized.input_tokens + normalized.output_tokens;
  }
  normalized.cached_input_tokens = Math.min(normalized.cached_input_tokens, normalized.input_tokens);
  normalized.reasoning_output_tokens = Math.min(normalized.reasoning_output_tokens, normalized.output_tokens);
  return normalized;
}

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
}

function addUsage(target, source) {
  const normalized = normalizeUsage(source);
  for (const key of USAGE_KEYS) target[key] += normalized[key];
  return target;
}

function subtractUsage(current, previous) {
  const normalizedCurrent = normalizeUsage(current);
  const normalizedPrevious = normalizeUsage(previous);
  const delta = emptyUsage();
  for (const key of USAGE_KEYS) {
    delta[key] = Math.max(0, normalizedCurrent[key] - normalizedPrevious[key]);
  }
  delta.cached_input_tokens = Math.min(delta.cached_input_tokens, delta.input_tokens);
  delta.reasoning_output_tokens = Math.min(delta.reasoning_output_tokens, delta.output_tokens);
  return delta;
}

function usageStateId(usage) {
  const normalized = normalizeUsage(usage);
  return USAGE_KEYS.map((key) => normalized[key]).join(":");
}

function usageStateHash(usage) {
  return createHash("sha256").update(usageStateId(usage)).digest("hex");
}

function cleanThreadId(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractParentThreadId(sessionMetaOrSource) {
  const seen = new WeakSet();

  function visit(value, depth = 0) {
    if (!value || depth > 6) return "";
    if (typeof value === "string") {
      const parsed = parseJsonObject(value);
      return parsed ? visit(parsed, depth + 1) : "";
    }
    if (typeof value !== "object") return "";
    if (seen.has(value)) return "";
    seen.add(value);

    const direct = [
      value.forked_from_id,
      value.forkedFromId,
      value.parent_thread_id,
      value.parentThreadId
    ].map(cleanThreadId).find(Boolean) || "";
    if (direct) return direct;

    const threadSpawn = value.subagent?.thread_spawn ?? value.subagent?.threadSpawn ??
      value.thread_spawn ?? value.threadSpawn;
    const spawnedParent = cleanThreadId(threadSpawn?.parent_thread_id ?? threadSpawn?.parentThreadId);
    if (spawnedParent) return spawnedParent;

    for (const nested of [value.payload, value.session_meta, value.sessionMeta, value.source]) {
      const parent = visit(nested, depth + 1);
      if (parent) return parent;
    }
    return "";
  }

  return visit(sessionMetaOrSource);
}

function normalizeEventSequence(events) {
  let cumulative = emptyUsage();
  const normalized = [];
  for (const sourceEvent of Array.isArray(events) ? events : []) {
    if (!sourceEvent || typeof sourceEvent !== "object") continue;
    const explicitCumulative = sourceEvent.cumulativeUsage && typeof sourceEvent.cumulativeUsage === "object"
      ? normalizeUsage(sourceEvent.cumulativeUsage)
      : null;
    let usageSplit = normalizeUsage(sourceEvent.usageSplit ?? sourceEvent.usage);
    if (explicitCumulative && !usageSplit.total_tokens) {
      usageSplit = subtractUsage(explicitCumulative, cumulative);
    }
    cumulative = explicitCumulative || addUsage({ ...cumulative }, usageSplit);
    const providedStateId = typeof sourceEvent.usageStateId === "string" &&
      /^[a-f0-9]{64}$/i.test(sourceEvent.usageStateId)
      ? sourceEvent.usageStateId.toLowerCase()
      : "";
    normalized.push({
      ...sourceEvent,
      usageSplit,
      cumulativeUsage: { ...cumulative },
      usageStateId: usageStateId(cumulative),
      lineageStateId: providedStateId || usageStateHash(cumulative)
    });
  }
  return normalized;
}

function sumEventUsage(events) {
  const total = emptyUsage();
  for (const event of events || []) addUsage(total, event?.usageSplit);
  return total;
}

function sharedPrefix(leftEvents, rightEvents) {
  const limit = Math.min(leftEvents.length, rightEvents.length);
  let count = 0;
  const usage = emptyUsage();
  while (count < limit && leftEvents[count].lineageStateId === rightEvents[count].lineageStateId) {
    addUsage(usage, leftEvents[count].usageSplit);
    count += 1;
  }
  return { count, usage };
}

function alignedSharedPrefix(childEvents, parentEvents) {
  let best = { count: 0, usage: emptyUsage(), parentOffset: null };
  if (!childEvents.length || !parentEvents.length) return best;

  for (let parentOffset = 0; parentOffset < parentEvents.length; parentOffset += 1) {
    if (childEvents[0].lineageStateId !== parentEvents[parentOffset].lineageStateId) continue;
    const limit = Math.min(childEvents.length, parentEvents.length - parentOffset);
    let count = 0;
    const usage = emptyUsage();
    while (count < limit &&
      childEvents[count].lineageStateId === parentEvents[parentOffset + count].lineageStateId) {
      addUsage(usage, childEvents[count].usageSplit);
      count += 1;
    }
    if (count > best.count) best = { count, usage, parentOffset };
  }
  return best;
}

function normalizeForkDecision(value) {
  const action = String(value?.action ?? value?.decision ?? value ?? "").trim().toLowerCase();
  if (["approve", "approved", "apply", "applied"].includes(action)) return "approve";
  if (["reject", "rejected", "ignore", "ignored"].includes(action)) return "reject";
  return "";
}

function forkDecisionFor(decisions, childThreadId, parentThreadId) {
  if (!childThreadId || !parentThreadId || !decisions) return "";
  if (Array.isArray(decisions)) {
    for (let index = decisions.length - 1; index >= 0; index -= 1) {
      const item = decisions[index];
      const child = cleanThreadId(item?.childThreadId ?? item?.child_thread_id);
      const parent = cleanThreadId(item?.parentThreadId ?? item?.parent_thread_id);
      if (child === childThreadId && parent === parentThreadId) return normalizeForkDecision(item);
    }
    return "";
  }
  if (typeof decisions !== "object") return "";
  const compoundKeys = [
    `${childThreadId}:${parentThreadId}`,
    `${childThreadId}|${parentThreadId}`,
    `${childThreadId}->${parentThreadId}`
  ];
  for (const key of compoundKeys) {
    if (Object.hasOwn(decisions, key)) return normalizeForkDecision(decisions[key]);
  }
  const childDecision = decisions[childThreadId];
  if (childDecision && typeof childDecision === "object" && Object.hasOwn(childDecision, parentThreadId)) {
    return normalizeForkDecision(childDecision[parentThreadId]);
  }
  return "";
}

function timestampMillis(value) {
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : null;
}

function positiveThreshold(value, fallback, floor) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.max(floor, number);
}

function explicitParentFor(record) {
  return cleanThreadId(record?.parentThreadId) || cleanThreadId(record?.forkedFromId) ||
    extractParentThreadId(record);
}

function cyclicThreadIds(parentByThreadId) {
  const cyclic = new Set();
  for (const threadId of parentByThreadId.keys()) {
    const path = [];
    const offsets = new Map();
    let current = threadId;
    while (current && parentByThreadId.has(current)) {
      if (offsets.has(current)) {
        for (const id of path.slice(offsets.get(current))) cyclic.add(id);
        break;
      }
      offsets.set(current, path.length);
      path.push(current);
      current = parentByThreadId.get(current);
    }
  }
  return cyclic;
}

function candidatePrecedes(candidate, child) {
  if (candidate.createdMillis !== null && child.createdMillis !== null) {
    if (candidate.createdMillis !== child.createdMillis) return candidate.createdMillis < child.createdMillis;
  }
  return candidate.index < child.index;
}

function betterInference(candidate, best) {
  if (!best) return true;
  if (candidate.prefix.count !== best.prefix.count) return candidate.prefix.count > best.prefix.count;
  if (candidate.prefix.usage.total_tokens !== best.prefix.usage.total_tokens) {
    return candidate.prefix.usage.total_tokens > best.prefix.usage.total_tokens;
  }
  const candidateTime = candidate.record.createdMillis ?? Number.NEGATIVE_INFINITY;
  const bestTime = best.record.createdMillis ?? Number.NEGATIVE_INFINITY;
  if (candidateTime !== bestTime) return candidateTime > bestTime;
  return candidate.record.index > best.record.index;
}

function deduplicateLineageRecords(records, options = {}) {
  const input = Array.isArray(records) ? records : [];
  const prepared = input.map((record, index) => {
    const rawEvents = normalizeEventSequence(
      Array.isArray(record?.rawEvents) ? record.rawEvents : record?.events
    );
    const rawUsageSplit = sumEventUsage(rawEvents);
    const threadId = cleanThreadId(record?.threadId);
    const explicitParentThreadId = explicitParentFor(record);
    const hasSqliteControl = record?.sqliteTokens !== undefined && record?.sqliteTokens !== null &&
      Number.isFinite(Number(record.sqliteTokens));
    const controlTokens = hasSqliteControl
      ? nonnegativeInteger(record.sqliteTokens)
      : rawUsageSplit.total_tokens;
    return {
      source: record && typeof record === "object" ? record : {},
      index,
      threadId,
      explicitParentThreadId,
      createdMillis: timestampMillis(record?.createdAt),
      rawEvents,
      rawUsageSplit,
      controlTokens,
      hasSqliteControl
    };
  });

  const byThreadId = new Map();
  const duplicateThreadIds = new Set();
  for (const record of prepared) {
    if (!record.threadId) continue;
    if (byThreadId.has(record.threadId)) duplicateThreadIds.add(record.threadId);
    else byThreadId.set(record.threadId, record);
  }
  const parentByThreadId = new Map(
    prepared
      .filter((record) => record.threadId && record.explicitParentThreadId)
      .map((record) => [record.threadId, record.explicitParentThreadId])
  );
  const cyclic = cyclicThreadIds(parentByThreadId);
  const minInferenceEvents = positiveThreshold(
    options.inferenceMinPrefixEvents ?? options.minInferredPrefixEvents,
    5,
    5
  );
  const minInferenceTokens = positiveThreshold(
    options.inferenceMinInheritedTokens ?? options.minInferredTokens,
    100_000,
    100_000
  );
  const reviewMode = options.reviewMode === "assisted" ? "assisted" : "automatic";

  let explicitMatches = 0;
  let inferredMatches = 0;
  let missingParents = 0;
  let noSharedPrefix = 0;
  let cyclicParents = 0;

  const outputRecords = prepared.map((record) => {
    let parent = null;
    let candidatePrefix = { count: 0, usage: emptyUsage(), parentOffset: null };
    let forkParentThreadId = record.explicitParentThreadId;
    let forkMatchKind = "none";

    if (record.explicitParentThreadId) {
      if (cyclic.has(record.threadId)) {
        cyclicParents += 1;
        forkMatchKind = "explicit_parent_cycle";
      } else {
        parent = byThreadId.get(record.explicitParentThreadId) || null;
        if (!parent) {
          missingParents += 1;
          forkMatchKind = "explicit_parent_missing";
        } else {
          candidatePrefix = alignedSharedPrefix(record.rawEvents, parent.rawEvents);
          if (candidatePrefix.count) {
            explicitMatches += 1;
            forkMatchKind = candidatePrefix.parentOffset > 0
              ? "explicit_parent_aligned"
              : "explicit_parent";
          } else {
            noSharedPrefix += 1;
            forkMatchKind = "explicit_parent_no_shared_prefix";
          }
        }
      }
    } else if (options.inferUnlinked === true && record.rawEvents.length >= minInferenceEvents) {
      let best = null;
      for (const candidateRecord of prepared) {
        if (candidateRecord === record || !candidateRecord.threadId || !candidatePrecedes(candidateRecord, record)) continue;
        if (candidateRecord.rawEvents.length < minInferenceEvents) continue;
        const candidatePrefix = sharedPrefix(record.rawEvents, candidateRecord.rawEvents);
        if (candidatePrefix.count < minInferenceEvents ||
          candidatePrefix.usage.total_tokens < minInferenceTokens) continue;
        const candidate = { record: candidateRecord, prefix: candidatePrefix };
        if (betterInference(candidate, best)) best = candidate;
      }
      if (best) {
        parent = best.record;
        candidatePrefix = { ...best.prefix, parentOffset: 0 };
        forkParentThreadId = parent.threadId;
        forkMatchKind = "inferred_exact_prefix";
        inferredMatches += 1;
      }
    }

    const decision = forkDecisionFor(options.forkDecisions, record.threadId, forkParentThreadId);
    const hasCandidate = candidatePrefix.count > 0;
    const autoApply = hasCandidate && (
      (forkMatchKind.startsWith("explicit_parent") && candidatePrefix.count >= 2) ||
      (forkMatchKind === "inferred_exact_prefix" && reviewMode === "automatic")
    );
    const applyCandidate = hasCandidate && (decision === "approve" || (decision !== "reject" && autoApply));
    const forkReviewStatus = !hasCandidate
      ? "not_applicable"
      : decision === "approve"
        ? "approved"
        : decision === "reject"
          ? "rejected"
          : autoApply
            ? "auto_applied"
            : "pending";
    const appliedPrefixEvents = applyCandidate ? candidatePrefix.count : 0;
    const appliedInheritedTokens = applyCandidate ? candidatePrefix.usage.total_tokens : 0;
    const events = record.rawEvents.slice(appliedPrefixEvents);
    const usageSplit = sumEventUsage(events);
    const branchTokens = Math.max(0, record.controlTokens - appliedInheritedTokens);
    return {
      ...record.source,
      threadId: record.threadId,
      rawEvents: record.rawEvents,
      rawUsageSplit: record.rawUsageSplit,
      events,
      usageSplit,
      inheritedTokens: appliedInheritedTokens,
      branchTokens,
      sharedPrefixEvents: appliedPrefixEvents,
      forkParentThreadId,
      forkMatchKind,
      forkReviewStatus,
      candidateInheritedTokens: candidatePrefix.usage.total_tokens,
      candidatePrefixEvents: candidatePrefix.count,
      candidateParentOffset: candidatePrefix.parentOffset
    };
  });

  const reviewItems = outputRecords
    .filter((record) => record.forkMatchKind !== "none")
    .map((record) => ({
      childThreadId: record.threadId,
      parentThreadId: record.forkParentThreadId,
      childTitle: String(record.title || "").trim().slice(0, 160),
      parentTitle: String(byThreadId.get(record.forkParentThreadId)?.source?.title || "").trim().slice(0, 160),
      matchKind: record.forkMatchKind,
      status: record.forkReviewStatus,
      candidateInheritedTokens: record.candidateInheritedTokens,
      candidatePrefixEvents: record.candidatePrefixEvents,
      candidateParentOffset: record.candidateParentOffset,
      appliedInheritedTokens: record.inheritedTokens,
      appliedPrefixEvents: record.sharedPrefixEvents,
      branchTokens: record.branchTokens
    }));
  const appliedExplicitMatches = outputRecords.filter((record) =>
    ["explicit_parent", "explicit_parent_aligned"].includes(record.forkMatchKind) && record.inheritedTokens > 0
  ).length;
  const appliedInferredMatches = outputRecords.filter((record) =>
    record.forkMatchKind === "inferred_exact_prefix" && record.inheritedTokens > 0
  ).length;

  const audit = {
    totalRecords: outputRecords.length,
    explicitForkRecords: prepared.filter((record) => Boolean(record.explicitParentThreadId)).length,
    explicitMatches: appliedExplicitMatches,
    inferredMatches: appliedInferredMatches,
    matchedForks: appliedExplicitMatches + appliedInferredMatches,
    candidateExplicitMatches: explicitMatches,
    candidateInferredMatches: inferredMatches,
    missingParents,
    noSharedPrefix,
    cyclicParents,
    duplicateThreadIds: [...duplicateThreadIds],
    rawTelemetryTokens: outputRecords.reduce((sum, record) => sum + record.rawUsageSplit.total_tokens, 0),
    sqliteControlTokens: prepared.reduce((sum, record) => sum + record.controlTokens, 0),
    inheritedTokens: outputRecords.reduce((sum, record) => sum + record.inheritedTokens, 0),
    deduplicatedTelemetryTokens: outputRecords.reduce((sum, record) => sum + record.usageSplit.total_tokens, 0),
    branchTokens: outputRecords.reduce((sum, record) => sum + record.branchTokens, 0),
    sharedPrefixEvents: outputRecords.reduce((sum, record) => sum + record.sharedPrefixEvents, 0),
    reviewItems,
    pendingForks: reviewItems.filter((item) => item.status === "pending").length,
    rejectedForks: reviewItems.filter((item) => item.status === "rejected").length,
    approvedForks: reviewItems.filter((item) => ["approved", "auto_applied"].includes(item.status)).length,
    inference: {
      enabled: options.inferUnlinked === true,
      minPrefixEvents: minInferenceEvents,
      minInheritedTokens: minInferenceTokens,
      reviewMode
    }
  };

  return { records: outputRecords, audit };
}

module.exports = {
  deduplicateLineageRecords,
  extractParentThreadId,
  usageStateId
};
