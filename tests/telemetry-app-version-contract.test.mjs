import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  FetchTelemetryTransport,
  MemoryIdentityStorage,
  TelemetryClient,
} from "../packages/telemetry-update-sdk/dist/index.js";

const require = createRequire(import.meta.url);
const {
  createHandler,
} = require("../cloudbase/functions/telemetry/src/handler.js");
const {
  createDashboardSnapshot,
} = require("../cloudbase/functions/operations-dashboard/src/aggregate.js");
const ENDPOINT = "https://telemetry.example.com/apps/bifang-tools/v1/track";

function harness(mock) {
  let now = new Date("2026-10-26T02:00:00.000Z");
  const records = new Map();
  const wire = [];
  const handler = createHandler({
    allowedAppIds: "bifang-tools",
    trackPath: new URL(ENDPOINT).pathname,
    writer: async (record) => {
      if (!records.has(record._id)) records.set(record._id, record);
    },
    now: () => now,
    logger: { error() {} },
  });
  mock.method(globalThis, "fetch", async (endpoint, init) => {
    assert.equal(String(endpoint), ENDPOINT);
    const payload = JSON.parse(init.body);
    wire.push(payload);
    const response = await handler({
      path: new URL(endpoint).pathname,
      httpMethod: init.method,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body,
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers,
    });
  });
  const transport = new FetchTelemetryTransport();
  const identityStorage = new MemoryIdentityStorage();
  return {
    records,
    wire,
    handler,
    nextDay() {
      now = new Date(now.getTime() + 86_400_000);
    },
    now: () => now,
    async start(applicationVersion) {
      const client = await TelemetryClient.init({
        appId: "bifang-tools",
        appVersion: applicationVersion,
        platform: "windows",
        arch: "x64",
        endpoint: ENDPOINT,
        enabled: true,
        identityStorage,
        transport,
        now: () => now,
        scheduler: (run) => run(),
      });
      return { client, deliveries: await client.drainResults() };
    },
  };
}

test("application versions survive the SDK wire, ingestion and dashboard independently of published release records", async (t) => {
  // A genuine app version equal to the SDK version is valid too.
  for (const [initialVersion, upgradedVersion] of [
    ["7.2.3", "7.2.4"],
    ["3.0.0", "3.0.1"],
  ]) {
    const h = harness(t.mock);
    const first = await h.start(initialVersion);
    assert.equal(first.deliveries[0].outcome, "acknowledged");
    assert.equal(h.wire[0].app_version, initialVersion);
    assert.equal(h.wire[0].sdk_version, "3.0.0");
    assert.equal([...h.records.values()][0].app_version, initialVersion);
    await h.start(upgradedVersion);
    assert.equal(
      h.wire.length,
      1,
      "same-day upgrade must not bypass the daily gate",
    );
    h.nextDay();
    const next = await h.start(upgradedVersion);
    assert.equal(next.deliveries[0].outcome, "acknowledged");
    assert.equal(next.client.installId, first.client.installId);
    assert.equal(h.wire.length, 2);
    assert.equal(h.wire[1].app_version, upgradedVersion);
    assert.equal(h.wire[1].sdk_version, "3.0.0");
    const stream = {
      code: "bifang-tools-windows-x64",
      platform: "windows",
      architecture: "x64",
      channel: "stable",
    };
    const snapshot = createDashboardSnapshot({
      now: h.now(),
      days: 7,
      selectedAppId: "bifang-tools",
      apps: [{ appId: "bifang-tools", releaseStreams: [stream] }],
      events: [...h.records.values()],
      releaseSummaries: [
        {
          appId: "bifang-tools",
          ...stream,
          highestVersion: null,
          status: "empty",
          updatedAt: null,
        },
      ],
    });
    assert.equal(snapshot.versions[0].label, upgradedVersion);
    assert.equal(snapshot.versions[0].value, 1);
    assert.equal(snapshot.releaseStreams[0].highestVersion, null);
    assert.equal(snapshot.releaseStreams[0].status, "empty");
    t.mock.restoreAll();
  }
});

test("missing or malformed application versions never become accepted telemetry records", async (t) => {
  const h = harness(t.mock);
  for (const version of [undefined, "", "latest", "v1.2.3", "01.2.3"]) {
    const result = await h.start(version);
    assert.equal(result.client.enabled, false);
    assert.equal(h.wire.length, 0);
  }
  await h.start("7.2.3");
  const before = h.records.size;
  for (const version of [undefined, "", "latest", "v1.2.3", "01.2.3"]) {
    const payload = { ...h.wire[0], app_version: version };
    const response = await h.handler({
      path: new URL(ENDPOINT).pathname,
      httpMethod: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(h.records.size, before);
  }
});
