"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  addDays,
  createDashboardSnapshot,
  toShanghaiDate,
} = require("../src/aggregate");
const {
  createHandler: createProductionHandler,
  parseDashboardApps,
  parseQuery,
} = require("../src/handler");
const {
  createManifestReader,
  fallbackManifest,
  summarizeManifest,
} = require("../src/manifest-reader");
const {
  createCloudBaseEventReader,
  createDefaultCloudBaseApp,
  PAGE_SIZE,
  MAX_PAGES_PER_COLLECTION,
  extractRuntimeSdkContext,
} = require("../src/reader");
const { safeDiagnostic } = require("../src/diagnostics");

const APPS = [
  {
    appId: "bifang-screen-recorder",
    collectionName: "telemetry_bifang_screen_recorder",
    platforms: ["windows", "macos"],
  },
  {
    appId: "bifang-mouse-clicker",
    collectionName: "telemetry_bifang_mouse_clicker",
    platforms: ["windows"],
  },
];
const NOW = new Date("2026-09-07T04:00:00.000Z");
const TOKEN = "test-dashboard-token-with-at-least-32-characters";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

function createHandler(options) {
  return createProductionHandler({ environmentId: "test-env", ...options });
}

function event(overrides) {
  return {
    schema_version: 2,
    event: "daily_active",
    app_id: "bifang-screen-recorder",
    app_version: "0.7.0",
    install_id: "11111111-1111-4111-8111-111111111111",
    platform: "windows",
    arch: "x64",
    active_date: "2026-09-07",
    received_at: `${overrides?.active_date || "2026-09-07"}T03:00:00.000Z`,
    source_ip: "203.0.113.9",
    event_id: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

test("aggregation returns only dashboard-safe summaries", () => {
  const snapshot = createDashboardSnapshot({
    apps: APPS,
    days: 7,
    environmentId: "test-env",
    events: [
      event({ active_date: "2026-09-06" }),
      event({ active_date: "2026-09-07" }),
      event({
        app_id: "bifang-mouse-clicker",
        app_version: "0.2.2",
        install_id: "33333333-3333-4333-8333-333333333333",
      }),
    ],
    manifests: [],
    now: NOW,
    selectedAppId: "all",
  });

  assert.equal(snapshot.totals.todayActive, 2);
  assert.equal(snapshot.totals.yesterdayActive, 1);
  assert.equal(snapshot.totals.periodActive, 2);
  assert.equal(snapshot.totals.returningToday, 1);
  assert.equal(snapshot.totals.returningRate, 50);
  assert.equal(snapshot.trend.length, 7);
  assert.equal(snapshot.trend.at(-1).total, 2);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("source_ip"), false);
  assert.equal(serialized.includes("install_id"), false);
  assert.equal(serialized.includes("event_id"), false);
  assert.equal(serialized.includes("203.0.113.9"), false);
  assert.equal(
    serialized.includes("11111111-1111-4111-8111-111111111111"),
    false,
  );
});

test("handler fails closed without a valid bearer token", async () => {
  const handler = createHandler({
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async () => [],
    manifestReader: async () => [],
    now: () => NOW,
  });

  const missing = await handler({
    httpMethod: "GET",
    path: "/admin/v1/metrics",
  });
  assert.equal(missing.statusCode, 401);

  const wrong = await handler({
    httpMethod: "GET",
    path: "/admin/v1/metrics",
    headers: { authorization: `Bearer ${"x".repeat(40)}` },
  });
  assert.equal(wrong.statusCode, 401);
});

test("handler returns a live aggregate for an authorized exact query", async () => {
  let readOptions;
  const handler = createHandler({
    apps: APPS,
    environmentId: "test-env",
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async (options) => {
      readOptions = options;
      return [event({})];
    },
    manifestReader: async () => [],
    now: () => NOW,
  });

  const response = await handler({
    httpMethod: "GET",
    path: "/admin/v1/metrics",
    url: "/admin/v1/metrics?days=7&app_id=bifang-screen-recorder",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.mode, "live");
  assert.equal(body.selectedAppId, "bifang-screen-recorder");
  assert.equal(body.rangeDays, 7);
  assert.equal(body.totals.todayActive, 1);
  assert.equal(readOptions.startDate, "2026-08-09");
  assert.equal(readOptions.endDate, "2026-09-07");
  assert.equal(readOptions.receivedBefore, NOW.toISOString());
  assert.deepEqual(readOptions.apps, [APPS[0]]);
});

test("CloudBase split and raw query representations keep the selected app and range", async () => {
  const reads = [];
  const manifestReads = [];
  const handler = createHandler({
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async (options) => {
      reads.push(options);
      return [];
    },
    manifestReader: async (apps) => {
      manifestReads.push(apps);
      return [];
    },
    now: () => NOW,
  });
  const query = { app_id: "bifang-mouse-clicker", days: "30" };
  for (const fields of [
    { queryStringParameters: query },
    {
      rawPath: "/admin/v1/metrics",
      rawQueryString: new URLSearchParams(query).toString(),
    },
    {
      multiValueQueryStringParameters: {
        app_id: [query.app_id],
        days: [query.days],
      },
    },
    {
      rawQueryString: new URLSearchParams(query).toString(),
      queryStringParameters: query,
    },
  ]) {
    const response = await handler({
      httpMethod: "GET",
      path: "/admin/v1/metrics",
      headers: { Authorization: `Bearer ${TOKEN}` },
      ...fields,
    });
    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 200);
    assert.equal(body.selectedAppId, query.app_id);
    assert.equal(body.rangeDays, 30);
    assert.equal(body.trend.length, 30);
    assert.equal(body.trend[0].date, "2026-08-09");
    assert.equal(body.manifests.length, 1);
    assert.equal(body.manifests[0].source, "unavailable");
  }
  const contextResponse = await handler(
    {},
    {
      httpContext: {
        method: "GET",
        path: "/admin/v1/metrics",
        queryStringParameters: query,
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    },
  );
  assert.equal(JSON.parse(contextResponse.body).rangeDays, 30);
  assert.ok(
    reads.every(
      (options) =>
        options.apps.length === 1 && options.apps[0].appId === query.app_id,
    ),
  );
  assert.ok(
    manifestReads.every(
      (apps) => apps.length === 1 && apps[0].appId === query.app_id,
    ),
  );
});

test("ambiguous, duplicate, empty and malformed query inputs are rejected", () => {
  for (const [url, sources] of [
    ["/?days=7&days=30", []],
    ["/?days=07", []],
    ["/?days=", []],
    ["/?app_id=", []],
    ["/?days=7", [{ days: "30" }]],
    ["/", [{ days: ["7", "30"] }]],
    ["/", [{ days: 7 }]],
    ["/", [{ raw: "true" }]],
    ["/", [7]],
  ])
    assert.deepEqual(parseQuery(url, sources), { ok: false });
  assert.deepEqual(parseQuery("/"), { ok: true, days: 14, appId: "all" });
});

test("configuration and storage failures never masquerade as a connected empty dashboard", async () => {
  let reads = 0;
  const logs = [];
  const defaults = {
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async () => {
      reads++;
      return [];
    },
    manifestReader: async () => [],
    now: () => NOW,
    logger: { error: (...args) => logs.push(args) },
  };
  const request = {
    httpMethod: "GET",
    path: "/admin/v1/metrics",
    headers: { authorization: `Bearer ${TOKEN}` },
  };
  for (const apps of [
    [],
    "bad",
    [{ ...APPS[0], collectionName: APPS[1].collectionName }, APPS[1]],
  ]) {
    const response = await createHandler({ ...defaults, apps })(request);
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), {
      error: "metrics_unavailable",
    });
  }
  assert.equal(reads, 0);
  for (const environmentId of [null, "", "current"]) {
    const response = await createHandler({ ...defaults, environmentId })(
      request,
    );
    assert.equal(response.statusCode, 503);
  }
  assert.equal(reads, 0);
  for (const reader of [
    async () => {
      throw new Error(`secret ${TOKEN} source_ip`);
    },
    async () => undefined,
  ]) {
    const response = await createHandler({ ...defaults, reader })(request);
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes(TOKEN), false);
    assert.equal(response.headers["Cache-Control"], "no-store");
    assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  }
  assert.deepEqual(logs, [
    [
      "operations_dashboard_query_failed",
      { code: "UNKNOWN", name: "Error", message: "metrics_query_failed" },
    ],
    [
      "operations_dashboard_query_failed",
      { code: "UNKNOWN", name: "TypeError", message: "metrics_query_failed" },
    ],
  ]);
  const method = await createHandler(defaults)({
    ...request,
    httpMethod: "POST",
  });
  const path = await createHandler(defaults)({
    ...request,
    path: "/admin/v1/metrics/",
  });
  assert.equal(method.statusCode, 405);
  assert.equal(path.statusCode, 404);
  const duplicateAuth = await createHandler(defaults)({
    ...request,
    headers: { authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] },
  });
  assert.equal(duplicateAuth.statusCode, 401);
});

test("DAU deduplicates per app/install/day and distributions select the newest valid observation", () => {
  const events = [
    event({ active_date: "2026-09-06", app_version: "0.6.0" }),
    event({ app_version: "0.7.0", received_at: "2026-09-07T01:00:00.000Z" }),
    event({ app_version: "0.7.1", received_at: "2026-09-07T02:00:00.000Z" }),
    event({ app_version: "0.7.1", received_at: "2026-09-07T02:00:00.000Z" }),
    event({ app_id: APPS[1].appId, app_version: "0.2.2" }),
    event({ schema_version: 1 }),
    event({ event: "install" }),
    event({ active_date: "2026-08-08" }),
    event({ active_date: "2026-09-08" }),
    event({ received_at: "2026-09-07T05:00:00.000Z" }),
    event({
      active_date: "2026-09-06",
      received_at: "2026-09-07T01:00:00.000Z",
    }),
    event({ install_id: "invalid-install" }),
    event({ app_version: "source_ip=203.0.113.9" }),
    event({ platform: "secret" }),
    event({ arch: "unknown" }),
    event({ received_at: "bad-date" }),
  ];
  const create = (events) =>
    createDashboardSnapshot({
      apps: APPS,
      days: 7,
      events,
      manifests: [],
      now: NOW,
    });
  const result = create(events);
  assert.equal(result.totals.todayActive, 2);
  assert.equal(result.totals.yesterdayActive, 1);
  assert.equal(result.totals.periodActive, 2);
  assert.equal(result.totals.returningToday, 1);
  assert.equal(result.totals.returningRate, 50);
  assert.equal(
    result.versions.find((item) => item.label === "录屏 0.7.1").value,
    1,
  );
  assert.equal(result.versions.length, 2);
  assert.deepEqual(result, create([...events].reverse()));
});

test("30-day bounds and previous full seven-day average are independent of chart range", () => {
  const events = [
    event({}),
    event({
      active_date: "2026-08-09",
      install_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
  ];
  for (let offset = -7; offset <= -1; offset++)
    events.push(event({ active_date: addDays("2026-09-07", offset) }));
  const make = (days) =>
    createDashboardSnapshot({
      apps: APPS,
      days,
      events,
      manifests: [],
      now: NOW,
    });
  const weekly = make(7);
  const monthly = make(30);
  assert.equal(monthly.trend[0].total, 1);
  assert.equal(monthly.totals.periodActive, 2);
  assert.equal(weekly.totals.periodActive, 1);
  assert.deepEqual(weekly.alerts[0], monthly.alerts[0]);
  assert.match(weekly.alerts[0].detail, /平均 1\.0 台/);
  assert.equal(weekly.alerts[0].tone, "neutral");
  assert.equal(
    toShanghaiDate(new Date("2026-09-06T16:00:00.000Z")),
    "2026-09-07",
  );
  assert.equal(
    toShanghaiDate(new Date("2026-09-06T15:59:59.999Z")),
    "2026-09-06",
  );
});

function updateManifest(overrides = {}) {
  return {
    schema_version: 1,
    app_id: APPS[0].appId,
    platform: "windows",
    enabled: false,
    force_update: false,
    rollout: 0,
    latest_version: "0.0.0",
    min_supported_version: "0.0.0",
    title: "尚未发布",
    message: "尚未发布更新",
    download_url: "https://example.com/not-published.exe",
    release_notes_url: "https://example.com/notes.html",
    sha256: "",
    published_at: "1970-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("missing configuration, malformed content and missing platform manifests remain unknown", async () => {
  let requests = 0;
  for (const baseUrl of [
    undefined,
    "",
    "invalid",
    "http://example.com/updates",
    "https://example.com/updates?token=abc",
    "https://user:pass@example.com/updates",
  ]) {
    const read = createManifestReader({
      baseUrl: baseUrl ?? "",
      fetchImpl: async () => {
        requests++;
      },
    });
    const result = await read(APPS);
    assert.equal(result.length, 3);
    assert.ok(result.every((item) => item.source === "unavailable"));
  }
  assert.equal(requests, 0);
  for (const overrides of [
    { schema_version: 2 },
    { latest_version: "bad" },
    { min_supported_version: "1.0.0" },
    { published_at: "2026-02-29T00:00:00Z" },
    { download_url: "http://example.com/file.exe" },
    { rollout: 101 },
    { sha256: "bad" },
    { secret: "not allowed" },
    { title: "\u0000" },
  ]) {
    assert.throws(() =>
      summarizeManifest(
        updateManifest(overrides),
        APPS[0].appId,
        "windows",
        "https://example.com/windows.json",
      ),
    );
  }
  const valid = summarizeManifest(
    updateManifest(),
    APPS[0].appId,
    "windows",
    "https://example.com/windows.json",
  );
  const snapshot = createDashboardSnapshot({
    apps: APPS,
    days: 7,
    events: [],
    manifests: [valid],
    now: NOW,
  });
  assert.equal(
    snapshot.manifests.filter((item) => item.source === "unavailable").length,
    2,
  );
  assert.match(snapshot.alerts.at(-1).title, /状态未知/);
  const none = createDashboardSnapshot({
    apps: APPS,
    days: 7,
    events: [],
    manifests: [],
    now: NOW,
  });
  assert.match(none.alerts.at(-1).title, /3 个更新清单状态未知/);
});

test("manifest HTTP fetch is bounded, uncached and does not follow redirects", async () => {
  let init;
  const reader = createManifestReader({
    baseUrl: "https://example.com/updates",
    fetchImpl: async (_url, options) => {
      init = options;
      return new Response(JSON.stringify(updateManifest()));
    },
  });
  const result = await reader([{ ...APPS[0], platforms: ["windows"] }]);
  assert.equal(result[0].source, "cloudbase");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  const huge = createManifestReader({
    baseUrl: "https://example.com/updates",
    fetchImpl: async () => new Response(" ".repeat(16385)),
  });
  assert.equal(
    (await huge([{ ...APPS[0], platforms: ["windows"] }]))[0].source,
    "unavailable",
  );
});

function fakeDatabase(getPage) {
  const calls = [];
  const expression = (operator, value) => ({
    [operator]: value,
    and(other) {
      return { ...this, ...other };
    },
  });
  const command = Object.fromEntries(
    ["gte", "lte", "gt"].map((key) => [key, (value) => expression(key, value)]),
  );
  return {
    calls,
    command,
    collection(name) {
      const call = { name };
      const query = {
        where(value) {
          call.where = value;
          return query;
        },
        orderBy(...value) {
          call.order = value;
          return query;
        },
        field(value) {
          call.field = value;
          return query;
        },
        limit(value) {
          call.limit = value;
          return query;
        },
        async get() {
          calls.push({ ...call });
          return getPage(calls.length - 1, call);
        },
      };
      return query;
    },
  };
}

test("CloudBase reader uses projected keyset pages and a fixed request cutoff", async () => {
  const first = Array.from({ length: PAGE_SIZE }, (_, i) => ({
    _id: String(i).padStart(4, "0"),
  }));
  const db = fakeDatabase(async (page) => ({
    data: page === 0 ? first : [{ _id: "0100" }],
  }));
  const read = createCloudBaseEventReader({
    appFactory: () => ({ database: () => db }),
  });
  const result = await read({
    apps: [APPS[0]],
    startDate: "2026-08-09",
    endDate: "2026-09-07",
    receivedBefore: NOW.toISOString(),
  });
  assert.equal(result.length, PAGE_SIZE + 1);
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[1].where._id.gt, "0099");
  for (const call of db.calls) {
    assert.deepEqual(call.order, ["_id", "asc"]);
    assert.equal(call.name, APPS[0].collectionName);
    assert.equal(call.where.app_id, APPS[0].appId);
    assert.equal(call.where.schema_version, 2);
    assert.equal(call.where.event, "daily_active");
    assert.equal(call.where.active_date.gte, "2026-08-09");
    assert.equal(call.where.active_date.lte, "2026-09-07");
    assert.equal(call.where.received_at.lte, NOW.toISOString());
    assert.equal(call.field.source_ip, undefined);
    assert.equal(call.field.event_id, undefined);
    assert.equal(call.limit, PAGE_SIZE);
  }
});

test("CloudBase errors, cursor regressions and query truncation fail closed", async () => {
  const options = {
    apps: [APPS[0]],
    startDate: "2026-08-09",
    endDate: "2026-09-07",
    receivedBefore: NOW.toISOString(),
  };
  for (const page of [
    undefined,
    { data: null },
    { code: "DATABASE_ERROR", data: [] },
    { data: [{ _id: "b" }, { _id: "a" }] },
    { data: [{}] },
  ]) {
    const db = fakeDatabase(async () => page);
    await assert.rejects(
      createCloudBaseEventReader({
        appFactory: () => ({ database: () => db }),
      })(options),
    );
  }
  const db = fakeDatabase(async (page) => ({
    data: Array.from({ length: PAGE_SIZE }, (_, i) => ({
      _id: String(page * PAGE_SIZE + i).padStart(8, "0"),
    })),
  }));
  await assert.rejects(
    createCloudBaseEventReader({ appFactory: () => ({ database: () => db }) })(
      options,
    ),
    /dashboard_query_limit_exceeded/,
  );
  assert.equal(db.calls.length, MAX_PAGES_PER_COLLECTION);
});

test("CloudBase initialization follows the telemetry runtime identity contract", () => {
  const sentinel = Symbol("current-env");
  const initializations = [];
  const cloudbaseModule = {
    default: {
      SYMBOL_CURRENT_ENV: sentinel,
      init: (options) => {
        initializations.push(options);
        return options;
      },
    },
  };
  createDefaultCloudBaseApp({ cloudbaseModule, envOverride: "" });
  createDefaultCloudBaseApp({ cloudbaseModule, envOverride: " test-env " });
  assert.deepEqual(initializations, [{ env: sentinel }, { env: "test-env" }]);
  assert.throws(
    () =>
      createDefaultCloudBaseApp({
        cloudbaseModule: { init: () => {} },
        envOverride: "",
      }),
    /cloudbase_environment_unavailable/,
  );
});

test("only the trusted runtime context supplies short-lived session identity", async () => {
  const first = {
    secretId: "fake-runtime-id",
    secretKey: "fake-runtime-key",
    token: "fake-session-one",
  };
  const second = { ...first, token: "fake-session-two" };
  const context = {
    extendedContext: { tmpSecret: first, arbitrary: "not forwarded" },
    environment: "not forwarded",
  };
  assert.deepEqual(extractRuntimeSdkContext(context), {
    extendedContext: { tmpSecret: first },
  });
  const env = {
    TENCENTCLOUD_SECRETID: first.secretId,
    TENCENTCLOUD_SECRETKEY: first.secretKey,
    TENCENTCLOUD_SESSIONTOKEN: first.token,
    IRRELEVANT: "not forwarded",
  };
  assert.deepEqual(
    extractRuntimeSdkContext({ environment: JSON.stringify(env) }),
    { extendedContext: { tmpSecret: first } },
  );
  assert.deepEqual(
    extractRuntimeSdkContext({
      environ: Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join(";"),
    }),
    { extendedContext: { tmpSecret: first } },
  );
  assert.equal(
    extractRuntimeSdkContext({
      extendedContext: {
        tmpSecret: { secretId: first.secretId, secretKey: first.secretKey },
      },
    }),
    null,
  );
  assert.equal(extractRuntimeSdkContext({ environment: "malformed" }), null);
  const contexts = [];
  const reader = createCloudBaseEventReader({
    appFactory: ({ runtimeContext }) => {
      contexts.push(runtimeContext);
      return { database: () => fakeDatabase(async () => ({ data: [] })) };
    },
  });
  const handler = createHandler({
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader,
    manifestReader: async () => [],
    now: () => NOW,
  });
  const eventWithForgedIdentity = {
    httpMethod: "GET",
    path: "/admin/v1/metrics",
    headers: { Authorization: `Bearer ${TOKEN}` },
    context: {
      extendedContext: { tmpSecret: { ...first, token: "forged-token" } },
    },
  };
  const nextContext = { extendedContext: { tmpSecret: second } };
  assert.equal(
    (await handler(eventWithForgedIdentity, context)).statusCode,
    200,
  );
  assert.equal(
    (await handler(eventWithForgedIdentity, nextContext)).statusCode,
    200,
  );
  assert.deepEqual(contexts, [context, nextContext]);
});

test("real js-sdk 3.8.2 signs database GET with refreshed runtime session context offline", () => {
  const script = `
    const assert = require('node:assert/strict');
    const { createDefaultCloudBaseApp } = require('./src/reader');
    let expectedToken;
    const verified = [];
    globalThis.fetch = async (url, init) => {
      assert.ok(String(url).includes('database/instances'));
      const headers = new Headers(init.headers);
      const authorization = headers.get('authorization') || '';
      assert.ok(authorization.length > 0);
      assert.ok(authorization.includes(expectedToken));
      assert.equal(authorization.includes('fake-runtime-secret-key'), false);
      verified.push(init.method);
      return new Response(JSON.stringify({ data: { list: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    (async () => {
      for (const token of ['fake-session-one', 'fake-session-two']) {
        expectedToken = token;
        const app = createDefaultCloudBaseApp({ envOverride: 'dashboard-offline-test', runtimeContext: {
          extendedContext: { tmpSecret: { secretId: 'fake-runtime-id', secretKey: 'fake-runtime-secret-key', token } }
        } });
        const result = await app.database().collection('telemetry_test').where({ event: 'daily_active' }).limit(1).get();
        assert.deepEqual(result.data, []);
      }
      process.stdout.write(JSON.stringify({ signedRequests: verified.length, allGet: verified.every(method => method === 'GET') }));
      process.exit(0);
    })().catch(() => { process.stderr.write('offline_sdk_signing_failed'); process.exit(1); });
  `;
  const output = execFileSync(process.execPath, ["-e", script], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      TENCENTCLOUD_SECRETID: "",
      TENCENTCLOUD_SECRETKEY: "",
      TENCENTCLOUD_SESSIONTOKEN: "",
      CLOUDBASE_APIKEY: "",
      TCB_CONTEXT_CNFG: "",
      TENCENTCLOUD_RUNENV: "",
    },
  });
  assert.deepEqual(JSON.parse(output), { signedRequests: 2, allGet: true });
});

test("safe diagnostics preserve only allowlisted error codes and fixed messages", () => {
  assert.deepEqual(
    safeDiagnostic({
      code: "DATABASE_PERMISSION_DENIED",
      name: "Error",
      message: `Permission denied for ${TOKEN}`,
      source_ip: "203.0.113.9",
    }),
    {
      code: "DATABASE_PERMISSION_DENIED",
      name: "Error",
      message: "database_permission_denied",
    },
  );
  assert.deepEqual(
    safeDiagnostic({ code: TOKEN, name: TOKEN, message: TOKEN, stack: TOKEN }),
    {
      code: "UNKNOWN",
      name: "Error",
      message: "metrics_query_failed",
    },
  );
  assert.equal(
    safeDiagnostic({
      code: "MODULE_NOT_FOUND",
      message: `Cannot find module ${TOKEN}`,
    }).message,
    "runtime_dependency_unavailable",
  );
  assert.equal(
    safeDiagnostic({
      name: "TypeError",
      message: "fetch failed",
      cause: { code: "ENOTFOUND" },
    }).code,
    "ENOTFOUND",
  );
  assert.equal(
    safeDiagnostic({ message: `collection not exist ${TOKEN}` }).message,
    "database_collection_missing",
  );
  assert.equal(
    safeDiagnostic({ message: `secretId or secretKey not configured ${TOKEN}` })
      .message,
    "runtime_credentials_unavailable",
  );
});

test("reader retains safe database errors and does not treat a truthy SUCCESS as SDK success", async () => {
  const options = {
    apps: [APPS[0]],
    startDate: "2026-08-09",
    endDate: "2026-09-07",
    receivedBefore: NOW.toISOString(),
  };
  for (const [result, expected] of [
    [
      {
        code: "DATABASE_REQUEST_FAILED",
        message: `permission denied ${TOKEN}`,
      },
      {
        code: "DATABASE_REQUEST_FAILED",
        name: "Error",
        message: "database_permission_denied",
      },
    ],
    [
      { code: "SUCCESS", data: [] },
      {
        code: "SUCCESS",
        name: "Error",
        message: "database_unexpected_success_code",
      },
    ],
  ]) {
    const db = fakeDatabase(async () => result);
    await assert.rejects(
      createCloudBaseEventReader({
        appFactory: () => ({ database: () => db }),
      })(options),
      (error) => {
        assert.deepEqual(safeDiagnostic(error), expected);
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      },
    );
  }
});

test("handler rejects unknown parameters and applications", async () => {
  const handler = createHandler({
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async () => [],
    manifestReader: async () => [],
    now: () => NOW,
  });
  for (const url of [
    "/admin/v1/metrics?days=365",
    "/admin/v1/metrics?app_id=unknown-tool",
    "/admin/v1/metrics?raw=true",
  ]) {
    const response = await handler({
      httpMethod: "GET",
      path: "/admin/v1/metrics",
      url,
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 400);
  }
});

test("dashboard app mapping has an exact fail-closed shape", () => {
  assert.deepEqual(parseDashboardApps(JSON.stringify(APPS)), APPS);
  assert.deepEqual(
    parseDashboardApps([{ ...APPS[0], secret: "not allowed" }]),
    [],
  );
  assert.deepEqual(parseDashboardApps("not-json"), []);
});

test("double-encoded app mapping survives the CloudBase CLI 3.8.1 config reviver", () => {
  // Reproduce ConfigParser.parseRawConfig in the installed CLI: JSON-shaped
  // strings whose parsed value is an object are automatically revived.
  const cliParse = (value) =>
    JSON.parse(JSON.stringify({ DASHBOARD_APPS_JSON: value }), (_key, item) => {
      if (typeof item === "string") {
        try {
          const parsed = JSON.parse(item);
          if (typeof parsed === "object") return parsed;
        } catch {
          // The CLI leaves non-JSON strings unchanged.
        }
      }
      return item;
    }).DASHBOARD_APPS_JSON;
  const json = JSON.stringify(APPS);
  assert.equal(Array.isArray(cliParse(json)), true);
  const escaped = JSON.stringify(json);
  const deployed = cliParse(escaped);
  assert.equal(typeof deployed, "string");
  assert.equal(cliParse(deployed), deployed);
  assert.deepEqual(parseDashboardApps(deployed), APPS);
  assert.deepEqual(parseDashboardApps(JSON.stringify(escaped)), []);
  assert.deepEqual(
    parseDashboardApps(
      JSON.stringify(JSON.stringify([{ ...APPS[0], secret: "forbidden" }])),
    ),
    [],
  );
  assert.deepEqual(parseDashboardApps(JSON.stringify("not-json")), []);
});

test("an unreadable update manifest remains explicitly unknown", async () => {
  const manifestUrl =
    "https://example.ap-shanghai.app.tcloudbase.com/updates/bifang-screen-recorder/windows.json";
  const unavailable = fallbackManifest(
    "bifang-screen-recorder",
    "windows",
    manifestUrl,
  );
  assert.equal(unavailable.source, "unavailable");

  const readManifests = createManifestReader({
    baseUrl: "https://example.ap-shanghai.app.tcloudbase.com/updates",
    fetchImpl: async () => ({ ok: false }),
  });
  const results = await readManifests([APPS[0]]);
  assert.equal(results.length, 2);
  assert.equal(
    results.every((item) => item.source === "unavailable"),
    true,
  );

  const snapshot = createDashboardSnapshot({
    apps: APPS,
    days: 7,
    environmentId: "test-env",
    events: [],
    manifests: [unavailable],
    now: NOW,
    selectedAppId: "bifang-screen-recorder",
  });
  assert.equal(snapshot.alerts.at(-1).tone, "warning");
  assert.match(snapshot.alerts.at(-1).title, /状态未知/);
});
