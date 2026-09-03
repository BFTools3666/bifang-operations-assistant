import assert from "node:assert/strict";
import test from "node:test";
import {
  FetchTelemetryTransport,
  MemoryIdentityStorage,
  TelemetryClient,
  TelemetryTransportError,
  isUuidV4,
  sanitizeEventProperties,
} from "../dist/index.js";

class CaptureTransport {
  events = [];

  async send(_endpoint, event) {
    this.events.push(structuredClone(event));
  }
}

class AcknowledgingTransport extends CaptureTransport {
  async send(endpoint, event, signal) {
    await super.send(endpoint, event, signal);
    return { httpStatus: 202, ack: { ok: true } };
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

test("drainResults retains synchronous init deliveries and returns each SDK event id", async () => {
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), transport),
  );

  const results = await client.drainResults();
  assert.deepEqual(
    results.map(({ event, outcome, receipt }) => ({
      event,
      outcome,
      receipt,
    })),
    [
      { event: "app_install", outcome: "sent", receipt: null },
      { event: "app_start", outcome: "sent", receipt: null },
    ],
  );
  assert.deepEqual(
    results.map((result) => result.eventId),
    transport.events.map((event) => event.event_id),
  );
  assert.ok(results.every((result) => isUuidV4(result.eventId)));
  assert.deepEqual(await client.drainResults(), []);
});

test("drainResults distinguishes strict service acknowledgements", async () => {
  const transport = new AcknowledgingTransport();
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), transport),
  );

  const automatic = await client.drainResults();
  assert.equal(automatic.length, 2);
  assert.ok(
    automatic.every(
      (result) =>
        result.outcome === "acknowledged" &&
        result.receipt.httpStatus === 202 &&
        result.receipt.ack.ok === true,
    ),
  );

  client.track("feature_used", { feature_id: "cloudbase_validation" });
  client.track("task_succeeded", {
    task_type: "cloudbase_validation",
    duration_ms: 1,
  });
  const manual = await client.drainResults();
  assert.deepEqual(
    manual.map(({ event, outcome }) => ({ event, outcome })),
    [
      { event: "feature_used", outcome: "acknowledged" },
      { event: "task_succeeded", outcome: "acknowledged" },
    ],
  );
  assert.deepEqual(
    manual.map((result) => result.eventId),
    transport.events.slice(-2).map((event) => event.event_id),
  );
});

test("default HTTP transport requires a JSON ok acknowledgement", async () => {
  const originalFetch = globalThis.fetch;
  const cases = [
    {
      response: { ok: true, status: 202, body: '{"ok":true}' },
      expected: {
        outcome: "acknowledged",
        receipt: { httpStatus: 202, ack: { ok: true } },
      },
    },
    {
      response: {
        ok: false,
        status: 403,
        body: '{"ok":false,"error":"unknown_app"}',
      },
      expected: {
        outcome: "failed",
        failure: {
          code: "server_rejected",
          httpStatus: 403,
          serverError: "unknown_app",
        },
      },
    },
    {
      response: { ok: false, status: 404, body: "not json" },
      expected: {
        outcome: "failed",
        failure: { code: "http_error", httpStatus: 404 },
      },
    },
    {
      response: { ok: false, status: 500, body: '{"ok":true}' },
      expected: {
        outcome: "failed",
        failure: { code: "http_error", httpStatus: 500 },
      },
    },
    {
      response: { ok: true, status: 202, body: "not json" },
      expected: {
        outcome: "failed",
        failure: { code: "invalid_response", httpStatus: 202 },
      },
    },
    {
      response: {
        ok: true,
        status: 202,
        body: '{"ok":false,"error":"invalid_payload"}',
      },
      expected: {
        outcome: "failed",
        failure: {
          code: "server_rejected",
          httpStatus: 202,
          serverError: "invalid_payload",
        },
      },
    },
  ];

  try {
    for (const { response, expected } of cases) {
      globalThis.fetch = async () => ({
        ok: response.ok,
        status: response.status,
        text: async () => response.body,
      });
      const client = await TelemetryClient.init(
        clientConfig(
          new MemoryIdentityStorage(),
          new FetchTelemetryTransport(),
        ),
      );
      const results = await client.drainResults();
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.outcome, expected.outcome);
        if (expected.receipt) {
          assert.deepEqual(result.receipt, expected.receipt);
        } else {
          assert.equal(result.receipt, null);
          assert.deepEqual(result.failure, expected.failure);
        }
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("custom transport cannot acknowledge a non-2xx receipt", async () => {
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), {
      async send() {
        return { httpStatus: 500, ack: { ok: true } };
      },
    }),
  );
  const results = await client.drainResults();
  assert.equal(results.length, 2);
  assert.ok(
    results.every(
      (result) =>
        result.outcome === "failed" &&
        result.receipt === null &&
        result.failure.code === "http_error" &&
        result.failure.httpStatus === 500,
    ),
  );
});

test("drainResults exposes network, timeout, and scheduler failures without rejecting", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError("private network detail");
    };
    const networkClient = await TelemetryClient.init(
      clientConfig(new MemoryIdentityStorage(), new FetchTelemetryTransport()),
    );
    const networkResults = await networkClient.drainResults();
    assert.ok(
      networkResults.every(
        (result) =>
          result.outcome === "failed" &&
          result.failure.code === "network_error",
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const timeoutClient = await TelemetryClient.init(
    clientConfig(
      new MemoryIdentityStorage(),
      { send: () => new Promise(() => undefined) },
      { timeoutMs: 5 },
    ),
  );
  const timeoutResults = await timeoutClient.drainResults();
  assert.ok(
    timeoutResults.every(
      (result) =>
        result.outcome === "failed" && result.failure.code === "timeout",
    ),
  );

  const schedulerClient = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), new CaptureTransport(), {
      scheduler() {
        throw new Error("broken scheduler");
      },
    }),
  );
  const schedulerResults = await schedulerClient.drainResults();
  assert.ok(
    schedulerResults.every(
      (result) =>
        result.outcome === "failed" &&
        result.failure.code === "scheduler_error",
    ),
  );

  const droppedSchedulerClient = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), new CaptureTransport(), {
      timeoutMs: 5,
      scheduler() {},
    }),
  );
  const droppedSchedulerResults = await droppedSchedulerClient.drainResults();
  assert.ok(
    droppedSchedulerResults.every(
      (result) =>
        result.outcome === "failed" &&
        result.failure.code === "scheduler_error",
    ),
  );
});

test("transport errors expose only bounded structured server details", () => {
  const error = new TelemetryTransportError("server_rejected", {
    httpStatus: 403,
    serverError: "unknown_app",
  });
  assert.equal(error.code, "server_rejected");
  assert.equal(error.httpStatus, 403);
  assert.equal(error.serverError, "unknown_app");

  const unsafe = new TelemetryTransportError("server_rejected", {
    httpStatus: 999,
    serverError: "raw private response text!",
  });
  assert.equal(unsafe.httpStatus, undefined);
  assert.equal(unsafe.serverError, undefined);
});

test("concurrent drain callers both wait for the same pending sends", async () => {
  const releases = [];
  const client = await TelemetryClient.init(
    clientConfig(new MemoryIdentityStorage(), {
      send() {
        return new Promise((resolve) => releases.push(resolve));
      },
    }),
  );
  assert.equal(releases.length, 2);

  let firstFinished = false;
  let secondFinished = false;
  const first = client.drain().then(() => {
    firstFinished = true;
  });
  const second = client.drain().then(() => {
    secondFinished = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstFinished, false);
  assert.equal(secondFinished, false);

  for (const release of releases) {
    release();
  }
  await Promise.all([first, second]);
  assert.equal(firstFinished, true);
  assert.equal(secondFinished, true);
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
