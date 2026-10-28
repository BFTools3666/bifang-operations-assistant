import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalizeReleaseStreams,
  createCloudBaseConfig,
  validateRegistry,
  validateReleaseStream,
} from "./generate-cloudbaserc.mjs";

const defaultRegistryUrl = new URL("./apps.json", import.meta.url);
const defaultConfigUrl = new URL(
  "../cloudbaserc.example.json",
  import.meta.url,
);

export async function addReleaseStream(appId, releaseStream, options = {}) {
  const stream = validateReleaseStream(releaseStream);
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const configUrl = options.configUrl || defaultConfigUrl;
  const currentRegistryText = await readFile(registryUrl, "utf8");
  const registry = JSON.parse(currentRegistryText);
  const currentApplications = validateRegistry(registry);
  const application = currentApplications.find(
    (candidate) => candidate.appId === appId,
  );
  if (!application) {
    throw new Error(`app_id is not registered: ${appId}`);
  }

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

  const nextStreams = canonicalizeReleaseStreams([
    ...application.releaseStreams,
    stream,
  ]);
  const nextRegistry = {
    ...registry,
    apps: registry.apps.map((candidate) =>
      candidate.app_id === appId
        ? { ...candidate, release_streams: nextStreams }
        : candidate,
    ),
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
        "release-stream registration failed and rollback was incomplete",
      );
    }
    throw error;
  }

  return { appId, releaseStream: stream };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5) {
    throw new TypeError(
      "usage: npm run cloudbase:app:stream:add -- <app_id> <platform> <architecture> <channel> <code>",
    );
  }
  const [appId, platform, architecture, channel, code] = args;
  const result = await addReleaseStream(appId, {
    platform,
    architecture,
    channel,
    code,
  });
  process.stdout.write(
    `added release stream ${result.releaseStream.code} for ${result.appId}\n`,
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
