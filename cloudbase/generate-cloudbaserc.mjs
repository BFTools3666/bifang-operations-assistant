import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const registryUrl = new URL("./apps.json", import.meta.url);
const outputUrl = new URL("../cloudbaserc.example.json", import.meta.url);

// `telemetry-` leaves 50 of SCF's 60 characters for the app id. Keeping the
// registry alphabet narrower than the public protocol makes every derived
// function name, route segment, and collection name reversible and collision
// free.
export const DEPLOYMENT_APP_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
export const RELEASE_CODE_PATTERN = DEPLOYMENT_APP_ID_PATTERN;
export const RELEASE_CHANNEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const SUPPORTED_RELEASE_PLATFORMS = Object.freeze([
  "windows",
  "macos",
  "linux",
]);
export const SUPPORTED_RELEASE_ARCHITECTURES = Object.freeze([
  "x64",
  "arm64",
  "ia32",
]);
export const MAX_RELEASE_STREAMS_PER_APP = 12;
export const OPERATIONS_DASHBOARD = Object.freeze({
  functionName: "operations-dashboard-api",
  path: "/admin/v1/metrics",
  webPath: "/dashboard",
});
export const APPLICATION_VERSION_API = Object.freeze({
  functionName: "application-version-api",
  path: "/tools/version-control/v1",
});
export const DASHBOARD_APPLICATION_MAPPING_SCHEMA_VERSION = 2;

const RELEASE_STREAM_KEYS = ["architecture", "channel", "code", "platform"];

export function deriveAppResources(appId) {
  assertDeploymentAppId(appId);
  return {
    appId,
    functionName: `telemetry-${appId}`,
    collectionName: `telemetry_${appId.replaceAll("-", "_")}`,
    trackPath: `/apps/${appId}/v1/track`,
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

export function createDashboardApplicationMapping(applications) {
  return {
    schema_version: DASHBOARD_APPLICATION_MAPPING_SCHEMA_VERSION,
    apps: applications.map(({ appId, releaseStreams }) => [
      appId,
      releaseStreams.map(({ platform, architecture, channel, code }) => [
        platform,
        architecture,
        channel,
        code,
      ]),
    ]),
  };
}

export function createCloudBaseConfig(registry) {
  const applications = validateRegistry(registry);
  const resources = applications.map(({ appId }) => deriveAppResources(appId));
  const dashboardApps = applications.map(({ appId, releaseStreams }) => {
    const telemetry = deriveAppResources(appId);
    const version = deriveApplicationVersionResources(appId);
    return {
      appId,
      collectionName: telemetry.collectionName,
      versionCollection: version.versionCollection,
      platforms: SUPPORTED_RELEASE_PLATFORMS.filter((platform) =>
        releaseStreams.some((stream) => stream.platform === platform),
      ),
      releaseStreams: releaseStreams.map((stream) => ({ ...stream })),
    };
  });
  const applicationVersionApps = applications.map(({ appId }) =>
    deriveApplicationVersionResources(appId),
  );
  const dashboardApplicationMapping =
    createDashboardApplicationMapping(dashboardApps);

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
        // The free experience plan fixes cloud functions at a 3-second timeout.
        timeout: 3,
        memorySize: 256,
        installDependency: true,
        envVariables: {
          // Bind database reads to the same environment selected by the CLI.
          // A separately supplied ENV_ID could drift or remain an unresolved
          // template literal and make the dashboard unavailable.
          CLOUDBASE_ENV_ID: "{{tcb.envId}}",
          // CLI 3.8.1 revives object-shaped JSON strings while parsing config.
          // Keep this a string for SCF; the handler accepts these two layers.
          // Keep the mapping compact enough for SCF's 4096-byte aggregate
          // environment-variable quota while deriving collection names and
          // platform summaries again inside the fail-closed handler.
          DASHBOARD_APPS_JSON: JSON.stringify(
            JSON.stringify(dashboardApplicationMapping),
          ),
          DASHBOARD_PATH: OPERATIONS_DASHBOARD.path,
          DASHBOARD_TOKEN_SHA256: "{{env.DASHBOARD_TOKEN_SHA256}}",
          DASHBOARD_WEB_PATH: OPERATIONS_DASHBOARD.webPath,
          // Only a verifier is stored in CloudBase. The raw browser access key
          // remains in the operator's ignored local secret file.
          DASHBOARD_ACCESS_TOKEN_SHA256:
            "{{env.DASHBOARD_ACCESS_TOKEN_SHA256}}",
        },
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
            qpsTotal: 100,
            qpsPerClient: {
              limitBy: "ClientIP",
              limitValue: 2,
            },
          },
        },
        {
          path: OPERATIONS_DASHBOARD.webPath,
          target: `function:${OPERATIONS_DASHBOARD.functionName}`,
          protocol: "HTTP_TO_HTTPS",
          enablePathTransmission: true,
          // The function enforces a high-entropy access key and a signed,
          // HttpOnly, Secure, SameSite=Strict session cookie.
          enableAuth: false,
          qpsPolicy: {
            qpsTotal: 100,
            qpsPerClient: {
              limitBy: "ClientIP",
              limitValue: 10,
            },
          },
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
  if (registry.schema_version !== 3) {
    throw new TypeError("cloudbase/apps.json schema_version must be 3");
  }
  if (!Array.isArray(registry.apps) || registry.apps.length === 0) {
    throw new TypeError("cloudbase/apps.json apps must be a non-empty array");
  }

  const applications = registry.apps.map((app, index) => {
    if (!isPlainObject(app)) {
      throw new TypeError(`apps[${index}] must contain an object`);
    }
    assertExactKeys(app, ["app_id", "release_streams"], `apps[${index}]`);
    assertDeploymentAppId(app.app_id);
    return {
      appId: app.app_id,
      releaseStreams: validateReleaseStreams(
        app.release_streams,
        `apps[${index}].release_streams`,
      ),
    };
  });

  const appIds = applications.map(({ appId }) => appId);
  if (new Set(appIds).size !== appIds.length) {
    throw new TypeError("cloudbase/apps.json contains duplicate app_id values");
  }
  const codes = applications.flatMap(({ releaseStreams }) =>
    releaseStreams.map(({ code }) => code),
  );
  if (new Set(codes).size !== codes.length) {
    throw new TypeError(
      "cloudbase/apps.json contains duplicate release code values",
    );
  }
  return applications;
}

export function validateReleaseStream(value, label = "release_stream") {
  if (!isPlainObject(value)) {
    throw new TypeError(`${label} must contain an object`);
  }
  assertExactKeys(value, RELEASE_STREAM_KEYS, label);
  if (!SUPPORTED_RELEASE_PLATFORMS.includes(value.platform)) {
    throw new TypeError(
      `${label}.platform must be one of: ${SUPPORTED_RELEASE_PLATFORMS.join(", ")}`,
    );
  }
  if (!SUPPORTED_RELEASE_ARCHITECTURES.includes(value.architecture)) {
    throw new TypeError(
      `${label}.architecture must be one of: ${SUPPORTED_RELEASE_ARCHITECTURES.join(", ")}`,
    );
  }
  if (
    typeof value.channel !== "string" ||
    !RELEASE_CHANNEL_PATTERN.test(value.channel)
  ) {
    throw new TypeError(
      `${label}.channel must be 1-32 lowercase letters, digits, or hyphens`,
    );
  }
  if (
    typeof value.code !== "string" ||
    !RELEASE_CODE_PATTERN.test(value.code)
  ) {
    throw new TypeError(
      `${label}.code must be 1-50 lowercase letters, digits, or hyphens`,
    );
  }
  return {
    platform: value.platform,
    architecture: value.architecture,
    channel: value.channel,
    code: value.code,
  };
}

export function validateReleaseStreams(value, label = "release_streams") {
  const streams = canonicalizeReleaseStreams(value, label);
  if (
    value.some((stream, index) =>
      RELEASE_STREAM_KEYS.some((key) => stream[key] !== streams[index][key]),
    )
  ) {
    throw new TypeError(`${label} must follow canonical release-stream order`);
  }
  return streams;
}

export function canonicalizeReleaseStreams(value, label = "release_streams") {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_RELEASE_STREAMS_PER_APP
  ) {
    throw new TypeError(
      `${label} must contain between 1 and ${MAX_RELEASE_STREAMS_PER_APP} items`,
    );
  }
  const streams = value.map((stream, index) =>
    validateReleaseStream(stream, `${label}[${index}]`),
  );
  const targets = streams.map(
    ({ platform, architecture, channel }) =>
      `${platform}\u0000${architecture}\u0000${channel}`,
  );
  if (new Set(targets).size !== targets.length) {
    throw new TypeError(
      `${label} contains duplicate platform/architecture/channel targets`,
    );
  }
  const codes = streams.map(({ code }) => code);
  if (new Set(codes).size !== codes.length) {
    throw new TypeError(`${label} contains duplicate code values`);
  }
  return streams.toSorted(compareReleaseStreams);
}

function compareReleaseStreams(left, right) {
  for (const [leftValue, rightValue] of [
    [
      SUPPORTED_RELEASE_PLATFORMS.indexOf(left.platform),
      SUPPORTED_RELEASE_PLATFORMS.indexOf(right.platform),
    ],
    [
      SUPPORTED_RELEASE_ARCHITECTURES.indexOf(left.architecture),
      SUPPORTED_RELEASE_ARCHITECTURES.indexOf(right.architecture),
    ],
  ]) {
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  if (left.channel !== right.channel) {
    return left.channel < right.channel ? -1 : 1;
  }
  if (left.code !== right.code) return left.code < right.code ? -1 : 1;
  return 0;
}

function assertDeploymentAppId(appId) {
  if (typeof appId !== "string" || !DEPLOYMENT_APP_ID_PATTERN.test(appId)) {
    throw new TypeError(
      "app_id must be 1-50 lowercase letters, digits, or hyphens and must start and end with a letter or digit",
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
    throw new TypeError(
      `${label} must contain exactly: ${sortedExpected.join(", ")}`,
    );
  }
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
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
  const generated = `${JSON.stringify(config, null, 2)}\n`;

  if (args[0] === "--check") {
    const current = await readFile(outputUrl, "utf8").catch(() => "");
    if (current !== generated) {
      throw new Error(
        "cloudbaserc.example.json is stale; run node cloudbase/generate-cloudbaserc.mjs",
      );
    }
    process.stdout.write("cloudbaserc.example.json is up to date\n");
    return;
  }

  await writeFile(outputUrl, generated, "utf8");
  process.stdout.write("generated cloudbaserc.example.json\n");
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
