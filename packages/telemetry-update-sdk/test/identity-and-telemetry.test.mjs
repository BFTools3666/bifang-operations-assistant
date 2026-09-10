import assert from "node:assert/strict";
import test from "node:test";
import {
  FetchTelemetryTransport,
  InstallIdentity,
  MemoryIdentityStorage,
  TelemetryClient,
  TelemetryTransportError,
  isUuidV4,
} from "../dist/index.js";

const DEFAULT_NOW = "2026-09-04T08:09:10.123Z";

class CaptureTransport {
  calls = [];

  async send(endpoint, event, signal) {
    this.calls.push({
      endpoint,
      event: structuredClone(event),
      signal,
    });
  }

  get events() {
    return this.calls.map(({ event }) => event);
  }
}

class CountingMemoryStorage extends MemoryIdentityStorage {
  claims = [];

  async claimActivityDay(day) {
    this.claims.push(day);
    return super.claimActivityDay(day);
  }
}

function clientConfig(storage, transport, overrides = {}) {
  return {
    appId: "bifang-tools",
    appVersion: "0.1.0",
    platform: "windows",
    arch: "x64",
    endpoint: "https://telemetry.example.com/v1/track",
    enabled: true,
    identityStorage: storage,
    transport,
    scheduler: (task) => task(),
    now: () => new Date(DEFAULT_NOW),
    ...overrides,
  };
}

test("first launch sends exactly one minimal daily_active event", async () => {
  const storage = new CountingMemoryStorage();
  const transport = new CaptureTransport();
  const client = await TelemetryClient.init(clientConfig(storage, transport));
  const results = await client.drainResults();

  assert.equal(client.enabled, true);
  assert.equal(transport.events.length, 1);
  assert.deepEqual(storage.claims, ["2026-09-04"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "sent");

  const event = transport.events[0];
  assert.deepEqual(Object.keys(event).sort(), [
    "app_id",
    "app_version",
    "arch",
    "event",
    "event_id",
    "install_id",
    "occurred_at",
    "platform",
    "schema_version",
    "sdk_version",
  ]);
  assert.deepEqual(
    {
      schema_version: event.schema_version,
      event: event.event,
      app_id: event.app_id,
      app_version: event.app_version,
      install_id: event.install_id,
      platform: event.platform,
      arch: event.arch,
      sdk_version: event.sdk_version,
      occurred_at: event.occurred_at,
    },
    {
      schema_version: 2,
      event: "daily_active",
      app_id: "bifang-tools",
      app_version: "0.1.0",
      install_id: client.installId,
      platform: "windows",
      arch: "x64",
      sdk_version: "3.0.0",
      occurred_at: DEFAULT_NOW,
    },
  );
  assert.ok(isUuidV4(event.event_id));
  assert.equal(results[0].event, "daily_active");
  assert.equal(results[0].eventId, event.event_id);
});

test("multiple tools keep telemetry endpoint, identity, and daily gate isolated", async () => {
  const pdfStorage = new CountingMemoryStorage();
  const imageStorage = new CountingMemoryStorage();
  const pdfTransport = new CaptureTransport();
  const imageTransport = new CaptureTransport();
  const pdfEndpoint =
    "https://gateway.example.com/apps/bifang-tools-pdf/v1/track";
  const imageEndpoint =
    "https://gateway.example.com/apps/bifang-tools-image/v1/track";

  const [pdfClient, imageClient] = await Promise.all([
    TelemetryClient.init(
      clientConfig(pdfStorage, pdfTransport, {
        appId: "bifang-tools-pdf",
        endpoint: pdfEndpoint,
      }),
    ),
    TelemetryClient.init(
      clientConfig(imageStorage, imageTransport, {
        appId: "bifang-tools-image",
        endpoint: imageEndpoint,
      }),
    ),
  ]);
  await Promise.all([pdfClient.drain(), imageClient.drain()]);

  assert.notEqual(pdfClient.installId, imageClient.installId);
  assert.deepEqual(pdfStorage.claims, ["2026-09-04"]);
  assert.deepEqual(imageStorage.claims, ["2026-09-04"]);
  assert.deepEqual(
    pdfTransport.calls.map(({ endpoint, event }) => ({
      endpoint,
      appId: event.app_id,
    })),
    [{ endpoint: pdfEndpoint, appId: "bifang-tools-pdf" }],
  );
  assert.deepEqual(
    imageTransport.calls.map(({ endpoint, event }) => ({
      endpoint,
      appId: event.app_id,
    })),
    [{ endpoint: imageEndpoint, appId: "bifang-tools-image" }],
  );

  const restartedPdfTransport = new CaptureTransport();
  const restartedImageTransport = new CaptureTransport();
  await Promise.all([
    TelemetryClient.init(
      clientConfig(pdfStorage, restartedPdfTransport, {
        appId: "bifang-tools-pdf",
        endpoint: pdfEndpoint,
      }),
    ),
    TelemetryClient.init(
      clientConfig(imageStorage, restartedImageTransport, {
        appId: "bifang-tools-image",
        endpoint: imageEndpoint,
      }),
    ),
  ]);
  assert.deepEqual(restartedPdfTransport.events, []);
  assert.deepEqual(restartedImageTransport.events, []);
});

test("another launch in the same Beijing day makes no request", async () => {
  const storage = new CountingMemoryStorage();
  const firstTransport = new CaptureTransport();
  const first = await TelemetryClient.init(
    clientConfig(storage, firstTransport, {
      now: () => new Date("2026-09-04T16:01:00.000Z"),
    }),
  );
  await first.drain();

  const secondTransport = new CaptureTransport();
  const second = await TelemetryClient.init(
    clientConfig(storage, secondTransport, {
      // Both instants are 2026-09-05 in Asia/Shanghai, despite different UTC days.
      now: () => new Date("2026-09-05T15:59:59.999Z"),
    }),
  );

  assert.equal(firstTransport.events.length, 1);
  assert.deepEqual(secondTransport.events, []);
  assert.deepEqual(await second.drainResults(), []);
  assert.deepEqual(storage.claims, ["2026-09-05", "2026-09-05"]);
  assert.equal(second.installId, first.installId);
});

test("a launch on the next Beijing day sends one new event", async () => {
  const storage = new CountingMemoryStorage();
  const firstTransport = new CaptureTransport();
  const first = await TelemetryClient.init(
    clientConfig(storage, firstTransport, {
      now: () => new Date("2026-09-05T15:59:59.999Z"),
    }),
  );
  await first.drain();

  const secondTransport = new CaptureTransport();
  const second = await TelemetryClient.init(
    clientConfig(storage, secondTransport, {
      now: () => new Date("2026-09-05T16:00:00.000Z"),
    }),
  );
  await second.drain();

  assert.deepEqual(storage.claims, ["2026-09-05", "2026-09-06"]);
  assert.equal(firstTransport.events.length, 1);
  assert.equal(secondTransport.events.length, 1);
  assert.equal(second.installId, first.installId);
  assert.notEqual(
    secondTransport.events[0].event_id,
    firstTransport.events[0].event_id,
  );
});

test("concurrent launches sharing one storage send only once", async () => {
  const storage = new MemoryIdentityStorage();
  const transports = Array.from({ length: 12 }, () => new CaptureTransport());
  const clients = await Promise.all(
    transports.map((transport) =>
      TelemetryClient.init(clientConfig(storage, transport)),
    ),
  );
  await Promise.all(clients.map((client) => client.drain()));

  assert.equal(new Set(clients.map(({ installId }) => installId)).size, 1);
  assert.equal(
    transports.reduce((total, transport) => total + transport.events.length, 0),
    1,
  );
});

test("the day is claimed before a network attempt and a failure is not retried that day", async () => {
  const originalFetch = globalThis.fetch;
  const storage = new CountingMemoryStorage();
  let fetchCalls = 0;
  try {
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new TypeError("private network detail");
    };
    const first = await TelemetryClient.init(
      clientConfig(storage, new FetchTelemetryTransport()),
    );
    const firstResults = await first.drainResults();

    assert.equal(fetchCalls, 1);
    assert.equal(firstResults.length, 1);
    assert.equal(firstResults[0].outcome, "failed");
    assert.equal(firstResults[0].failure.code, "network_error");

    const laterTransport = new CaptureTransport();
    const later = await TelemetryClient.init(
      clientConfig(storage, laterTransport),
    );
    assert.deepEqual(await later.drainResults(), []);
    assert.deepEqual(laterTransport.events, []);
    assert.deepEqual(storage.claims, ["2026-09-04", "2026-09-04"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a claim failure fails closed and never reaches the gateway", async () => {
  const transport = new CaptureTransport();
  let claimCalls = 0;
  const storage = new MemoryIdentityStorage();
  storage.claimActivityDay = async () => {
    claimCalls += 1;
    throw new Error("disk unavailable");
  };

  const client = await TelemetryClient.init(clientConfig(storage, transport));

  assert.equal(client.enabled, true);
  assert.equal(claimCalls, 1);
  assert.deepEqual(transport.events, []);
  assert.deepEqual(await client.drainResults(), []);
  await assert.doesNotReject(client.drain());
});

test("disabled and invalid configurations do not claim a day", async (t) => {
  const cases = [
    ["not explicitly enabled", { enabled: undefined }],
    ["invalid app id", { appId: "Invalid App" }],
    ["invalid app version", { appVersion: "latest" }],
    ["invalid platform", { platform: "android" }],
    ["invalid architecture", { arch: "ppc64" }],
    ["unsafe endpoint", { endpoint: "http://telemetry.example.test/track" }],
    ["missing endpoint", { endpoint: undefined }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const storage = new CountingMemoryStorage();
      const transport = new CaptureTransport();
      const client = await TelemetryClient.init(
        clientConfig(storage, transport, overrides),
      );

      assert.equal(client.enabled, false);
      assert.deepEqual(storage.claims, []);
      assert.deepEqual(transport.events, []);
      assert.deepEqual(await client.drainResults(), []);
    });
  }
});

test("acknowledgement, network, timeout, and scheduler outcomes stay isolated", async (t) => {
  await t.test("strict acknowledgement", async () => {
    const client = await TelemetryClient.init(
      clientConfig(new MemoryIdentityStorage(), {
        async send() {
          return { httpStatus: 202, ack: { ok: true } };
        },
      }),
    );
    const results = await client.drainResults();
    assert.equal(results.length, 1);
    assert.deepEqual(
      {
        event: results[0].event,
        outcome: results[0].outcome,
        receipt: results[0].receipt,
      },
      {
        event: "daily_active",
        outcome: "acknowledged",
        receipt: { httpStatus: 202, ack: { ok: true } },
      },
    );
  });

  await t.test("network failure", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        throw new TypeError("do not expose me");
      };
      const client = await TelemetryClient.init(
        clientConfig(
          new MemoryIdentityStorage(),
          new FetchTelemetryTransport(),
        ),
      );
      const results = await client.drainResults();
      assert.equal(results.length, 1);
      assert.equal(results[0].outcome, "failed");
      assert.deepEqual(results[0].failure, { code: "network_error" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.test("timeout", async () => {
    const client = await TelemetryClient.init(
      clientConfig(
        new MemoryIdentityStorage(),
        { send: () => new Promise(() => undefined) },
        { timeoutMs: 5 },
      ),
    );
    const results = await client.drainResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "failed");
    assert.deepEqual(results[0].failure, { code: "timeout" });
    await assert.doesNotReject(client.drain());
  });

  await t.test("scheduler throws", async () => {
    const client = await TelemetryClient.init(
      clientConfig(new MemoryIdentityStorage(), new CaptureTransport(), {
        scheduler() {
          throw new Error("broken scheduler");
        },
      }),
    );
    const results = await client.drainResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "failed");
    assert.deepEqual(results[0].failure, { code: "scheduler_error" });
  });

  await t.test("scheduler drops the task", async () => {
    const client = await TelemetryClient.init(
      clientConfig(new MemoryIdentityStorage(), new CaptureTransport(), {
        timeoutMs: 5,
        scheduler() {},
      }),
    );
    const results = await client.drainResults();
    assert.equal(results.length, 1);
    assert.equal(results[0].outcome, "failed");
    assert.deepEqual(results[0].failure, { code: "scheduler_error" });
  });
});

test("invalid transport receipts and generic transport errors become safe results", async (t) => {
  await t.test("non-2xx acknowledgement", async () => {
    const client = await TelemetryClient.init(
      clientConfig(new MemoryIdentityStorage(), {
        async send() {
          return { httpStatus: 500, ack: { ok: true } };
        },
      }),
    );
    const [result] = await client.drainResults();
    assert.equal(result.outcome, "failed");
    assert.deepEqual(result.failure, { code: "http_error", httpStatus: 500 });
  });

  await t.test("generic transport exception", async () => {
    const client = await TelemetryClient.init(
      clientConfig(new MemoryIdentityStorage(), {
        async send() {
          throw new Error("private exception text");
        },
      }),
    );
    const [result] = await client.drainResults();
    assert.equal(result.outcome, "failed");
    assert.deepEqual(result.failure, { code: "transport_error" });
  });
});

test("transport errors expose only bounded machine-readable details", () => {
  const safe = new TelemetryTransportError("server_rejected", {
    httpStatus: 403,
    serverError: "unknown_app",
  });
  assert.equal(safe.httpStatus, 403);
  assert.equal(safe.serverError, "unknown_app");

  const unsafe = new TelemetryTransportError("server_rejected", {
    httpStatus: 999,
    serverError: "raw private response text!",
  });
  assert.equal(unsafe.httpStatus, undefined);
  assert.equal(unsafe.serverError, undefined);
});

test("install identity remains stable while launch sessions remain distinct", async () => {
  const storage = new MemoryIdentityStorage();
  const first = await new InstallIdentity(storage, {
    now: () => new Date(DEFAULT_NOW),
  }).initialize();
  const second = await new InstallIdentity(storage, {
    now: () => new Date("2026-09-05T00:00:00.000Z"),
  }).initialize();

  assert.ok(isUuidV4(first.installId));
  assert.ok(isUuidV4(first.sessionId));
  assert.equal(first.isFirstInstall, true);
  assert.equal(second.installId, first.installId);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.isFirstInstall, false);
});

test("concurrent identity initialization selects one stable install id", async () => {
  const storage = new MemoryIdentityStorage();
  const identities = await Promise.all(
    Array.from({ length: 12 }, () =>
      new InstallIdentity(storage, {
        now: () => new Date(DEFAULT_NOW),
      }).initialize(),
    ),
  );

  assert.equal(new Set(identities.map(({ installId }) => installId)).size, 1);
  assert.equal(
    identities.filter(({ isFirstInstall }) => isFirstInstall).length,
    1,
  );
  assert.equal(new Set(identities.map(({ sessionId }) => sessionId)).size, 12);
});
