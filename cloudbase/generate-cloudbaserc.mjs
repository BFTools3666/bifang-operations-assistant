import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const registryUrl = new URL("./apps.json", import.meta.url);
const outputUrl = new URL("../cloudbaserc.json.example", import.meta.url);

// `telemetry-` leaves 50 of SCF's 60 characters for the app id. Keeping the
// registry alphabet narrower than the public protocol makes every derived
// function name, route segment, and collection name reversible and collision
// free.
export const DEPLOYMENT_APP_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
export const SUPPORTED_UPDATE_PLATFORMS = Object.freeze(["windows", "macos"]);
export const OPERATIONS_DASHBOARD = Object.freeze({
  functionName: "operations-dashboard-api",
  path: "/admin/v1/metrics",
});
export const APPLICATION_VERSION_API = Object.freeze({
  functionName: "application-version-api",
  path: "/tools/version-control/v1",
});
const UPDATE_MANIFEST_KEYS = [
  "app_id",
  "download_url",
  "enabled",
  "force_update",
  "latest_version",
  "message",
  "min_supported_version",
  "platform",
  "published_at",
  "release_notes_url",
  "rollout",
  "schema_version",
  "sha256",
  "title",
];
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
const VISIBLE_DISPLAY_CONTENT_PATTERN = /[^\s\u200c\u200d\ufe00-\ufe0f]/u;

export function deriveAppResources(appId) {
  assertDeploymentAppId(appId);
  return {
    appId,
    functionName: `telemetry-${appId}`,
    collectionName: `telemetry_${appId.replaceAll("-", "_")}`,
    trackPath: `/apps/${appId}/v1/track`,
    updatePath: `/updates/${appId}`,
  };
}

export function deriveApplicationVersionResources(appId) {
  assertDeploymentAppId(appId);
  const normalized = appId.replaceAll("-", "_");
  return {
    appId,
    versionCollection: `versions_${normalized}`,
    adCollection: `ads_${normalized}`,
    auditCollection: `audit_${normalized}`,
  };
}

export function createCloudBaseConfig(registry) {
  const applications = validateRegistry(registry);
  const resources = applications.map(({ appId }) => deriveAppResources(appId));
  const dashboardApps = applications.map(({ appId, platforms }) => ({
    appId,
    collectionName: deriveAppResources(appId).collectionName,
    platforms,
  }));
  const applicationVersionApps = applications.map(({ appId }) =>
    deriveApplicationVersionResources(appId),
  );

  return {
    $schema: "https://static.cloudbase.net/cli/cloudbaserc.schema.json",
    version: "2.1",
    envId: "{{env.ENV_ID}}",
    functionRoot: "./cloudbase/functions",
    functions: [
      ...resources.map((resource) => ({
        name: resource.functionName,
        // CloudBase CLI resolves an explicit dir from the project root, not from
        // functionRoot. All isolated function instances intentionally reuse this
        // same source directory.
        dir: "./cloudbase/functions/telemetry",
        type: "Event",
        runtime: "Nodejs20.19",
        handler: "index.main",
        timeout: 3,
        memorySize: 256,
        installDependency: true,
        envVariables: {
          ALLOWED_APP_IDS: resource.appId,
          TELEMETRY_COLLECTION: resource.collectionName,
          TRACK_PATH: resource.trackPath,
        },
      })),
      {
        name: APPLICATION_VERSION_API.functionName,
        dir: "./cloudbase/functions/application-version-api",
        type: "Event",
        runtime: "Nodejs20.19",
        handler: "index.main",
        timeout: 3,
        memorySize: 256,
        installDependency: true,
        envVariables: {
          // Use the CLI-selected target environment directly. The deployment
          // plan also passes -e, so no separate ENV_ID template variable can
          // drift from the reviewed target.
          CLOUDBASE_ENV_ID: "{{tcb.envId}}",
          APPLICATION_VERSION_API_PATH: APPLICATION_VERSION_API.path,
          // This mapping contains collection names only. Credentials and their
          // digests are injected separately and are never written to Git.
          APPLICATION_VERSION_APPS_JSON: JSON.stringify(
            JSON.stringify(applicationVersionApps),
          ),
          APPLICATION_VERSION_CREDENTIALS_B64:
            "{{env.APPLICATION_VERSION_CREDENTIALS_B64}}",
        },
      },
      {
        name: OPERATIONS_DASHBOARD.functionName,
        dir: "./cloudbase/functions/operations-dashboard",
        type: "Event",
        runtime: "Nodejs20.19",
        handler: "index.main",
        timeout: 8,
        memorySize: 256,
        installDependency: true,
        envVariables: {
          CLOUDBASE_ENV_ID: "{{env.ENV_ID}}",
          // CLI 3.8.1 revives object-shaped JSON strings while parsing config.
          // Keep this a string for SCF; the handler accepts these two layers.
          DASHBOARD_APPS_JSON: JSON.stringify(JSON.stringify(dashboardApps)),
          DASHBOARD_PATH: OPERATIONS_DASHBOARD.path,
          DASHBOARD_TOKEN_SHA256: "{{env.DASHBOARD_TOKEN_SHA256}}",
          DASHBOARD_UPDATES_BASE_URL: "{{env.DASHBOARD_UPDATES_BASE_URL}}",
        },
      },
    ],
    hosting: [
      {
        name: "updates",
        root: "./cloudbase/updates",
        framework: "static",
        installCommand: "",
        buildCommand: "",
        outputDir: ".",
        deployPath: "/updates",
      },
    ],
    gateway: {
      routes: [
        ...resources.map((resource) => ({
          path: resource.trackPath,
          target: `function:${resource.functionName}`,
          protocol: "HTTP_TO_HTTPS",
          enablePathTransmission: true,
          enableAuth: false,
          qpsPolicy: {
            qpsTotal: 100,
            qpsPerClient: {
              limitBy: "ClientIP",
              limitValue: 10,
            },
          },
        })),
        {
          path: APPLICATION_VERSION_API.path,
          target: `function:${APPLICATION_VERSION_API.functionName}`,
          protocol: "HTTP_TO_HTTPS",
          enablePathTransmission: true,
          enableAuth: false,
          qpsPolicy: {
            qpsTotal: 100,
            qpsPerClient: {
              limitBy: "ClientIP",
              limitValue: 10,
            },
          },
        },
        {
          path: OPERATIONS_DASHBOARD.path,
          target: `function:${OPERATIONS_DASHBOARD.functionName}`,
          protocol: "HTTP_TO_HTTPS",
          enablePathTransmission: true,
          // The gateway is reachable, but the function requires a high-entropy
          // bearer token and fails closed when its SHA-256 is not configured.
          enableAuth: false,
          qpsPolicy: {
            qpsTotal: 5,
            qpsPerClient: {
              limitBy: "ClientIP",
              limitValue: 2,
            },
          },
        },
        {
          path: "/updates",
          target: "hosting:updates",
          enableAuth: false,
        },
      ],
    },
  };
}

export function validateRegistry(registry) {
  if (!isPlainObject(registry)) {
    throw new TypeError("cloudbase/apps.json must contain an object");
  }
  assertExactKeys(registry, ["apps", "schema_version"], "registry");
  if (registry.schema_version !== 2) {
    throw new TypeError("cloudbase/apps.json schema_version must be 2");
  }
  if (!Array.isArray(registry.apps) || registry.apps.length === 0) {
    throw new TypeError("cloudbase/apps.json apps must be a non-empty array");
  }

  const applications = registry.apps.map((app, index) => {
    if (!isPlainObject(app)) {
      throw new TypeError(`apps[${index}] must contain an object`);
    }
    assertExactKeys(app, ["app_id", "platforms"], `apps[${index}]`);
    assertDeploymentAppId(app.app_id);
    return {
      appId: app.app_id,
      platforms: validateUpdatePlatforms(
        app.platforms,
        `apps[${index}].platforms`,
      ),
    };
  });

  const appIds = applications.map(({ appId }) => appId);
  if (new Set(appIds).size !== appIds.length) {
    throw new TypeError("cloudbase/apps.json contains duplicate app_id values");
  }
  return applications;
}

export async function validateUpdateManifests(
  applications,
  updatesRootUrl = new URL("./updates/", import.meta.url),
) {
  if (!Array.isArray(applications) || applications.length === 0) {
    throw new TypeError("registered applications must be a non-empty array");
  }
  for (const [index, application] of applications.entries()) {
    if (!isPlainObject(application)) {
      throw new TypeError(`applications[${index}] must contain an object`);
    }
    assertExactKeys(
      application,
      ["appId", "platforms"],
      `applications[${index}]`,
    );
    assertDeploymentAppId(application.appId);
    validateUpdatePlatforms(
      application.platforms,
      `applications[${index}].platforms`,
    );
  }

  const appIds = applications.map(({ appId }) => appId);
  if (new Set(appIds).size !== appIds.length) {
    throw new TypeError("registered applications contain duplicate app ids");
  }
  const appIdSet = new Set(appIds);
  const entries = await readdir(updatesRootUrl, { withFileTypes: true });
  const orphanDirectories = entries
    .filter((entry) => entry.isDirectory() && !appIdSet.has(entry.name))
    .map((entry) => entry.name)
    .sort();
  const symbolicLinks = entries
    .filter((entry) => entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  if (orphanDirectories.length > 0) {
    throw new TypeError(
      `unregistered update directories: ${orphanDirectories.join(", ")}`,
    );
  }
  if (symbolicLinks.length > 0) {
    throw new TypeError(
      `symbolic links are not allowed in cloudbase/updates: ${symbolicLinks.join(", ")}`,
    );
  }

  for (const { appId, platforms } of applications) {
    const appUpdatesUrl = new URL(
      `${encodeURIComponent(appId)}/`,
      updatesRootUrl,
    );
    let manifestEntries;
    try {
      manifestEntries = await readdir(appUpdatesUrl, { withFileTypes: true });
    } catch (error) {
      throw new TypeError(
        `missing update directory: cloudbase/updates/${appId} (${error.message})`,
      );
    }

    const expectedFiles = new Set(
      platforms.map((platform) => `${platform}.json`),
    );
    const unexpectedEntries = manifestEntries
      .filter(
        (entry) =>
          !entry.isFile() ||
          entry.isSymbolicLink() ||
          !expectedFiles.has(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
    if (unexpectedEntries.length > 0) {
      throw new TypeError(
        `unexpected entries in cloudbase/updates/${appId}: ${unexpectedEntries.join(", ")}`,
      );
    }

    for (const platform of platforms) {
      const manifestUrl = new URL(`${platform}.json`, appUpdatesUrl);
      let manifest;
      try {
        manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
      } catch (error) {
        throw new TypeError(
          `missing or invalid update manifest: cloudbase/updates/${appId}/${platform}.json (${error.message})`,
        );
      }
      validateUpdateManifest(manifest, appId, platform);
    }
  }
}

export function validateUpdateManifest(
  manifest,
  expectedAppId,
  expectedPlatform,
) {
  assertDeploymentAppId(expectedAppId);
  assertUpdatePlatform(expectedPlatform);
  const label = `cloudbase/updates/${expectedAppId}/${expectedPlatform}.json`;
  if (!isPlainObject(manifest)) {
    throw new TypeError(`${label} must contain an object`);
  }
  try {
    assertExactKeys(manifest, UPDATE_MANIFEST_KEYS, label);
  } catch {
    throw new TypeError(`${label} must contain exactly the 14 v1 fields`);
  }

  if (
    manifest.schema_version !== 1 ||
    manifest.app_id !== expectedAppId ||
    manifest.platform !== expectedPlatform ||
    typeof manifest.enabled !== "boolean" ||
    !isSemVer(manifest.latest_version) ||
    !isSemVer(manifest.min_supported_version) ||
    compareSemVer(manifest.min_supported_version, manifest.latest_version) >
      0 ||
    typeof manifest.force_update !== "boolean" ||
    !Number.isInteger(manifest.rollout) ||
    manifest.rollout < 0 ||
    manifest.rollout > 100 ||
    !isSafeDisplayText(manifest.title, 120) ||
    !isSafeDisplayText(manifest.message, 1_000) ||
    !isSafeExternalUrl(manifest.download_url) ||
    !isSafeExternalUrl(manifest.release_notes_url) ||
    !/^(?:|[0-9a-f]{64})$/i.test(manifest.sha256) ||
    !isRfc3339Date(manifest.published_at)
  ) {
    throw new TypeError(`${label} does not satisfy the complete v1 contract`);
  }

  if (!manifest.enabled) {
    if (manifest.force_update || manifest.rollout !== 0) {
      throw new TypeError(
        `${label} must use force_update false and rollout 0 while disabled`,
      );
    }
  } else if (
    manifest.sha256 === "" ||
    isExampleInvalidUrl(manifest.download_url) ||
    isExampleInvalidUrl(manifest.release_notes_url)
  ) {
    throw new TypeError(
      `${label} cannot be enabled with placeholder URLs or an empty sha256`,
    );
  }

  return manifest;
}

export function validateWindowsUpdateManifest(manifest, expectedAppId) {
  return validateUpdateManifest(manifest, expectedAppId, "windows");
}

export function validateMacosUpdateManifest(manifest, expectedAppId) {
  return validateUpdateManifest(manifest, expectedAppId, "macos");
}

export function validateUpdatePlatforms(value, label = "platforms") {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  for (const platform of value) {
    assertUpdatePlatform(platform, label);
  }
  if (new Set(value).size !== value.length) {
    throw new TypeError(`${label} contains duplicate platform values`);
  }
  const canonical = SUPPORTED_UPDATE_PLATFORMS.filter((platform) =>
    value.includes(platform),
  );
  if (canonical.some((platform, index) => platform !== value[index])) {
    throw new TypeError(
      `${label} must follow canonical order: ${SUPPORTED_UPDATE_PLATFORMS.join(", ")}`,
    );
  }
  return [...value];
}

function isSemVer(value) {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    SEMVER_PATTERN.test(value)
  );
}

function compareSemVer(left, right) {
  const leftMatch = SEMVER_PATTERN.exec(left);
  const rightMatch = SEMVER_PATTERN.exec(right);
  for (let index = 1; index <= 3; index += 1) {
    const comparison = compareNumericIdentifier(
      leftMatch[index],
      rightMatch[index],
    );
    if (comparison !== 0) return comparison;
  }
  return comparePrerelease(
    leftMatch[4]?.split(".") || [],
    rightMatch[4]?.split(".") || [],
  );
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(left[index], right[index]);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isSafeDisplayText(value, maxCodePoints) {
  return (
    typeof value === "string" &&
    Array.from(value).length >= 1 &&
    Array.from(value).length <= maxCodePoints &&
    VISIBLE_DISPLAY_CONTENT_PATTERN.test(value) &&
    !UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  );
}

function isRfc3339Date(value) {
  if (typeof value !== "string" || value.length > 35) return false;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }
  if (match[7] !== "Z") {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }
  return true;
}

function isSafeExternalUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === ""
  ) {
    return false;
  }
  const hostname = normalizeHostname(parsed.hostname);
  return (
    hostname !== "localhost" &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local") &&
    !hostname.endsWith(".internal") &&
    !isNonPublicIpv4(hostname) &&
    !isNonPublicIpv6(hostname)
  );
}

function isExampleInvalidUrl(value) {
  const hostname = normalizeHostname(new URL(value).hostname);
  return (
    hostname === "example.invalid" || hostname.endsWith(".example.invalid")
  );
}

function normalizeHostname(value) {
  return value
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function isNonPublicIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isNonPublicIpv6(hostname) {
  if (!hostname.includes(":")) return false;
  return (
    hostname.startsWith("::") ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    /^fe[89a-f]/.test(hostname) ||
    hostname.startsWith("ff") ||
    hostname.startsWith("2001:db8:")
  );
}

function assertDeploymentAppId(appId) {
  if (typeof appId !== "string" || !DEPLOYMENT_APP_ID_PATTERN.test(appId)) {
    throw new TypeError(
      "app_id must be 1-50 lowercase letters, digits, or hyphens and must start and end with a letter or digit",
    );
  }
}

function assertUpdatePlatform(platform, label = "platform") {
  if (!SUPPORTED_UPDATE_PLATFORMS.includes(platform)) {
    throw new TypeError(
      `${label} must contain only: ${SUPPORTED_UPDATE_PLATFORMS.join(", ")}`,
    );
  }
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new TypeError(`${label} contains missing or unknown fields`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check") || args.length > 1) {
    throw new TypeError(
      "usage: node cloudbase/generate-cloudbaserc.mjs [--check]",
    );
  }

  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  const config = createCloudBaseConfig(registry);
  await validateUpdateManifests(validateRegistry(registry));
  const generated = `${JSON.stringify(config, null, 2)}\n`;

  if (args[0] === "--check") {
    const current = await readFile(outputUrl, "utf8").catch(() => "");
    if (current !== generated) {
      throw new Error(
        "cloudbaserc.json.example is stale; run node cloudbase/generate-cloudbaserc.mjs",
      );
    }
    process.stdout.write("cloudbaserc.json.example is up to date\n");
    return;
  }

  await writeFile(outputUrl, generated, "utf8");
  process.stdout.write(
    `generated ${fileURLToPath(outputUrl)} from ${fileURLToPath(registryUrl)}\n`,
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
