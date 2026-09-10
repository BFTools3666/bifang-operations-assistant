"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  addDays,
  createDashboardSnapshot,
  normalizeReleaseSummaries,
  toShanghaiDate,
} = require("../src/aggregate");
const {
  createHandler: createProductionHandler,
  parseDashboardApps,
  parseQuery,
} = require("../src/handler");
const {
  createCloudBaseEventReader,
  createDefaultCloudBaseApp,
  PAGE_SIZE,
  MAX_PAGES_PER_COLLECTION,
  extractRuntimeSdkContext,
} = require("../src/reader");
const {
  createVersionSortKey,
  createCloudBaseVersionReader,
  emptyReleaseSummary,
  summarizeVersionDocument,
} = require("../src/version-reader");
const { safeDiagnostic } = require("../src/diagnostics");

const APPS = [
  {
    appId: "bifang-screen-recorder",
    collectionName: "telemetry_bifang_screen_recorder",
    versionCollection: "versions_bifang_screen_recorder",
    platforms: ["windows", "macos"],
    releaseStreams: [
      {
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-screen-recorder-windows-x64",
      },
      {
        platform: "macos",
        architecture: "arm64",
        channel: "stable",
        code: "bifang-screen-recorder-macos-arm64",
      },
    ],
  },
  {
    appId: "bifang-mouse-clicker",
    collectionName: "telemetry_bifang_mouse_clicker",
    versionCollection: "versions_bifang_mouse_clicker",
    platforms: ["windows"],
    releaseStreams: [
      {
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-mouse-clicker",
      },
    ],
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

function releaseSummaries(apps = APPS) {
  return apps.flatMap((app) =>
    app.releaseStreams.map((stream) => emptyReleaseSummary(app, stream)),
  );
}

function versionDocument(overrides = {}) {
  return {
    doc_type: "version_record",
    schema_version: 1,
    code: APPS[0].releaseStreams[0].code,
    code_version: "1.10",
    version_sort_key: createVersionSortKey("1.10"),
    forced_update: false,
    prompt_update: true,
    stop_update: false,
    updated_at: "2026-09-07T03:00:00.000Z",
    download_url: "https://downloads.example.com/private.exe",
    prompt_content: "not projected or returned",
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
    releaseSummaries: releaseSummaries(),
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
    versionReader: async ({ apps }) => releaseSummaries(apps),
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
    versionReader: async ({ apps }) => releaseSummaries(apps),
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
  const versionReads = [];
  const handler = createHandler({
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async (options) => {
      reads.push(options);
      return [];
    },
    versionReader: async (options) => {
      versionReads.push(options);
      return releaseSummaries(options.apps);
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
    assert.equal(body.releaseStreams.length, 1);
    assert.equal(body.releaseStreams[0].status, "empty");
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
    versionReads.every(
      (options) =>
        options.apps.length === 1 && options.apps[0].appId === query.app_id,
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
    versionReader: async ({ apps }) => releaseSummaries(apps),
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
  const duplicateCaseVariantAuth = await createHandler(defaults)({
    ...request,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      authorization: `Bearer ${"x".repeat(40)}`,
    },
  });
  assert.equal(duplicateCaseVariantAuth.statusCode, 401);
});

test("DAU deduplicates per app/install/day and distributions select the newest observation", () => {
  const events = [
    event({ active_date: "2026-09-06", app_version: "0.6.0" }),
    event({ app_version: "0.7.0", received_at: "2026-09-07T01:00:00.000Z" }),
    event({ app_version: "0.7.1", received_at: "2026-09-07T02:00:00.000Z" }),
    event({ app_version: "0.7.1", received_at: "2026-09-07T02:00:00.000Z" }),
    event({ app_id: APPS[1].appId, app_version: "0.2.2" }),
  ];
  const create = (events) =>
    createDashboardSnapshot({
      apps: APPS,
      days: 7,
      events,
      releaseSummaries: releaseSummaries(),
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

test("malformed telemetry rows fail closed while an empty result remains a real zero", async () => {
  const malformedRows = [
    event({ install_id: "invalid-install" }),
    event({ app_version: "source_ip=203.0.113.9" }),
    event({ platform: "secret" }),
    event({ arch: "unknown" }),
  ];
  for (const row of malformedRows) {
    assert.throws(
      () =>
        createDashboardSnapshot({
          apps: APPS,
          days: 7,
          events: [row],
          releaseSummaries: releaseSummaries(),
          now: NOW,
        }),
      /telemetry event is invalid/,
    );

    const response = await createHandler({
      apps: APPS,
      path: "/admin/v1/metrics",
      tokenHash: TOKEN_HASH,
      reader: async () => [row],
      versionReader: async ({ apps }) => releaseSummaries(apps),
      now: () => NOW,
      logger: { error() {} },
    })({
      httpMethod: "GET",
      path: "/admin/v1/metrics",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(JSON.parse(response.body), {
      error: "metrics_unavailable",
    });
  }

  const emptyResponse = await createHandler({
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async () => [],
    versionReader: async ({ apps }) => releaseSummaries(apps),
    now: () => NOW,
  })({
    httpMethod: "GET",
    path: "/admin/v1/metrics",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(emptyResponse.statusCode, 200);
  assert.equal(JSON.parse(emptyResponse.body).totals.todayActive, 0);
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
      releaseSummaries: releaseSummaries(),
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
      const call = { name, orders: [] };
      const query = {
        where(value) {
          call.where = value;
          return query;
        },
        orderBy(...value) {
          call.order = value;
          call.orders.push(value);
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

test("version reader returns one safe highest-version summary per configured release stream", async () => {
  const windowsCode = APPS[0].releaseStreams[0].code;
  const db = fakeDatabase(async (_page, call) => ({
    data: call.where.code === windowsCode ? [versionDocument()] : [],
  }));
  const read = createCloudBaseVersionReader({
    appFactory: () => ({ database: () => db }),
  });
  const result = await read({ apps: [APPS[0]], runtimeContext: {} });

  assert.deepEqual(result, [
    {
      appId: APPS[0].appId,
      code: windowsCode,
      platform: "windows",
      architecture: "x64",
      channel: "stable",
      highestVersion: "1.10",
      status: "prompt",
      updatedAt: "2026-09-07T03:00:00.000Z",
    },
    emptyReleaseSummary(APPS[0], APPS[0].releaseStreams[1]),
  ]);
  assert.equal(db.calls.length, 2);
  for (const [index, call] of db.calls.entries()) {
    assert.equal(call.name, APPS[0].versionCollection);
    assert.deepEqual(call.where, {
      doc_type: "version_record",
      schema_version: 1,
      code: APPS[0].releaseStreams[index].code,
    });
    assert.deepEqual(call.orders, [
      ["version_sort_key", "desc"],
      ["updated_at", "desc"],
      ["_id", "desc"],
    ]);
    assert.equal(call.limit, 1);
    assert.equal(call.field.download_url, undefined);
    assert.equal(call.field.prompt_content, undefined);
    assert.equal(call.field.update_content, undefined);
    assert.equal(call.field.version_sort_key, true);
  }
  const serialized = JSON.stringify(result);
  assert.equal(
    /download|promptContent|secret|credential/i.test(serialized),
    false,
  );
});

test("unknown code, cross-application rows, malformed states and read failures fail closed", async () => {
  const stream = APPS[0].releaseStreams[0];
  for (const row of [
    versionDocument({ code: "unknown-code" }),
    versionDocument({ code: APPS[1].releaseStreams[0].code }),
    versionDocument({ code_version: "1.0.0-beta" }),
    versionDocument({ version_sort_key: "999" }),
    versionDocument({ forced_update: true, prompt_update: true }),
    versionDocument({ updated_at: "not-a-time" }),
  ]) {
    assert.throws(
      () => summarizeVersionDocument(row, APPS[0], stream),
      /application_version_document_invalid/,
    );
  }

  for (const result of [
    undefined,
    { data: null },
    { data: [], code: "DATABASE_ERROR" },
    { data: [versionDocument(), versionDocument()] },
  ]) {
    const db = fakeDatabase(async () => result);
    await assert.rejects(
      createCloudBaseVersionReader({
        appFactory: () => ({ database: () => db }),
      })({ apps: [{ ...APPS[0], releaseStreams: [stream] }] }),
    );
  }
});

test("a corrupted oversized sort key cannot mask the real highest version", async () => {
  const stream = APPS[0].releaseStreams[0];
  const realHighest = versionDocument({
    code_version: "2.0",
    version_sort_key: createVersionSortKey("2.0"),
  });
  const corruptedLowerVersion = versionDocument({
    code_version: "1.0",
    version_sort_key: `99${"9".repeat(98)}`,
  });
  assert.ok(
    corruptedLowerVersion.version_sort_key > realHighest.version_sort_key,
  );

  // CloudBase returns the corrupt row first because the query orders and limits
  // server-side. The reader must reject it instead of reporting 1.0 as highest.
  const db = fakeDatabase(async () => ({ data: [corruptedLowerVersion] }));
  await assert.rejects(
    createCloudBaseVersionReader({
      appFactory: () => ({ database: () => db }),
    })({ apps: [{ ...APPS[0], releaseStreams: [stream] }] }),
    /application_version_document_invalid/,
  );
  assert.equal(db.calls[0].field.version_sort_key, true);
});

test("release aggregation preserves a real empty stream and rejects missing or cross-app summaries", () => {
  const empty = releaseSummaries([APPS[0]]);
  assert.deepEqual(normalizeReleaseSummaries([APPS[0]], empty), empty);
  const snapshot = createDashboardSnapshot({
    apps: APPS,
    days: 7,
    events: [],
    releaseSummaries: releaseSummaries(),
    now: NOW,
  });
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.releaseStreams.length, 3);
  assert.ok(snapshot.releaseStreams.every((item) => item.status === "empty"));
  assert.match(snapshot.alerts.at(-1).title, /3 个发布流尚无版本/);

  assert.throws(
    () => normalizeReleaseSummaries([APPS[0]], []),
    /count does not match/,
  );
  assert.throws(
    () =>
      normalizeReleaseSummaries(
        [APPS[0]],
        [{ ...empty[0], appId: APPS[1].appId }, empty[1]],
      ),
    /ambiguous/,
  );
});

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
    versionReader: async ({ apps }) => releaseSummaries(apps),
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
    versionReader: async ({ apps }) => releaseSummaries(apps),
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
  assert.deepEqual(
    parseDashboardApps([
      APPS[0],
      {
        ...APPS[1],
        releaseStreams: [
          {
            ...APPS[1].releaseStreams[0],
            code: APPS[0].releaseStreams[0].code,
          },
        ],
      },
    ]),
    [],
  );
  assert.deepEqual(
    parseDashboardApps([
      { ...APPS[0], versionCollection: APPS[1].versionCollection },
    ]),
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

test("an unreadable version collection makes the whole dashboard unavailable", async () => {
  const handler = createHandler({
    apps: APPS,
    path: "/admin/v1/metrics",
    tokenHash: TOKEN_HASH,
    reader: async () => [],
    versionReader: async () => {
      throw new Error("application_version_document_invalid");
    },
    now: () => NOW,
    logger: { error: () => undefined },
  });
  const response = await handler({
    httpMethod: "GET",
    path: "/admin/v1/metrics",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(response.body), { error: "metrics_unavailable" });
  assert.equal(response.body.includes("application_version"), false);
});
