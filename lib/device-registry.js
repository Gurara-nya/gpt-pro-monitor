"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_EVENTS_PER_BATCH = 500;
const STALE_AFTER_MS = 45 * 60 * 1000;
const mutations = new Map();

function clean(value, max = 120) {
  return String(value || "").trim().slice(0, max);
}

function cleanId(value, fallback = "device") {
  const normalized = clean(value, 120).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || `${fallback}-${crypto.randomUUID().slice(0, 8)}`;
}

function iso(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function secureToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeUsage(value) {
  const input = count(value?.input_tokens);
  const cached = Math.min(input, count(value?.cached_input_tokens));
  const output = count(value?.output_tokens);
  const reasoning = Math.min(output, count(value?.reasoning_output_tokens));
  const total = input || output ? input + output : count(value?.total_tokens);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total
  };
}

function normalizeEvent(value) {
  const eventId = clean(value?.eventId, 64).toLowerCase();
  const threadHash = clean(value?.threadHash, 64).toLowerCase();
  const at = iso(value?.at);
  const usage = normalizeUsage(value?.usage || value?.usageSplit);
  if (!/^[a-f0-9]{64}$/.test(eventId) || !/^[a-f0-9]{64}$/.test(threadHash) || !at || !usage.total_tokens) {
    return null;
  }
  const parentThreadHash = clean(value?.parentThreadHash, 64).toLowerCase();
  const usageStateId = clean(value?.usageStateId, 64).toLowerCase();
  return {
    eventId,
    threadHash,
    parentThreadHash: /^[a-f0-9]{64}$/.test(parentThreadHash) ? parentThreadHash : "",
    usageStateId: /^[a-f0-9]{64}$/.test(usageStateId) ? usageStateId : "",
    cumulativeTotalTokens: count(value?.cumulativeTotalTokens),
    at,
    model: clean(value?.model || "unknown", 120) || "unknown",
    provider: clean(value?.provider, 80),
    usage
  };
}

function normalizeSnapshot(value) {
  const threadHash = clean(value?.threadHash, 64).toLowerCase();
  const updatedAt = iso(value?.updatedAt || value?.at);
  const totalTokens = count(value?.totalTokens ?? value?.total_tokens);
  if (!/^[a-f0-9]{64}$/.test(threadHash) || !updatedAt || !totalTokens) return null;
  const parentThreadHash = clean(value?.parentThreadHash, 64).toLowerCase();
  return {
    threadHash,
    parentThreadHash: /^[a-f0-9]{64}$/.test(parentThreadHash) ? parentThreadHash : "",
    updatedAt,
    totalTokens,
    model: clean(value?.model || "unknown", 120) || "unknown",
    provider: clean(value?.provider, 80)
  };
}

function normalizeAgent(value) {
  const platform = clean(value?.platform, 24).toLowerCase();
  return {
    version: clean(value?.version, 32),
    platform: ["win32", "linux", "darwin"].includes(platform) ? platform : clean(platform, 24),
    nodeVersion: clean(value?.nodeVersion, 32),
    installed: Boolean(value?.installed)
  };
}

function normalizeIngestBatch(value) {
  if (!value || Number(value.schemaVersion) !== 1) {
    throw Object.assign(new Error("Unsupported device ingest schema"), { statusCode: 400 });
  }
  if (!Array.isArray(value.events) || value.events.length > MAX_EVENTS_PER_BATCH) {
    throw Object.assign(new Error(`A batch must contain at most ${MAX_EVENTS_PER_BATCH} events`), { statusCode: 413 });
  }
  const events = value.events.map(normalizeEvent);
  if (events.some((event) => !event)) {
    throw Object.assign(new Error("Device batch contains an invalid event"), { statusCode: 400 });
  }
  const snapshots = Array.isArray(value.snapshots)
    ? value.snapshots.slice(0, MAX_EVENTS_PER_BATCH).map(normalizeSnapshot)
    : [];
  if (snapshots.some((snapshot) => !snapshot)) {
    throw Object.assign(new Error("Device batch contains an invalid snapshot"), { statusCode: 400 });
  }
  return {
    schemaVersion: 1,
    batchId: clean(value.batchId || crypto.randomUUID(), 120),
    cursor: clean(value.cursor, 240),
    events,
    snapshots,
    agent: normalizeAgent(value.agent)
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWrite(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700).catch(() => {});
  const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

function publicDevice(device, now = Date.now()) {
  const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
  return {
    id: device.id,
    name: device.name,
    enabled: device.enabled !== false,
    builtIn: Boolean(device.builtIn),
    revoked: Boolean(device.revokedAt),
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
    stale: !device.builtIn && (!lastSeen || now - lastSeen > STALE_AFTER_MS),
    lastCursor: device.lastCursor || "",
    tokenCreatedAt: device.tokenCreatedAt || null,
    agentVersion: device.agentVersion || "",
    agentPlatform: device.agentPlatform || "",
    agentNodeVersion: device.agentNodeVersion || "",
    agentInstalled: Boolean(device.agentInstalled),
    lastAccepted: count(device.lastAccepted),
    lastDuplicates: count(device.lastDuplicates)
  };
}

class DeviceRegistry {
  constructor(rootDir, options = {}) {
    this.rootDir = rootDir;
    this.localName = clean(options.localName || "Local device", 120);
    this.manifestFile = path.join(rootDir, "manifest.json");
    this.eventsFile = path.join(rootDir, "events.jsonl");
    this.snapshotsFile = path.join(rootDir, "snapshots.json");
    this.ownershipFile = path.join(rootDir, "ownership.json");
  }

  async ensure() {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => {});
    const manifest = await readJson(this.manifestFile, { version: 1, devices: [] });
    if (!manifest.devices.some((device) => device.id === "local")) {
      manifest.devices.unshift({
        id: "local",
        name: this.localName,
        enabled: true,
        builtIn: true,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        tokenDigest: ""
      });
      await this.writeManifest(manifest);
    }
    return manifest;
  }

  async writeManifest(manifest) {
    await atomicWrite(this.manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async list() {
    const manifest = await this.ensure();
    return manifest.devices.map((device) => publicDevice(device));
  }

  async create(name) {
    return this.mutate(async () => {
      const manifest = await this.ensure();
      const token = secureToken();
      const requested = cleanId(name || "remote-device", "device");
      let id = requested;
      let suffix = 2;
      while (manifest.devices.some((device) => device.id === id)) id = `${requested}-${suffix++}`;
      const now = new Date().toISOString();
      const device = {
        id,
        name: clean(name || id, 120),
        enabled: true,
        builtIn: false,
        createdAt: now,
        lastSeenAt: null,
        tokenCreatedAt: now,
        tokenDigest: tokenDigest(token),
        recentBatchIds: []
      };
      manifest.devices.push(device);
      await this.writeManifest(manifest);
      return { device: publicDevice(device), token };
    });
  }

  async patch(id, changes) {
    return this.mutate(async () => {
      const manifest = await this.ensure();
      const device = manifest.devices.find((item) => item.id === id);
      if (!device) throw Object.assign(new Error("Device not found"), { statusCode: 404 });
      if (changes.name !== undefined) device.name = clean(changes.name, 120) || device.name;
      if (!device.builtIn && changes.enabled !== undefined) {
        device.enabled = Boolean(changes.enabled);
        device.revokedAt = device.enabled ? null : new Date().toISOString();
      }
      await this.writeManifest(manifest);
      return publicDevice(device);
    });
  }

  async rotate(id) {
    return this.mutate(async () => {
      const manifest = await this.ensure();
      const device = manifest.devices.find((item) => item.id === id && !item.builtIn);
      if (!device) throw Object.assign(new Error("Remote device not found"), { statusCode: 404 });
      const token = secureToken();
      device.tokenDigest = tokenDigest(token);
      device.tokenCreatedAt = new Date().toISOString();
      device.enabled = true;
      device.revokedAt = null;
      await this.writeManifest(manifest);
      return { device: publicDevice(device), token };
    });
  }

  async remove(id) {
    return this.mutate(async () => {
      const manifest = await this.ensure();
      const index = manifest.devices.findIndex((item) => item.id === id && !item.builtIn);
      if (index === -1) throw Object.assign(new Error("Remote device not found"), { statusCode: 404 });
      const [removed] = manifest.devices.splice(index, 1);
      await this.writeManifest(manifest);
      return publicDevice(removed);
    });
  }

  async authenticate(token) {
    const manifest = await this.ensure();
    const digest = tokenDigest(token);
    return manifest.devices.find((device) =>
      !device.builtIn && device.enabled !== false && !device.revokedAt && safeEqual(device.tokenDigest, digest)
    ) || null;
  }

  async ingest(token, value) {
    const batch = normalizeIngestBatch(value);
    return this.mutate(async () => {
      const manifest = await this.ensure();
      const digest = tokenDigest(token);
      const device = manifest.devices.find((item) =>
        !item.builtIn && item.enabled !== false && !item.revokedAt && safeEqual(item.tokenDigest, digest)
      );
      if (!device) throw Object.assign(new Error("Invalid or revoked device token"), { statusCode: 401 });
      const recent = new Set(device.recentBatchIds || []);
      const replay = recent.has(batch.batchId);

      const existingEvents = await this.loadEvents();
      const eventsById = new Map(existingEvents.map((event) => [event.eventId, event]));
      let accepted = 0;
      let duplicates = 0;
      for (const event of batch.events) {
        if (eventsById.has(event.eventId)) {
          const previous = eventsById.get(event.eventId);
          if (event.parentThreadHash) previous.parentThreadHash = event.parentThreadHash;
          if (event.usageStateId) previous.usageStateId = event.usageStateId;
          if (event.cumulativeTotalTokens) previous.cumulativeTotalTokens = event.cumulativeTotalTokens;
          duplicates += 1;
          continue;
        }
        const stored = { ...event, ownerDeviceId: device.id, receivedAt: new Date().toISOString() };
        eventsById.set(event.eventId, stored);
        existingEvents.push(stored);
        accepted += 1;
      }

      const snapshots = await this.loadSnapshots();
      for (const snapshot of batch.snapshots) {
        const key = `${device.id}:${snapshot.threadHash}`;
        const previous = snapshots[key];
        if (!previous || snapshot.totalTokens > previous.totalTokens || snapshot.updatedAt > previous.updatedAt ||
          (!previous.parentThreadHash && snapshot.parentThreadHash)) {
          snapshots[key] = { ...snapshot, deviceId: device.id };
        }
      }

      device.lastSeenAt = new Date().toISOString();
      device.lastCursor = batch.cursor || device.lastCursor || "";
      device.recentBatchIds = [...recent, batch.batchId].slice(-1000);
      device.agentVersion = batch.agent.version || device.agentVersion || "";
      device.agentPlatform = batch.agent.platform || device.agentPlatform || "";
      device.agentNodeVersion = batch.agent.nodeVersion || device.agentNodeVersion || "";
      device.agentInstalled = batch.agent.installed || device.agentInstalled || false;
      device.lastAccepted = accepted;
      device.lastDuplicates = duplicates;
      await atomicWrite(this.eventsFile, existingEvents.map((event) => JSON.stringify(event)).join("\n") + (existingEvents.length ? "\n" : ""));
      await atomicWrite(this.snapshotsFile, `${JSON.stringify(snapshots, null, 2)}\n`);
      await this.writeManifest(manifest);
      return { accepted, duplicates, cursor: device.lastCursor, replay, serverTime: device.lastSeenAt };
    });
  }

  async loadEvents() {
    try {
      const text = await fs.readFile(this.eventsFile, "utf8");
      return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  async loadSnapshots() {
    return readJson(this.snapshotsFile, {});
  }

  async resolveOwnership(localEventIds = []) {
    return this.mutate(async () => {
      await this.ensure();
      const events = await this.loadEvents();
      const stored = await readJson(this.ownershipFile, null);
      const firstMigration = !stored?.initializedAt;
      const owners = {};
      for (const [eventId, ownerDeviceId] of Object.entries(stored?.owners || {})) {
        const normalizedEventId = clean(eventId, 64).toLowerCase();
        const normalizedOwner = clean(ownerDeviceId, 120);
        if (/^[a-f0-9]{64}$/.test(normalizedEventId) && normalizedOwner) {
          owners[normalizedEventId] = normalizedOwner;
        }
      }
      let changed = !stored || Object.keys(owners).length !== Object.keys(stored.owners || {}).length;
      const local = [...new Set([...localEventIds]
        .map((eventId) => clean(eventId, 64).toLowerCase())
        .filter((eventId) => /^[a-f0-9]{64}$/.test(eventId)))];
      const remote = events.slice().sort((left, right) =>
        String(left.receivedAt || left.at || "").localeCompare(String(right.receivedAt || right.at || ""))
      );
      const claim = (eventId, deviceId) => {
        if (!eventId || !deviceId || owners[eventId]) return;
        owners[eventId] = deviceId;
        changed = true;
      };

      if (firstMigration) {
        for (const eventId of local) claim(eventId, "local");
        for (const event of remote) claim(event.eventId, event.ownerDeviceId);
      } else {
        for (const event of remote) claim(event.eventId, event.ownerDeviceId);
        for (const eventId of local) claim(eventId, "local");
      }

      if (changed || firstMigration) {
        await atomicWrite(this.ownershipFile, `${JSON.stringify({
          version: 1,
          initializedAt: stored?.initializedAt || new Date().toISOString(),
          owners
        }, null, 2)}\n`);
      }
      return new Map(Object.entries(owners));
    });
  }

  async data() {
    const [devices, events, snapshots] = await Promise.all([this.list(), this.loadEvents(), this.loadSnapshots()]);
    return { devices, events, snapshots: Object.values(snapshots) };
  }

  mutate(operation) {
    const previous = mutations.get(this.rootDir) || Promise.resolve();
    const next = previous.then(operation);
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (mutations.get(this.rootDir) === tracked) mutations.delete(this.rootDir);
    });
    mutations.set(this.rootDir, tracked);
    return next;
  }
}

module.exports = {
  DeviceRegistry,
  MAX_EVENTS_PER_BATCH,
  STALE_AFTER_MS,
  normalizeEvent,
  normalizeAgent,
  normalizeIngestBatch,
  normalizeSnapshot,
  publicDevice,
  tokenDigest
};
