import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as sdk from "../dist/index.js";

const BASE_URL = "https://gateway.example.com/tools/version-control/v1";
const CODE = "bifang-screen-recorder-windows-x64";
const CURRENT_VERSION = "1.2.3";
const APP_KEY = "runtime-key-never-log";
const APP_SECRET = "runtime-secret-never-log";

function responseData(overrides = {}) {
  return {
    update: true,
    downloadUrl: "https://downloads.example.com/tool-2.0.0.exe",
    promptContent: "发现新版本",
    forcedUpdate: false,
    promptUpdate: true,
    stopUpdate: false,
    updateContent: "<div>本次更新内容</div>",
    ...overrides,
  };
}

function checker(responseValue, overrides = {}) {
  return new sdk.ApplicationVersionChecker({
    baseUrl: BASE_URL,
    code: CODE,
    currentVersion: CURRENT_VERSION,
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify(responseValue),
    }),
    ...overrides,
  });
}

test("checker calls the canonical single-v1 endpoint with both credentials", async () => {
  let requestedUrl;
  let requestedInit;
  const decision = await checker(responseData(), {
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return { ok: true, text: async () => JSON.stringify(responseData()) };
    },
  }).check();

  assert.equal(decision.kind, "optional");
  assert.equal(
    requestedUrl,
    `${BASE_URL}/versions/bifang-screen-recorder-windows-x64/1.2.3`,
  );
  assert.deepEqual(requestedInit.headers, {
    accept: "application/json",
    "x-app-key": APP_KEY,
    "x-app-secret": APP_SECRET,
  });
  assert.equal(requestedInit.method, "GET");
  assert.equal(requestedInit.cache, "no-store");
  assert.equal(requestedUrl.includes("/v1/v1"), false);
  assert.equal(requestedUrl.includes(".json"), false);
  assert.equal(requestedUrl.includes("/updates/"), false);
});

test("URL construction rejects every non-canonical base and encodes path values", () => {
  assert.equal(
    sdk.buildApplicationVersionCheckUrl(BASE_URL, "工具%windows", "01.002"),
    `${BASE_URL}/versions/%E5%B7%A5%E5%85%B7%25windows/01.002`,
  );
  for (const baseUrl of [
    "http://gateway.example.com/tools/version-control/v1",
    "https://gateway.example.com/tools/version-control/v1/",
    "https://gateway.example.com/tools/version-control/v1/v1",
    "https://gateway.example.com/updates",
    "https://gateway.example/tools/version-control/v1",
    "https://gateway.invalid/tools/version-control/v1",
    "https://gateway.test/tools/version-control/v1",
    "https://gateway.home.arpa/tools/version-control/v1",
    "https://gateway.onion/tools/version-control/v1",
    "https://192.88.99.10/tools/version-control/v1",
    "https://198.51.100.10/tools/version-control/v1",
    "https://203.0.113.10/tools/version-control/v1",
    `${BASE_URL}?channel=stable`,
  ]) {
    assert.equal(
      sdk.buildApplicationVersionCheckUrl(baseUrl, CODE, CURRENT_VERSION),
      null,
      baseUrl,
    );
  }
  assert.equal(
    sdk.buildApplicationVersionCheckUrl(BASE_URL, "bad/code", CURRENT_VERSION),
    null,
  );
  assert.equal(
    sdk.buildApplicationVersionCheckUrl(BASE_URL, CODE, "v1.2.3"),
    null,
  );
});

test("the frozen bare seven fields map to none, optional, required and stopped", () => {
  const none = sdk.parseApplicationVersionData(
    responseData({ update: false, promptUpdate: false }),
  );
  const normal = sdk.parseApplicationVersionData(
    responseData({ promptUpdate: false }),
  );
  const required = sdk.parseApplicationVersionData(
    responseData({ forcedUpdate: true, promptUpdate: false }),
  );
  const stopped = sdk.parseApplicationVersionData(
    responseData({ update: false, promptUpdate: false, stopUpdate: true }),
  );
  assert.ok(none && normal && required && stopped);
  assert.deepEqual(sdk.decideApplicationVersion(none), {
    kind: "none",
    reason: "up_to_date",
  });
  assert.equal(sdk.decideApplicationVersion(normal).kind, "optional");
  assert.equal(sdk.decideApplicationVersion(required).kind, "required");
  assert.equal(sdk.decideApplicationVersion(stopped).kind, "stopped");
});

test("response parsing is exact, validates state combinations and rejects wrappers", () => {
  assert.deepEqual(
    sdk.parseApplicationVersionData(responseData()),
    responseData(),
  );
  const missing = responseData();
  delete missing.updateContent;
  for (const value of [
    missing,
    { ...responseData(), extra: true },
    { data: responseData() },
    responseData({ update: false, forcedUpdate: true, promptUpdate: false }),
    responseData({ forcedUpdate: true, promptUpdate: true }),
    responseData({ update: true, promptUpdate: false, stopUpdate: true }),
    responseData({ downloadUrl: "http://downloads.example.com/tool.exe" }),
    responseData({ downloadUrl: "https://127.0.0.1/tool.exe" }),
    responseData({ downloadUrl: "https://downloads.invalid/tool.exe" }),
    responseData({ downloadUrl: "https://198.51.100.10/tool.exe" }),
    responseData({ promptContent: "<b>unsafe</b>" }),
    responseData({ promptContent: "P".repeat(101) }),
    responseData({ updateContent: "unsafe\u202etext" }),
    responseData({ updateContent: "U".repeat(10_001) }),
  ]) {
    assert.equal(sdk.parseApplicationVersionData(value), null);
  }
});

test("invalid config, HTTP failure, malformed JSON, network failure and timeout stay silent", async () => {
  let invalidConfigFetches = 0;
  const invalidConfig = checker(responseData(), {
    appSecret: "",
    fetch: async () => {
      invalidConfigFetches += 1;
      throw new Error("must not run");
    },
  });
  assert.deepEqual(await invalidConfig.check(), {
    kind: "none",
    reason: "invalid_config",
  });
  assert.equal(invalidConfigFetches, 0);
  assert.deepEqual(
    await checker(responseData(), { appKey: "unsafe\r\nheader" }).check(),
    { kind: "none", reason: "invalid_config" },
  );

  const cases = [
    [
      "http",
      checker(responseData(), {
        fetch: async () => ({ ok: false, text: async () => "private body" }),
      }),
      "unavailable",
    ],
    [
      "json",
      checker(responseData(), {
        fetch: async () => ({ ok: true, text: async () => "not-json" }),
      }),
      "invalid_response",
    ],
    [
      "network",
      checker(responseData(), {
        fetch: async () => {
          throw new Error("private network details");
        },
      }),
      "unavailable",
    ],
    [
      "timeout",
      checker(responseData(), {
        timeoutMs: 5,
        fetch: () => new Promise(() => undefined),
      }),
      "unavailable",
    ],
  ];
  for (const [name, currentChecker, reason] of cases) {
    assert.deepEqual(
      await currentChecker.check(),
      { kind: "none", reason },
      name,
    );
  }
});

test("debug output never contains credentials, URL, code or response body", async () => {
  const logs = [];
  const decision = await checker(responseData(), {
    logger: { debug: (message, context) => logs.push({ message, context }) },
    fetch: async () => {
      throw new Error(`${APP_KEY} ${APP_SECRET} ${CODE} private-body`);
    },
  }).check();

  assert.deepEqual(decision, { kind: "none", reason: "unavailable" });
  const serialized = JSON.stringify(logs);
  for (const forbidden of [
    APP_KEY,
    APP_SECRET,
    CODE,
    BASE_URL,
    "private-body",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.match(serialized, /application_version_fetch_failed/);
});

test("host hooks route all four decisions and contain hook failures", async () => {
  const received = [];
  const hooks = {
    onOptionalUpdate: ({ kind }) => received.push(kind),
    onRequiredUpdate: ({ kind }) => received.push(kind),
    onStoppedUpdate: ({ kind }) => received.push(kind),
    onNoUpdate: ({ kind }) => received.push(kind),
  };
  for (const data of [
    responseData(),
    responseData({ forcedUpdate: true, promptUpdate: false }),
    responseData({ update: false, promptUpdate: false, stopUpdate: true }),
    responseData({ update: false, promptUpdate: false }),
  ]) {
    const parsed = sdk.parseApplicationVersionData(data);
    assert.ok(parsed);
    await sdk.runApplicationVersionHostHooks(
      sdk.decideApplicationVersion(parsed),
      hooks,
    );
  }
  assert.deepEqual(received, ["optional", "required", "stopped", "none"]);
  await assert.doesNotReject(
    sdk.runApplicationVersionHostHooks(
      { kind: "optional", data: responseData() },
      { onOptionalUpdate: () => Promise.reject(new Error("host failed")) },
    ),
  );
});

test("generic SemVer utilities remain while every static-manifest API is removed", () => {
  assert.equal(sdk.compareSemVer("1.10.0", "1.9.0"), 1);
  for (const removed of [
    "UpdateChecker",
    "UpdateConfig",
    "UPDATE_SCHEMA_VERSION",
    "DEFAULT_UPDATE_TIMEOUT_MS",
    "buildUpdateUrl",
    "decideUpdate",
    "parseUpdateConfig",
    "rolloutBucket",
    "runUpdateHostHooks",
  ]) {
    assert.equal(Object.hasOwn(sdk, removed), false, removed);
  }
});

test("generated public declarations contain no legacy static-manifest contract", async () => {
  const declarations = await Promise.all(
    [
      "../dist/index.d.ts",
      "../dist/types.d.ts",
      "../dist/update-checker.d.ts",
    ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
  );
  const publicSurface = declarations.join("\n");
  for (const removed of [
    "UpdateChecker",
    "UpdateConfig",
    "UPDATE_SCHEMA_VERSION",
    "DEFAULT_UPDATE_TIMEOUT_MS",
    "buildUpdateUrl",
    "decideUpdate",
    "parseUpdateConfig",
    "rolloutBucket",
    "runUpdateHostHooks",
    "latest_version",
    "min_supported_version",
    "release_notes_url",
  ]) {
    assert.equal(publicSurface.includes(removed), false, removed);
  }
});
