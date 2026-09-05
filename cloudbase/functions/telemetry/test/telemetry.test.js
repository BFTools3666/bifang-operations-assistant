"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { describe, test } = require("node:test");

const { createBurstGuard } = require("../src/burst-guard");
const {
  createDailyActiveId,
  createHandler,
  extractRequest,
  extractTrustedSourceIp,
  normalizeSingleAllowedAppId,
  normalizeTrackPath,
  toShanghaiDate,
} = require("../src/handler");
const {
  EVENTS,
  isIso8601,
  isSemVer,
  validateAndSanitizePayload,
} = require("../src/validation");
const {
  COLLECTION_NAME_PATTERN,
  createCloudBaseWriter,
  createDefaultCloudBaseApp,
  isDuplicateWriteError,
  normalizeCollectionName,
} = require("../src/writer");
const publicApi = require("../index");

const EVENT_ID = "018f47a2-8b2d-4c6d-9a3f-8f4a8dc6d7b1";
const SECOND_EVENT_ID = "5aee2344-a955-4568-8f89-74c3b7e9f04a";
const INSTALL_ID = "87d6a4ee-df1d-471e-b3ee-cb32f547e429";
const SECOND_INSTALL_ID = "d8024d55-17bf-4e8d-9218-2e2fd36f67b5";
const SERVER_TIME = new Date("2026-09-03T16:02:03.456Z");
const TEST_TRACK_PATH = "/apps/bifang-tools/v1/track";

function makePayload(overrides = {}) {
  return {
    schema_version: 2,
    event_id: EVENT_ID,
    event: "daily_active",
    app_id: "bifang-tools",
    app_version: "0.1.0",
    install_id: INSTALL_ID,
    platform: "windows",
    arch: "x64",
    sdk_version: "2.0.0",
    occurred_at: "2026-09-03T16:01:58.123Z",
    ...overrides,
  };
}

function makeRequest(body, overrides = {}) {
  return {
    path: TEST_TRACK_PATH,
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
    allowedAppIds: ["bifang-tools"],
    trackPath: TEST_TRACK_PATH,
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
  test("accepts only daily_active and adds Shanghai-day server metadata", async () => {
    const { handler, writes } = makeHarness();
    const request = makeRequest(makePayload());
    request.requestContext = { http: { sourceIp: "203.0.113.9" } };

    const response = await handler(request);

    assert.equal(response.statusCode, 202);
    assert.deepEqual(parseResponse(response), { ok: true });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], {
      ...makePayload(),
      _id: createDailyActiveId("bifang-tools", "2026-09-04", INSTALL_ID),
      active_date: "2026-09-04",
      received_at: SERVER_TIME.toISOString(),
      source_ip: "203.0.113.9",
    });
    assert.equal(response.body.includes("203.0.113.9"), false);
    assert.equal(response.body.includes(INSTALL_ID), false);
    assert.equal(response.headers["Access-Control-Allow-Origin"], "*");
  });

  test("deduplicates by app, Shanghai date, and installation rather than event id", async () => {
    const { handler, writes } = makeHarness();

    assert.equal((await handler(makeRequest(makePayload()))).statusCode, 202);
    assert.equal(
      (await handler(makeRequest(makePayload({ event_id: SECOND_EVENT_ID }))))
        .statusCode,
      202,
    );
    assert.equal(writes.length, 2);
    assert.equal(writes[0]._id, writes[1]._id);
    assert.notEqual(writes[0]._id, EVENT_ID);

    const otherInstall = await handler(
      makeRequest(
        makePayload({
          event_id: SECOND_EVENT_ID,
          install_id: SECOND_INSTALL_ID,
        }),
      ),
    );
    assert.equal(otherInstall.statusCode, 202);
    assert.notEqual(writes[0]._id, writes[2]._id);
  });

  test("extracts IP only from trusted contexts and stores null when absent", async () => {
    const cases = [
      [
        { requestContext: { http: { sourceIp: " 2001:db8::1 " } } },
        {},
        "2001:db8::1",
      ],
      [{ requestContext: { sourceIp: "198.51.100.8" } }, {}, "198.51.100.8"],
      [{}, { httpContext: { sourceIp: "192.0.2.4" } }, "192.0.2.4"],
      [{}, { httpContext: { clientIp: "2001:db8::8" } }, "2001:db8::8"],
      [
        {
          requestContext: { http: { sourceIp: "not-an-ip" } },
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.77",
          },
        },
        {},
        null,
      ],
    ];

    for (const [eventExtras, context, expected] of cases) {
      const { handler, writes } = makeHarness();
      const request = makeRequest(makePayload(), eventExtras);
      const response = await handler(request, context);
      assert.equal(response.statusCode, 202);
      assert.equal(writes[0].source_ip, expected);
      assert.equal(response.body.includes(String(expected)), false);
    }
  });

  test("rejects client-supplied IP, old telemetry fields, and every unknown field", async () => {
    const { handler, writes } = makeHarness();
    const cases = [
      { source_ip: "203.0.113.9" },
      { ip: "203.0.113.9" },
      { client_ip: "203.0.113.9" },
      { received_at: "2026-09-03T16:02:03.456Z" },
      { session_id: SECOND_INSTALL_ID },
      { channel: "official" },
      { properties: {} },
      { extra_field: true },
    ];

    for (const extra of cases) {
      const response = await handler(makeRequest(makePayload(extra)));
      assert.equal(response.statusCode, 400, JSON.stringify(extra));
    }
    assert.equal(writes.length, 0);
  });

  test("rejects old, high-frequency, and malformed envelope variants", async () => {
    const { handler, writes } = makeHarness();
    const cases = [
      { schema_version: 1 },
      { schema_version: "2" },
      { event_id: "not-a-uuid" },
      { event: "app_install" },
      { event: "app_start" },
      { event: "feature_used" },
      { app_id: "Bad App" },
      { app_version: "01.0.0" },
      { install_id: "not-a-uuid" },
      { platform: "android" },
      { arch: "mips" },
      { sdk_version: "2.0.1" },
      { sdk_version: "v2.0.0" },
      { occurred_at: "2026-02-30T00:00:00Z" },
    ];

    for (const overrides of cases) {
      const response = await handler(makeRequest(makePayload(overrides)));
      assert.equal(response.statusCode, 400, JSON.stringify(overrides));
    }
    assert.equal(writes.length, 0);
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

  test("fails closed when a function is configured for zero or multiple apps", async () => {
    for (const allowedAppIds of [
      "",
      "bifang-tools,another-tool",
      "bifang-tools,Bad App",
    ]) {
      const { handler, writes } = makeHarness({ allowedAppIds });
      const response = await handler(makeRequest(makePayload()));

      assert.equal(response.statusCode, 403);
      assert.deepEqual(parseResponse(response), {
        ok: false,
        error: "unknown_app",
      });
      assert.equal(writes.length, 0);
    }
  });

  test("accepts only the configured app-specific tracking path", async () => {
    const trackPath = TEST_TRACK_PATH;
    const { handler, writes } = makeHarness({ trackPath });

    const legacyResponse = await handler(
      makeRequest(makePayload(), { path: "/v1/track" }),
    );
    const isolatedResponse = await handler(
      makeRequest(makePayload(), { path: trackPath }),
    );

    assert.equal(legacyResponse.statusCode, 404);
    assert.equal(isolatedResponse.statusCode, 202);
    assert.equal(writes.length, 1);
  });

  test("supports CORS preflight before requiring a JSON content type", async () => {
    const { handler, writes } = makeHarness();
    const response = await handler({
      path: TEST_TRACK_PATH,
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
    const wrongMethod = await handler({
      path: TEST_TRACK_PATH,
      httpMethod: "GET",
    });

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
      allowedAppIds: "bifang-tools",
      trackPath: TEST_TRACK_PATH,
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
      allowedAppIds: "bifang-tools",
      trackPath: TEST_TRACK_PATH,
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

  test("preserves the injected per-instance burst guard", async () => {
    let clock = 1000;
    const guard = createBurstGuard({
      limit: 1,
      windowMs: 10_000,
      nowMs: () => clock,
    });
    const { handler, writes } = makeHarness({ burstGuard: guard });

    const accepted = await handler(makeRequest(makePayload()));
    const limited = await handler(
      makeRequest(makePayload({ event_id: SECOND_EVENT_ID })),
    );
    clock += 10_000;
    const acceptedAfterWindow = await handler(
      makeRequest(makePayload({ event_id: SECOND_EVENT_ID })),
    );

    assert.equal(accepted.statusCode, 202);
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(parseResponse(limited), {
      ok: false,
      error: "rate_limited",
    });
    assert.equal(acceptedAfterWindow.statusCode, 202);
    assert.equal(writes.length, 2);
    assert.equal(writes[0]._id, writes[1]._id);
  });
});

describe("gateway shape and validation helpers", () => {
  test("extracts API Gateway v2 and context HTTP shapes without headers as IP", () => {
    assert.deepEqual(
      extractRequest({
        rawPath: "/v1/track",
        requestContext: { http: { method: "post" } },
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.77",
        },
        body: "{}",
      }),
      {
        method: "POST",
        path: "/v1/track",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.77",
        },
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

  test("uses the documented trusted IP precedence and validates addresses", () => {
    assert.equal(
      extractTrustedSourceIp(
        {
          requestContext: {
            http: { sourceIp: "203.0.113.1" },
            sourceIp: "203.0.113.2",
          },
          headers: { "x-forwarded-for": "203.0.113.99" },
        },
        { httpContext: { sourceIp: "203.0.113.3", clientIp: "203.0.113.4" } },
      ),
      "203.0.113.1",
    );
    assert.equal(
      extractTrustedSourceIp(
        { requestContext: { http: { sourceIp: "bad" }, sourceIp: "::1" } },
        {},
      ),
      "::1",
    );
    assert.equal(
      extractTrustedSourceIp({ headers: { "x-real-ip": "203.0.113.8" } }, {}),
      null,
    );
  });

  test("derives calendar dates in Asia/Shanghai around UTC boundaries", () => {
    assert.equal(
      toShanghaiDate(new Date("2026-09-03T15:59:59.999Z")),
      "2026-09-03",
    );
    assert.equal(
      toShanghaiDate(new Date("2026-09-03T16:00:00.000Z")),
      "2026-09-04",
    );
  });

  test("generates a deterministic server-side SHA-256 daily key", () => {
    const expected = createHash("sha256")
      .update(`bifang-tools\u00002026-09-04\u0000${INSTALL_ID}`, "utf8")
      .digest("hex");
    assert.equal(
      createDailyActiveId("bifang-tools", "2026-09-04", INSTALL_ID),
      expected,
    );
    assert.equal(expected.length, 64);
    assert.notEqual(
      createDailyActiveId("bifang-tools", "2026-09-05", INSTALL_ID),
      expected,
    );
  });

  test("accepts exactly one valid ALLOWED_APP_IDS value", () => {
    assert.equal(normalizeSingleAllowedAppId(" bifang-tools "), "bifang-tools");
    assert.equal(
      normalizeSingleAllowedAppId("bifang-tools,bifang-tools"),
      null,
    );
    assert.equal(normalizeSingleAllowedAppId("Bad App"), null);
  });

  test("validates an app-specific TRACK_PATH and fails closed when absent", () => {
    assert.equal(normalizeTrackPath(undefined), null);
    assert.equal(
      normalizeTrackPath("/apps/bifang-tools/v1/track"),
      "/apps/bifang-tools/v1/track",
    );
    for (const invalid of [
      "apps/bifang-tools/v1/track",
      "/apps//v1/track",
      "/apps/bifang-tools/v1/track/",
      "/apps/bifang-tools/v1/track?source=test",
    ]) {
      assert.throws(() => normalizeTrackPath(invalid), /TRACK_PATH/);
    }
  });

  test("exports a lazy CloudBase entrypoint and injectable test APIs", () => {
    assert.equal(typeof publicApi.main, "function");
    assert.equal(publicApi.handler, publicApi.main);
    assert.equal(typeof publicApi.createHandler, "function");
    assert.equal(typeof publicApi.createCloudBaseWriter, "function");
  });

  test("advertises daily_active as the only event and validates its exact shape", () => {
    assert.deepEqual([...EVENTS], ["daily_active"]);
    assert.deepEqual(validateAndSanitizePayload(makePayload()), {
      ok: true,
      value: makePayload(),
    });
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
});

describe("CloudBase writer adapter", () => {
  test("uses and validates an isolated collection name", async () => {
    let selectedCollection;
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => ({
        database: () => ({
          collection(name) {
            selectedCollection = name;
            return { add: async () => {} };
          },
        }),
      }),
    });

    await writer({ _id: "server-id" });
    assert.equal(selectedCollection, "telemetry_bifang_tools");
    assert.equal(normalizeCollectionName(undefined), null);
    assert.equal(COLLECTION_NAME_PATTERN.test("telemetry_bifang_tools"), true);
    for (const invalid of ["Telemetry", "telemetry-tools", "../events"]) {
      assert.throws(() => normalizeCollectionName(invalid), /COLLECTION/);
    }
  });

  test("fails closed before database initialization when collection is absent", async () => {
    let appFactoryCalls = 0;
    const writer = createCloudBaseWriter({
      collectionName: "",
      appFactory: () => {
        appFactoryCalls += 1;
        return { database() {} };
      },
    });

    await assert.rejects(
      writer({ _id: "server-id" }),
      /telemetry_collection_not_configured/,
    );
    assert.equal(appFactoryCalls, 0);
  });

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

  test("is lazy, writes to the configured collection, and preserves the handler _id", async () => {
    let appFactoryCalls = 0;
    let selectedCollection;
    const added = [];
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
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

    const dailyId = createDailyActiveId(
      "bifang-tools",
      "2026-09-04",
      INSTALL_ID,
    );
    assert.equal(appFactoryCalls, 0);
    await writer({ _id: dailyId, event_id: EVENT_ID, event: "daily_active" });
    await writer({
      _id: "another-server-id",
      event_id: SECOND_EVENT_ID,
      event: "daily_active",
    });

    assert.equal(appFactoryCalls, 1);
    assert.equal(selectedCollection, "telemetry_bifang_tools");
    assert.equal(added[0]._id, dailyId);
    assert.equal(added[0].event_id, EVENT_ID);
    assert.equal(added[1]._id, "another-server-id");
  });

  test("requires the handler-generated _id", async () => {
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => ({
        database: () => ({ collection: () => ({ add: async () => {} }) }),
      }),
    });

    await assert.rejects(
      writer({ event_id: EVENT_ID }),
      /document\._id is required/,
    );
  });

  test("treats a duplicate _id insert as an idempotent success", async () => {
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
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

    assert.deepEqual(await writer({ _id: "server-id" }), { duplicate: true });
    assert.equal(isDuplicateWriteError({ code: 11000 }), true);
    assert.equal(isDuplicateWriteError(new Error("permission denied")), false);
  });

  test("propagates non-duplicate database failures to the generic handler boundary", async () => {
    const failure = new Error("permission denied");
    const writer = createCloudBaseWriter({
      collectionName: "telemetry_bifang_tools",
      appFactory: () => ({
        database: () => ({
          collection: () => ({ add: async () => Promise.reject(failure) }),
        }),
      }),
    });

    await assert.rejects(writer({ _id: "server-id" }), failure);
  });
});
