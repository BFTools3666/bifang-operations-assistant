import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
export const APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION = "3.8.1";
const DEPLOYMENT_MATERIAL_MAX_FILES = 1_024;
const DEPLOYMENT_MATERIAL_MAX_BYTES = 32 * 1_024 * 1_024;
const SCF_ENVIRONMENT_VARIABLE_QUOTA_BYTES = 4_096;
const SCF_ENVIRONMENT_VARIABLE_SAFETY_MARGIN_BYTES = 256;
const RUNTIME_CREDENTIAL_SCOPES = Object.freeze(["versions:check", "ads:show"]);
const ADVERTISEMENT_CONTRACT_TEST_CREDENTIAL_PREFIX = "contract-ads-";
const MANAGEMENT_READ_CREDENTIAL_SCOPES = Object.freeze([
  "versions:read",
  "ads:read",
]);
const MANAGEMENT_WRITE_CREDENTIAL_SCOPES = Object.freeze([
  "versions:write",
  "ads:write",
]);
const FUNCTION_SHAPE = Object.freeze({
  name: APPLICATION_VERSION_API.functionName,
  type: "Event",
  runtime: "Nodejs20.19",
  handler: "index.main",
  timeout: 3,
  memory_size: 256,
});
const VERSION_INDEXES = Object.freeze([
  "doc_type + code + created_at(desc) + _id(desc)",
  "doc_type + code + version_sort_key(desc) + updated_at(desc) + _id(desc)",
]);
const AD_INDEXES = Object.freeze([
  "doc_type + app_code + created_at(desc) + _id(desc)",
]);
const AUDIT_INDEXES = Object.freeze(["occurred_at(desc)"]);
export const APPLICATION_VERSION_DEPLOYMENT_CONTROL_FILES = Object.freeze([
  "cloudbaserc.example.json",
  "cloudbase/apps.json",
  "cloudbase/deploy-application-version-api.mjs",
  "cloudbase/plan-application-version-api-deployment.mjs",
  "cloudbase/generate-cloudbaserc.mjs",
  "package.json",
  "package-lock.json",
]);
export const APPLICATION_VERSION_DEPLOYMENT_DIRECTORY_TREES = Object.freeze([
  "cloudbase/functions/application-version-api",
  "node_modules/@cloudbase/cli",
]);
const LEGACY_STATIC_UPDATE_OBJECT_ALLOWLIST = Object.freeze([
  "/updates/bifang-mouse-clicker/windows.json",
  "/updates/bifang-screen-recorder/windows.json",
  "/updates/bifang-screen-recorder/macos.json",
  "/updates/example-tool/windows.json",
  "/updates/update.schema.json",
]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function collectDeploymentSourceFiles(directory, relativeDirectory, collected) {
  const rootMetadata = lstatSync(directory);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new TypeError(
      "application-version deployment material roots must be real directories",
    );
  }
  const entries = readdirSync(directory, { withFileTypes: true }).sort(
    (left, right) => compareCodeUnits(left.name, right.name),
  );
  for (const entry of entries) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = resolve(directory, entry.name);
    const metadata = lstatSync(absolutePath);
    if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
      throw new TypeError(
        "application-version deployment materials must not contain symbolic links",
      );
    }
    if (entry.isDirectory() && metadata.isDirectory()) {
      collectDeploymentSourceFiles(absolutePath, relativePath, collected);
      continue;
    }
    if (!entry.isFile() || !metadata.isFile()) {
      throw new TypeError(
        "application-version deployment materials contain an unsupported filesystem entry",
      );
    }
    collected.push({ path: relativePath, absolutePath });
    if (collected.length > DEPLOYMENT_MATERIAL_MAX_FILES) {
      throw new TypeError(
        "application-version deployment materials exceed the reviewed file-count limit",
      );
    }
  }
}

function appendDeploymentMaterial(hash, path, content) {
  const pathBytes = Buffer.from(path, "utf8");
  hash.update(`${pathBytes.length}:`, "utf8");
  hash.update(pathBytes);
  hash.update(`:${content.length}:`, "utf8");
  hash.update(content);
  hash.update("\0", "utf8");
}

export function createApplicationVersionDeploymentMaterialsSummary(
  credentialConfigurationBase64,
  materialRoot = repositoryRoot,
) {
  const credentialText = normalizeCredentialConfiguration(
    credentialConfigurationBase64,
  );
  let files;
  try {
    files = APPLICATION_VERSION_DEPLOYMENT_CONTROL_FILES.map((path) => {
      const absolutePath = resolve(materialRoot, path);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new TypeError(
          "application-version deployment control materials must be real files",
        );
      }
      return { path, absolutePath };
    });
    for (const path of APPLICATION_VERSION_DEPLOYMENT_DIRECTORY_TREES) {
      collectDeploymentSourceFiles(resolve(materialRoot, path), path, files);
    }
    files.sort((left, right) => compareCodeUnits(left.path, right.path));
    files = files.map(({ path, absolutePath }) => ({
      path,
      content: readFileSync(absolutePath),
    }));
    assertPinnedCloudBaseCliMaterials(files);
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(
      "application-version deployment materials are missing or unreadable",
    );
  }

  const totalBytes = files.reduce(
    (total, { content }) => total + content.length,
    Buffer.byteLength(credentialText, "utf8"),
  );
  if (totalBytes > DEPLOYMENT_MATERIAL_MAX_BYTES) {
    throw new TypeError(
      "application-version deployment materials exceed the reviewed byte limit",
    );
  }

  const aggregate = createHash("sha256");
  aggregate.update("bifang-application-version-deployment-materials-v1\0");
  appendDeploymentMaterial(
    aggregate,
    "@normalized-credential-configuration",
    Buffer.from(credentialText, "utf8"),
  );
  for (const file of files) {
    appendDeploymentMaterial(aggregate, file.path, file.content);
  }

  return {
    schema_version: 1,
    sha256: aggregate.digest("hex"),
    includes_normalized_credential_configuration: true,
    files: files.map(({ path, content }) => ({
      path,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    })),
  };
}

function assertPinnedCloudBaseCliMaterials(files) {
  const rootPackage = parseJsonDeploymentMaterial(
    files,
    "package.json",
    "root package metadata",
  );
  const packageLock = parseJsonDeploymentMaterial(
    files,
    "package-lock.json",
    "root package-lock metadata",
  );
  const packageMetadata = parseJsonDeploymentMaterial(
    files,
    "node_modules/@cloudbase/cli/package.json",
    "repository-local @cloudbase/cli package metadata",
  );
  const entryMaterial = files.find(
    ({ path }) => path === "node_modules/@cloudbase/cli/bin/tcb",
  );
  if (
    rootPackage?.devDependencies?.["@cloudbase/cli"] !==
      APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION ||
    packageLock?.packages?.[""]?.devDependencies?.["@cloudbase/cli"] !==
      APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION ||
    packageLock?.packages?.["node_modules/@cloudbase/cli"]?.version !==
      APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION ||
    packageMetadata?.name !== "@cloudbase/cli" ||
    packageMetadata?.version !== APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION ||
    packageMetadata?.bin?.tcb !== "bin/tcb" ||
    !entryMaterial
  ) {
    throw new TypeError(
      `root manifests and repository-local @cloudbase/cli must be exactly ${APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION}`,
    );
  }
}

function parseJsonDeploymentMaterial(files, path, label) {
  const material = files.find((candidate) => candidate.path === path);
  try {
    return JSON.parse(material?.content.toString("utf8"));
  } catch {
    throw new TypeError(`${label} is invalid`);
  }
}

export function validateApplicationVersionDeploymentInputs(
  registry,
  credentialConfigurationBase64,
  { envId },
) {
  const applications = validateRegistry(registry);
  if (typeof envId !== "string" || !ENV_ID_PATTERN.test(envId)) {
    throw new TypeError("env_id must be a plain CloudBase environment id");
  }
  const credentialText = normalizeCredentialConfiguration(
    credentialConfigurationBase64,
  );
  assertRuntimeCredentialsUseSingleCodes(credentialText);
  const credentials = parseCredentials(
    credentialText,
    applications.map(({ appId }) => appId),
  );
  if (!credentials) throw new TypeError("credential configuration is invalid");
  const registeredCodesByApp = new Map(
    applications.map(({ appId, releaseStreams }) => [
      appId,
      new Set(releaseStreams.map(({ code }) => code)),
    ]),
  );
  if (
    credentials.some((credential) =>
      [...credential.codes].some(
        (code) => !registeredCodesByApp.get(credential.appId)?.has(code),
      ),
    )
  ) {
    throw new TypeError(
      "credential configuration contains a code not registered in cloudbase/apps.json",
    );
  }
  if (
    credentials.some(
      (credential) =>
        credentialHasRuntimeScopes(credential) && credential.codes.size !== 1,
    )
  ) {
    throw new TypeError(
      "each runtime credential must bind exactly one release-stream code",
    );
  }
  if (
    credentials.some(
      (credential) =>
        !credentialIsRuntime(credential) &&
        !credentialHasExactScopes(
          credential,
          MANAGEMENT_READ_CREDENTIAL_SCOPES,
        ) &&
        !credentialHasExactScopes(
          credential,
          MANAGEMENT_WRITE_CREDENTIAL_SCOPES,
        ),
    )
  ) {
    throw new TypeError(
      "each credential must use one approved scope bundle: runtime versions:check with optional ads:show, management-read versions:read+ads:read, or management-write versions:write+ads:write",
    );
  }
  const uncoveredRuntimeReleaseStreams = applications.flatMap(
    ({ appId, releaseStreams }) =>
      releaseStreams
        .filter(
          ({ code }) =>
            !credentials.some(
              (credential) =>
                credential.appId === appId &&
                credential.codes.has(code) &&
                credentialIsRuntime(credential),
            ),
        )
        .map(({ code }) => `${appId}/${code}`),
  );
  if (uncoveredRuntimeReleaseStreams.length > 0) {
    throw new TypeError(
      `credential configuration must provide an isolated runtime credential for every registered release stream; missing: ${uncoveredRuntimeReleaseStreams.join(", ")}`,
    );
  }
  const uncoveredManagementReadReleaseStreams = applications.flatMap(
    ({ appId, releaseStreams }) =>
      releaseStreams
        .filter(
          ({ code }) =>
            !credentials.some(
              (credential) =>
                credential.appId === appId &&
                credential.codes.has(code) &&
                credentialHasExactScopes(
                  credential,
                  MANAGEMENT_READ_CREDENTIAL_SCOPES,
                ),
            ),
        )
        .map(({ code }) => `${appId}/${code}`),
  );
  if (uncoveredManagementReadReleaseStreams.length > 0) {
    throw new TypeError(
      `credential configuration must provide an isolated management-read credential for every registered release stream; missing: ${uncoveredManagementReadReleaseStreams.join(", ")}`,
    );
  }
  const uncoveredManagementWriteReleaseStreams = applications.flatMap(
    ({ appId, releaseStreams }) =>
      releaseStreams
        .filter(
          ({ code }) =>
            !credentials.some(
              (credential) =>
                credential.appId === appId &&
                credential.codes.has(code) &&
                credentialHasExactScopes(
                  credential,
                  MANAGEMENT_WRITE_CREDENTIAL_SCOPES,
                ),
            ),
        )
        .map(({ code }) => `${appId}/${code}`),
  );
  if (uncoveredManagementWriteReleaseStreams.length > 0) {
    throw new TypeError(
      `credential configuration must provide an isolated management-write credential for every registered release stream; missing: ${uncoveredManagementWriteReleaseStreams.join(", ")}`,
    );
  }
  const advertisementContractTestCredentials = credentials.filter(
    credentialIsAdvertisementContractTest,
  );
  if (
    credentials.some(
      (credential) =>
        credential.scopes.has("ads:show") &&
        !credentialIsAdvertisementContractTest(credential),
    ) ||
    credentials.some(
      (credential) =>
        credential.fingerprint.startsWith(
          ADVERTISEMENT_CONTRACT_TEST_CREDENTIAL_PREFIX,
        ) && !credentialIsAdvertisementContractTest(credential),
    )
  ) {
    throw new TypeError(
      "ads:show is reserved for a dedicated contract-ads-* runtime credential",
    );
  }
  if (advertisementContractTestCredentials.length !== 1) {
    throw new TypeError(
      "credential configuration must provide exactly one dedicated ads:show contract-test credential",
    );
  }

  const applicationResources = applications.map(({ appId }) =>
    deriveApplicationVersionResources(appId),
  );
  const plannedCredentialConfiguration = credentials.map((credential) => ({
    credential_id: credential.fingerprint,
    app_id: credential.appId,
    codes: [...credential.codes],
    scopes: [...credential.scopes],
    key_sha256: credential.keyHash.toString("hex"),
    secret_sha256: credential.secretHashes.map((hash) => hash.toString("hex")),
  }));
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

  return {
    applications,
    applicationResources,
    credentialText,
    credentials,
    enforcedEnvironmentMaximum,
    functionEnvironmentBytes,
    plannedCredentialConfiguration,
  };
}

export function createApplicationVersionDeploymentPlan(
  registry,
  credentialConfigurationBase64,
  { envId, origin, liveState },
) {
  if (typeof envId !== "string" || !ENV_ID_PATTERN.test(envId)) {
    throw new TypeError("env_id must be a plain CloudBase environment id");
  }
  const domain = readDefaultCloudBaseDomain(origin);
  const {
    applications,
    applicationResources,
    credentialText,
    credentials,
    enforcedEnvironmentMaximum,
    functionEnvironmentBytes,
    plannedCredentialConfiguration,
  } = validateApplicationVersionDeploymentInputs(
    registry,
    credentialConfigurationBase64,
    { envId },
  );
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
  const resources = {
    function: APPLICATION_VERSION_API.functionName,
    route,
    applications: applicationResources.map((resource) => ({
      app_id: resource.appId,
      collections: [
        {
          name: resource.versionCollection,
          permission: "ADMINONLY",
          indexes: [...VERSION_INDEXES],
          constraints: [
            "transactional version-key documents enforce canonical uniqueness",
          ],
        },
        {
          name: resource.adCollection,
          permission: "ADMINONLY",
          indexes: [...AD_INDEXES],
        },
        {
          name: resource.auditCollection,
          permission: "ADMINONLY",
          indexes: [...AUDIT_INDEXES],
        },
      ],
    })),
  };
  const legacyStaticUpdateTargets = {
    route: { path: "/updates", target: "hosting:updates", enableAuth: false },
    hosting: { name: "updates", deploy_path: "/updates" },
    object_paths: [...LEGACY_STATIC_UPDATE_OBJECT_ALLOWLIST],
  };
  const reconciliation = reconcileLiveState(liveState, {
    envId,
    origin: `https://${domain}`,
    appIds: applications.map(({ appId }) => appId),
    credentials: plannedCredentialConfiguration,
    resources,
  });
  const legacyStaticUpdateRetirement = reconcileLegacyStaticUpdates(
    liveState?.legacy_static_updates,
    legacyStaticUpdateTargets,
  );
  const credentialConfigSha256 = createHash("sha256")
    .update(credentialText, "utf8")
    .digest("hex");
  const deploymentMaterials =
    createApplicationVersionDeploymentMaterialsSummary(credentialText);

  return {
    schema_version: 1,
    mode: "service-only-preview",
    requires_stage_4_confirmation: true,
    env_id: envId,
    origin: `https://${domain}`,
    base_url: `https://${domain}${APPLICATION_VERSION_API.path}`,
    credential_config_sha256: credentialConfigSha256,
    deployment_cli: {
      package: "@cloudbase/cli",
      version: APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
      resolution:
        "process.execPath + reviewed private-staging copy of repository-local @cloudbase/cli/bin/tcb",
    },
    deployment_materials: deploymentMaterials,
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
    resources,
    reconciliation,
    legacy_static_update_retirement: legacyStaticUpdateRetirement,
    read_only_preflight: [
      {
        resource: "local-generated-config",
        argv: ["npm", "run", "cloudbase:config:check"],
      },
      {
        resource: "functions",
        argv: ["tcb", "fn", "list", "-e", envId, "--limit", "100", "--json"],
        instruction: `Record whether ${APPLICATION_VERSION_API.functionName} is absent. If present, export its type, runtime, handler, timeout, memory and redacted application/credential bindings into the live-state receipt; presence alone is not a blocker, but any incompatible shape or binding removal is.`,
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
        instruction: `Record whether ${APPLICATION_VERSION_API.path} is absent. If present, export its complete target, auth, path-transmission and QPS configuration into the live-state receipt; an exact match is preserved and any conflict blocks.`,
      },
      {
        resource: "collections-and-cost",
        kind: "manual-read-only",
        instruction:
          "Export a complete inventory of current collection names, ACLs, indexes and record counts plus the environment plan, quota usage and billing prompts. Require the live-state receipt to show EnableOverrun=false, a free-experience/zero-cost plan, no paid order, upgrade prompt or resource pack, and sufficient remaining quota. Compatible existing ADMINONLY collections and their records are preserved; missing collections/indexes may be added. Stop on an ACL conflict, incomplete inventory, non-zero amount, upgrade, overage or auto-renewal signal.",
      },
      {
        resource: "legacy-static-updates",
        kind: "manual-read-only",
        instruction:
          "Export the complete live /updates route, updates hosting deploy path and every hosted object path into legacy_static_updates. The inventory is compared only with the explicit historical allowlist; any unknown object blocks retirement. This only prepares a later exact preview, authorizes no deletion and must not include telemetry resources.",
      },
    ],
    write_steps_after_confirmation: createWriteSteps({
      reconciliation,
      envId,
      routeApiBody,
      credentialConfigSha256,
      deploymentMaterialsSha256: deploymentMaterials.sha256,
    }),
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
      "Every listed collection must return ADMINONLY and contain every reviewed required index; preserve any extra existing index recorded by reconciliation.",
      "Use test-only credentials and records to verify all ten endpoints, then verify the upgraded mouse clicker and screen recorder Windows client against the single-v1 Base URL. macOS remains unverified until a real Mac run.",
      "Remove test records only after a separate exact-target delete preview and confirmation.",
    ],
    excluded_scope: [
      "telemetry functions and routes",
      "operations-dashboard-api and dashboard deployment",
      "mouse clicker and screen recorder source trees",
    ],
    safety_notes: [
      "The function deployment command explicitly uses the tracked cloudbaserc.example.json and -e env_id; it does not read an ignored or stale cloudbaserc.json.",
      "The deployment helper binds the normalized credential configuration, registry, tracked deploy/planner/generator scripts, root package manifests, cloudbaserc.example.json, every application-version function file and the complete installed CloudBase CLI tree into one reviewed SHA-256; any pre-snapshot drift blocks the write.",
      "The deployment helper independently revalidates exact credential coverage and the 3840-byte function-environment safety limit for the actual env_id before any child starts.",
      `After verification, the helper copies every reviewed material into a private temporary snapshot and uses process.execPath with only that snapshot's @cloudbase/cli ${APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION} bin/tcb entry and cwd; later repository edits, PATH executables and command-shell shims cannot change uploaded bytes.`,
      "The CLI version preflight and deployment each have a finite timeout, forcibly terminate on expiry, suppress raw output and remove the exact private snapshot in all outcomes.",
      "The function uses {{tcb.envId}} for its runtime environment id and a 3-second timeout compatible with the current free-experience ceiling; any actual plan or billing mismatch blocks deployment.",
      "Use cloudbase/application-version-credentials.b64 for the local Base64 credential file; it is ignored by Git and must never be printed, committed or copied into evidence.",
      "Do not call VerifyHTTPServiceRoute for the system default .app.tcloudbase.com domain: the existing environment receipt records that CloudBase rejects manual verification for this internal default domain. Use Domain-only Describe plus the explicit path/cost gates instead.",
      "The default-domain write uses CreateHTTPServiceRoute with only the existing Domain value and the exact new route. An existing exact version route is preserved; a conflicting route blocks. No domain-level, certificate or unrelated route field is sent.",
      "The legacy /updates route, hosting deploy path and registered manifest objects are retirement targets, not version-service deployment writes. Remove them only after both real clients pass the new API E2E, a fresh exact-target preview and a separate explicit confirmation.",
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

function assertRuntimeCredentialsUseSingleCodes(credentialText) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(credentialText, "base64").toString("utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(parsed?.credentials)) return;
  if (
    parsed.credentials.some(
      (credential) =>
        Array.isArray(credential?.scopes) &&
        credential.scopes.includes("versions:check") &&
        (!Array.isArray(credential.codes) || credential.codes.length !== 1),
    )
  ) {
    throw new TypeError(
      "each runtime credential must bind exactly one release-stream code",
    );
  }
}

export async function planApplicationVersionDeployment(options) {
  const registryUrl = options.registryUrl || defaultRegistryUrl;
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  const credentialConfigurationBase64 = await readFile(
    options.credentialsFile,
    "utf8",
  );
  const liveState = options.liveStateFile
    ? JSON.parse(await readFile(options.liveStateFile, "utf8"))
    : options.liveState;
  return createApplicationVersionDeploymentPlan(
    registry,
    credentialConfigurationBase64,
    { ...options, liveState },
  );
}

function reconcileLiveState(liveState, expected) {
  if (liveState === undefined) {
    return {
      status: "live-state-required",
      deployment_kind: "unresolved",
      blockers: [
        "No complete read-only live-state receipt was supplied; write steps are intentionally omitted.",
      ],
      actions: { function: null, route: null, collections: [] },
    };
  }
  assertPlainObject(liveState, "live_state");
  assertExactKeys(
    liveState,
    [
      "schema_version",
      "env_id",
      "origin",
      "gateway_domain",
      "cost_gate",
      "function",
      "route",
      "collections",
      "collections_inventory_complete",
      "legacy_static_updates",
    ],
    "live_state",
  );
  if (liveState.schema_version !== 1) {
    throw new TypeError("live_state schema_version must be 1");
  }
  if (
    liveState.env_id !== expected.envId ||
    liveState.origin !== expected.origin
  ) {
    throw new TypeError("live_state target does not match env_id and origin");
  }
  if (liveState.collections_inventory_complete !== true) {
    throw new TypeError("live_state collection inventory must be complete");
  }

  const blockers = [
    ...validateGatewayDomain(liveState.gateway_domain),
    ...validateCostGate(liveState.cost_gate),
  ];
  const functionResult = reconcileFunction(
    liveState.function,
    expected.appIds,
    expected.credentials,
  );
  blockers.push(...functionResult.blockers);
  const routeResult = reconcileRoute(liveState.route, expected.resources.route);
  blockers.push(...routeResult.blockers);
  const collectionResult = reconcileCollections(
    liveState.collections,
    expected.resources.applications,
  );
  blockers.push(...collectionResult.blockers);

  if (liveState.function === null && liveState.route !== null) {
    blockers.push(
      "The version route exists while the shared function is absent; a separate migration review is required.",
    );
  }
  if (
    liveState.function === null &&
    collectionResult.actions.some(
      ({ action, record_count: recordCount }) =>
        action !== "create" && recordCount > 0,
    )
  ) {
    blockers.push(
      "The shared function is absent while a planned collection already contains records; ownership requires a separate migration review.",
    );
  }

  const isFirstDeployment =
    liveState.function === null &&
    liveState.route === null &&
    collectionResult.actions.every(({ action }) => action === "create");
  return {
    status: blockers.length === 0 ? "ready-after-confirmation" : "blocked",
    deployment_kind: isFirstDeployment
      ? "first-deployment"
      : "preserve-and-add",
    blockers,
    actions: {
      function: functionResult.action,
      route: routeResult.action,
      collections: collectionResult.actions,
    },
  };
}

function validateGatewayDomain(value) {
  assertPlainObject(value, "live_state.gateway_domain");
  assertExactKeys(
    value,
    ["enabled", "status", "dns_status"],
    "live_state.gateway_domain",
  );
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.status !== "string" ||
    typeof value.dns_status !== "string"
  ) {
    throw new TypeError("live_state.gateway_domain is malformed");
  }
  const blockers = [];
  if (!value.enabled) blockers.push("The default HTTPS domain is disabled.");
  if (value.status !== "SUCCESS") {
    blockers.push("The default HTTPS domain status is not SUCCESS.");
  }
  if (value.dns_status !== "OK") {
    blockers.push("The default HTTPS domain DNS status is not OK.");
  }
  return blockers;
}

function reconcileLegacyStaticUpdates(value, expected) {
  const base = {
    requires_new_api_e2e_for_both_clients: true,
    requires_fresh_exact_target_preflight: true,
    requires_separate_delete_confirmation: true,
    delete_commands: [],
    forbidden_targets: [
      "telemetry functions",
      "telemetry routes under /apps/<app_id>/v1/track",
      "telemetry_<app_id> collections",
    ],
    expected_targets: {
      route: expected.route.path,
      hosting_deploy_path: expected.hosting.deploy_path,
      hosted_object_allowlist: [...expected.object_paths],
      current_generated_config: {
        hosting_absent: true,
        updates_route_absent: true,
      },
    },
  };
  if (value === undefined) {
    return {
      ...base,
      status: "live-state-required",
      blockers: [
        "No complete read-only legacy static-update inventory was supplied; no retirement target is authorized.",
      ],
      delete_targets: [],
    };
  }
  assertPlainObject(value, "live_state.legacy_static_updates");
  assertExactKeys(
    value,
    ["inventory_complete", "route", "hosting", "object_paths"],
    "live_state.legacy_static_updates",
  );
  if (value.inventory_complete !== true) {
    throw new TypeError(
      "live_state.legacy_static_updates inventory must be complete",
    );
  }
  const blockers = [];
  const deleteTargets = [];
  if (value.route !== null) {
    if (!structurallyEqual(value.route, expected.route)) {
      blockers.push(
        "The live /updates route is not the exact reviewed static-hosting route.",
      );
    } else {
      deleteTargets.push({ kind: "gateway-route", path: expected.route.path });
    }
  }
  if (value.hosting !== null) {
    if (!structurallyEqual(value.hosting, expected.hosting)) {
      blockers.push(
        "The live updates hosting target is not the exact reviewed deploy path.",
      );
    } else {
      deleteTargets.push({
        kind: "hosting-deploy-path",
        name: expected.hosting.name,
        path: expected.hosting.deploy_path,
      });
    }
  }
  const liveObjectPaths = validateUniqueStrings(
    value.object_paths,
    "live_state.legacy_static_updates.object_paths",
  );
  const objectClassifications = expected.object_paths.map((path) => ({
    path,
    state: liveObjectPaths.includes(path) ? "present" : "already-absent",
  }));
  for (const path of liveObjectPaths) {
    if (!expected.object_paths.includes(path)) {
      blockers.push(
        `Unrecognized static update object ${path} blocks retirement.`,
      );
    } else {
      deleteTargets.push({ kind: "hosting-object", path });
    }
  }
  return {
    ...base,
    status: blockers.length === 0 ? "preview-only" : "blocked",
    blockers,
    object_classifications: objectClassifications,
    delete_targets: blockers.length === 0 ? deleteTargets : [],
  };
}

function validateCostGate(value) {
  assertPlainObject(value, "live_state.cost_gate");
  assertExactKeys(
    value,
    [
      "enable_overrun",
      "zero_cost_plan",
      "non_zero_amount_detected",
      "paid_or_upgrade_prompt_detected",
      "auto_renewal_enabled",
      "remaining_quota_sufficient",
    ],
    "live_state.cost_gate",
  );
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "boolean") {
      throw new TypeError(`live_state.cost_gate.${key} must be boolean`);
    }
  }
  const blockers = [];
  if (value.enable_overrun) blockers.push("EnableOverrun must remain false.");
  if (!value.zero_cost_plan)
    blockers.push("A verified zero-cost plan is required.");
  if (value.non_zero_amount_detected) {
    blockers.push("A non-zero amount was detected.");
  }
  if (value.paid_or_upgrade_prompt_detected) {
    blockers.push(
      "A paid order, resource pack or upgrade prompt was detected.",
    );
  }
  if (value.auto_renewal_enabled) {
    blockers.push("Automatic renewal must remain disabled.");
  }
  if (!value.remaining_quota_sufficient) {
    blockers.push("Remaining free quota is insufficient or unverified.");
  }
  return blockers;
}

function reconcileFunction(value, plannedAppIds, plannedCredentials) {
  if (value === null) {
    return {
      blockers: [],
      action: {
        action: "create",
        resource: APPLICATION_VERSION_API.functionName,
        add_app_ids: [...plannedAppIds],
        add_credential_ids: plannedCredentials.map(
          ({ credential_id: credentialId }) => credentialId,
        ),
      },
    };
  }
  assertPlainObject(value, "live_state.function");
  assertExactKeys(
    value,
    [
      "name",
      "type",
      "runtime",
      "handler",
      "timeout",
      "memory_size",
      "application_ids",
      "credential_bindings",
    ],
    "live_state.function",
  );
  const blockers = [];
  for (const [key, expectedValue] of Object.entries(FUNCTION_SHAPE)) {
    if (value[key] !== expectedValue) {
      blockers.push(
        `Existing function ${key} is incompatible with the reviewed shared-function shape.`,
      );
    }
  }
  const existingAppIds = validateUniqueStrings(
    value.application_ids,
    "live_state.function.application_ids",
  );
  for (const appId of existingAppIds) {
    if (!plannedAppIds.includes(appId)) {
      blockers.push(
        `Planned configuration would remove existing app_id ${appId}.`,
      );
    }
  }
  const existingCredentials = validateLiveCredentialBindings(
    value.credential_bindings,
  );
  for (const existing of existingCredentials) {
    const planned = plannedCredentials.find(
      ({ credential_id: credentialId }) =>
        credentialId === existing.credential_id,
    );
    if (!planned || !credentialBindingIsPreserved(existing, planned)) {
      blockers.push(
        `Planned configuration would remove or change existing credential binding ${existing.credential_id}.`,
      );
    }
  }
  return {
    blockers,
    action: {
      action: "preserve-and-update-additively",
      resource: APPLICATION_VERSION_API.functionName,
      preserve_app_ids: existingAppIds,
      add_app_ids: plannedAppIds.filter(
        (appId) => !existingAppIds.includes(appId),
      ),
      preserve_credential_ids: existingCredentials.map(
        ({ credential_id: credentialId }) => credentialId,
      ),
      add_credential_ids: plannedCredentials
        .map(({ credential_id: credentialId }) => credentialId)
        .filter(
          (credentialId) =>
            !existingCredentials.some(
              ({ credential_id: existingId }) => existingId === credentialId,
            ),
        ),
    },
  };
}

function validateLiveCredentialBindings(value) {
  if (!Array.isArray(value)) {
    throw new TypeError(
      "live_state.function.credential_bindings must be an array",
    );
  }
  const bindings = value.map((binding, index) => {
    const label = `live_state.function.credential_bindings[${index}]`;
    assertPlainObject(binding, label);
    assertExactKeys(
      binding,
      [
        "credential_id",
        "app_id",
        "codes",
        "scopes",
        "key_sha256",
        "secret_sha256",
      ],
      label,
    );
    if (
      typeof binding.credential_id !== "string" ||
      typeof binding.app_id !== "string" ||
      !/^[0-9a-f]{64}$/.test(binding.key_sha256)
    ) {
      throw new TypeError(`${label} is malformed`);
    }
    const codes = validateUniqueStrings(binding.codes, `${label}.codes`);
    const scopes = validateUniqueStrings(binding.scopes, `${label}.scopes`);
    const secretHashes = validateUniqueStrings(
      binding.secret_sha256,
      `${label}.secret_sha256`,
    );
    if (secretHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) {
      throw new TypeError(`${label}.secret_sha256 is malformed`);
    }
    return { ...binding, codes, scopes, secret_sha256: secretHashes };
  });
  if (
    new Set(bindings.map(({ credential_id: credentialId }) => credentialId))
      .size !== bindings.length
  ) {
    throw new TypeError(
      "live_state.function.credential_bindings contains duplicate credential_id values",
    );
  }
  return bindings;
}

function credentialBindingIsPreserved(existing, planned) {
  return (
    existing.app_id === planned.app_id &&
    existing.key_sha256 === planned.key_sha256 &&
    setEquals(existing.codes, planned.codes) &&
    setEquals(existing.scopes, planned.scopes) &&
    existing.secret_sha256.every((hash) => planned.secret_sha256.includes(hash))
  );
}

function reconcileRoute(value, expectedRoute) {
  if (value === null) {
    return {
      blockers: [],
      action: { action: "create", path: expectedRoute.path },
    };
  }
  assertPlainObject(value, "live_state.route");
  if (!structurallyEqual(value, expectedRoute)) {
    return {
      blockers: [
        `Existing route ${expectedRoute.path} conflicts with the reviewed target or security/QPS configuration.`,
      ],
      action: { action: "review", path: expectedRoute.path },
    };
  }
  return {
    blockers: [],
    action: { action: "preserve", path: expectedRoute.path },
  };
}

function reconcileCollections(value, applications) {
  if (!Array.isArray(value)) {
    throw new TypeError("live_state.collections must be an array");
  }
  const byName = new Map();
  for (const [index, collection] of value.entries()) {
    const label = `live_state.collections[${index}]`;
    assertPlainObject(collection, label);
    assertExactKeys(
      collection,
      ["name", "permission", "indexes", "record_count"],
      label,
    );
    if (
      typeof collection.name !== "string" ||
      typeof collection.permission !== "string" ||
      !Number.isInteger(collection.record_count) ||
      collection.record_count < 0
    ) {
      throw new TypeError(`${label} is malformed`);
    }
    const indexes = validateUniqueStrings(
      collection.indexes,
      `${label}.indexes`,
    );
    if (byName.has(collection.name)) {
      throw new TypeError("live_state.collections contains duplicate names");
    }
    byName.set(collection.name, { ...collection, indexes });
  }

  const blockers = [];
  const actions = [];
  for (const expected of applications.flatMap(
    ({ collections }) => collections,
  )) {
    const existing = byName.get(expected.name);
    if (!existing) {
      actions.push({
        action: "create",
        name: expected.name,
        record_count: 0,
        add_indexes: [...expected.indexes],
      });
      continue;
    }
    if (existing.permission !== "ADMINONLY") {
      blockers.push(
        `Existing collection ${expected.name} is not ADMINONLY and requires a separate ACL review.`,
      );
    }
    const missingIndexes = expected.indexes.filter(
      (index) => !existing.indexes.includes(index),
    );
    actions.push({
      action:
        missingIndexes.length === 0 ? "preserve" : "preserve-and-add-indexes",
      name: expected.name,
      record_count: existing.record_count,
      add_indexes: missingIndexes,
      preserve_indexes: existing.indexes,
    });
  }
  return { blockers, actions };
}

function createWriteSteps({
  reconciliation,
  envId,
  routeApiBody,
  credentialConfigSha256,
  deploymentMaterialsSha256,
}) {
  if (reconciliation.status !== "ready-after-confirmation") return [];
  const steps = [
    {
      kind: "manual-secret",
      resource: "function-environment",
      instruction:
        "Keep the reviewed credential Base64 only in cloudbase/application-version-credentials.b64. The credential-bound deployment helper must verify both reviewed SHA-256 values and inject the exact credential only into its tcb child process without echoing it.",
    },
    ...reconciliation.actions.collections
      .filter(({ action }) => action !== "preserve")
      .map((collection) => ({
        kind: "manual",
        resource: `collection:${collection.name}`,
        instruction:
          collection.action === "create"
            ? `Create ${collection.name}, set ADMINONLY, and create only the reviewed indexes; do not write test data yet.`
            : `Preserve all ${collection.record_count} existing records and existing indexes in ${collection.name}; add only these missing indexes: ${collection.add_indexes.join(", ")}.`,
      })),
    {
      kind: "command",
      resource: "function",
      action: reconciliation.actions.function.action,
      argv: [
        "node",
        "cloudbase/deploy-application-version-api.mjs",
        "--env-id",
        envId,
        "--credentials-b64-file",
        "cloudbase/application-version-credentials.b64",
        "--expected-sha256",
        credentialConfigSha256,
        "--expected-materials-sha256",
        deploymentMaterialsSha256,
      ],
      instruction:
        reconciliation.actions.function.action === "create"
          ? "Create the reviewed shared function after the stage 4 confirmation."
          : "Update the existing shared function in place; preserve its name, every existing application binding and every existing credential hash while adding only the reviewed applications/credentials.",
      output_policy:
        "The helper suppresses raw stdout and stderr and reports only a generic success or a sanitized exit-code/signal failure. No request id is claimed or retained because the CLI output format is not a frozen safe interface.",
    },
  ];
  if (reconciliation.actions.route.action === "create") {
    steps.push({
      kind: "command",
      resource: "route",
      action: "create",
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
    });
  }
  return steps;
}

function validateUniqueStrings(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError(`${label} must contain unique non-empty strings`);
  }
  return [...value];
}

function credentialHasExactScopes(credential, expectedScopes) {
  return (
    credential.scopes.size === expectedScopes.length &&
    expectedScopes.every((scope) => credential.scopes.has(scope))
  );
}

function credentialIsRuntime(credential) {
  return credential.codes.size === 1 && credentialHasRuntimeScopes(credential);
}

function credentialHasRuntimeScopes(credential) {
  return (
    credential.scopes.has("versions:check") &&
    credential.scopes.size <= RUNTIME_CREDENTIAL_SCOPES.length &&
    [...credential.scopes].every((scope) =>
      RUNTIME_CREDENTIAL_SCOPES.includes(scope),
    )
  );
}

function credentialIsAdvertisementContractTest(credential) {
  return (
    credential.fingerprint.startsWith(
      ADVERTISEMENT_CONTRACT_TEST_CREDENTIAL_PREFIX,
    ) &&
    credential.codes.size === 1 &&
    credentialHasExactScopes(credential, RUNTIME_CREDENTIAL_SCOPES)
  );
}

function setEquals(left, right) {
  return (
    left.length === right.length && left.every((item) => right.includes(item))
  );
}

function structurallyEqual(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => structurallyEqual(item, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    structurallyEqual(leftKeys, rightKeys) &&
    leftKeys.every((key) => structurallyEqual(left[key], right[key]))
  );
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
}

function assertExactKeys(value, expectedKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const canonicalExpected = [...expectedKeys].sort();
  if (!structurallyEqual(actualKeys, canonicalExpected)) {
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

export function normalizeCredentialConfiguration(value) {
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
  const hasLiveState = args.length === 8 && args[6] === "--live-state-file";
  if (
    (args.length !== 6 && !hasLiveState) ||
    args[0] !== "--env-id" ||
    args[2] !== "--origin" ||
    args[4] !== "--credentials-b64-file"
  ) {
    throw new TypeError(
      "usage: npm run cloudbase:version-api:deploy:plan -- --env-id <env_id> --origin <https_origin> --credentials-b64-file <untracked_path> [--live-state-file <untracked_read_only_receipt>]",
    );
  }
  const options = {
    envId: args[1],
    origin: args[3],
    credentialsFile: resolve(args[5]),
  };
  if (hasLiveState) options.liveStateFile = resolve(args[7]);
  return options;
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
