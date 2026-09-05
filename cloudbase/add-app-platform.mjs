import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createDisabledUpdateManifest } from "./add-app.mjs";
import {
  SUPPORTED_UPDATE_PLATFORMS,
  createCloudBaseConfig,
  validateRegistry,
  validateUpdateManifests,
  validateUpdatePlatforms,
} from "./generate-cloudbaserc.mjs";

const defaultRegistryUrl = new URL("./apps.json", import.meta.url);
const defaultConfigUrl = new URL(
  "../cloudbaserc.json.example",
  import.meta.url,
);
const defaultUpdatesUrl = new URL("./updates/", import.meta.url);

export async function addAppPlatform(appId, platform, options = {}) {
  validateUpdatePlatforms([platform]);
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const configUrl = options.configUrl || defaultConfigUrl;
  const updatesUrl = options.updatesUrl || defaultUpdatesUrl;
  const currentRegistryText = await readFile(registryUrl, "utf8");
  const registry = JSON.parse(currentRegistryText);
  const currentApplications = validateRegistry(registry);
  const application = currentApplications.find(
    (candidate) => candidate.appId === appId,
  );
  if (!application) {
    throw new Error(`app_id is not registered: ${appId}`);
  }
  if (application.platforms.includes(platform)) {
    throw new Error(`platform already exists for ${appId}: ${platform}`);
  }

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
  await validateUpdateManifests(currentApplications, updatesUrl);

  const requestedPlatforms = new Set([...application.platforms, platform]);
  const nextPlatforms = SUPPORTED_UPDATE_PLATFORMS.filter((candidate) =>
    requestedPlatforms.has(candidate),
  );
  const nextRegistry = {
    ...registry,
    apps: registry.apps.map((candidate) =>
      candidate.app_id === appId
        ? { ...candidate, platforms: nextPlatforms }
        : candidate,
    ),
  };
  const nextRegistryText = `${JSON.stringify(nextRegistry, null, 2)}\n`;
  const manifestUrl = new URL(
    `${encodeURIComponent(appId)}/${platform}.json`,
    updatesUrl,
  );
  const manifestText = `${JSON.stringify(
    createDisabledUpdateManifest(appId, platform),
    null,
    2,
  )}\n`;
  let manifestCreated = false;
  let registryTouched = false;

  try {
    await writeFile(manifestUrl, manifestText, {
      encoding: "utf8",
      flag: "wx",
    });
    manifestCreated = true;
    registryTouched = true;
    await writeFile(registryUrl, nextRegistryText, "utf8");
    await validateUpdateManifests(validateRegistry(nextRegistry), updatesUrl);
  } catch (error) {
    const rollback = [];
    if (registryTouched) {
      rollback.push(writeFile(registryUrl, currentRegistryText, "utf8"));
    }
    if (manifestCreated) {
      rollback.push(rm(manifestUrl, { force: true }));
    }
    const rollbackResults = await Promise.allSettled(rollback);
    const rollbackFailures = rollbackResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "platform scaffold failed and rollback was incomplete",
      );
    }
    throw error;
  }

  return {
    appId,
    platform,
    manifestPath: `/updates/${appId}/${platform}.json`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    throw new TypeError(
      "usage: npm run cloudbase:app:platform:add -- <app_id> <platform>",
    );
  }
  const result = await addAppPlatform(args[0], args[1]);
  process.stdout.write(
    `added ${result.platform} manifest for ${result.appId}: ${result.manifestPath}\n`,
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
