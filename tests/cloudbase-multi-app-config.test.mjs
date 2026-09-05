import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { addApp, createDisabledUpdateManifest } from "../cloudbase/add-app.mjs";
import {
  createCloudBaseConfig,
  deriveAppResources,
  validateRegistry,
  validateUpdateManifests,
  validateWindowsUpdateManifest,
} from "../cloudbase/generate-cloudbaserc.mjs";

const readJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );

test("the app registry exactly generates the checked-in CloudBase template", async () => {
  const registry = await readJson("cloudbase/apps.json");
  const checkedIn = await readJson("cloudbaserc.json.example");
  const generated = createCloudBaseConfig(registry);

  assert.deepEqual(generated, checkedIn);
  await validateUpdateManifests(validateRegistry(registry));
});

test("each registered app gets one function, route, collection, and update path", () => {
  const appIds = ["bifang-tools", "image-helper"];
  const registry = {
    schema_version: 1,
    apps: appIds.map((app_id) => ({ app_id })),
  };
  const config = createCloudBaseConfig(registry);

  assert.equal(config.functions.length, appIds.length);
  assert.equal(config.gateway.routes.length, appIds.length + 1);
  assert.equal(
    config.gateway.routes.some((route) => route.path === "/v1/track"),
    false,
  );

  for (const appId of appIds) {
    const resources = deriveAppResources(appId);
    const fn = config.functions.find(
      (candidate) => candidate.name === resources.functionName,
    );
    const route = config.gateway.routes.find(
      (candidate) => candidate.path === resources.trackPath,
    );

    assert.ok(fn);
    assert.equal(fn.dir, "./cloudbase/functions/telemetry");
    assert.equal(fn.timeout, 3);
    assert.deepEqual(fn.envVariables, {
      ALLOWED_APP_IDS: appId,
      TELEMETRY_COLLECTION: resources.collectionName,
      TRACK_PATH: resources.trackPath,
    });
    assert.equal(route.target, `function:${resources.functionName}`);
    assert.equal(route.enableAuth, false);
    assert.equal(resources.updatePath, `/updates/${appId}`);
  }
});

test("the registry rejects ambiguous or unsafe deployment app ids", () => {
  const registryFor = (...appIds) => ({
    schema_version: 1,
    apps: appIds.map((app_id) => ({ app_id })),
  });

  assert.throws(
    () => validateRegistry(registryFor("same-tool", "same-tool")),
    /duplicate/,
  );
  for (const appId of [
    "Bad-App",
    "has_underscore",
    "has.dot",
    "-leading",
    "trailing-",
    "a".repeat(51),
  ]) {
    assert.throws(() => validateRegistry(registryFor(appId)), /app_id/);
  }
});

test("the app scaffold starts with a disabled and unusable update manifest", () => {
  const manifest = createDisabledUpdateManifest("new-tool");

  assert.equal(manifest.app_id, "new-tool");
  assert.equal(manifest.enabled, false);
  assert.equal(manifest.force_update, false);
  assert.equal(manifest.rollout, 0);
  assert.equal(manifest.sha256, "");
  assert.equal(
    new URL(manifest.download_url).hostname,
    "downloads.example.invalid",
  );
  assert.equal(
    new URL(manifest.release_notes_url).hostname,
    "releases.example.invalid",
  );
  assert.equal(validateWindowsUpdateManifest(manifest, "new-tool"), manifest);
});

test("the complete update contract rejects unsafe or internally inconsistent manifests", () => {
  const valid = createDisabledUpdateManifest("new-tool");
  const enabled = {
    ...valid,
    enabled: true,
    rollout: 100,
    download_url: "https://downloads.example.com/new-tool/setup.exe",
    release_notes_url: "https://releases.example.com/new-tool/0.0.0",
    sha256: "a".repeat(64),
  };
  assert.equal(validateWindowsUpdateManifest(enabled, "new-tool"), enabled);

  const invalidCases = [
    { ...valid, latest_version: "v1.0.0" },
    { ...valid, min_supported_version: "1.0.0", latest_version: "0.9.0" },
    { ...valid, download_url: "http://downloads.example.com/tool.exe" },
    { ...valid, rollout: 1 },
    { ...valid, force_update: true },
    { ...valid, published_at: "2026-02-30T00:00:00Z" },
    { ...valid, extra_field: true },
    { ...valid, enabled: true, rollout: 100 },
  ];

  for (const manifest of invalidCases) {
    assert.throws(
      () => validateWindowsUpdateManifest(manifest, "new-tool"),
      /cloudbase\/updates\/new-tool\/windows\.json/,
    );
  }
});

test("the app scaffold adds a real temporary second app without overwriting the first", async () => {
  await withTemporaryCloudBaseFixture(async (fixture) => {
    const resources = await addApp("second-tool", fixture);
    const registry = JSON.parse(await readFile(fixture.registryUrl, "utf8"));
    const config = JSON.parse(await readFile(fixture.configUrl, "utf8"));
    const secondManifest = JSON.parse(
      await readFile(
        new URL("second-tool/windows.json", fixture.updatesUrl),
        "utf8",
      ),
    );

    assert.deepEqual(
      registry.apps.map((app) => app.app_id),
      ["first-tool", "second-tool"],
    );
    assert.deepEqual(config, createCloudBaseConfig(registry));
    assert.equal(resources.functionName, "telemetry-second-tool");
    assert.equal(secondManifest.app_id, "second-tool");
    assert.equal(secondManifest.enabled, false);
    await validateUpdateManifests(
      validateRegistry(registry),
      fixture.updatesUrl,
    );
  });
});

test("the app scaffold refuses existing ids and orphan update directories", async () => {
  await withTemporaryCloudBaseFixture(async (fixture) => {
    const registryBefore = await readFile(fixture.registryUrl, "utf8");
    const configBefore = await readFile(fixture.configUrl, "utf8");

    await assert.rejects(addApp("first-tool", fixture), /already exists/);
    assert.equal(await readFile(fixture.registryUrl, "utf8"), registryBefore);
    assert.equal(await readFile(fixture.configUrl, "utf8"), configBefore);

    await mkdir(new URL("orphan-tool/", fixture.updatesUrl));
    await assert.rejects(
      validateUpdateManifests(["first-tool"], fixture.updatesUrl),
      /unregistered update directories: orphan-tool/,
    );
  });
});

async function withTemporaryCloudBaseFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "bifang-cloudbase-test-"));
  const cloudbasePath = join(root, "cloudbase");
  const updatesPath = join(cloudbasePath, "updates");
  const firstUpdatesPath = join(updatesPath, "first-tool");
  const registryUrl = pathToFileURL(join(cloudbasePath, "apps.json"));
  const configUrl = pathToFileURL(join(root, "cloudbaserc.json.example"));
  const updatesUrl = pathToFileURL(`${updatesPath}${sep}`);
  const registry = {
    schema_version: 1,
    apps: [{ app_id: "first-tool" }],
  };

  try {
    await mkdir(firstUpdatesPath, { recursive: true });
    await writeFile(
      registryUrl,
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      configUrl,
      `${JSON.stringify(createCloudBaseConfig(registry), null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      pathToFileURL(join(firstUpdatesPath, "windows.json")),
      `${JSON.stringify(createDisabledUpdateManifest("first-tool"), null, 2)}\n`,
      "utf8",
    );

    await run({ registryUrl, configUrl, updatesUrl });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
