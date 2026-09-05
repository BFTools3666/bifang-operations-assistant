import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createCloudBaseConfig,
  deriveAppResources,
  validateRegistry,
  validateUpdateManifests,
  validateWindowsUpdateManifest,
} from "./generate-cloudbaserc.mjs";

const defaultRegistryUrl = new URL("./apps.json", import.meta.url);
const defaultConfigUrl = new URL(
  "../cloudbaserc.json.example",
  import.meta.url,
);
const defaultUpdatesUrl = new URL("./updates/", import.meta.url);

export function createDisabledUpdateManifest(appId) {
  deriveAppResources(appId);
  const manifest = {
    schema_version: 1,
    app_id: appId,
    platform: "windows",
    latest_version: "0.0.0",
    min_supported_version: "0.0.0",
    enabled: false,
    force_update: false,
    rollout: 0,
    title: `${appId} 尚未发布更新`,
    message: "此清单尚未配置真实安装包，当前不会向用户显示更新。",
    download_url: `https://downloads.example.invalid/${appId}/replace-me.exe`,
    release_notes_url: `https://releases.example.invalid/${appId}/replace-me`,
    sha256: "",
    published_at: "1970-01-01T00:00:00.000Z",
  };
  return validateWindowsUpdateManifest(manifest, appId);
}

export async function addApp(appId, options = {}) {
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const configUrl = options.configUrl || defaultConfigUrl;
  const updatesUrl = options.updatesUrl || defaultUpdatesUrl;
  const resources = deriveAppResources(appId);
  const currentRegistryText = await readFile(registryUrl, "utf8");
  const registry = JSON.parse(currentRegistryText);
  const currentAppIds = validateRegistry(registry);
  if (currentAppIds.includes(appId)) {
    throw new Error(`app_id already exists: ${appId}`);
  }

  // Refuse to overwrite a hand-edited or stale generated file. The operator can
  // review and reconcile it before running this command again.
  const expectedCurrentConfig = `${JSON.stringify(
    createCloudBaseConfig(registry),
    null,
    2,
  )}\n`;
  const currentConfig = await readFile(configUrl, "utf8");
  if (currentConfig !== expectedCurrentConfig) {
    throw new Error(
      "cloudbaserc.json.example has ungenerated changes; run the config check and reconcile it first",
    );
  }
  await validateUpdateManifests(currentAppIds, updatesUrl);

  const nextRegistry = {
    ...registry,
    apps: [...registry.apps, { app_id: appId }],
  };
  const nextRegistryText = `${JSON.stringify(nextRegistry, null, 2)}\n`;
  const nextConfigText = `${JSON.stringify(
    createCloudBaseConfig(nextRegistry),
    null,
    2,
  )}\n`;
  const manifestText = `${JSON.stringify(
    createDisabledUpdateManifest(appId),
    null,
    2,
  )}\n`;
  const appUpdatesUrl = new URL(`${encodeURIComponent(appId)}/`, updatesUrl);
  const manifestUrl = new URL("windows.json", appUpdatesUrl);
  let createdDirectory = false;
  let registryTouched = false;
  let configTouched = false;

  try {
    await mkdir(appUpdatesUrl, { recursive: false });
    createdDirectory = true;
    await writeFile(manifestUrl, manifestText, {
      encoding: "utf8",
      flag: "wx",
    });
    registryTouched = true;
    await writeFile(registryUrl, nextRegistryText, "utf8");
    configTouched = true;
    await writeFile(configUrl, nextConfigText, "utf8");
    await validateUpdateManifests([...currentAppIds, appId], updatesUrl);
  } catch (error) {
    const rollback = [];
    if (registryTouched) {
      rollback.push(writeFile(registryUrl, currentRegistryText, "utf8"));
    }
    if (configTouched) {
      rollback.push(writeFile(configUrl, currentConfig, "utf8"));
    }
    if (createdDirectory) {
      rollback.push(rm(appUpdatesUrl, { recursive: true, force: true }));
    }
    const rollbackResults = await Promise.allSettled(rollback);
    const rollbackFailures = rollbackResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "app scaffold failed and rollback was incomplete",
      );
    }
    throw error;
  }

  return resources;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new TypeError("usage: npm run cloudbase:app:add -- <app_id>");
  }
  const resources = await addApp(args[0]);
  process.stdout.write(
    `added ${resources.appId}: ${resources.functionName}, ${resources.trackPath}, ${resources.collectionName}, ${resources.updatePath}/windows.json\n`,
  );
}

const isMain =
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(resolve(process.argv[1])).href.toLowerCase();

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
