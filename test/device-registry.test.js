"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DeviceRegistry, normalizeAgent, normalizeIngestBatch } = require("../lib/device-registry");

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function event(id, thread = "thread", total = 10, at = "2026-07-14T00:00:00.000Z") {
  return {
    eventId: hash(id),
    threadHash: hash(thread),
    at,
    model: "gpt-5.6-luna",
    usage: { input_tokens: total - 2, cached_input_tokens: 2, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: total },
    title: "must not be persisted",
    cwd: "C:/private"
  };
}

function batch(id, events, cursor = id, agent) {
  return { schemaVersion: 1, batchId: id, cursor, events, snapshots: [], agent };
}

async function registryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gpt-monitor-devices-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new DeviceRegistry(root, { localName: "WORKSTATION" });
}

test("creates a built-in local device and returns remote tokens only once", async (t) => {
  const registry = await registryFixture(t);
  const created = await registry.create("Laptop");
  assert.ok(created.token.length >= 40);
  const devices = await registry.list();
  assert.deepEqual(devices.map((device) => device.id), ["local", "laptop"]);
  const manifest = JSON.parse(await fs.readFile(registry.manifestFile, "utf8"));
  assert.ok(!JSON.stringify(manifest).includes(created.token));
});

test("ingest is batch-idempotent and globally deduplicates copied rollouts", async (t) => {
  const registry = await registryFixture(t);
  const first = await registry.create("Laptop");
  const second = await registry.create("Desktop");
  const copied = event("copied");
  const ingested = await registry.ingest(first.token, batch("a", [copied], "a", {
    version: "2.0.0", platform: "win32", nodeVersion: "v22.17.0", installed: true
  }));
  assert.equal(ingested.accepted, 1);
  assert.equal(ingested.duplicates, 0);
  assert.equal(ingested.cursor, "a");
  assert.equal(ingested.replay, false);
  assert.match(ingested.serverTime, /^\d{4}-\d{2}-\d{2}T/);
  const registered = (await registry.list()).find((device) => device.id === "laptop");
  assert.equal(registered.agentVersion, "2.0.0");
  assert.equal(registered.agentPlatform, "win32");
  assert.equal(registered.agentNodeVersion, "v22.17.0");
  assert.equal(registered.agentInstalled, true);
  assert.equal(registered.lastAccepted, 1);
  assert.equal((await registry.ingest(first.token, batch("a", [copied]))).replay, true);
  const duplicate = await registry.ingest(second.token, batch("b", [copied]));
  assert.equal(duplicate.accepted, 0);
  assert.equal(duplicate.duplicates, 1);
  const stored = await registry.loadEvents();
  assert.equal(stored[0].ownerDeviceId, "laptop");
  assert.equal(stored[0].title, undefined);
  assert.equal(stored[0].cwd, undefined);
});

test("out-of-order batches retain every unique event", async (t) => {
  const registry = await registryFixture(t);
  const device = await registry.create("Laptop");
  await registry.ingest(device.token, batch("late", [event("late", "thread", 20, "2026-07-14T02:00:00Z")]));
  await registry.ingest(device.token, batch("early", [event("early", "thread", 10, "2026-07-14T01:00:00Z")]));
  assert.equal((await registry.loadEvents()).length, 2);
});

test("token rotation invalidates the old token and revocation blocks ingest", async (t) => {
  const registry = await registryFixture(t);
  const created = await registry.create("Laptop");
  const rotated = await registry.rotate(created.device.id);
  await assert.rejects(() => registry.ingest(created.token, batch("old", [])), /Invalid or revoked/);
  assert.equal((await registry.ingest(rotated.token, batch("new", []))).accepted, 0);
  await registry.patch(created.device.id, { enabled: false });
  await assert.rejects(() => registry.ingest(rotated.token, batch("revoked", [])), /Invalid or revoked/);
});

test("invalid and over-limit payloads are rejected", () => {
  assert.throws(() => normalizeIngestBatch({ schemaVersion: 2, events: [] }), /Unsupported/);
  assert.throws(() => normalizeIngestBatch({ schemaVersion: 1, events: Array.from({ length: 501 }, (_, i) => event(String(i))) }), /at most 500/);
  assert.throws(() => normalizeIngestBatch({ schemaVersion: 1, events: [{ prompt: "secret" }] }), /invalid event/);
});

test("agent metadata is normalized without accepting arbitrary fields", () => {
  assert.deepEqual(normalizeAgent({
    version: " 2.0.0 ", platform: "WIN32", nodeVersion: "v22.17.0", installed: 1, secret: "no"
  }), {
    version: "2.0.0", platform: "win32", nodeVersion: "v22.17.0", installed: true
  });
});
