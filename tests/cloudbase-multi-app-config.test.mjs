import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { addApp } from "../cloudbase/add-app.mjs";
import { addReleaseStream } from "../cloudbase/add-release-stream.mjs";
import {
  APPLICATION_VERSION_API,
  OPERATIONS_DASHBOARD,
  createCloudBaseConfig,
  deriveAppResources,
  deriveApplicationVersionResources,
  validateRegistry,
} from "../cloudbase/generate-cloudbaserc.mjs";

const repositoryRoot = new URL("../", import.meta.url);

const stream = (overrides = {}) => ({
  platform: "windows",
  architecture: "x64",
  channel: "stable",
  code: "first-tool",
  ...overrides,
});

const registry = (apps = undefined) => ({
  schema_version: 3,
  apps: apps || [
    {
      app_id: "first-tool",
      release_streams: [stream()],
    },
  ],
});

test("the app registry exactly generates the checked-in CloudBase template", async () => {
  const checkedInRegistry = JSON.parse(
    await readFile(new URL("cloudbase/apps.json", repositoryRoot), "utf8"),
  );
  const checkedInConfig = JSON.parse(
    await readFile(new URL("cloudbaserc.example.json", repositoryRoot), "utf8"),
  );

  assert.deepEqual(createCloudBaseConfig(checkedInRegistry), checkedInConfig);
});

test("the pinned CloudBase CLI 3.8.1 accepts the generated template offline", () => {
  const cli = fileURLToPath(
    new URL("../node_modules/@cloudbase/cli/bin/tcb", import.meta.url),
  );
  const config = fileURLToPath(
    new URL("../cloudbaserc.example.json", import.meta.url),
  );
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "validate",
      "--config-file",
      config,
      "--json",
      "--env-id",
      "offline-config-check",
    ],
    {
      cwd: fileURLToPath(repositoryRoot),
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        APPLICATION_VERSION_CREDENTIALS_B64: "dGVzdA==",
        DASHBOARD_TOKEN_SHA256: "a".repeat(64),
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.valid, true);
  assert.equal(output.version, "2.1");
  assert.deepEqual(output.errors, []);
  assert.deepEqual(output.summary, {
    functions: 4,
    hosting: 0,
    databases: 0,
    gateways: 4,
  });
});

test("release streams are the non-sensitive authority while telemetry remains isolated", async () => {
  const checkedInRegistry = JSON.parse(
    await readFile(new URL("cloudbase/apps.json", repositoryRoot), "utf8"),
  );
  const applications = validateRegistry(checkedInRegistry);
  const config = createCloudBaseConfig(checkedInRegistry);

  assert.equal(checkedInRegistry.schema_version, 3);
  assert.deepEqual(
    applications.map(({ appId, releaseStreams }) => ({
      appId,
      codes: releaseStreams.map(({ code }) => code),
    })),
    [
      {
        appId: "bifang-screen-recorder",
        codes: [
          "bifang-screen-recorder-windows-x64",
          "bifang-screen-recorder-macos-arm64",
        ],
      },
      {
        appId: "bifang-mouse-clicker",
        codes: ["bifang-mouse-clicker"],
      },
    ],
  );

  for (const { appId } of applications) {
    const telemetry = deriveAppResources(appId);
    const telemetryFunction = config.functions.find(
      ({ name }) => name === telemetry.functionName,
    );
    const telemetryRoute = config.gateway.routes.find(
      ({ path }) => path === telemetry.trackPath,
    );
    assert.ok(telemetryFunction);
    assert.equal(
      telemetryFunction.envVariables.TELEMETRY_COLLECTION,
      telemetry.collectionName,
    );
    assert.equal(telemetryFunction.envVariables.ALLOWED_APP_IDS, appId);
    assert.equal(telemetryRoute.target, `function:${telemetry.functionName}`);
  }

  const versionFunction = config.functions.find(
    ({ name }) => name === APPLICATION_VERSION_API.functionName,
  );
  const applicationResources = JSON.parse(
    JSON.parse(versionFunction.envVariables.APPLICATION_VERSION_APPS_JSON),
  );
  assert.deepEqual(
    applicationResources,
    applications.map(({ appId }) => deriveApplicationVersionResources(appId)),
  );

  const dashboardFunction = config.functions.find(
    ({ name }) => name === OPERATIONS_DASHBOARD.functionName,
  );
  assert.equal(
    dashboardFunction.envVariables.CLOUDBASE_ENV_ID,
    "{{tcb.envId}}",
  );
  const dashboardApps = JSON.parse(
    JSON.parse(dashboardFunction.envVariables.DASHBOARD_APPS_JSON),
  );
  assert.deepEqual(dashboardApps[0], {
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
  });
  assert.equal(
    "DASHBOARD_UPDATES_BASE_URL" in dashboardFunction.envVariables,
    false,
  );
  assert.equal("hosting" in config, false);
  assert.deepEqual(
    config.gateway.routes.map(({ path }) => path),
    [
      "/apps/bifang-screen-recorder/v1/track",
      "/apps/bifang-mouse-clicker/v1/track",
      "/tools/version-control/v1",
      "/admin/v1/metrics",
    ],
  );
  assert.equal(JSON.stringify(config).includes("cloudbase/updates"), false);
});

test("registry v3 rejects ambiguous, duplicate and unsafe release identities", () => {
  assert.throws(
    () => validateRegistry({ schema_version: 2, apps: [] }),
    /schema_version must be 3/,
  );
  assert.throws(
    () =>
      validateRegistry({
        ...registry(),
        apps: [{ app_id: "Bad_App", release_streams: [stream()] }],
      }),
    /app_id must be/,
  );

  for (const invalidStream of [
    stream({ platform: "android" }),
    stream({ architecture: "riscv64" }),
    stream({ channel: "Stable" }),
    stream({ code: "has/slash" }),
    { ...stream(), unexpected: true },
  ]) {
    assert.throws(
      () =>
        validateRegistry(
          registry([
            { app_id: "first-tool", release_streams: [invalidStream] },
          ]),
        ),
      /must be|must contain/,
    );
  }

  assert.throws(
    () =>
      validateRegistry(
        registry([
          {
            app_id: "first-tool",
            release_streams: [stream(), stream({ code: "another-code" })],
          },
        ]),
      ),
    /duplicate platform\/architecture\/channel targets/,
  );
  assert.throws(
    () =>
      validateRegistry(
        registry([
          { app_id: "first-tool", release_streams: [stream()] },
          {
            app_id: "second-tool",
            release_streams: [stream({ code: "first-tool" })],
          },
        ]),
      ),
    /duplicate release code/,
  );
  assert.throws(
    () =>
      validateRegistry(
        registry([
          {
            app_id: "first-tool",
            release_streams: [
              stream({
                platform: "macos",
                architecture: "arm64",
                code: "first-tool-macos",
              }),
              stream(),
            ],
          },
        ]),
      ),
    /canonical release-stream order/,
  );
  assert.throws(
    () =>
      validateRegistry(
        registry([
          {
            app_id: "first-tool",
            release_streams: Array.from({ length: 13 }, (_, index) =>
              stream({
                channel: `channel-${String(index).padStart(2, "0")}`,
                code: `first-tool-${String(index).padStart(2, "0")}`,
              }),
            ),
          },
        ]),
      ),
    /between 1 and 12 items/,
  );
});

test("the app scaffold registers app and streams without creating update files", async () => {
  await withTemporaryCloudBaseFixture(async (fixture) => {
    const result = await addApp("second-tool", {
      ...fixture,
      releaseStreams: [
        stream({
          platform: "macos",
          architecture: "arm64",
          code: "second-tool-macos-arm64",
        }),
        stream({ code: "second-tool-windows-x64" }),
      ],
    });
    const nextRegistry = JSON.parse(
      await readFile(fixture.registryUrl, "utf8"),
    );
    const nextConfig = JSON.parse(await readFile(fixture.configUrl, "utf8"));

    assert.equal(result.appId, "second-tool");
    assert.equal(result.functionName, "telemetry-second-tool");
    assert.equal("updatePath" in result, false);
    assert.deepEqual(
      nextRegistry.apps[1].release_streams.map(({ code }) => code),
      ["second-tool-windows-x64", "second-tool-macos-arm64"],
    );
    assert.deepEqual(nextConfig, createCloudBaseConfig(nextRegistry));
    assert.equal("hosting" in nextConfig, false);
  });
});

test("a registered app can add one canonical release stream without overwrites", async () => {
  await withTemporaryCloudBaseFixture(async (fixture) => {
    const result = await addReleaseStream(
      "first-tool",
      stream({
        platform: "macos",
        architecture: "arm64",
        code: "first-tool-macos-arm64",
      }),
      fixture,
    );
    const nextRegistry = JSON.parse(
      await readFile(fixture.registryUrl, "utf8"),
    );

    assert.deepEqual(result, {
      appId: "first-tool",
      releaseStream: {
        platform: "macos",
        architecture: "arm64",
        channel: "stable",
        code: "first-tool-macos-arm64",
      },
    });
    assert.deepEqual(
      nextRegistry.apps[0].release_streams.map(({ code }) => code),
      ["first-tool", "first-tool-macos-arm64"],
    );
    assert.deepEqual(
      JSON.parse(await readFile(fixture.configUrl, "utf8")),
      createCloudBaseConfig(nextRegistry),
    );

    const registryBeforeDuplicate = await readFile(fixture.registryUrl, "utf8");
    await assert.rejects(
      addReleaseStream(
        "first-tool",
        stream({ code: "duplicate-target" }),
        fixture,
      ),
      /duplicate platform\/architecture\/channel targets/,
    );
    assert.equal(
      await readFile(fixture.registryUrl, "utf8"),
      registryBeforeDuplicate,
    );
  });
});

test("app and stream registration refuse stale generated configuration", async () => {
  await withTemporaryCloudBaseFixture(async (fixture) => {
    const registryBefore = await readFile(fixture.registryUrl, "utf8");
    await writeFile(fixture.configUrl, "{}\n", "utf8");

    await assert.rejects(
      addApp("second-tool", {
        ...fixture,
        releaseStreams: [stream({ code: "second-tool" })],
      }),
      /ungenerated changes/,
    );
    await assert.rejects(
      addReleaseStream(
        "first-tool",
        stream({
          platform: "macos",
          architecture: "arm64",
          code: "first-tool-macos",
        }),
        fixture,
      ),
      /ungenerated changes/,
    );
    assert.equal(await readFile(fixture.registryUrl, "utf8"), registryBefore);
  });
});

async function withTemporaryCloudBaseFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "bifang-cloudbase-test-"));
  const cloudbasePath = join(root, "cloudbase");
  const registryUrl = pathToFileURL(join(cloudbasePath, "apps.json"));
  const configUrl = pathToFileURL(join(root, "cloudbaserc.example.json"));
  const initialRegistry = registry();

  try {
    await mkdir(cloudbasePath, { recursive: true });
    await writeFile(
      registryUrl,
      `${JSON.stringify(initialRegistry, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      configUrl,
      `${JSON.stringify(createCloudBaseConfig(initialRegistry), null, 2)}\n`,
      "utf8",
    );
    await run({ registryUrl, configUrl });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
