import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryIdentityStorage,
  TelemetryClient,
  isUuidV4,
  sanitizeEventProperties,
} from "../dist/index.js";

class CaptureTransport {
  events = [];

  async send(_endpoint, event) {
    this.events.push(structuredClone(event));
  }
}

function clientConfig(storage, transport, overrides = {}) {
  return {
    appId: "example-tool",
    appVersion: "0.1.0",
    platform: "windows",
    arch: "x64",
    channel: "stable",
    endpoint: "https://telemetry.example.invalid/v1/track",
    enabled: true,
    identityStorage: storage,
    transport,
    scheduler: (task) => task(),
    ...overrides,
  };
}

test("first init persists identity and queues app_install then app_start", async () => {
  const storage = new MemoryIdentityStorage();
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(clientConfig(storage, transport));
  await client.drain();

  assert.equal(transport.events.length, 2);
  assert.deepEqual(
    transport.events.map((event) => event.event),
    ["app_install", "app_start"],
  );
  assert.ok(isUuidV4(client.installId));
  assert.ok(isUuidV4(client.sessionId));
  assert.equal(transport.events[0].install_id, client.installId);
  assert.equal(transport.events[0].session_id, client.sessionId);
  assert.equal(transport.events[0].schema_version, 1);
  assert.equal(transport.events[0].sdk_version, "1.0.0");
  assert.deepEqual(transport.events[0].properties, {});
});

test("second init keeps install_id, changes session_id, and does not repeat app_install", async () => {
  const storage = new MemoryIdentityStorage();
  const firstTransport = new CaptureTransport();
  const first = await TelemetryClient.init(
    clientConfig(storage, firstTransport),
  );
  await first.drain();

  const secondTransport = new CaptureTransport();
  const second = await TelemetryClient.init(
    clientConfig(storage, secondTransport),
  );
  await second.drain();

  assert.equal(second.installId, first.installId);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.deepEqual(
    secondTransport.events.map((event) => event.event),
    ["app_start"],
  );
});

test("concurrent init on one storage creates one install marker and one install event", async () => {
  const storage = new MemoryIdentityStorage();
  const firstTransport = new CaptureTransport();
  const secondTransport = new CaptureTransport();

  const [first, second] = await Promise.all([
    TelemetryClient.init(clientConfig(storage, firstTransport)),
    TelemetryClient.init(clientConfig(storage, secondTransport)),
  ]);
  await Promise.all([first.drain(), second.drain()]);

  assert.equal(first.installId, second.installId);
  assert.notEqual(first.sessionId, second.sessionId);
  const allEvents = [...firstTransport.events, ...secondTransport.events];
  assert.equal(
    allEvents.filter((event) => event.event === "app_install").length,
    1,
  );
  assert.equal(
    allEvents.filter((event) => event.event === "app_start").length,
    2,
  );
});

test("feature_used is typed, sanitized, bounded, and contains only allowlisted fields", async () => {
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), transport),
  );
  await client.drain();
  transport.events.length = 0;

  client.track("feature_used", {
    feature: " export_csv ",
    ignored_user_text: "must not leave the client",
    nested: { secret: true },
  });
  client.track("feature_used", { feature: "x".repeat(65) });
  await client.drain();

  assert.equal(transport.events.length, 1);
  assert.equal(transport.events[0].event, "feature_used");
  assert.deepEqual(transport.events[0].properties, { feature: "export_csv" });
  assert.ok(Object.keys(transport.events[0].properties).length <= 20);
});

test("task_failed accepts only an error_code", async () => {
  assert.deepEqual(
    sanitizeEventProperties("task_failed", {
      error_code: "EXPORT_TIMEOUT",
      exception: "private exception message",
      path: "C:/private/file.txt",
    }),
    { error_code: "EXPORT_TIMEOUT" },
  );
  assert.equal(
    sanitizeEventProperties("task_failed", {
      error_code: "contains spaces and user text",
    }),
    null,
  );
});

test("property identifiers reject high-confidence sensitive values", () => {
  for (const feature of [
    "AA:BB:CC:DD:EE:FF",
    "AA-BB-CC-DD-EE-FF",
    "AABBCCDDEEFF",
    "aabb.ccdd.eeff",
    "13800138000",
    "138-0013-8000",
    "11010519491231002X",
    "550e8400-e29b-41d4-a716-446655440000",
    "0123456789abcdef",
    "U29tZVNlbnNpdGl2ZURhdGE",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
  ]) {
    assert.equal(
      sanitizeEventProperties("feature_used", { feature }),
      null,
      feature,
    );
  }
});

test("telemetry is disabled unless explicitly enabled", async () => {
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), transport, {
      enabled: undefined,
    }),
  );
  client.track("feature_used", { feature: "export_csv" });
  await client.drain();

  assert.equal(client.enabled, false);
  assert.deepEqual(transport.events, []);
});

test("unreachable transport and timeout never throw into host code", async () => {
  const rejectingClient = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), {
      async send() {
        throw new Error("network unreachable");
      },
    }),
  );
  assert.doesNotThrow(() =>
    rejectingClient.track("feature_used", { feature: "export_csv" }),
  );
  await assert.doesNotReject(rejectingClient.drain());

  const hangingClient = await TelemetryClient.init(
    clientConfig(
      new MemoryIdentityStorage(),
      { send: () => new Promise(() => undefined) },
      { timeoutMs: 5 },
    ),
  );
  hangingClient.track("feature_used", { feature: "export_csv" });
  await assert.doesNotReject(hangingClient.drain());
});

test("broken storage recovers silently with a valid ephemeral identity", async () => {
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(
    clientConfig(
      {
        async read() {
          throw new Error("read failed");
        },
        async write() {
          throw new Error("write failed");
        },
      },
      transport,
    ),
  );
  await assert.doesNotReject(client.drain());
  assert.ok(isUuidV4(client.installId));
  assert.ok(isUuidV4(client.sessionId));
  assert.deepEqual(
    transport.events.map((event) => event.event),
    ["app_start"],
  );
});
