"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyWindow,
  usageWindows,
  withUsageWindows
} = require("../lib/quota-windows");

test("weekly primary without secondary is exposed only as a weekly window", () => {
  const usage = withUsageWindows({
    primaryWindow: { windowSeconds: 604800, usedPercent: 65, remainingPercent: 35 },
    secondaryWindow: null
  });
  assert.equal(usage.windows.length, 1);
  assert.deepEqual(usage.windows[0], {
    windowSeconds: 604800,
    usedPercent: 65,
    remainingPercent: 35,
    id: "weekly",
    kind: "weekly",
    label: "每周窗口",
    shortLabel: "WEEK"
  });
});

test("five-hour and weekly windows are identified independently of source order", () => {
  const windows = usageWindows({
    primaryWindow: { windowSeconds: 604800 },
    secondaryWindow: { windowSeconds: 18000 }
  });
  assert.deepEqual(windows.map((window) => window.kind), ["five_hour", "weekly"]);
});

test("unknown durations keep their real duration and use a custom kind", () => {
  assert.deepEqual(classifyWindow(172800), {
    id: "custom_172800",
    kind: "custom",
    label: "2 天窗口",
    shortLabel: "2D"
  });
});

test("legacy history records are projected without mutating compatibility fields", () => {
  const primaryWindow = { windowSeconds: 18000, remainingPercent: 80 };
  const secondaryWindow = { windowSeconds: 604800, remainingPercent: 20 };
  const usage = withUsageWindows({ primaryWindow, secondaryWindow });
  assert.equal(usage.primaryWindow, primaryWindow);
  assert.equal(usage.secondaryWindow, secondaryWindow);
  assert.deepEqual(usage.windows.map((window) => window.id), ["five_hour", "weekly"]);
});

test("existing normalized windows are deduplicated by semantic identity", () => {
  const windows = usageWindows({
    windows: [
      { id: "outdated", kind: "custom", windowSeconds: 604800, remainingPercent: 40 },
      { windowSeconds: 604800, remainingPercent: 39 }
    ]
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].id, "weekly");
  assert.equal(windows[0].remainingPercent, 40);
});
