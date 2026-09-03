"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const { createBurstGuard } = require("../src/burst-guard");
const {
  createHandler,
  extractRequest,
  normalizeAllowedAppIds,
} = require("../src/handler");
const {
  isIso8601,
  isSemVer,
  validateAndSanitizePayload,
} = require("../src/validation");
const {
  createCloudBaseWriter,
  createDefaultCloudBaseApp,
  isDuplicateWriteError,
} = require("../src/writer");
const publicApi = require("../index");

const EVENT_ID = "018f47a2-8b2d-4c6d-9a3f-8f4a8dc6d7b1";
const INSTALL_ID = "87d6a4ee-df1d-471e-b3ee-cb32f547e429";
const SESSION_ID = "d8024d55-17bf-4e8d-9218-2e2fd36f67b5";
const SERVER_TIME = new Date("2026-09-03T01:02:03.456Z");

function makePayload(overrides = {}) {
  return {
    schema_version: 1,
    event_id: EVENT_ID,
    event: "app_start",
    app_id: "example-tool",
    app_version: "0.1.0",
    install_id: INSTALL_ID,
    session_id: SESSION_ID,
    platform: "windows",
    arch: "x64",
    channel: "stable",
    sdk_version: "1.0.0",
    occurred_at: "2026-09-03T00:59:58.123Z",
    properties: {},
    ...overrides,
  };
}

function makeRequest(body, overrides = {}) {
  return {
    path: "/v1/track",
    httpMethod: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...overrides,
  };
}

function parseResponse(response) {
  return response.body ? JSON.parse(response.body) : undefined;
}

function makeHarness(options = {}) {
  const writes = [];
  const handler = createHandler({
    allowedAppIds: ["example-tool"],
    writer: async (document) => {
      writes.push(document);
    },
    now: () => SERVER_TIME,
    logger: { error() {} },
    ...options,
  });
  return { handler, writes };
}

describe("HTTP Event function handler", () => {
  test("accepts a valid event, reconstructs it, and overwrites received_at", async () => {
    const { handler, writes } = makeHarness();
    const clientReceivedAt = "1999-01-01T00:00:00.000Z";
    const request = makeRequest(
      makePayload({
        received_at: clientReceivedAt,
      }),
    );
    request.requestContext = { sourceIp: "203.0.113.9" };

    const response = await handler(request);

    assert.equal(response.statusCode, 202);
    assert.deepEqual(parseResponse(response), { ok: true });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].received_at, SERVER_TIME.toISOString());
    assert.notEqual(writes[0].received_at, clientReceivedAt);
    assert.equal(writes[0]._id, EVENT_ID);
    assert.equal(writes[0].event_id, EVENT_ID);
    assert.equal("sourceIp" in writes[0], false);
    assert.equal(response.headers["Access-Control-Allow-Origin"], "*");
  });

  test("accepts each event with its documented property shape", async () => {
    const { handler, writes } = makeHarness();
    const cases = [
      ["app_install", {}],
      ["app_start", {}],
      ["feature_used", { feature: "export.pdf" }],
      ["task_started", { task_type: "batch_export" }],
      ["task_succeeded", { task_type: "batch_export", duration_ms: 1250 }],
      ["task_failed", { error_code: "E_NETWORK_TIMEOUT" }],
      [
        "update_prompt_shown",
        { latest_version: "1.10.0-beta.1", required: false },
      ],
      ["update_clicked", { latest_version: "1.10.0", action: "remind_later" }],
    ];

    for (const [index, [event, properties]] of cases.entries()) {
      const uniqueEventId = `018f47a2-8b2d-4c6d-${(0x9a3f + index)
        .toString(16)
        .padStart(4, "0")}-8f4a8dc6d7b1`;
      const response = await handler(
        makeRequest(
          makePayload({ event_id: uniqueEventId, event, properties }),
        ),
      );
      assert.equal(response.statusCode, 202, event);
    }

    assert.equal(writes.length, cases.length);
  });

  test("valid feature_used reaches the writer with only allowed properties", async () => {
    const { handler, writes } = makeHarness();
    const response = await handler(
      makeRequest(
        makePayload({
          event: "feature_used",
          properties: { feature: "quick_capture" },
        }),
      ),
    );

    assert.equal(response.statusCode, 202);
    assert.deepEqual(writes[0].properties, { feature: "quick_capture" });
  });

  test("returns 400 and never writes malformed, oversized, encoded, or non-JSON bodies", async () => {
    const { handler, writes } = makeHarness();
    const cases = [
      makeRequest("{"),
      makeRequest("[]"),
      makeRequest(`${" ".repeat(4097)}`),
      makeRequest(makePayload(), { isBase64Encoded: true }),
      makeRequest(makePayload(), { isBase64Encoded: "true" }),
      makeRequest(makePayload(), { headers: {} }),
      makeRequest(makePayload(), {
        headers: { "content-type": "application/octet-stream" },
      }),
      makeRequest(makePayload(), { body: Buffer.from("{}") }),
    ];

    for (const request of cases) {
      const response = await handler(request);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(parseResponse(response), {
        ok: false,
        error: "invalid_payload",
      });
    }
    assert.equal(writes.length, 0);
  });

  test("returns 400 without writing for disallowed event properties", async () => {
    const { handler, writes } = makeHarness();
    const cases = [
      ["app_start", { unexpected: true }],
      ["feature_used", { feature: "quick_capture", email: "x@example.com" }],
      ["feature_used", { feature: { nested: true } }],
      ["feature_used", { feature: ["nested"] }],
      ["feature_used", { feature: "folder/name" }],
      ["feature_used", { feature: "data:text/plain;base64,SGVsbG8=" }],
      ["feature_used", { feature: "AA:BB:CC:DD:EE:FF" }],
      ["feature_used", { feature: "AA-BB-CC-DD-EE-FF" }],
      ["feature_used", { feature: "AABBCCDDEEFF" }],
      ["feature_used", { feature: "aabb.ccdd.eeff" }],
      ["feature_used", { feature: "13800138000" }],
      ["feature_used", { feature: "138-0013-8000" }],
      ["feature_used", { feature: "11010519491231002X" }],
      ["feature_used", { feature: "550e8400-e29b-41d4-a716-446655440000" }],
      ["feature_used", { feature: "0123456789abcdef" }],
      ["feature_used", { feature: "U29tZVNlbnNpdGl2ZURhdGE" }],
      [
        "feature_used",
        {
          feature:
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
        },
      ],
      ["task_started", { task_type: "export", duration_ms: -1 }],
      ["task_succeeded", { task_type: "export", duration_ms: 1.25 }],
      ["task_failed", { error_code: "E_TIMEOUT", task_type: "export" }],
      ["update_prompt_shown", { latest_version: "1.0.0", required: "false" }],
      ["update_clicked", { latest_version: "1.0.0", action: "download" }],
    ];

    for (const [event, properties] of cases) {
      const response = await handler(
        makeRequest(makePayload({ event, properties })),
      );
      assert.equal(response.statusCode, 400, event);
    }
    assert.equal(writes.length, 0);
  });

  test("returns 400 without writing for invalid envelope fields", async () => {
    const { handler, writes } = makeHarness();
    const cases = [
      { schema_version: 2 },
      { event_id: "not-a-uuid" },
      { event: "user_profile_viewed" },
      { app_id: "Bad App" },
      { app_version: "01.0.0" },
      { install_id: "not-a-uuid" },
      { session_id: "not-a-uuid" },
      { platform: "android" },
      { arch: "mips" },
      { channel: "Stable Channel" },
      { sdk_version: "v1.0.0" },
      { occurred_at: "2026-02-30T00:00:00Z" },
      { extra_field: "not-allowed" },
    ];

    for (const overrides of cases) {
      const response = await handler(makeRequest(makePayload(overrides)));
      assert.equal(response.statusCode, 400, JSON.stringify(overrides));
    }
    assert.equal(writes.length, 0);
  });

  test("rejects a syntactically valid but unknown app without writing", async () => {
    const { handler, writes } = makeHarness();
    const response = await handler(
      makeRequest(makePayload({ app_id: "another-tool" })),
    );

    assert.equal(response.statusCode, 403);
    assert.deepEqual(parseResponse(response), {
      ok: false,
      error: "unknown_app",
    });
    assert.equal(writes.length, 0);
  });

  test("supports CORS preflight before requiring a JSON content type", async () => {
    const { handler, writes } = makeHarness();
    const response = await handler({
      path: "/v1/track",
      httpMethod: "OPTIONS",
      headers: { Origin: "tauri://localhost" },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.body, "");
    assert.equal(
      response.headers["Access-Control-Allow-Methods"],
      "POST, OPTIONS",
    );
    assert.equal(writes.length, 0);
  });

  test("returns safe 404 and 405 responses for routes outside the contract", async () => {
    const { handler, writes } = makeHarness();
    const missing = await handler({ path: "/health", httpMethod: "GET" });
    const wrongMethod = await handler({ path: "/v1/track", httpMethod: "GET" });

    assert.equal(missing.statusCode, 404);
    assert.deepEqual(parseResponse(missing), { ok: false, error: "not_found" });
    assert.equal(wrongMethod.statusCode, 405);
    assert.deepEqual(parseResponse(wrongMethod), {
      ok: false,
      error: "method_not_allowed",
    });
    assert.equal(writes.length, 0);
  });

  test("returns only a generic 500 response when storage fails", async () => {
    const logs = [];
    const handler = createHandler({
      allowedAppIds: "example-tool",
      writer: async () => {
        throw new Error("database secret and stack must not leak");
      },
      now: () => SERVER_TIME,
      logger: { error: (...args) => logs.push(args) },
    });

    const response = await handler(makeRequest(makePayload()));

    assert.equal(response.statusCode, 500);
    assert.deepEqual(parseResponse(response), {
      ok: false,
      error: "internal_error",
    });
    assert.equal(response.body.includes("database"), false);
    assert.deepEqual(logs, [["telemetry_write_failed"]]);
  });

  test("a broken diagnostic logger cannot escape the generic error boundary", async () => {
    const handler = createHandler({
      allowedAppIds: "example-tool",
      writer: async () => {
        throw new Error("storage failure");
      },
      now: () => SERVER_TIME,
      logger: {
        error() {
          throw new Error("logger failure");
        },
      },
    });

    const response = await handler(makeRequest(makePayload()));
    assert.equal(response.statusCode, 500);
    assert.deepEqual(parseResponse(response), {
      ok: false,
      error: "internal_error",
    });
  });

  test("enforces an injected per-instance burst guard without another write", async () => {
    let clock = 1000;
    const guard = createBurstGuard({
      limit: 1,
      windowMs: 10_000,
      nowMs: () => clock,
    });
    const { handler, writes } = makeHarness({ burstGuard: guard });

    const accepted = await handler(makeRequest(makePayload()));
    const limited = await handler(makeRequest(makePayload()));
    clock += 10_000;
    const acceptedAfterWindow = await handler(makeRequest(makePayload()));

    assert.equal(accepted.statusCode, 202);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(parseResponse(limited), {
      ok: false,
      error: "rate_limited",
    });
    assert.equal(acceptedAfterWindow.statusCode, 202);
    assert.equal(writes.length, 2);
  });
});

describe("gateway shape and validation helpers", () => {
  test("extracts API Gateway v2 and context HTTP shapes", () => {
    assert.deepEqual(
      extractRequest({
        rawPath: "/v1/track",
        requestContext: { http: { method: "post" } },
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      {
        method: "POST",
        path: "/v1/track",
        headers: { "content-type": "application/json" },
        body: "{}",
        isBase64Encoded: false,
      },
    );

    assert.equal(
      extractRequest(
        { body: "{}" },
        {
          httpContext: {
            httpMethod: "POST",
            url: "https://example.invalid/v1/track?source=test",
            headers: { "Content-Type": "application/json" },
          },
        },
      ).path,
      "/v1/track",
    );

    assert.deepEqual(extractRequest(null, null), {
      method: "",
      path: "",
      headers: {},
      body: undefined,
      isBase64Encoded: false,
    });
  });

  test("normalizes a comma-separated ALLOWED_APP_IDS whitelist", () => {
    assert.deepEqual(
      [
        ...normalizeAllowedAppIds(
          " example-tool,second_tool.beta, Bad App,example-tool ",
        ),
      ],
      ["example-tool", "second_tool.beta"],
    );
  });

  test("exports a lazy CloudBase entrypoint and injectable test APIs", () => {
    assert.equal(typeof publicApi.main, "function");
    assert.equal(publicApi.handler, publicApi.main);
    assert.equal(typeof publicApi.createHandler, "function");
    assert.equal(typeof publicApi.createCloudBaseWriter, "function");
  });

  test("uses strict SemVer including normal prerelease syntax", () => {
    for (const version of [
      "0.1.0",
      "1.10.0",
      "1.0.0-alpha.1",
      "1.0.0+build.7",
    ]) {
      assert.equal(isSemVer(version), true, version);
    }
    for (const version of ["v1.0.0", "1.0", "01.0.0", "1.0.0-01", "1.0.0+"]) {
      assert.equal(isSemVer(version), false, version);
    }
  });

  test("validates real ISO instants rather than normalized invalid dates", () => {
    assert.equal(isIso8601("2024-02-29T23:59:59.999Z"), true);
    assert.equal(isIso8601("2026-09-03T09:00:00+08:00"), true);
    assert.equal(isIso8601("2026-02-29T00:00:00Z"), false);
    assert.equal(isIso8601("2026-09-03 09:00:00"), false);
    assert.equal(isIso8601("2026-09-03T09:00:00+14:01"), false);
  });

  test("enforces no more than twenty primitive property values before event rules", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 21 }, (_, index) => [`key${index}`, index]),
    );
    const result = validateAndSanitizePayload(
      makePayload({ event: "feature_used", properties }),
    );
    assert.equal(result.ok, false);
  });
});

describe("CloudBase writer adapter", () => {
  test("uses the current-environment symbol unless an explicit override exists", () => {
    const initCalls = [];
    const currentEnv = Symbol("current-cloudbase-environment");
    const cloudbaseModule = {
      SYMBOL_CURRENT_ENV: currentEnv,
      init(options) {
        initCalls.push(options);
        return { database() {} };
      },
    };

    createDefaultCloudBaseApp({ cloudbaseModule, envOverride: null });
    createDefaultCloudBaseApp({
      cloudbaseModule,
      envOverride: "  explicit-env-id  ",
    });

    assert.deepEqual(initCalls, [
      { env: currentEnv },
      { env: "explicit-env-id" },
    ]);
  });

  test("real js-sdk resolves the Event-runtime environment synchronously without database I/O", () => {
    const writerPath = require.resolve("../src/writer");
    const script = `
      process.env.TCB_ENV = "test-runtime-env-123456";
      process.env.SCF_NAMESPACE = "test-runtime-env-123456";
      delete process.env.CLOUDBASE_ENV_ID;
      delete process.env.TENCENTCLOUD_RUNENV;
      const { createDefaultCloudBaseApp } = require(${JSON.stringify(writerPath)});
      const app = createDefaultCloudBaseApp();
      if (!app || typeof app.database !== "function") {
        throw new Error("real CloudBase SDK did not return an app");
      }
      process.stdout.write("initialized");
      // The SDK owns an auth-state MessagePort. This isolated test process exits
      // explicitly after synchronous initialization; no database API is called.
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      timeout: 5_000,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "initialized");
  });

  test("is lazy, writes to telemetry_events, and fixes _id to event_id", async () => {
    let appFactoryCalls = 0;
    let selectedCollection;
    const added = [];
    const writer = createCloudBaseWriter({
      appFactory: async () => {
        appFactoryCalls += 1;
        return {
          database() {
            return {
              collection(name) {
                selectedCollection = name;
                return {
                  async add(document) {
                    added.push(document);
                  },
                };
              },
            };
          },
        };
      },
    });

    assert.equal(appFactoryCalls, 0);
    await writer({
      event_id: EVENT_ID,
      _id: "client-value",
      event: "app_start",
    });
    await writer({ event_id: INSTALL_ID, event: "app_start" });

    assert.equal(appFactoryCalls, 1);
    assert.equal(selectedCollection, "telemetry_events");
    assert.equal(added[0]._id, EVENT_ID);
    assert.equal(added[1]._id, INSTALL_ID);
  });

  test("treats a duplicate _id insert as an idempotent success", async () => {
    const writer = createCloudBaseWriter({
      appFactory: () => ({
        database: () => ({
          collection: () => ({
            add: async () => {
              const error = new Error("E11000 duplicate key error");
              error.code = 11000;
              throw error;
            },
          }),
        }),
      }),
    });

    assert.deepEqual(await writer({ event_id: EVENT_ID }), { duplicate: true });
    assert.equal(isDuplicateWriteError({ code: 11000 }), true);
    assert.equal(isDuplicateWriteError(new Error("permission denied")), false);
  });

  test("propagates non-duplicate database failures to the generic handler boundary", async () => {
    const failure = new Error("permission denied");
    const writer = createCloudBaseWriter({
      appFactory: () => ({
        database: () => ({
          collection: () => ({ add: async () => Promise.reject(failure) }),
        }),
      }),
    });

    await assert.rejects(writer({ event_id: EVENT_ID }), failure);
  });
});
