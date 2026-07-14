"use strict";

const WINDOW_KINDS = Object.freeze({
  18000: {
    id: "five_hour",
    kind: "five_hour",
    label: "5 小时窗口",
    shortLabel: "5H"
  },
  604800: {
    id: "weekly",
    kind: "weekly",
    label: "每周窗口",
    shortLabel: "WEEK"
  }
});

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function durationLabel(seconds) {
  const total = nullableNumber(seconds);
  if (total === null || total <= 0) return "自定义窗口";
  if (total % 604800 === 0) return `${total / 604800} 周窗口`;
  if (total % 86400 === 0) return `${total / 86400} 天窗口`;
  if (total % 3600 === 0) return `${total / 3600} 小时窗口`;
  if (total % 60 === 0) return `${total / 60} 分钟窗口`;
  return `${Math.round(total)} 秒窗口`;
}

function shortDurationLabel(seconds) {
  const total = nullableNumber(seconds);
  if (total === null || total <= 0) return "CUSTOM";
  if (total % 604800 === 0) return `${total / 604800}W`;
  if (total % 86400 === 0) return `${total / 86400}D`;
  if (total % 3600 === 0) return `${total / 3600}H`;
  if (total % 60 === 0) return `${total / 60}M`;
  return `${Math.round(total)}S`;
}

function classifyWindow(seconds, fallbackId = "custom") {
  const normalizedSeconds = nullableNumber(seconds);
  const exact = WINDOW_KINDS[normalizedSeconds];
  if (exact) return { ...exact };
  const suffix = normalizedSeconds && normalizedSeconds > 0
    ? Math.round(normalizedSeconds)
    : String(fallbackId || "custom").replace(/[^a-z0-9_-]+/gi, "_").toLowerCase();
  return {
    id: `custom_${suffix}`,
    kind: "custom",
    label: durationLabel(normalizedSeconds),
    shortLabel: shortDurationLabel(normalizedSeconds)
  };
}

function normalizeUsageWindow(window, fallbackId = "custom") {
  if (!window || typeof window !== "object") return null;
  const windowSeconds = nullableNumber(
    window.windowSeconds ?? window.limit_window_seconds ?? window.window_seconds
  );
  const classified = classifyWindow(windowSeconds, fallbackId);
  return {
    ...window,
    id: classified.id,
    kind: classified.kind,
    label: classified.label,
    shortLabel: classified.shortLabel,
    windowSeconds
  };
}

function windowRank(window) {
  if (window.kind === "five_hour") return 0;
  if (window.kind === "weekly") return 1;
  return 2;
}

function usageWindows(usage) {
  if (!usage || typeof usage !== "object") return [];
  const source = Array.isArray(usage.windows) && usage.windows.length
    ? usage.windows.map((window, index) => [window, `window_${index + 1}`])
    : [
      [usage.primaryWindow, "primary"],
      [usage.secondaryWindow, "secondary"]
    ];
  const deduped = new Map();
  for (const [window, fallbackId] of source) {
    const normalized = normalizeUsageWindow(window, fallbackId);
    if (normalized && !deduped.has(normalized.id)) deduped.set(normalized.id, normalized);
  }
  return [...deduped.values()].sort((left, right) =>
    windowRank(left) - windowRank(right) ||
    (left.windowSeconds ?? Number.MAX_SAFE_INTEGER) - (right.windowSeconds ?? Number.MAX_SAFE_INTEGER)
  );
}

function withUsageWindows(usage) {
  if (!usage || typeof usage !== "object") return usage;
  return {
    ...usage,
    windows: usageWindows(usage)
  };
}

module.exports = {
  classifyWindow,
  durationLabel,
  normalizeUsageWindow,
  shortDurationLabel,
  usageWindows,
  withUsageWindows
};
