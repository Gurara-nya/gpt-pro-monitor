"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeConfig, preservePrivateUsageConfig } = require("../server");

test("fork review defaults to assisted mode and normalizes unique decisions", () => {
  const config = normalizeConfig({
    usageUsers: [{
      id: "owner",
      label: "Owner",
      codexUsage: {
        forkReviewMode: "invalid",
        forkDecisions: [
          { childThreadId: "child", parentThreadId: "parent", action: "approve", updatedAt: "2026-07-15T00:00:00Z" },
          { childThreadId: "child", parentThreadId: "parent", action: "reject", updatedAt: "2026-07-16T00:00:00Z" },
          { childThreadId: "ignored", parentThreadId: "parent", action: "maybe" }
        ]
      }
    }]
  });

  const usage = config.usageUsers[0].codexUsage;
  assert.equal(usage.forkReviewMode, "assisted");
  assert.deepEqual(usage.forkDecisions, [{
    childThreadId: "child",
    parentThreadId: "parent",
    action: "reject",
    updatedAt: "2026-07-16T00:00:00.000Z"
  }]);
});

test("automatic fork mode remains available for operators who opt in", () => {
  const config = normalizeConfig({
    usageUsers: [{ id: "owner", codexUsage: { forkReviewMode: "automatic" } }]
  });
  assert.equal(config.usageUsers[0].codexUsage.forkReviewMode, "automatic");
});

test("ordinary settings saves preserve private fork decisions omitted from public state", () => {
  const existing = normalizeConfig({
    usageUsers: [{
      id: "owner",
      codexUsage: {
        forkDecisions: [{ childThreadId: "child", parentThreadId: "parent", action: "approve" }]
      }
    }]
  });
  const submitted = {
    usageUsers: [{
      id: "owner",
      label: "Renamed",
      codexUsage: { enabled: true, forkReviewMode: "automatic" }
    }]
  };

  const merged = preservePrivateUsageConfig(submitted, existing);
  assert.deepEqual(merged.usageUsers[0].codexUsage.forkDecisions, existing.usageUsers[0].codexUsage.forkDecisions);
  assert.equal(merged.usageUsers[0].codexUsage.forkReviewMode, "automatic");
  assert.equal(submitted.usageUsers[0].codexUsage.forkDecisions, undefined);
});

test("the dedicated fork API remains authoritative over stale configuration updates", () => {
  const existing = normalizeConfig({
    usageUsers: [{
      id: "owner",
      codexUsage: {
        forkDecisions: [{ childThreadId: "old", parentThreadId: "parent", action: "approve" }]
      }
    }]
  });
  const submitted = {
    usageUsers: [{
      id: "owner",
      codexUsage: {
        forkDecisions: [{ childThreadId: "new", parentThreadId: "parent", action: "reject" }]
      }
    }]
  };

  const merged = preservePrivateUsageConfig(submitted, existing);
  assert.deepEqual(merged.usageUsers[0].codexUsage.forkDecisions, existing.usageUsers[0].codexUsage.forkDecisions);
});
