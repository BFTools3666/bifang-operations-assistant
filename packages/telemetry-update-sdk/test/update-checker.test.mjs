import assert from "node:assert/strict";
import test from "node:test";
import {
  UpdateChecker,
  buildUpdateUrl,
  compareSemVer,
  decideUpdate,
  isSafeExternalUrl,
  parseUpdateConfig,
  rolloutBucket,
  runUpdateHostHooks,
} from "../dist/index.js";

const INSTALL_ID = "5e74d84a-1972-4c1f-b27c-85b3b441f152";

function manifest(overrides = {}) {
  return {
    schema_version: 1,
    app_id: "bifang-tools",
    platform: "windows",
    enabled: true,
    latest_version: "0.2.0",
    min_supported_version: "0.1.0",
    force_update: false,
    rollout: 100,
    title: "Bifang Tools 0.2.0",
    message: "A tested update is available.",
    download_url:
      "https://downloads.example.invalid/replace-me/bifang-tools-0.2.0.exe",
    release_notes_url:
      "https://releases.example.invalid/replace-me/bifang-tools/0.2.0",
    sha256: "",
    published_at: "2026-09-03T04:43:55.000Z",
    ...overrides,
  };
}

function checker(manifestValue, overrides = {}) {
  return new UpdateChecker({
    baseUrl: "https://updates.example.invalid/replace-me/updates",
    appId: "bifang-tools",
    platform: "windows",
    currentVersion: "0.1.0",
    installId: INSTALL_ID,
    fetch: async () => ({
      ok: true,
      text: async () => JSON.stringify(manifestValue),
    }),
    ...overrides,
  });
}

test("latest greater than current is optional at rollout 100", async () => {
  const decision = await checker(manifest()).check();
  assert.equal(decision.kind, "optional");
  assert.deepEqual(decision.config, manifest());
});

test("latest equal to current returns none", async () => {
  const decision = await checker(
    manifest({ latest_version: "0.1.0", min_supported_version: "0.1.0" }),
  ).check();
  assert.deepEqual(decision, { kind: "none", reason: "up_to_date" });
});

test("rollout zero returns none", async () => {
  const decision = await checker(manifest({ rollout: 0 })).check();
  assert.deepEqual(decision, { kind: "none", reason: "rollout" });
});

test("locally disabled checker returns none without fetching", async () => {
  let fetchCalls = 0;
  const decision = await checker(manifest(), {
    enabled: false,
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, text: async () => JSON.stringify(manifest()) };
    },
  }).check();

  assert.deepEqual(decision, { kind: "none", reason: "disabled" });
  assert.equal(fetchCalls, 0);
});

test("force_update returns required when a newer version exists", async () => {
  const decision = await checker(manifest({ force_update: true })).check();
  assert.equal(decision.kind, "required");
});

test("current below min_supported returns required", () => {
  const config = parseUpdateConfig(
    manifest({ latest_version: "2.0.0", min_supported_version: "1.5.0" }),
  );
  assert.ok(config);
  assert.equal(decideUpdate("1.0.0", INSTALL_ID, config).kind, "required");
});

test("Semantic Version comparison handles multi-digit and prerelease values", () => {
  assert.equal(compareSemVer("1.10.0", "1.9.0"), 1);
  assert.equal(
    compareSemVer("9007199254740993.0.0", "9007199254740992.0.0"),
    1,
  );
  assert.equal(compareSemVer("1.0.0-beta.11", "1.0.0-rc.1"), -1);
  assert.equal(
    compareSemVer("1.0.0-9007199254740992", "1.0.0-9007199254740993"),
    -1,
  );
  assert.equal(compareSemVer("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.throws(() => compareSemVer("01.0.0", "1.0.0"), TypeError);
});

test("rollout bucket is stable and stays in range", () => {
  const first = rolloutBucket(INSTALL_ID, "2.0.0");
  assert.equal(rolloutBucket(INSTALL_ID, "2.0.0"), first);
  assert.ok(first >= 0 && first < 100);
});

test("manifest parsing is strict and rejects unsafe URLs", () => {
  assert.deepEqual(
    parseUpdateConfig(manifest(), "bifang-tools", "windows"),
    manifest(),
  );
  const missingTitle = manifest();
  delete missingTitle.title;
  assert.equal(parseUpdateConfig(missingTitle), null);
  assert.equal(parseUpdateConfig({ ...manifest(), extra: true }), null);
  assert.equal(parseUpdateConfig(manifest({ rollout: 101 })), null);
  assert.equal(
    parseUpdateConfig(
      manifest({ latest_version: "1.0.0", min_supported_version: "2.0.0" }),
    ),
    null,
  );
  assert.equal(
    parseUpdateConfig(manifest({ download_url: "http://example.com/a.exe" })),
    null,
  );
  assert.equal(
    parseUpdateConfig(manifest({ release_notes_url: "https://127.0.0.1/a" })),
    null,
  );
});

test("manifest display text, checksum, and publication time are strict", () => {
  assert.ok(
    parseUpdateConfig(
      manifest({
        title: "T".repeat(120),
        message: "M".repeat(1_000),
        sha256: "aB".repeat(32),
        published_at: "2024-02-29T23:59:59.123456789+14:00",
      }),
    ),
  );
  assert.ok(
    parseUpdateConfig(
      manifest({
        title: "家庭相册 👨‍👩‍👧‍👦 2.0",
        message: "安全、简短的更新说明。",
        sha256: "",
        published_at: "2026-09-03T09:00:00+08:00",
      }),
    ),
  );

  for (const overrides of [
    { title: "" },
    { title: "   " },
    { title: "T".repeat(121) },
    { title: "unsafe\ntext" },
    { title: "\u200b" },
    { title: "safe\u202etxt.exe" },
    { title: "\u2061" },
    { title: "\u200d\ufe0f" },
    { message: "" },
    { message: "\t" },
    { message: "M".repeat(1_001) },
    { message: "unsafe\u007ftext" },
    { message: "unsafe\u0085text" },
    { sha256: "a".repeat(63) },
    { sha256: "g".repeat(64) },
    { published_at: "2026-02-29T00:00:00Z" },
    { published_at: "2026-09-03 09:00:00Z" },
    { published_at: "2026-09-03T09:00:00" },
    { published_at: "2026-09-03T09:00:00+14:01" },
  ]) {
    assert.equal(
      parseUpdateConfig(manifest(overrides)),
      null,
      JSON.stringify(overrides),
    );
  }
});

test("safe URL validation rejects credentials and non-HTTPS protocols", () => {
  assert.equal(isSafeExternalUrl("https://example.com/download"), true);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
  assert.equal(isSafeExternalUrl("https://user:pass@example.com/a"), false);
  assert.equal(isSafeExternalUrl("file:///C:/secret"), false);
  assert.equal(isSafeExternalUrl("https://localhost/a"), false);
  assert.equal(isSafeExternalUrl("https://[::ffff:127.0.0.1]/a"), false);
  assert.equal(isSafeExternalUrl("https://[::ffff:10.0.0.1]/a"), false);
  assert.equal(isSafeExternalUrl("https://[ff02::1]/a"), false);
});

test("checker requests the canonical path and returns none on network failure", async () => {
  let requestedUrl;
  let requestedInit;
  const successful = checker(manifest(), {
    fetch: async (url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return { ok: true, text: async () => JSON.stringify(manifest()) };
    },
  });
  assert.equal((await successful.check()).kind, "optional");
  assert.equal(
    requestedUrl,
    "https://updates.example.invalid/replace-me/updates/bifang-tools/windows.json",
  );
  assert.equal(
    buildUpdateUrl(
      "https://updates.example.invalid/replace-me/updates",
      "bifang-tools",
      "windows",
    ),
    requestedUrl,
  );
  assert.equal(requestedInit.cache, "no-store");
  assert.deepEqual(requestedInit.headers, { accept: "application/json" });

  const unavailable = checker(manifest(), {
    fetch: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(await unavailable.check(), {
    kind: "none",
    reason: "unavailable",
  });
});

test("multiple tools keep update bases and manifests isolated", async () => {
  const requestedUrls = [];
  const configurations = [
    {
      appId: "bifang-tools-pdf",
      baseUrl: "https://updates.example.invalid/apps/pdf/releases",
    },
    {
      appId: "bifang-tools-image",
      baseUrl: "https://updates.example.invalid/apps/image/releases",
    },
  ];

  const decisions = await Promise.all(
    configurations.map(({ appId, baseUrl }) =>
      new UpdateChecker({
        baseUrl,
        appId,
        platform: "windows",
        currentVersion: "0.1.0",
        installId: INSTALL_ID,
        fetch: async (url) => {
          requestedUrls.push(url);
          return {
            ok: true,
            text: async () => JSON.stringify(manifest({ app_id: appId })),
          };
        },
      }).check(),
    ),
  );

  assert.deepEqual(
    new Set(requestedUrls),
    new Set([
      "https://updates.example.invalid/apps/pdf/releases/bifang-tools-pdf/windows.json",
      "https://updates.example.invalid/apps/image/releases/bifang-tools-image/windows.json",
    ]),
  );
  assert.ok(decisions.every(({ kind }) => kind === "optional"));

  const crossedManifest = await new UpdateChecker({
    baseUrl: configurations[0].baseUrl,
    appId: configurations[0].appId,
    platform: "windows",
    currentVersion: "0.1.0",
    installId: INSTALL_ID,
    fetch: async () => ({
      ok: true,
      text: async () =>
        JSON.stringify(manifest({ app_id: configurations[1].appId })),
    }),
  }).check();
  assert.deepEqual(crossedManifest, {
    kind: "none",
    reason: "invalid_config",
  });
});

test("checker timeout is silent", async () => {
  const decision = await checker(manifest(), {
    timeoutMs: 5,
    fetch: () => new Promise(() => undefined),
  }).check();
  assert.deepEqual(decision, { kind: "none", reason: "unavailable" });
});

test("host integration hooks receive decisions without implementing UI", async () => {
  const config = parseUpdateConfig(manifest());
  assert.ok(config);
  const decision = { kind: "optional", config };
  let received;
  await runUpdateHostHooks(decision, {
    onOptionalUpdate(value) {
      received = value;
    },
  });
  assert.equal(received, decision);
  await assert.doesNotReject(
    runUpdateHostHooks(decision, {
      onOptionalUpdate() {
        throw new Error("host UI failed");
      },
    }),
  );
});
