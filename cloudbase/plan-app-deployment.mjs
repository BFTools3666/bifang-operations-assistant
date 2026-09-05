import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  deriveAppResources,
  validateRegistry,
  validateUpdateManifests,
} from "./generate-cloudbaserc.mjs";

const defaultRegistryUrl = new URL("./apps.json", import.meta.url);
const defaultUpdatesUrl = new URL("./updates/", import.meta.url);
const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function createAppDeploymentPlan(registry, appId, { envId, origin }) {
  const applications = validateRegistry(registry);
  const application = applications.find(
    (candidate) => candidate.appId === appId,
  );
  if (!application) {
    throw new TypeError(`app_id is not registered: ${appId}`);
  }
  if (typeof envId !== "string" || !ENV_ID_PATTERN.test(envId)) {
    throw new TypeError("env_id must be a plain CloudBase environment id");
  }
  const domain = readDefaultCloudBaseDomain(origin);
  const resources = deriveAppResources(appId);
  const route = {
    path: resources.trackPath,
    upstreamResourceType: "SCF",
    upstreamResourceName: resources.functionName,
    enable: true,
    enableAuth: false,
    enableSafeDomain: true,
    enablePathTransmission: true,
    qpsPolicy: {
      qpsTotal: 100,
      qpsPerClient: {
        limitBy: "ClientIP",
        limitValue: 10,
      },
    },
  };
  const routeApiBody = JSON.stringify({
    EnvId: envId,
    Domain: {
      Domain: domain,
      Routes: [toCloudBaseApiRoute(route)],
    },
  });
  const manifestSteps = application.platforms.map((platform) => {
    const localPath = `cloudbase/updates/${appId}/${platform}.json`;
    const cloudPath = `updates/${appId}/${platform}.json`;
    return {
      kind: "command",
      resource: `manifest:${platform}`,
      argv: [
        "tcb",
        "hosting",
        "deploy",
        localPath,
        cloudPath,
        "-e",
        envId,
        "--json",
      ],
    };
  });

  return {
    schema_version: 1,
    mode: "target-only-preview",
    requires_stage_4_confirmation: true,
    env_id: envId,
    origin: `https://${domain}`,
    app_id: appId,
    resources: {
      function: resources.functionName,
      collection: resources.collectionName,
      collection_permission: "ADMINONLY",
      route,
      manifests: application.platforms.map(
        (platform) => `/updates/${appId}/${platform}.json`,
      ),
    },
    excluded_app_ids: applications
      .map(({ appId: registeredAppId }) => registeredAppId)
      .filter((registeredAppId) => registeredAppId !== appId),
    read_only_preflight: [
      {
        resource: "functions",
        argv: ["tcb", "fn", "list", "--limit", "100", "--json"],
      },
      {
        resource: "routes",
        argv: [
          "tcb",
          "routes",
          "list",
          "-e",
          envId,
          "--limit",
          "1000",
          "--filter",
          `Domain=${domain}`,
          "--json",
        ],
      },
      {
        resource: "manifests",
        argv: [
          "tcb",
          "hosting",
          "list",
          `updates/${appId}`,
          "-e",
          envId,
          "--json",
        ],
      },
    ],
    write_steps_after_confirmation: [
      {
        kind: "manual",
        resource: "collection",
        instruction: `Create or verify ${resources.collectionName} with ADMINONLY permission; stop if it exists with a different contract.`,
      },
      {
        kind: "command",
        resource: "function",
        argv: ["tcb", "fn", "deploy", resources.functionName, "--json"],
      },
      {
        kind: "command",
        resource: "route",
        argv: [
          "tcb",
          "api",
          "tcb",
          "CreateHTTPServiceRoute",
          "--api-version",
          "2018-06-08",
          "--body",
          routeApiBody,
          "--json",
        ],
      },
      ...manifestSteps,
    ],
    post_write_verification: [
      `DescribeHTTPServiceRoute must return exactly ${route.path} -> ${resources.functionName} for the selected domain.`,
      ...application.platforms.map(
        (platform) =>
          `GET /updates/${appId}/${platform}.json and require byte-for-byte equality with the local file.`,
      ),
      `DescribeDatabaseACL must return ADMINONLY for ${resources.collectionName}.`,
    ],
    safety_notes: [
      "fn deploy is bound to cloudbaserc.json envId; verify that file before execution.",
      "CloudBase CLI 3.8.1 ignores --safe and --verify for a single local file, so each manifest requires an absent-target preflight and independent byte verification.",
      "The platform default domain is created through the exact CreateHTTPServiceRoute API because routes add rejects system default domains during its custom-domain verification step.",
    ],
    forbidden_scope: [
      "tcb deploy",
      "tcb deploy --only=gateway",
      "tcb fn deploy --all",
      "directory-level hosting deploy",
      "--force",
      "--prune",
      "delete commands",
    ],
  };
}

function toCloudBaseApiRoute(route) {
  return {
    Path: route.path,
    UpstreamResourceType: route.upstreamResourceType,
    UpstreamResourceName: route.upstreamResourceName,
    Enable: route.enable,
    EnableAuth: route.enableAuth,
    EnableSafeDomain: route.enableSafeDomain,
    EnablePathTransmission: route.enablePathTransmission,
    QPSPolicy: {
      QPSTotal: route.qpsPolicy.qpsTotal,
      QPSPerClient: {
        LimitBy: route.qpsPolicy.qpsPerClient.limitBy,
        LimitValue: route.qpsPolicy.qpsPerClient.limitValue,
      },
    },
  };
}

export async function planAppDeployment(appId, options = {}) {
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const updatesUrl = options.updatesUrl || defaultUpdatesUrl;
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  await validateUpdateManifests(validateRegistry(registry), updatesUrl);
  return createAppDeploymentPlan(registry, appId, options);
}

function readDefaultCloudBaseDomain(origin) {
  if (typeof origin !== "string") {
    throw new TypeError("origin must be a CloudBase default HTTPS origin");
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("origin must be a CloudBase default HTTPS origin");
  }
  const domain = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !domain.endsWith(".app.tcloudbase.com")
  ) {
    throw new TypeError("origin must be a CloudBase default HTTPS origin");
  }
  return domain;
}

function parseArguments(args) {
  if (args.length !== 5 || args[1] !== "--env-id" || args[3] !== "--origin") {
    throw new TypeError(
      "usage: npm run cloudbase:app:deploy:plan -- <app_id> --env-id <env_id> --origin <https_origin>",
    );
  }
  return {
    appId: args[0],
    envId: args[2],
    origin: args[4],
  };
}

async function main() {
  const { appId, envId, origin } = parseArguments(process.argv.slice(2));
  const plan = await planAppDeployment(appId, { envId, origin });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
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
