import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  MemoryIdentityStorage,
  SDK_VERSION,
  TelemetryClient,
} from "@bifang/telemetry-update-sdk";

import {
  createCloudBaseConfig,
  validateRegistry,
} from "../cloudbase/generate-cloudbaserc.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const {
  validateAndSanitizePayload,
} = require("../cloudbase/functions/telemetry/src/validation.js");
const {
  createVersionSortKey: createApiVersionSortKey,
} = require("../cloudbase/functions/application-version-api/src/version.js");
const {
  createVersionSortKey: createDashboardVersionSortKey,
} = require("../cloudbase/functions/operations-dashboard/src/version-reader.js");
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const readJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );

test("apps.json v3 is the non-sensitive app and release-stream authority", async () => {
  const registry = await readJson("cloudbase/apps.json");
  const applications = validateRegistry(registry);

  assert.equal(registry.schema_version, 3);
  assert.equal(applications.length, 3);
  assert.deepEqual(
    applications.flatMap(({ appId, releaseStreams }) =>
      releaseStreams.map((releaseStream) => ({ appId, ...releaseStream })),
    ),
    [
      {
        appId: "bifang-screen-recorder",
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-screen-recorder-windows-x64",
      },
      {
        appId: "bifang-screen-recorder",
        platform: "macos",
        architecture: "arm64",
        channel: "stable",
        code: "bifang-screen-recorder-macos-arm64",
      },
      {
        appId: "bifang-mouse-clicker",
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-mouse-clicker",
      },
      {
        appId: "bifang-tools",
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-tools-windows-x64",
      },
    ],
  );
});

test("application API and independently deployed dashboard share the exact version sort key", () => {
  for (const version of [
    "0",
    "1",
    "1.0",
    "01.002.000",
    "1.10",
    "99999999999999999999999999999999999999999999999999",
  ]) {
    assert.equal(
      createDashboardVersionSortKey(version),
      createApiVersionSortKey(version),
      version,
    );
  }
});

test("the repository has no static-update source files or deploy topology", async () => {
  const registry = await readJson("cloudbase/apps.json");
  const config = createCloudBaseConfig(registry);
  const generatedSource = await readFile(
    new URL("../cloudbase/generate-cloudbaserc.mjs", import.meta.url),
    "utf8",
  );
  const registrationSources = await Promise.all(
    ["add-app.mjs", "add-release-stream.mjs", "plan-app-deployment.mjs"].map(
      (name) =>
        readFile(new URL(`../cloudbase/${name}`, import.meta.url), "utf8"),
    ),
  );
  const updateEntries = await readdir(
    new URL("../cloudbase/updates", import.meta.url),
    { recursive: true, withFileTypes: true },
  ).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });

  assert.equal(
    updateEntries.some((entry) => entry.isFile()),
    false,
  );
  assert.equal("hosting" in config, false);
  assert.equal(
    config.gateway.routes.some(({ path }) => path === "/updates"),
    false,
  );
  assert.equal(
    JSON.stringify(config).includes("DASHBOARD_UPDATES_BASE_URL"),
    false,
  );
  assert.doesNotMatch(generatedSource, /cloudbase\/updates|hosting:updates/);
  for (const source of registrationSources) {
    assert.doesNotMatch(source, /cloudbase\/updates|hosting\s+deploy/i);
    assert.doesNotMatch(source, /manifest/i);
  }
});

test("active runtime and current operator surfaces cannot reintroduce the retired static protocol", async () => {
  const activeRoots = [
    ".env.example",
    "cloudbaserc.example.json",
    "apps/operations-dashboard/app",
    "apps/operations-dashboard/components",
    "apps/operations-dashboard/lib",
    "apps/operations-dashboard/README.md",
    "cloudbase/functions/application-version-api",
    "cloudbase/functions/operations-dashboard",
    "cloudbase/generate-cloudbaserc.mjs",
    "cloudbase/add-app.mjs",
    "cloudbase/add-release-stream.mjs",
    "cloudbase/deploy-application-version-api.mjs",
    "cloudbase/plan-app-deployment.mjs",
    "examples",
    "packages/telemetry-update-sdk/src",
    "tools/python-sdk-test-client",
  ];
  const tracked = await execFileAsync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...activeRoots,
    ],
    {
      cwd: repositoryRoot,
      windowsHide: true,
    },
  );
  const trackedActiveFiles = tracked.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter(
      (relativePath) =>
        !/(?:^|\/)(?:test|tests)(?:\/|$)/u.test(relativePath) &&
        !/\.test\.[cm]?[jt]sx?$/u.test(relativePath) &&
        !relativePath.endsWith("package-lock.json"),
    );
  const activeFiles = [];
  for (const relativePath of trackedActiveFiles) {
    try {
      await access(path.join(repositoryRoot, relativePath));
      activeFiles.push(relativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const retiredMarkers =
    /DASHBOARD_UPDATES_BASE_URL|\/updates\/|update_base_url|updateBaseUrl|\brollout\b|min_supported_version|minSupportedVersion|manifestUrl|manifest-reader|update\.schema|WINDOWS_JSON_FIELDS|add-app-platform/u;

  assert.ok(activeFiles.length > 0);
  for (const relativePath of activeFiles) {
    const source = await readFile(
      path.join(repositoryRoot, relativePath),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      retiredMarkers,
      `${relativePath} contains a retired static-update marker`,
    );
  }
});

test("the curl example remains the minimal daily-active ingestion envelope", async () => {
  const source = await readFile(
    new URL("../examples/telemetry-event.json", import.meta.url),
    "utf8",
  );
  const event = JSON.parse(source);

  assert.ok(Buffer.byteLength(source, "utf8") <= 4_096);
  assert.equal(event.schema_version, 2);
  assert.equal(event.event, "daily_active");
  assert.equal(event.sdk_version, SDK_VERSION);
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
  assert.equal("channel" in event, false);
  assert.equal("session_id" in event, false);
  assert.equal("properties" in event, false);
  assert.equal("source_ip" in event, false);
  assert.equal("active_date" in event, false);
  assert.equal("received_at" in event, false);

  const serialized = JSON.stringify(event).toLowerCase();
  for (const forbidden of [
    "password",
    "token",
    "cookie",
    "email",
    "phone",
    "clipboard",
    "file_content",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("the telemetry function accepts the exact daily_active event emitted by SDK 3.0", async () => {
  const emitted = [];
  const client = await TelemetryClient.init({
    appId: "bifang-tools",
    appVersion: "0.1.0",
    platform: "windows",
    arch: "x64",
    endpoint: "https://telemetry.example.com/apps/bifang-tools/v1/track",
    enabled: true,
    identityStorage: new MemoryIdentityStorage(),
    transport: {
      async send(_endpoint, event) {
        emitted.push(structuredClone(event));
      },
    },
    scheduler: (task) => task(),
    now: () => new Date("2026-09-10T04:00:00.000Z"),
  });

  await client.drain();

  assert.equal(SDK_VERSION, "3.0.0");
  assert.equal(emitted.length, 1);
  assert.deepEqual(validateAndSanitizePayload(emitted[0]), {
    ok: true,
    value: emitted[0],
  });
});

test("the generated template preserves telemetry and application-version boundaries", async () => {
  const config = await readJson("cloudbaserc.example.json");
  const telemetryFunctionPackage = await readJson(
    "cloudbase/functions/telemetry/package.json",
  );
  const applicationVersionFunctionPackage = await readJson(
    "cloudbase/functions/application-version-api/package.json",
  );
  const applicationVersionRepository = await readFile(
    new URL(
      "../cloudbase/functions/application-version-api/src/repository.js",
      import.meta.url,
    ),
    "utf8",
  );
  const telemetrySdkPackage = await readJson(
    "packages/telemetry-update-sdk/package.json",
  );
  const telemetryFunction = config.functions.find(
    (candidate) => candidate.name === "telemetry-bifang-screen-recorder",
  );
  const telemetryRoute = config.gateway.routes.find(
    (candidate) => candidate.path === "/apps/bifang-screen-recorder/v1/track",
  );
  const versionFunction = config.functions.find(
    (candidate) => candidate.name === "application-version-api",
  );
  const versionRoute = config.gateway.routes.find(
    (candidate) => candidate.path === "/tools/version-control/v1",
  );

  assert.equal(config.version, "2.1");
  assert.equal(telemetryFunction.type, "Event");
  assert.equal(telemetryFunction.runtime, "Nodejs20.19");
  assert.equal(telemetryFunction.handler, "index.main");
  assert.equal(telemetryFunction.timeout, 3);
  assert.equal(
    telemetryFunction.envVariables.TELEMETRY_COLLECTION,
    "telemetry_bifang_screen_recorder",
  );
  assert.equal(
    telemetryRoute.target,
    "function:telemetry-bifang-screen-recorder",
  );
  assert.equal(telemetryRoute.protocol, "HTTP_TO_HTTPS");
  assert.equal(telemetryRoute.enablePathTransmission, true);
  assert.equal(telemetryRoute.enableAuth, false);
  assert.equal(telemetryFunctionPackage.version, "3.0.0");
  assert.equal(telemetryFunctionPackage.version, telemetrySdkPackage.version);
  assert.equal(versionFunction.type, "Event");
  assert.equal(versionRoute.target, "function:application-version-api");
  assert.equal(versionRoute.enablePathTransmission, true);
  assert.equal(
    telemetryFunctionPackage.dependencies["@cloudbase/js-sdk"],
    "3.8.2",
  );
  assert.equal(
    applicationVersionFunctionPackage.dependencies["@cloudbase/node-sdk"],
    "3.18.3",
  );
  assert.equal(
    Object.hasOwn(
      applicationVersionFunctionPackage.dependencies,
      "@cloudbase/js-sdk",
    ),
    false,
  );
  assert.match(
    applicationVersionRepository,
    /require\("@cloudbase\/node-sdk"\)/u,
  );
  assert.doesNotMatch(
    applicationVersionRepository,
    /require\("@cloudbase\/js-sdk"\)/u,
  );
  assert.equal(
    applicationVersionFunctionPackage.dependencies.htmlparser2,
    "10.1.0",
  );
});
