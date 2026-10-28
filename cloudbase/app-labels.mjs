import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEPLOYMENT_APP_ID_PATTERN,
  validateRegistry,
} from "./generate-cloudbaserc.mjs";

const require = createRequire(import.meta.url);
const {
  validateAppLabels,
} = require("./functions/operations-dashboard/src/app-labels.js");
const defaultLabelsFile = new URL(
  "./functions/operations-dashboard/src/app-labels.json",
  import.meta.url,
);
const defaultRegistryFile = new URL("./apps.json", import.meta.url);
const CHINESE_CHARACTER = /\p{Script=Han}/u;

export function validateAppLabelCoverage(registry, labels) {
  const applications = validateRegistry(registry);
  const catalog = validateAppLabels(labels);
  for (const { appId } of applications) {
    if (!Object.hasOwn(catalog, appId)) {
      throw new TypeError(`missing display name for registered app: ${appId}`);
    }
    assertChineseName(appId, catalog[appId]);
  }
  return catalog;
}

export function validateObservedAppLabels(appIds, labels) {
  if (
    !Array.isArray(appIds) ||
    appIds.length === 0 ||
    appIds.some(
      (appId) =>
        typeof appId !== "string" || !DEPLOYMENT_APP_ID_PATTERN.test(appId),
    ) ||
    new Set(appIds).size !== appIds.length
  ) {
    throw new TypeError(
      "observed appIds must be a non-empty array of unique valid APP_IDs",
    );
  }
  const catalog = validateAppLabels(labels);
  const observedLabels = {};
  for (const appId of appIds) {
    if (!Object.hasOwn(catalog, appId)) {
      throw new TypeError(`missing display name for observed app: ${appId}`);
    }
    assertChineseName(appId, catalog[appId]);
    observedLabels[appId] = catalog[appId];
  }
  return Object.freeze(observedLabels);
}

export async function checkAppLabels(options = {}) {
  const { registry, labels, applications } = await readState(options);
  validateAppLabelCoverage(registry, labels);
  let profileCheck = {};
  if (options.profileFile) {
    let profile;
    try {
      const body = await readFile(options.profileFile);
      if (body.length > 1_048_576) throw new Error();
      profile = JSON.parse(body.toString("utf8").replace(/^\uFEFF/u, ""));
    } catch {
      throw new TypeError("unable to read a valid non-sensitive Profile JSON");
    }
    if (
      !profile ||
      Array.isArray(profile) ||
      profile.profile_schema_version !== 2 ||
      typeof profile.app_id !== "string" ||
      !DEPLOYMENT_APP_ID_PATTERN.test(profile.app_id)
    ) {
      throw new TypeError(
        "name verification requires a Profile v2 with a valid app_id",
      );
    }
    validateObservedAppLabels([profile.app_id], {
      [profile.app_id]: profile.display_name,
    });
    if (!applications.some(({ appId }) => appId === profile.app_id)) {
      throw new TypeError("Profile application is not registered");
    }
    if (labels[profile.app_id] !== profile.display_name) {
      throw new TypeError(
        "registered display name does not match Profile display_name",
      );
    }
    profileCheck = {
      profileAppId: profile.app_id,
      profileDisplayNameMatches: true,
    };
  }
  const catalogCount = Object.keys(labels).length;
  return {
    registeredCount: applications.length,
    catalogCount,
    metadataOnlyCount: catalogCount - applications.length,
    ...profileCheck,
  };
}

export async function listAppLabels(options = {}) {
  const { labels, applications } = await readState(options);
  const registeredIds = new Set(applications.map(({ appId }) => appId));
  return [...new Set([...registeredIds, ...Object.keys(labels)])]
    .sort()
    .map((appId) => ({
      appId,
      displayName: labels[appId] ?? null,
      registered: registeredIds.has(appId),
    }));
}

export async function setAppLabel(appId, displayName, options = {}) {
  if (typeof appId !== "string") {
    throw new TypeError("app_id must be a string");
  }
  const { labels, applications } = await readState(options);
  const nextLabels = validateAppLabels({ ...labels, [appId]: displayName });
  assertChineseName(appId, nextLabels[appId]);
  const labelsFile = asPath(options.labelsFile ?? defaultLabelsFile);
  const temporaryFile = `${labelsFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryFile, `${JSON.stringify(nextLabels, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryFile, labelsFile);
  } finally {
    await rm(temporaryFile, { force: true });
  }
  return {
    appId,
    displayName,
    registered: applications.some((app) => app.appId === appId),
  };
}

async function readState(options) {
  const [registryText, labelsText] = await Promise.all([
    readFile(options.registryFile ?? defaultRegistryFile, "utf8"),
    readFile(options.labelsFile ?? defaultLabelsFile, "utf8"),
  ]);
  const registry = JSON.parse(registryText);
  return {
    registry,
    applications: validateRegistry(registry),
    labels: validateAppLabels(JSON.parse(labelsText)),
  };
}

function assertChineseName(appId, displayName) {
  if (!CHINESE_CHARACTER.test(displayName)) {
    throw new TypeError(
      `display name must include Chinese characters: ${appId}`,
    );
  }
}

function asPath(value) {
  return value instanceof URL ? fileURLToPath(value) : resolve(value);
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const positional = [];
  const options = {};
  const optionKeys = {
    "--labels-file": "labelsFile",
    "--registry-file": "registryFile",
    "--profile-file": "profileFile",
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const optionKey = Object.hasOwn(optionKeys, argument)
      ? optionKeys[argument]
      : undefined;
    if (optionKey) {
      const value = rest[index + 1];
      if (!value || value.startsWith("--") || options[optionKey]) {
        throw new TypeError(`invalid or duplicate option: ${argument}`);
      }
      options[optionKey] = resolve(value);
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new TypeError(`unknown option: ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  if (
    !["check", "list", "set"].includes(command) ||
    (options.profileFile && command !== "check") ||
    positional.length !== (command === "set" ? 2 : 0)
  ) {
    throw new TypeError(
      'usage: node cloudbase/app-labels.mjs check [--profile-file <path>] | list | set <app_id> "中文显示名" [--labels-file <path>] [--registry-file <path>]; npm run cloudbase:app:name -- <app_id> "中文显示名"',
    );
  }
  return { command, positional, options };
}

async function main() {
  const { command, positional, options } = parseArguments(
    process.argv.slice(2),
  );
  const result =
    command === "check"
      ? await checkAppLabels(options)
      : command === "list"
        ? await listAppLabels(options)
        : await setAppLabel(positional[0], positional[1], options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
