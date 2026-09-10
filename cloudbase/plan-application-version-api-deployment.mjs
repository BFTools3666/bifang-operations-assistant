import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import {
  APPLICATION_VERSION_API,
  deriveApplicationVersionResources,
  validateRegistry,
} from "./generate-cloudbaserc.mjs";

const require = createRequire(import.meta.url);
const {
  MAX_CREDENTIAL_CONFIGURATION_BASE64_BYTES,
  parseCredentials,
} = require("./functions/application-version-api/src/auth");

const defaultRegistryUrl = new URL("./apps.json", import.meta.url);
const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SCF_ENVIRONMENT_VARIABLE_QUOTA_BYTES = 4_096;
const SCF_ENVIRONMENT_VARIABLE_SAFETY_MARGIN_BYTES = 512;

export function createApplicationVersionDeploymentPlan(
  registry,
  credentialConfigurationBase64,
  { envId, origin },
) {
  const applications = validateRegistry(registry);
  if (typeof envId !== "string" || !ENV_ID_PATTERN.test(envId)) {
    throw new TypeError("env_id must be a plain CloudBase environment id");
  }
  const domain = readDefaultCloudBaseDomain(origin);
  const credentialText = normalizeCredentialConfiguration(
    credentialConfigurationBase64,
  );
  const credentials = parseCredentials(
    credentialText,
    applications.map(({ appId }) => appId),
  );
  if (!credentials) throw new TypeError("credential configuration is invalid");

  const applicationResources = applications.map(({ appId }) =>
    deriveApplicationVersionResources(appId),
  );
  const functionEnvironment = {
    CLOUDBASE_ENV_ID: envId,
    APPLICATION_VERSION_API_PATH: APPLICATION_VERSION_API.path,
    APPLICATION_VERSION_APPS_JSON: JSON.stringify(applicationResources),
    APPLICATION_VERSION_CREDENTIALS_B64: credentialText,
  };
  const functionEnvironmentBytes = Object.entries(functionEnvironment).reduce(
    (total, [key, value]) =>
      total + Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8"),
    0,
  );
  const enforcedEnvironmentMaximum =
    SCF_ENVIRONMENT_VARIABLE_QUOTA_BYTES -
    SCF_ENVIRONMENT_VARIABLE_SAFETY_MARGIN_BYTES;
  if (functionEnvironmentBytes > enforcedEnvironmentMaximum) {
    throw new TypeError(
      `function environment exceeds the ${enforcedEnvironmentMaximum}-byte deployment safety limit`,
    );
  }
  const route = {
    path: APPLICATION_VERSION_API.path,
    upstreamResourceType: "SCF",
    upstreamResourceName: APPLICATION_VERSION_API.functionName,
    enable: true,
    enableAuth: false,
    enableSafeDomain: true,
    enablePathTransmission: true,
    qpsPolicy: {
      qpsTotal: 100,
      qpsPerClient: { limitBy: "ClientIP", limitValue: 10 },
    },
  };
  const routeApiBody = JSON.stringify({
    EnvId: envId,
    Domain: {
      Domain: domain,
      Routes: [toCloudBaseApiRoute(route)],
    },
  });
  const describeDomainApiBody = JSON.stringify({
    EnvId: envId,
    Filters: [{ Name: "Domain", Values: [domain] }],
    Offset: 0,
    Limit: 10,
  });

  return {
    schema_version: 1,
    mode: "service-only-preview",
    requires_stage_4_confirmation: true,
    env_id: envId,
    origin: `https://${domain}`,
    base_url: `https://${domain}${APPLICATION_VERSION_API.path}`,
    credential_config_sha256: createHash("sha256")
      .update(credentialText, "utf8")
      .digest("hex"),
    function_environment_budget: {
      estimated_utf8_bytes: functionEnvironmentBytes,
      enforced_maximum_bytes: enforcedEnvironmentMaximum,
      platform_quota_bytes: SCF_ENVIRONMENT_VARIABLE_QUOTA_BYTES,
    },
    credential_bindings: credentials.map((credential) => ({
      credential_id: credential.fingerprint,
      app_id: credential.appId,
      codes: [...credential.codes],
      scopes: [...credential.scopes],
      secret_versions: credential.secretHashes.length,
    })),
    resources: {
      function: APPLICATION_VERSION_API.functionName,
      route,
      applications: applicationResources.map((resource) => ({
        app_id: resource.appId,
        collections: [
          {
            name: resource.versionCollection,
            permission: "ADMINONLY",
            indexes: [
              "doc_type + code + created_at(desc) + _id(desc)",
              "doc_type + code + version_sort_key(desc) + updated_at(desc) + _id(desc)",
            ],
            constraints: [
              "transactional version-key documents enforce canonical uniqueness",
            ],
          },
          {
            name: resource.adCollection,
            permission: "ADMINONLY",
            indexes: ["doc_type + app_code + created_at(desc) + _id(desc)"],
          },
          {
            name: resource.auditCollection,
            permission: "ADMINONLY",
            indexes: ["occurred_at(desc)"],
          },
        ],
      })),
    },
    read_only_preflight: [
      {
        resource: "local-generated-config",
        argv: ["npm", "run", "cloudbase:config:check"],
      },
      {
        resource: "functions",
        argv: ["tcb", "fn", "list", "-e", envId, "--limit", "100", "--json"],
        instruction: `Require ${APPLICATION_VERSION_API.functionName} to be absent. If a function with that exact name already exists, stop for a separate update/migration review; do not overwrite it.`,
      },
      {
        resource: "routes",
        argv: [
          "tcb",
          "api",
          "tcb",
          "DescribeHTTPServiceRoute",
          "--api-version",
          "2018-06-08",
          "--body",
          describeDomainApiBody,
          "--json",
        ],
        instruction: `Require the existing default HTTPS domain to be enabled and the exact path ${APPLICATION_VERSION_API.path} to be absent. If that path already exists, stop for a separate edit/migration review; do not overwrite it.`,
      },
      {
        resource: "collections-and-cost",
        kind: "manual-read-only",
        instruction:
          "Export the current collection names, ACLs, indexes, record counts, environment plan, quota usage and billing prompts. Require the live environment receipt to show EnableOverrun=false, a free-experience/zero-cost plan, no paid order or resource pack, and sufficient remaining quota. This is a first deployment: every planned version/ad/audit collection must be absent or empty; any existing record requires a separate migration review. Stop on any non-zero amount, upgrade, overage or auto-renewal signal.",
      },
    ],
    write_steps_after_confirmation: [
      {
        kind: "manual-secret",
        resource: "function-environment",
        instruction:
          "Load APPLICATION_VERSION_CREDENTIALS_B64 from the reviewed local secret file without echoing it; require the SHA-256 shown in this plan.",
      },
      ...applicationResources.flatMap((resource) =>
        [
          resource.versionCollection,
          resource.adCollection,
          resource.auditCollection,
        ].map((collection) => ({
          kind: "manual",
          resource: `collection:${collection}`,
          instruction: `Create or verify empty ${collection}, set ADMINONLY, and create only the indexes listed in this plan; do not write into, overwrite or delete an existing non-empty or incompatible collection.`,
        })),
      ),
      {
        kind: "command",
        resource: "function",
        argv: [
          "tcb",
          "fn",
          "deploy",
          APPLICATION_VERSION_API.functionName,
          "--config-file",
          "cloudbaserc.json.example",
          "-e",
          envId,
        ],
        output_policy:
          "Treat stdout and stderr as sensitive deployment output: inspect locally, do not persist or share the raw stream, and retain only a redacted status plus request id when available.",
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
    ],
    post_write_verification: [
      {
        kind: "poll-command",
        resource: "route-status",
        argv: [
          "tcb",
          "api",
          "tcb",
          "DescribeHTTPServiceRoute",
          "--api-version",
          "2018-06-08",
          "--body",
          describeDomainApiBody,
          "--json",
        ],
        success_condition: `Poll with bounded backoff until exactly one enabled default HTTPS domain reports Status=SUCCESS and DNSStatus=OK, with exactly ${APPLICATION_VERSION_API.path} -> SCF ${APPLICATION_VERSION_API.functionName}; FAIL or a conflicting route blocks. /v1/v1 must not exist.`,
      },
      "After route status succeeds, probe the public HTTPS endpoint until TLS succeeds and an unauthenticated request reaches the function's expected 401 JSON response; a gateway 404 or TLS failure means propagation is incomplete.",
      "Every listed collection must return ADMINONLY and only the reviewed indexes.",
      "Use test-only credentials and records; verify all ten endpoints, then verify the unchanged original executable against the single-v1 Base URL.",
      "Remove test records only after a separate exact-target delete preview and confirmation.",
    ],
    excluded_scope: [
      "telemetry functions and routes",
      "operations-dashboard-api and dashboard deployment",
      "/updates static hosting",
      "mouse clicker and screen recorder source trees",
    ],
    safety_notes: [
      "The function deployment command explicitly uses the tracked cloudbaserc.json.example and -e env_id; it does not read an ignored or stale cloudbaserc.json.",
      "The function uses {{tcb.envId}} for its runtime environment id and a 3-second timeout compatible with the current free-experience ceiling; any actual plan or billing mismatch blocks deployment.",
      "Use cloudbase/application-version-credentials.b64 for the local Base64 credential file; it is ignored by Git and must never be printed, committed or copied into evidence.",
      "Do not call VerifyHTTPServiceRoute for the system default .app.tcloudbase.com domain: the existing environment receipt records that CloudBase rejects manual verification for this internal default domain. Use Domain-only Describe plus the explicit path/cost gates instead.",
      "The default-domain write uses CreateHTTPServiceRoute with only the existing Domain value and the exact new route; missing paths use create while existing paths require a separate edit review. No domain-level, certificate or unrelated route field is sent.",
    ],
    forbidden_scope: [
      "tcb deploy",
      "tcb deploy --only=gateway",
      "tcb fn deploy --all",
      "--force",
      "--prune",
      "delete commands",
      "paid domains, certificates, plans, resource packs or overage",
    ],
  };
}

export async function planApplicationVersionDeployment(options) {
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  const credentialConfigurationBase64 = await readFile(
    options.credentialsFile,
    "utf8",
  );
  return createApplicationVersionDeploymentPlan(
    registry,
    credentialConfigurationBase64,
    options,
  );
}

function normalizeCredentialConfiguration(value) {
  if (typeof value !== "string") {
    throw new TypeError("credential configuration must be base64 text");
  }
  const normalized = value.trim();
  if (
    normalized.length < 4 ||
    Buffer.byteLength(normalized, "utf8") >
      MAX_CREDENTIAL_CONFIGURATION_BASE64_BYTES ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    normalized.length % 4 !== 0
  ) {
    throw new TypeError("credential configuration must be base64 text");
  }
  return normalized;
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

function parseArguments(args) {
  if (
    args.length !== 6 ||
    args[0] !== "--env-id" ||
    args[2] !== "--origin" ||
    args[4] !== "--credentials-b64-file"
  ) {
    throw new TypeError(
      "usage: npm run cloudbase:version-api:deploy:plan -- --env-id <env_id> --origin <https_origin> --credentials-b64-file <untracked_path>",
    );
  }
  return {
    envId: args[1],
    origin: args[3],
    credentialsFile: resolve(args[5]),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = await planApplicationVersionDeployment(options);
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
