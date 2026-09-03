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
  assert.equal(transport.events[0].channel, "official");
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

test("an explicit valid channel is preserved", async () => {
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), transport, { channel: "beta" }),
  );
  await client.drain();

  assert.equal(client.enabled, true);
  assert.ok(transport.events.length > 0);
  assert.ok(transport.events.every((event) => event.channel === "beta"));
});

test("explicit invalid channels safely disable telemetry", async () => {
  for (const channel of [null, "", "Stable Channel"]) {
    const transport = new CaptureTransport();
    const client = await TelemetryClient.init(
      clientConfig(new MemoryIdentityStorage(), transport, { channel }),
    );
    await client.drain();

    assert.equal(client.enabled, false, String(channel));
    assert.deepEqual(transport.events, [], String(channel));
  }
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

test("only exact event property shapes are sanitized", () => {
  const cases = [
    ["app_install", {}],
    ["app_start", {}],
    ["feature_used", { feature_id: " export_csv " }],
    ["task_started", { task_type: " batch_export " }],
    ["task_succeeded", { task_type: " batch_export ", duration_ms: 0 }],
    ["task_failed", { task_type: " batch_export ", error_code: " E_TIMEOUT " }],
    ["update_prompt_shown", { target_version: "1.10.0-beta.1" }],
    ["update_clicked", { target_version: "1.10.0" }],
  ];

  const expected = [
    {},
    {},
    { feature_id: "export_csv" },
    { task_type: "batch_export" },
    { task_type: "batch_export", duration_ms: 0 },
    { task_type: "batch_export", error_code: "E_TIMEOUT" },
    { target_version: "1.10.0-beta.1" },
    { target_version: "1.10.0" },
  ];

  cases.forEach(([event, properties], index) => {
    assert.deepEqual(
      sanitizeEventProperties(event, properties),
      expected[index],
    );
  });
});

test("old aliases, missing keys, extra keys, and invalid values are rejected", () => {
  const cases = [
    ["app_install", { unexpected: true }],
    ["app_start", { unexpected: true }],
    ["app_start", new Date(0)],
    ["feature_used", { feature: "export_csv" }],
    ["feature_used", { feature_id: "export_csv", extra: true }],
    ["feature_used", { feature_id: "x".repeat(65) }],
    ["task_started", { task_type: "export", duration_ms: 1 }],
    ["task_succeeded", { task_type: "export" }],
    ["task_succeeded", { task_type: "export", duration_ms: 1, extra: true }],
    ["task_succeeded", { task_type: "export", duration_ms: -1 }],
    ["task_succeeded", { task_type: "export", duration_ms: 1.25 }],
    ["task_succeeded", { task_type: "export", duration_ms: 604_800_001 }],
    ["task_failed", { error_code: "E_TIMEOUT" }],
    [
      "task_failed",
      { task_type: "export", error_code: "E_TIMEOUT", extra: true },
    ],
    ["update_prompt_shown", { latest_version: "1.0.0", required: false }],
    ["update_prompt_shown", { target_version: "v1.0.0" }],
    ["update_prompt_shown", { target_version: "1.0.0", required: false }],
    ["update_clicked", { latest_version: "1.0.0", action: "update_now" }],
    ["update_clicked", { target_version: "1.0.0", action: "update_now" }],
  ];

  for (const [event, properties] of cases) {
    assert.equal(sanitizeEventProperties(event, properties), null, event);
  }
});

test("track drops the whole event instead of stripping extra fields", async () => {
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), transport),
  );
  await client.drain();
  transport.events.length = 0;

  client.track("feature_used", {
    feature_id: "export_csv",
    ignored_user_text: "must not leave the client",
    nested: { secret: true },
  });
  client.track("feature_used", { feature_id: " export_csv " });
  await client.drain();

  assert.equal(transport.events.length, 1);
  assert.equal(transport.events[0].event, "feature_used");
  assert.deepEqual(transport.events[0].properties, {
    feature_id: "export_csv",
  });
  assert.ok(Object.keys(transport.events[0].properties).length <= 20);
});

test("update helpers emit only the exact target_version property", async () => {
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), transport),
  );
  await client.drain();
  transport.events.length = 0;

  const decision = {
    kind: "optional",
    config: { latest_version: "1.2.3" },
  };
  client.trackUpdatePromptShown(decision);
  client.trackUpdateClicked(decision);
  await client.drain();

  assert.deepEqual(
    transport.events.map(({ event, properties }) => ({ event, properties })),
    [
      {
        event: "update_prompt_shown",
        properties: { target_version: "1.2.3" },
      },
      {
        event: "update_clicked",
        properties: { target_version: "1.2.3" },
      },
    ],
  );
});

test("task_failed requires task_type and error_code with no extra fields", () => {
  assert.deepEqual(
    sanitizeEventProperties("task_failed", {
      task_type: "export",
      error_code: "EXPORT_TIMEOUT",
    }),
    { task_type: "export", error_code: "EXPORT_TIMEOUT" },
  );
  assert.equal(
    sanitizeEventProperties("task_failed", {
      task_type: "export",
      error_code: "EXPORT_TIMEOUT",
      exception: "private exception message",
    }),
    null,
  );
  assert.equal(
    sanitizeEventProperties("task_failed", {
      task_type: "export",
      error_code: "contains spaces and user text",
    }),
    null,
  );
});

test("property identifiers reject high-confidence sensitive values", () => {
  for (const featureId of [
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
      sanitizeEventProperties("feature_used", { feature_id: featureId }),
      null,
      featureId,
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
  client.track("feature_used", { feature_id: "export_csv" });
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
    rejectingClient.track("feature_used", { feature_id: "export_csv" }),
  );
  await assert.doesNotReject(rejectingClient.drain());

  const hangingClient = await TelemetryClient.init(
    clientConfig(
      new MemoryIdentityStorage(),
      { send: () => new Promise(() => undefined) },
      { timeoutMs: 5 },
    ),
  );
  hangingClient.track("feature_used", { feature_id: "export_csv" });
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
