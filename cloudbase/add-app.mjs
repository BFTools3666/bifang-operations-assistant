import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalizeReleaseStreams,
  createCloudBaseConfig,
  deriveAppResources,
  validateRegistry,
} from "./generate-cloudbaserc.mjs";

const defaultRegistryUrl = new URL("./apps.json", import.meta.url);
const defaultConfigUrl = new URL(
  "../cloudbaserc.example.json",
  import.meta.url,
);

export async function addApp(appId, options = {}) {
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const configUrl = options.configUrl || defaultConfigUrl;
  const releaseStreams = canonicalizeReleaseStreams(
    options.releaseStreams ?? [],
    "releaseStreams",
  );
  const resources = deriveAppResources(appId);
  const currentRegistryText = await readFile(registryUrl, "utf8");
  const registry = JSON.parse(currentRegistryText);
  const currentApplications = validateRegistry(registry);
  if (currentApplications.some((application) => application.appId === appId)) {
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
  if (currentConfig.replaceAll("\r\n", "\n") !== expectedCurrentConfig) {
    throw new Error(
      "cloudbaserc.example.json has ungenerated changes; run the config check and reconcile it first",
    );
  }

  const nextRegistry = {
    ...registry,
    apps: [
      ...registry.apps,
      { app_id: appId, release_streams: releaseStreams },
    ],
  };
  validateRegistry(nextRegistry);
  const nextRegistryText = `${JSON.stringify(nextRegistry, null, 2)}\n`;
  const nextConfigText = `${JSON.stringify(
    createCloudBaseConfig(nextRegistry),
    null,
    2,
  )}\n`;
  let registryTouched = false;
  let configTouched = false;

  try {
    registryTouched = true;
    await writeFile(registryUrl, nextRegistryText, "utf8");
    configTouched = true;
    await writeFile(configUrl, nextConfigText, "utf8");
  } catch (error) {
    const rollback = [];
    if (registryTouched) {
      rollback.push(writeFile(registryUrl, currentRegistryText, "utf8"));
    }
    if (configTouched) {
      rollback.push(writeFile(configUrl, currentConfig, "utf8"));
    }
    const rollbackResults = await Promise.allSettled(rollback);
    const rollbackFailures = rollbackResults
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "app registration failed and rollback was incomplete",
      );
    }
    throw error;
  }

  return {
    ...resources,
    releaseStreams,
  };
}

function parseReleaseStreams(args) {
  if (args.length === 0 || args.length % 4 !== 0) {
    throw new TypeError(
      "each release stream requires <platform> <architecture> <channel> <code>",
    );
  }
  const streams = [];
  for (let index = 0; index < args.length; index += 4) {
    streams.push({
      platform: args[index],
      architecture: args[index + 1],
      channel: args[index + 2],
      code: args[index + 3],
    });
  }
  return streams;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 && (args.length < 5 || (args.length - 1) % 4 !== 0)) {
    throw new TypeError(
      "usage: npm run cloudbase:app:add -- <app_id> [<platform> <architecture> <channel> <code> ...]",
    );
  }
  const [appId, ...releaseStreamArgs] = args;
  const resources = await addApp(appId, {
    releaseStreams: releaseStreamArgs.length
      ? parseReleaseStreams(releaseStreamArgs)
      : [],
  });
  process.stdout.write(
    `added ${resources.appId}: ${resources.functionName}, ${resources.trackPath}, ${resources.collectionName}; legacy release codes: ${resources.releaseStreams.map(({ code }) => code).join(", ") || "none"}\n`,
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
