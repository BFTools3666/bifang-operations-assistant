import assert from "node:assert/strict";
import { spawn as spawnChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
  createApplicationVersionDeploymentMaterialsSummary,
  createApplicationVersionDeploymentPlan,
  planApplicationVersionDeployment,
} from "../cloudbase/plan-application-version-api-deployment.mjs";
import { deployApplicationVersionApi } from "../cloudbase/deploy-application-version-api.mjs";

const ENV_ID = "bftoos-sh-d3ga7hahz59229f0a";
const ORIGIN =
  "https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com";
const KEY = "test-management-key-never-deployed";
const SECRET = "test-management-secret-never-deployed";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createDeploymentFixture(
  root,
  {
    packageVersion = APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
    cliEntry,
    registryValue = mouseRegistry(),
  } = {},
) {
  const functionRoot = join(
    root,
    "cloudbase",
    "functions",
    "application-version-api",
  );
  const cliPackageRoot = join(root, "node_modules", "@cloudbase", "cli");
  const cliPackagePath = join(cliPackageRoot, "package.json");
  const cliBinRoot = join(cliPackageRoot, "bin");
  const cliRuntimePath = join(cliPackageRoot, "runtime", "bootstrap.js");
  await mkdir(join(functionRoot, "src"), { recursive: true });
  await mkdir(cliPackageRoot, { recursive: true });
  await mkdir(cliBinRoot, { recursive: true });
  await mkdir(join(cliPackageRoot, "runtime"), { recursive: true });
  const configPath = join(root, "cloudbaserc.example.json");
  const registryPath = join(root, "cloudbase", "apps.json");
  const deployScriptPath = join(
    root,
    "cloudbase",
    "deploy-application-version-api.mjs",
  );
  const plannerScriptPath = join(
    root,
    "cloudbase",
    "plan-application-version-api-deployment.mjs",
  );
  const generatorScriptPath = join(
    root,
    "cloudbase",
    "generate-cloudbaserc.mjs",
  );
  const packagePath = join(root, "package.json");
  const packageLockPath = join(root, "package-lock.json");
  const sourcePath = join(functionRoot, "src", "handler.js");
  const configText = '{"version":"2.1","functions":[]}\n';
  const deployScriptText = 'export const deploy = "reviewed";\n';
  const plannerScriptText = 'export const plan = "reviewed";\n';
  const generatorScriptText = 'export const generate = "reviewed";\n';
  const packageText = `${JSON.stringify({
    name: "deployment-fixture",
    private: true,
    devDependencies: {
      "@cloudbase/cli": APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
    },
  })}\n`;
  const packageLockText = `${JSON.stringify({
    name: "deployment-fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "deployment-fixture",
        devDependencies: {
          "@cloudbase/cli": APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
        },
      },
      "node_modules/@cloudbase/cli": {
        version: APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
        resolved: "https://registry.npmjs.org/@cloudbase/cli/-/cli-3.8.1.tgz",
        integrity: "sha512-fixture-only",
        dev: true,
      },
    },
  })}\n`;
  const sourceText = "exports.main = async () => ({ ok: true });\n";
  const cliEntryText =
    cliEntry ??
    `if (process.argv[2] === "--version") console.log("CloudBase CLI ${packageVersion}");\n`;
  const cliRuntimeText = 'module.exports = "reviewed-runtime";\n';
  const cliPackageText = JSON.stringify({
    name: "@cloudbase/cli",
    version: packageVersion,
    bin: { tcb: "bin/tcb" },
  });
  await writeFile(configPath, configText, "utf8");
  await writeFile(registryPath, JSON.stringify(registryValue), "utf8");
  await writeFile(deployScriptPath, deployScriptText, "utf8");
  await writeFile(plannerScriptPath, plannerScriptText, "utf8");
  await writeFile(generatorScriptPath, generatorScriptText, "utf8");
  await writeFile(packagePath, packageText, "utf8");
  await writeFile(packageLockPath, packageLockText, "utf8");
  await writeFile(
    join(functionRoot, "index.js"),
    'require("./src/handler");\n',
  );
  await writeFile(sourcePath, sourceText, "utf8");
  await writeFile(cliPackagePath, cliPackageText, "utf8");
  await writeFile(join(cliBinRoot, "tcb"), cliEntryText, "utf8");
  await writeFile(cliRuntimePath, cliRuntimeText, "utf8");
  return {
    configPath,
    configText,
    registryPath,
    deployScriptPath,
    deployScriptText,
    packagePath,
    packageText,
    packageLockPath,
    packageLockText,
    sourcePath,
    sourceText,
    cliEntryPath: join(cliBinRoot, "tcb"),
    cliEntryText,
    cliPackagePath,
    cliPackageText,
    cliRuntimePath,
    cliRuntimeText,
  };
}

function fakeCloudBaseCliSpawn(calls, reportedVersion, deployExitCode = 0) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    const isVersion = args.includes("--version");
    if (isVersion) child.stdout = new PassThrough();
    queueMicrotask(() => {
      if (isVersion) {
        child.stdout.end(
          `CloudBase CLI ${reportedVersion}\nA non-contract update hint is suppressed\n`,
        );
      }
      child.emit("close", isVersion ? 0 : deployExitCode, null);
    });
    return child;
  };
}

function timeoutCloudBaseCliSpawn(calls, hangMode) {
  return (command, args, options) => {
    const child = new EventEmitter();
    const call = { command, args, options, killSignals: [] };
    calls.push(call);
    const isVersion = args.includes("--version");
    if (isVersion) child.stdout = new PassThrough();
    child.kill = (signal) => {
      call.killSignals.push(signal);
      queueMicrotask(() => {
        child.emit("error", new Error("late child error after timeout"));
        child.emit("close", null, signal);
      });
      return true;
    };
    if ((isVersion ? "version" : "deploy") !== hangMode) {
      queueMicrotask(() => {
        if (isVersion) child.stdout.end("CloudBase CLI 3.8.1\n");
        child.emit("close", 0, null);
      });
    }
    return child;
  };
}

function registry() {
  return {
    schema_version: 3,
    apps: [
      {
        app_id: "bifang-mouse-clicker",
        release_streams: [
          {
            platform: "windows",
            architecture: "x64",
            channel: "stable",
            code: "bifang-mouse-clicker",
          },
        ],
      },
      {
        app_id: "bifang-screen-recorder",
        release_streams: [
          {
            platform: "windows",
            architecture: "x64",
            channel: "stable",
            code: "bifang-screen-recorder-windows-x64",
          },
          {
            platform: "macos",
            architecture: "arm64",
            channel: "stable",
            code: "bifang-screen-recorder-macos-arm64",
          },
        ],
      },
    ],
  };
}

function mouseRegistry() {
  const value = registry();
  return { ...value, apps: [value.apps[0]] };
}

function credentialsBase64(credentialCount = 1) {
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      credentials: [
        {
          credential_id: "mouse-runtime-2026-09",
          key_sha256: sha256(`${KEY}-mouse-runtime`),
          secret_sha256: [sha256(`${SECRET}-mouse-runtime`)],
          app_id: "bifang-mouse-clicker",
          codes: ["bifang-mouse-clicker"],
          scopes: ["versions:check"],
        },
        ...Array.from({ length: credentialCount }, (_, index) => {
          const suffix = index === 0 ? "" : `-${index}`;
          return {
            credential_id:
              index === 0
                ? "contract-ads-mouse-2026-09"
                : `e2e-runtime-2026-09${suffix}`,
            key_sha256: sha256(index === 0 ? KEY : `${KEY}${suffix}`),
            secret_sha256: [
              sha256(index === 0 ? SECRET : `${SECRET}${suffix}`),
            ],
            app_id: "bifang-mouse-clicker",
            codes: ["bifang-mouse-clicker"],
            scopes:
              index === 0 ? ["versions:check", "ads:show"] : ["versions:check"],
          };
        }),
        {
          credential_id: "mouse-management-read-2026-09",
          key_sha256: sha256(`${KEY}-mouse-management-read`),
          secret_sha256: [sha256(`${SECRET}-mouse-management-read`)],
          app_id: "bifang-mouse-clicker",
          codes: ["bifang-mouse-clicker"],
          scopes: ["versions:read", "ads:read"],
        },
        {
          credential_id: "mouse-management-write-2026-09",
          key_sha256: sha256(`${KEY}-mouse-management-write`),
          secret_sha256: [sha256(`${SECRET}-mouse-management-write`)],
          app_id: "bifang-mouse-clicker",
          codes: ["bifang-mouse-clicker"],
          scopes: ["versions:write", "ads:write"],
        },
      ],
    }),
    "utf8",
  ).toString("base64");
}

function twoAppCredentialConfiguration() {
  return {
    schema_version: 1,
    credentials: [
      {
        credential_id: "e2e-runtime-2026-09",
        key_sha256: sha256(KEY),
        secret_sha256: [sha256(SECRET)],
        app_id: "bifang-mouse-clicker",
        codes: ["bifang-mouse-clicker"],
        scopes: ["versions:check"],
      },
      {
        credential_id: "screen-windows-runtime-2026-09",
        key_sha256: sha256(`${KEY}-screen-windows`),
        secret_sha256: [sha256(`${SECRET}-screen-windows`)],
        app_id: "bifang-screen-recorder",
        codes: ["bifang-screen-recorder-windows-x64"],
        scopes: ["versions:check"],
      },
      {
        credential_id: "screen-macos-runtime-2026-09",
        key_sha256: sha256(`${KEY}-screen-macos-runtime`),
        secret_sha256: [sha256(`${SECRET}-screen-macos-runtime`)],
        app_id: "bifang-screen-recorder",
        codes: ["bifang-screen-recorder-macos-arm64"],
        scopes: ["versions:check"],
      },
      {
        credential_id: "contract-ads-screen-macos-2026-09",
        key_sha256: sha256(`${KEY}-screen-macos`),
        secret_sha256: [sha256(`${SECRET}-screen-macos`)],
        app_id: "bifang-screen-recorder",
        codes: ["bifang-screen-recorder-macos-arm64"],
        scopes: ["versions:check", "ads:show"],
      },
      {
        credential_id: "mouse-management-read-2026-09",
        key_sha256: sha256(`${KEY}-mouse-management-read`),
        secret_sha256: [sha256(`${SECRET}-mouse-management-read`)],
        app_id: "bifang-mouse-clicker",
        codes: ["bifang-mouse-clicker"],
        scopes: ["versions:read", "ads:read"],
      },
      {
        credential_id: "mouse-management-write-2026-09",
        key_sha256: sha256(`${KEY}-mouse-management-write`),
        secret_sha256: [sha256(`${SECRET}-mouse-management-write`)],
        app_id: "bifang-mouse-clicker",
        codes: ["bifang-mouse-clicker"],
        scopes: ["versions:write", "ads:write"],
      },
      {
        credential_id: "screen-management-read-2026-09",
        key_sha256: sha256(`${KEY}-screen-management-read`),
        secret_sha256: [sha256(`${SECRET}-screen-management-read`)],
        app_id: "bifang-screen-recorder",
        codes: [
          "bifang-screen-recorder-windows-x64",
          "bifang-screen-recorder-macos-arm64",
        ],
        scopes: ["versions:read", "ads:read"],
      },
      {
        credential_id: "screen-management-write-2026-09",
        key_sha256: sha256(`${KEY}-screen-management-write`),
        secret_sha256: [sha256(`${SECRET}-screen-management-write`)],
        app_id: "bifang-screen-recorder",
        codes: [
          "bifang-screen-recorder-windows-x64",
          "bifang-screen-recorder-macos-arm64",
        ],
        scopes: ["versions:write", "ads:write"],
      },
    ],
  };
}

function compactCredentialConfiguration(configuration) {
  const appIds = [
    ...new Set(configuration.credentials.map(({ app_id }) => app_id)),
  ];
  const codes = [
    ...new Set(
      configuration.credentials.flatMap((credential) => credential.codes),
    ),
  ];
  const scopeMasks = new Map([
    ["versions:check", 1],
    ["versions:check,ads:show", 9],
    ["versions:read,ads:read", 18],
    ["versions:write,ads:write", 36],
  ]);
  return {
    schema_version: 2,
    app_ids: appIds,
    codes,
    credentials: configuration.credentials.map((value) => [
      value.credential_id,
      appIds.indexOf(value.app_id),
      value.codes.map((code) => codes.indexOf(code)),
      Buffer.from(value.key_sha256, "hex").toString("base64"),
      value.secret_sha256.map((hash) =>
        Buffer.from(hash, "hex").toString("base64"),
      ),
      scopeMasks.get(value.scopes.join(",")),
    ]),
  };
}

function twoAppCredentialsBase64() {
  return Buffer.from(
    JSON.stringify(
      compactCredentialConfiguration(twoAppCredentialConfiguration()),
    ),
    "utf8",
  ).toString("base64");
}

function costGate() {
  return {
    enable_overrun: false,
    zero_cost_plan: true,
    non_zero_amount_detected: false,
    paid_or_upgrade_prompt_detected: false,
    auto_renewal_enabled: false,
    remaining_quota_sufficient: true,
  };
}

function legacyStaticUpdates(
  objectPaths = [
    "/updates/bifang-mouse-clicker/windows.json",
    "/updates/bifang-screen-recorder/windows.json",
    "/updates/bifang-screen-recorder/macos.json",
    "/updates/example-tool/windows.json",
    "/updates/update.schema.json",
  ],
) {
  return {
    inventory_complete: true,
    route: { path: "/updates", target: "hosting:updates", enableAuth: false },
    hosting: { name: "updates", deploy_path: "/updates" },
    object_paths: objectPaths,
  };
}

function firstDeploymentLiveState() {
  return {
    schema_version: 1,
    env_id: ENV_ID,
    origin: ORIGIN,
    gateway_domain: { enabled: true, status: "SUCCESS", dns_status: "OK" },
    cost_gate: costGate(),
    function: null,
    route: null,
    collections: [],
    collections_inventory_complete: true,
    legacy_static_updates: legacyStaticUpdates(),
  };
}

function versionRoute() {
  return {
    path: "/tools/version-control/v1",
    upstreamResourceType: "SCF",
    upstreamResourceName: "application-version-api",
    enable: true,
    enableAuth: false,
    enableSafeDomain: true,
    enablePathTransmission: true,
    qpsPolicy: {
      qpsTotal: 100,
      qpsPerClient: { limitBy: "ClientIP", limitValue: 10 },
    },
  };
}

function existingMouseCredential() {
  return {
    credential_id: "e2e-runtime-2026-09",
    app_id: "bifang-mouse-clicker",
    codes: ["bifang-mouse-clicker"],
    scopes: ["versions:check"],
    key_sha256: sha256(KEY),
    secret_sha256: [sha256(SECRET)],
  };
}

function additiveLiveState() {
  return {
    ...firstDeploymentLiveState(),
    function: {
      name: "application-version-api",
      type: "Event",
      runtime: "Nodejs20.19",
      handler: "index.main",
      timeout: 3,
      memory_size: 256,
      application_ids: ["bifang-mouse-clicker"],
      credential_bindings: [existingMouseCredential()],
    },
    route: versionRoute(),
    collections: [
      {
        name: "versions_bifang_mouse_clicker",
        permission: "ADMINONLY",
        indexes: [
          "doc_type + code + created_at(desc) + _id(desc)",
          "doc_type + code + version_sort_key(desc) + updated_at(desc) + _id(desc)",
        ],
        record_count: 8,
      },
      {
        name: "ads_bifang_mouse_clicker",
        permission: "ADMINONLY",
        indexes: [],
        record_count: 2,
      },
      {
        name: "audit_bifang_mouse_clicker",
        permission: "ADMINONLY",
        indexes: ["occurred_at(desc)"],
        record_count: 12,
      },
    ],
  };
}

test("telemetry-only registration never creates legacy version collection plans", () => {
  const input = registry();
  input.apps.push({ app_id: "new-center-tool", release_streams: [] });
  const plan = createApplicationVersionDeploymentPlan(
    input,
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN },
  );
  assert.equal(
    plan.resources.applications.some((app) => app.app_id === "new-center-tool"),
    false,
  );
  assert.equal(plan.resources.applications.length, 2);
});

test("the service-only plan freezes one v1 route and all per-app collections", () => {
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN, liveState: firstDeploymentLiveState() },
  );

  assert.equal(plan.mode, "service-only-preview");
  assert.equal(plan.requires_stage_4_confirmation, true);
  assert.equal(plan.env_id, ENV_ID);
  assert.equal(plan.base_url, `${ORIGIN}/tools/version-control/v1`);
  assert.equal(plan.resources.function, "application-version-api");
  assert.equal(plan.resources.route.path, "/tools/version-control/v1");
  assert.equal(plan.resources.route.path.includes("/v1/v1"), false);
  assert.equal(plan.reconciliation.status, "ready-after-confirmation");
  assert.equal(plan.reconciliation.deployment_kind, "first-deployment");
  assert.equal(plan.reconciliation.actions.function.action, "create");
  assert.equal(plan.reconciliation.actions.route.action, "create");
  assert.deepEqual(plan.deployment_cli, {
    package: "@cloudbase/cli",
    version: "3.8.1",
    resolution:
      "process.execPath + reviewed private-staging copy of repository-local @cloudbase/cli/bin/tcb",
  });
  assert.match(plan.deployment_materials.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    plan.deployment_materials.includes_normalized_credential_configuration,
    true,
  );
  const reviewedMaterialPaths = new Set(
    plan.deployment_materials.files.map(({ path }) => path),
  );
  for (const path of [
    "cloudbaserc.example.json",
    "cloudbase/apps.json",
    "cloudbase/deploy-application-version-api.mjs",
    "cloudbase/plan-application-version-api-deployment.mjs",
    "cloudbase/generate-cloudbaserc.mjs",
    "package.json",
    "package-lock.json",
  ]) {
    assert.equal(reviewedMaterialPaths.has(path), true, path);
  }
  assert.ok(
    plan.deployment_materials.files.some(({ path }) =>
      path.startsWith("cloudbase/functions/application-version-api/"),
    ),
  );
  assert.ok(
    plan.deployment_materials.files.some(({ path }) =>
      path.startsWith("node_modules/@cloudbase/cli/"),
    ),
  );
  assert.deepEqual(plan.function_environment_budget, {
    estimated_utf8_bytes: plan.function_environment_budget.estimated_utf8_bytes,
    enforced_maximum_bytes: 3_840,
    platform_quota_bytes: 4_096,
  });
  assert.ok(
    plan.function_environment_budget.estimated_utf8_bytes <
      plan.function_environment_budget.enforced_maximum_bytes,
  );
  assert.deepEqual(
    plan.resources.applications.map(({ app_id }) => app_id),
    ["bifang-mouse-clicker", "bifang-screen-recorder"],
  );
  assert.deepEqual(
    plan.resources.applications[0].collections.map(({ name }) => name),
    [
      "versions_bifang_mouse_clicker",
      "ads_bifang_mouse_clicker",
      "audit_bifang_mouse_clicker",
    ],
  );
  assert.ok(
    plan.resources.applications
      .flatMap(({ collections }) => collections)
      .every(({ permission }) => permission === "ADMINONLY"),
  );
  const versionIndexes = plan.resources.applications[0].collections.find(
    ({ name }) => name === "versions_bifang_mouse_clicker",
  ).indexes;
  assert.ok(
    versionIndexes.includes(
      "doc_type + code + version_sort_key(desc) + updated_at(desc) + _id(desc)",
    ),
  );
  assert.deepEqual(
    plan.resources.applications[0].collections.find(
      ({ name }) => name === "versions_bifang_mouse_clicker",
    ).constraints,
    ["transactional version-key documents enforce canonical uniqueness"],
  );
  assert.match(
    plan.read_only_preflight.find(
      ({ resource }) => resource === "collections-and-cost",
    ).instruction,
    /Compatible existing ADMINONLY collections and their records are preserved/,
  );
  assert.match(
    plan.read_only_preflight.find(
      ({ resource }) => resource === "collections-and-cost",
    ).instruction,
    /EnableOverrun=false/,
  );
  const routePreflight = plan.read_only_preflight.find(
    ({ resource }) => resource === "routes",
  );
  assert.ok(routePreflight.argv.includes("DescribeHTTPServiceRoute"));
  assert.match(routePreflight.instruction, /exact match is preserved/);
  const routePreflightBody = JSON.parse(
    routePreflight.argv[routePreflight.argv.indexOf("--body") + 1],
  );
  assert.deepEqual(routePreflightBody.Filters, [
    { Name: "Domain", Values: [new URL(ORIGIN).hostname] },
  ]);
  assert.match(
    plan.read_only_preflight.find(({ resource }) => resource === "functions")
      .instruction,
    /presence alone is not a blocker/i,
  );
  assert.doesNotMatch(
    JSON.stringify(plan.read_only_preflight),
    /VerifyHTTPServiceRoute/,
  );
});

test("credential material is validated but only a fingerprint and binding summary are emitted", () => {
  const encoded = credentialsBase64();
  const plan = createApplicationVersionDeploymentPlan(
    mouseRegistry(),
    encoded,
    {
      envId: ENV_ID,
      origin: ORIGIN,
    },
  );

  assert.equal(plan.credential_config_sha256, sha256(encoded));
  assert.deepEqual(plan.credential_bindings, [
    {
      credential_id: "mouse-runtime-2026-09",
      app_id: "bifang-mouse-clicker",
      codes: ["bifang-mouse-clicker"],
      scopes: ["versions:check"],
      secret_versions: 1,
    },
    {
      credential_id: "contract-ads-mouse-2026-09",
      app_id: "bifang-mouse-clicker",
      codes: ["bifang-mouse-clicker"],
      scopes: ["versions:check", "ads:show"],
      secret_versions: 1,
    },
    {
      credential_id: "mouse-management-read-2026-09",
      app_id: "bifang-mouse-clicker",
      codes: ["bifang-mouse-clicker"],
      scopes: ["versions:read", "ads:read"],
      secret_versions: 1,
    },
    {
      credential_id: "mouse-management-write-2026-09",
      app_id: "bifang-mouse-clicker",
      codes: ["bifang-mouse-clicker"],
      scopes: ["versions:write", "ads:write"],
      secret_versions: 1,
    },
  ]);
  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, new RegExp(KEY));
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, /key_sha256|secret_sha256/);
});

test("a reconciled first deployment contains no top-level broad, delete, telemetry, hosting, or dashboard writes", () => {
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN, liveState: firstDeploymentLiveState() },
  );
  const commands = plan.write_steps_after_confirmation
    .filter(({ kind }) => kind === "command")
    .map(({ argv }) => argv);
  assert.deepEqual(commands[0], [
    "node",
    "cloudbase/deploy-application-version-api.mjs",
    "--env-id",
    ENV_ID,
    "--credentials-b64-file",
    "cloudbase/application-version-credentials.b64",
    "--expected-sha256",
    sha256(twoAppCredentialsBase64()),
    "--expected-materials-sha256",
    plan.deployment_materials.sha256,
  ]);
  assert.match(
    plan.write_steps_after_confirmation.find(
      ({ resource }) => resource === "function",
    ).output_policy,
    /generic success or a sanitized exit-code\/signal failure/,
  );
  assert.doesNotMatch(
    plan.write_steps_after_confirmation.find(
      ({ resource }) => resource === "function",
    ).output_policy,
    /request id when available/iu,
  );
  assert.equal(commands.length, 2);
  assert.deepEqual(plan.read_only_preflight[0].argv, [
    "npm",
    "run",
    "cloudbase:config:check",
  ]);
  assert.deepEqual(plan.read_only_preflight[1].argv.slice(0, 5), [
    "tcb",
    "fn",
    "list",
    "-e",
    ENV_ID,
  ]);
  const serialized = JSON.stringify(commands);
  const argvValues = commands.flat();
  assert.equal(argvValues.includes("hosting"), false);
  assert.equal(argvValues.includes("operations-dashboard-api"), false);
  assert.equal(
    argvValues.some((value) => /^telemetry-/.test(value)),
    false,
  );
  for (const forbidden of ["--all", "--prune", "delete"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }
  assert.match(
    plan.safety_notes.join("\n"),
    /--force only for the literal tcb fn deploy application-version-api create or update/u,
  );
  assert.ok(
    plan.forbidden_scope.includes(
      "--force outside the exact tcb fn deploy application-version-api create or update",
    ),
  );

  const routeBody = JSON.parse(commands[1][commands[1].indexOf("--body") + 1]);
  assert.equal(routeBody.EnvId, ENV_ID);
  assert.equal(routeBody.Domain.Domain, new URL(ORIGIN).hostname);
  assert.deepEqual(
    routeBody.Domain.Routes.map(({ Path }) => Path),
    ["/tools/version-control/v1"],
  );
  assert.equal(commands[1].includes("CreateHTTPServiceRoute"), true);
  assert.equal(commands[1].includes("ModifyHTTPServiceRoute"), false);
  const routeStatus = plan.post_write_verification.find(
    ({ resource } = {}) => resource === "route-status",
  );
  assert.ok(routeStatus.argv.includes("DescribeHTTPServiceRoute"));
  const routeStatusBody = JSON.parse(
    routeStatus.argv[routeStatus.argv.indexOf("--body") + 1],
  );
  assert.deepEqual(routeStatusBody.Filters, [
    { Name: "Domain", Values: [new URL(ORIGIN).hostname] },
  ]);
  assert.match(routeStatus.success_condition, /Status=SUCCESS/);
  assert.match(routeStatus.success_condition, /DNSStatus=OK/);
  assert.match(plan.post_write_verification[1], /expected 401 JSON response/);
  assert.match(
    plan.safety_notes.join("\n"),
    /cloudbase\/application-version-credentials\.b64/,
  );
  assert.match(
    plan.safety_notes.join("\n"),
    /Do not call VerifyHTTPServiceRoute/,
  );
});

test("live state is mandatory before any write step is emitted", () => {
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN },
  );

  assert.equal(plan.reconciliation.status, "live-state-required");
  assert.deepEqual(plan.write_steps_after_confirmation, []);
  assert.equal(
    plan.legacy_static_update_retirement.status,
    "live-state-required",
  );
  assert.deepEqual(plan.legacy_static_update_retirement.delete_commands, []);
});

test("an existing compatible service is preserved while apps, credentials, collections and indexes are added", () => {
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN, liveState: additiveLiveState() },
  );

  assert.equal(plan.reconciliation.status, "ready-after-confirmation");
  assert.equal(plan.reconciliation.deployment_kind, "preserve-and-add");
  assert.deepEqual(plan.reconciliation.actions.function, {
    action: "preserve-and-update-additively",
    resource: "application-version-api",
    preserve_app_ids: ["bifang-mouse-clicker"],
    add_app_ids: ["bifang-screen-recorder"],
    preserve_credential_ids: ["e2e-runtime-2026-09"],
    add_credential_ids: [
      "screen-windows-runtime-2026-09",
      "screen-macos-runtime-2026-09",
      "contract-ads-screen-macos-2026-09",
      "mouse-management-read-2026-09",
      "mouse-management-write-2026-09",
      "screen-management-read-2026-09",
      "screen-management-write-2026-09",
    ],
  });
  assert.deepEqual(plan.reconciliation.actions.route, {
    action: "preserve",
    path: "/tools/version-control/v1",
  });
  const mouseVersion = plan.reconciliation.actions.collections.find(
    ({ name }) => name === "versions_bifang_mouse_clicker",
  );
  assert.equal(mouseVersion.action, "preserve");
  assert.equal(mouseVersion.record_count, 8);
  const mouseAds = plan.reconciliation.actions.collections.find(
    ({ name }) => name === "ads_bifang_mouse_clicker",
  );
  assert.equal(mouseAds.action, "preserve-and-add-indexes");
  assert.deepEqual(mouseAds.add_indexes, [
    "doc_type + app_code + created_at(desc) + _id(desc)",
  ]);
  assert.ok(
    plan.reconciliation.actions.collections
      .filter(({ name }) => name.includes("screen_recorder"))
      .every(({ action }) => action === "create"),
  );

  const commands = plan.write_steps_after_confirmation
    .filter(({ kind }) => kind === "command")
    .map(({ argv }) => argv);
  assert.equal(commands.length, 1);
  assert.ok(
    commands[0].includes("cloudbase/deploy-application-version-api.mjs"),
  );
  assert.equal(
    JSON.stringify(commands).includes("CreateHTTPServiceRoute"),
    false,
  );
  assert.match(
    plan.write_steps_after_confirmation.find(
      ({ resource }) => resource === "function",
    ).instruction,
    /preserve its name, every existing application binding and every existing credential hash/,
  );
  assert.doesNotMatch(JSON.stringify(plan), /key_sha256|secret_sha256/);
});

test("legacy static updates get exact retirement targets but never delete commands or telemetry targets", () => {
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN, liveState: additiveLiveState() },
  );
  const retirement = plan.legacy_static_update_retirement;

  assert.equal(retirement.status, "preview-only");
  assert.equal(retirement.requires_new_api_e2e_for_both_clients, true);
  assert.equal(retirement.requires_fresh_exact_target_preflight, true);
  assert.equal(retirement.requires_separate_delete_confirmation, true);
  assert.deepEqual(retirement.delete_commands, []);
  assert.deepEqual(retirement.expected_targets.hosted_object_allowlist, [
    "/updates/bifang-mouse-clicker/windows.json",
    "/updates/bifang-screen-recorder/windows.json",
    "/updates/bifang-screen-recorder/macos.json",
    "/updates/example-tool/windows.json",
    "/updates/update.schema.json",
  ]);
  assert.deepEqual(retirement.expected_targets.current_generated_config, {
    hosting_absent: true,
    updates_route_absent: true,
  });
  assert.ok(
    retirement.object_classifications.every(({ state }) => state === "present"),
  );
  assert.deepEqual(
    retirement.delete_targets.map(({ kind, path }) => [kind, path]),
    [
      ["gateway-route", "/updates"],
      ["hosting-deploy-path", "/updates"],
      ["hosting-object", "/updates/bifang-mouse-clicker/windows.json"],
      ["hosting-object", "/updates/bifang-screen-recorder/windows.json"],
      ["hosting-object", "/updates/bifang-screen-recorder/macos.json"],
      ["hosting-object", "/updates/example-tool/windows.json"],
      ["hosting-object", "/updates/update.schema.json"],
    ],
  );
  const serialized = JSON.stringify(retirement);
  assert.doesNotMatch(serialized, /telemetry-bifang-/);
  assert.doesNotMatch(serialized, /\/apps\/bifang-/);
  assert.doesNotMatch(serialized, /telemetry_bifang_/);
});

test("incompatible existing resources or removed credentials block all version-service writes", () => {
  const liveState = additiveLiveState();
  liveState.gateway_domain.enabled = false;
  liveState.function.runtime = "Nodejs18.15";
  liveState.function.credential_bindings[0].codes = ["removed-code"];
  liveState.route.qpsPolicy.qpsPerClient.limitValue = 20;
  liveState.collections[0].permission = "READONLY";
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN, liveState },
  );

  assert.equal(plan.reconciliation.status, "blocked");
  assert.match(
    plan.reconciliation.blockers.join("\n"),
    /default HTTPS domain is disabled/,
  );
  assert.match(
    plan.reconciliation.blockers.join("\n"),
    /runtime is incompatible/,
  );
  assert.match(
    plan.reconciliation.blockers.join("\n"),
    /remove or change existing credential binding/,
  );
  assert.match(plan.reconciliation.blockers.join("\n"), /Existing route/);
  assert.match(plan.reconciliation.blockers.join("\n"), /not ADMINONLY/);
  assert.deepEqual(plan.write_steps_after_confirmation, []);
});

test("a complete partial allowlist inventory marks missing historical objects already absent", () => {
  const liveState = additiveLiveState();
  liveState.legacy_static_updates.object_paths = [
    "/updates/example-tool/windows.json",
    "/updates/update.schema.json",
  ];
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN, liveState },
  );
  const retirement = plan.legacy_static_update_retirement;

  assert.equal(retirement.status, "preview-only");
  assert.deepEqual(
    retirement.object_classifications.map(({ state }) => state),
    [
      "already-absent",
      "already-absent",
      "already-absent",
      "present",
      "present",
    ],
  );
  assert.deepEqual(
    retirement.delete_targets.filter(({ kind }) => kind === "hosting-object"),
    [
      { kind: "hosting-object", path: "/updates/example-tool/windows.json" },
      { kind: "hosting-object", path: "/updates/update.schema.json" },
    ],
  );
  assert.deepEqual(retirement.delete_commands, []);
});

test("legacy inventory classifies absent allowlisted objects and blocks unknown objects", () => {
  const liveState = additiveLiveState();
  liveState.legacy_static_updates.object_paths = [
    "/updates/bifang-mouse-clicker/windows.json",
    "/updates/unknown-tool/windows.json",
  ];
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    twoAppCredentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN, liveState },
  );

  assert.equal(plan.reconciliation.status, "ready-after-confirmation");
  assert.equal(plan.legacy_static_update_retirement.status, "blocked");
  assert.match(
    plan.legacy_static_update_retirement.blockers.join("\n"),
    /Unrecognized static update object/,
  );
  assert.deepEqual(plan.legacy_static_update_retirement.delete_commands, []);
  assert.deepEqual(plan.legacy_static_update_retirement.delete_targets, []);
  assert.deepEqual(
    plan.legacy_static_update_retirement.object_classifications,
    [
      {
        path: "/updates/bifang-mouse-clicker/windows.json",
        state: "present",
      },
      {
        path: "/updates/bifang-screen-recorder/windows.json",
        state: "already-absent",
      },
      {
        path: "/updates/bifang-screen-recorder/macos.json",
        state: "already-absent",
      },
      { path: "/updates/example-tool/windows.json", state: "already-absent" },
      { path: "/updates/update.schema.json", state: "already-absent" },
    ],
  );
});

test("unsafe origins, unknown apps in credentials and malformed secret files fail closed", async () => {
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(registry(), credentialsBase64(), {
        envId: "$(unsafe)",
        origin: ORIGIN,
      }),
    /environment id/,
  );
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(registry(), credentialsBase64(), {
        envId: ENV_ID,
        origin: "https://example.com",
      }),
    /default HTTPS origin/,
  );

  const decoded = JSON.parse(
    Buffer.from(credentialsBase64(), "base64").toString("utf8"),
  );
  decoded.credentials[0].app_id = "unknown-tool";
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(decoded), "utf8").toString("base64"),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /credential configuration is invalid/,
  );
  decoded.credentials[0].app_id = "bifang-mouse-clicker";
  decoded.credentials[0].codes = ["unregistered-release-stream"];
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(decoded), "utf8").toString("base64"),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /code not registered/,
  );

  const directory = await mkdtemp(join(tmpdir(), "bifang-version-plan-"));
  try {
    const credentialsFile = join(directory, "credentials.b64");
    const liveStateFile = join(directory, "live-state.json");
    const registryFile = join(directory, "apps.json");
    await writeFile(registryFile, JSON.stringify(registry()), "utf8");
    await writeFile(credentialsFile, "not-base64", "utf8");
    await assert.rejects(
      planApplicationVersionDeployment({
        envId: ENV_ID,
        origin: ORIGIN,
        credentialsFile,
      }),
      /base64 text/,
    );
    await writeFile(credentialsFile, twoAppCredentialsBase64(), "utf8");
    await writeFile(
      liveStateFile,
      JSON.stringify(firstDeploymentLiveState()),
      "utf8",
    );
    const plan = await planApplicationVersionDeployment({
      envId: ENV_ID,
      origin: ORIGIN,
      credentialsFile,
      liveStateFile,
      registryUrl: registryFile,
    });
    assert.equal(plan.reconciliation.status, "ready-after-confirmation");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every release stream requires isolated runtime and management credential coverage", () => {
  const decoded = twoAppCredentialConfiguration();

  const missingRuntimeApp = structuredClone(decoded);
  missingRuntimeApp.credentials = missingRuntimeApp.credentials.filter(
    ({ credential_id: credentialId }) =>
      ![
        "screen-windows-runtime-2026-09",
        "screen-macos-runtime-2026-09",
      ].includes(credentialId),
  );
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(missingRuntimeApp), "utf8").toString(
          "base64",
        ),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /runtime credential.*bifang-screen-recorder/u,
  );

  const missingRuntimeCode = structuredClone(decoded);
  missingRuntimeCode.credentials = missingRuntimeCode.credentials.filter(
    ({ credential_id: credentialId }) =>
      credentialId !== "screen-macos-runtime-2026-09",
  );
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(missingRuntimeCode), "utf8").toString(
          "base64",
        ),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /runtime credential.*bifang-screen-recorder-macos-arm64/u,
  );

  const missingCheckScope = structuredClone(decoded);
  missingCheckScope.credentials.find(
    ({ credential_id: credentialId }) =>
      credentialId === "screen-windows-runtime-2026-09",
  ).scopes = ["ads:show"];
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(missingCheckScope), "utf8").toString(
          "base64",
        ),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /credential configuration is invalid/u,
  );

  const combinedRuntimeCodes = structuredClone(decoded);
  combinedRuntimeCodes.credentials = combinedRuntimeCodes.credentials.filter(
    ({ credential_id: credentialId }) =>
      ![
        "screen-windows-runtime-2026-09",
        "screen-macos-runtime-2026-09",
      ].includes(credentialId),
  );
  combinedRuntimeCodes.credentials.push({
    credential_id: "screen-combined-runtime-rejected",
    key_sha256: sha256(`${KEY}-screen-combined`),
    secret_sha256: [sha256(`${SECRET}-screen-combined`)],
    app_id: "bifang-screen-recorder",
    codes: [
      "bifang-screen-recorder-windows-x64",
      "bifang-screen-recorder-macos-arm64",
    ],
    scopes: ["versions:check", "ads:show"],
  });
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(combinedRuntimeCodes), "utf8").toString(
          "base64",
        ),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /credential configuration is invalid/u,
  );

  const missingManagement = structuredClone(decoded);
  missingManagement.credentials = missingManagement.credentials.filter(
    ({ credential_id: credentialId }) =>
      credentialId !== "screen-management-read-2026-09",
  );
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(missingManagement), "utf8").toString(
          "base64",
        ),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /management-read credential.*bifang-screen-recorder/u,
  );

  const missingManagementWrite = structuredClone(decoded);
  missingManagementWrite.credentials =
    missingManagementWrite.credentials.filter(
      ({ credential_id: credentialId }) =>
        credentialId !== "screen-management-write-2026-09",
    );
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(missingManagementWrite), "utf8").toString(
          "base64",
        ),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /management-write credential.*bifang-screen-recorder/u,
  );

  const mixedScopes = structuredClone(decoded);
  mixedScopes.credentials[0].scopes.push("versions:write");
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        registry(),
        Buffer.from(JSON.stringify(mixedScopes), "utf8").toString("base64"),
        { envId: ENV_ID, origin: ORIGIN },
      ),
    /credential configuration is invalid/u,
  );
});

test("credential-bound deploy helper verifies reviewed materials and uses only the pinned local CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-bound-deploy-"));
  try {
    await createDeploymentFixture(directory);
    const credentialsFile = join(directory, "credentials.b64");
    const credentialText = credentialsBase64();
    await writeFile(credentialsFile, `${credentialText}\n`, "utf8");
    const deploymentMaterials =
      createApplicationVersionDeploymentMaterialsSummary(
        credentialText,
        directory,
      );
    const calls = [];

    const result = await deployApplicationVersionApi(
      {
        envId: ENV_ID,
        credentialsFile,
        expectedSha256: sha256(credentialText),
        expectedMaterialsSha256: deploymentMaterials.sha256,
      },
      fakeCloudBaseCliSpawn(calls, APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION),
      { deploymentRoot: directory },
    );
    assert.deepEqual(result, { status: "completed", exit_code: 0 });
    assert.equal(calls.length, 2);
    const [versionCall, deployCall] = calls;
    const serializedInvocation = JSON.stringify([
      deployCall.command,
      deployCall.args,
    ]);
    assert.doesNotMatch(serializedInvocation, new RegExp(credentialText, "u"));
    assert.equal(deployCall.options.shell, false);
    assert.equal(
      deployCall.options.env.APPLICATION_VERSION_CREDENTIALS_B64,
      credentialText,
    );
    assert.equal(deployCall.options.env.NO_UPDATE_NOTIFIER, "1");
    assert.equal(deployCall.options.stdio, "ignore");
    assert.equal(
      Object.hasOwn(
        versionCall.options.env,
        "APPLICATION_VERSION_CREDENTIALS_B64",
      ),
      false,
    );
    const allowedEnvironmentKeys = new Set([
      "APPDATA",
      "APPLICATION_VERSION_CREDENTIALS_B64",
      "COMSPEC",
      "HOME",
      "HOMEDRIVE",
      "HOMEPATH",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "NO_UPDATE_NOTIFIER",
      "PATH",
      "PATHEXT",
      "SYSTEMDRIVE",
      "SYSTEMROOT",
      "TEMP",
      "TMP",
      "TMPDIR",
      "USERPROFILE",
      "WINDIR",
    ]);
    assert.ok(
      Object.keys(versionCall.options.env).every((key) =>
        allowedEnvironmentKeys.has(key),
      ),
    );
    assert.ok(
      Object.keys(deployCall.options.env).every((key) =>
        allowedEnvironmentKeys.has(key),
      ),
    );

    assert.notEqual(versionCall.options.cwd, directory);
    assert.equal(versionCall.options.cwd, deployCall.options.cwd);
    const expectedCliEntry = join(
      deployCall.options.cwd,
      "node_modules",
      "@cloudbase",
      "cli",
      "bin",
      "tcb",
    );
    assert.equal(versionCall.command, process.execPath);
    assert.deepEqual(versionCall.args, [expectedCliEntry, "--version"]);
    assert.equal(deployCall.command, process.execPath);
    assert.deepEqual(deployCall.args, [
      expectedCliEntry,
      "fn",
      "deploy",
      "application-version-api",
      "--force",
      "--config-file",
      "cloudbaserc.example.json",
      "-e",
      ENV_ID,
    ]);
    await assert.rejects(access(deployCall.options.cwd), { code: "ENOENT" });

    let spawned = false;
    await assert.rejects(
      deployApplicationVersionApi(
        {
          envId: ENV_ID,
          credentialsFile,
          expectedSha256: "0".repeat(64),
          expectedMaterialsSha256: deploymentMaterials.sha256,
        },
        () => {
          spawned = true;
          throw new Error("must not spawn");
        },
        { deploymentRoot: directory },
      ),
      /reviewed SHA-256/u,
    );
    assert.equal(spawned, false);

    const failureCalls = [];
    await assert.rejects(
      deployApplicationVersionApi(
        {
          envId: ENV_ID,
          credentialsFile,
          expectedSha256: sha256(credentialText),
          expectedMaterialsSha256: deploymentMaterials.sha256,
        },
        fakeCloudBaseCliSpawn(
          failureCalls,
          APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
          17,
        ),
        { deploymentRoot: directory },
      ),
      /exit code 17; raw output was suppressed/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deploy helper independently enforces credential coverage and the 3840-byte budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-helper-gates-"));
  try {
    await createDeploymentFixture(directory);
    const credentialsFile = join(directory, "credentials.b64");
    for (const [credentialText, expectedError] of [
      [credentialsBase64(6), /3840-byte deployment safety limit/u],
      [
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(
              Buffer.from(credentialsBase64(), "base64").toString("utf8"),
            ),
            credentials: JSON.parse(
              Buffer.from(credentialsBase64(), "base64").toString("utf8"),
            ).credentials.filter(
              ({ credential_id: credentialId }) =>
                credentialId !== "mouse-management-write-2026-09",
            ),
          }),
          "utf8",
        ).toString("base64"),
        /management-write credential/u,
      ],
    ]) {
      await writeFile(credentialsFile, credentialText, "utf8");
      const reviewed = createApplicationVersionDeploymentMaterialsSummary(
        credentialText,
        directory,
      );
      const calls = [];
      await assert.rejects(
        deployApplicationVersionApi(
          {
            envId: ENV_ID,
            credentialsFile,
            expectedSha256: sha256(credentialText),
            expectedMaterialsSha256: reviewed.sha256,
          },
          fakeCloudBaseCliSpawn(
            calls,
            APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
          ),
          { deploymentRoot: directory },
        ),
        expectedError,
      );
      assert.equal(calls.length, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private staging isolates deployment bytes from root drift at the spawn boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-staging-snapshot-"));
  try {
    const fixture = await createDeploymentFixture(directory);
    const credentialsFile = join(directory, "credentials.b64");
    const credentialText = credentialsBase64();
    await writeFile(credentialsFile, credentialText, "utf8");
    const reviewed = createApplicationVersionDeploymentMaterialsSummary(
      credentialText,
      directory,
    );
    const calls = [];
    const baseSpawn = fakeCloudBaseCliSpawn(
      calls,
      APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
    );
    let drifted = false;
    const driftAtSpawn = (command, args, options) => {
      if (!drifted && args.includes("--version")) {
        drifted = true;
        writeFileSync(
          fixture.configPath,
          '{"version":"root-drift-after-snapshot"}\n',
          "utf8",
        );
        writeFileSync(
          fixture.sourcePath,
          "exports.main = async () => ({ rootDrift: true });\n",
          "utf8",
        );
      }
      return baseSpawn(command, args, options);
    };

    const result = await deployApplicationVersionApi(
      {
        envId: ENV_ID,
        credentialsFile,
        expectedSha256: sha256(credentialText),
        expectedMaterialsSha256: reviewed.sha256,
      },
      driftAtSpawn,
      { deploymentRoot: directory },
    );
    assert.deepEqual(result, { status: "completed", exit_code: 0 });
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].options.cwd, directory);
    assert.equal(calls[0].options.cwd, calls[1].options.cwd);
    await assert.rejects(access(calls[1].options.cwd), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("staging drift during the version preflight blocks the deploy child", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-staging-drift-"));
  try {
    await createDeploymentFixture(directory);
    const credentialsFile = join(directory, "credentials.b64");
    const credentialText = credentialsBase64();
    await writeFile(credentialsFile, credentialText, "utf8");
    const reviewed = createApplicationVersionDeploymentMaterialsSummary(
      credentialText,
      directory,
    );
    const calls = [];
    const baseSpawn = fakeCloudBaseCliSpawn(
      calls,
      APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
    );
    const driftStagingAtVersionCheck = (command, args, options) => {
      if (args.includes("--version")) {
        writeFileSync(
          join(
            options.cwd,
            "cloudbase",
            "functions",
            "application-version-api",
            "src",
            "handler.js",
          ),
          "exports.main = async () => ({ stagingDrift: true });\n",
          "utf8",
        );
      }
      return baseSpawn(command, args, options);
    };

    await assert.rejects(
      deployApplicationVersionApi(
        {
          envId: ENV_ID,
          credentialsFile,
          expectedSha256: sha256(credentialText),
          expectedMaterialsSha256: reviewed.sha256,
        },
        driftStagingAtVersionCheck,
        { deploymentRoot: directory },
      ),
      /deployment materials do not match the reviewed SHA-256/u,
    );
    assert.equal(calls.length, 1);
    await assert.rejects(access(calls[0].options.cwd), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("version and deployment children time out, terminate, settle once and clean staging", async () => {
  for (const hangMode of ["version", "deploy"]) {
    const directory = await mkdtemp(
      join(tmpdir(), `bifang-${hangMode}-timeout-`),
    );
    try {
      await createDeploymentFixture(directory);
      const credentialsFile = join(directory, "credentials.b64");
      const credentialText = credentialsBase64();
      await writeFile(credentialsFile, credentialText, "utf8");
      const reviewed = createApplicationVersionDeploymentMaterialsSummary(
        credentialText,
        directory,
      );
      const calls = [];
      await assert.rejects(
        deployApplicationVersionApi(
          {
            envId: ENV_ID,
            credentialsFile,
            expectedSha256: sha256(credentialText),
            expectedMaterialsSha256: reviewed.sha256,
          },
          timeoutCloudBaseCliSpawn(calls, hangMode),
          {
            deploymentRoot: directory,
            versionTimeoutMs: 20,
            deploymentTimeoutMs: 20,
          },
        ),
        hangMode === "version"
          ? /version check timed out/u
          : /deployment timed out; raw output was suppressed/u,
      );
      assert.equal(calls.length, hangMode === "version" ? 1 : 2);
      assert.deepEqual(calls.at(-1).killSignals, ["SIGKILL"]);
      await assert.rejects(access(calls.at(-1).options.cwd), {
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("deployment materials reject a linked or reparse-point CLI tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-linked-cli-"));
  try {
    for (const mode of ["root", "nested"]) {
      const fixtureRoot = join(directory, mode);
      await createDeploymentFixture(fixtureRoot);
      const cliRoot = join(fixtureRoot, "node_modules", "@cloudbase", "cli");
      const linkedPath = mode === "root" ? cliRoot : join(cliRoot, "runtime");
      const realPath = join(fixtureRoot, `real-cloudbase-cli-${mode}`);
      await rename(linkedPath, realPath);
      await symlink(
        realPath,
        linkedPath,
        process.platform === "win32" ? "junction" : "dir",
      );
      assert.throws(
        () =>
          createApplicationVersionDeploymentMaterialsSummary(
            credentialsBase64(),
            fixtureRoot,
          ),
        mode === "root"
          ? /material roots must be real directories/u
          : /must not contain symbolic links/u,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment material drift in config, controls, lockfile, complete CLI tree or function source blocks before any child starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-deploy-drift-"));
  try {
    const fixture = await createDeploymentFixture(directory);
    const credentialText = credentialsBase64();
    const credentialsFile = join(directory, "credentials.b64");
    await writeFile(credentialsFile, credentialText, "utf8");
    const reviewed = createApplicationVersionDeploymentMaterialsSummary(
      credentialText,
      directory,
    );
    const options = {
      envId: ENV_ID,
      credentialsFile,
      expectedSha256: sha256(credentialText),
      expectedMaterialsSha256: reviewed.sha256,
    };

    for (const [path, original, changed] of [
      [fixture.configPath, fixture.configText, '{"version":"drifted"}\n'],
      [
        fixture.deployScriptPath,
        fixture.deployScriptText,
        'export const deploy = "drifted";\n',
      ],
      [
        fixture.packageLockPath,
        fixture.packageLockText,
        fixture.packageLockText.replace(
          '"name":"deployment-fixture"',
          '"name":"deployment-fixture-drifted"',
        ),
      ],
      [
        fixture.cliEntryPath,
        fixture.cliEntryText,
        'console.log("CloudBase CLI 3.8.1");\nprocess.exitCode = 99;\n',
      ],
      [
        fixture.cliRuntimePath,
        fixture.cliRuntimeText,
        'module.exports = "drifted-runtime";\n',
      ],
      [
        fixture.sourcePath,
        fixture.sourceText,
        "exports.main = async () => ({ drifted: true });\n",
      ],
    ]) {
      await writeFile(path, changed, "utf8");
      let spawned = false;
      await assert.rejects(
        deployApplicationVersionApi(
          options,
          () => {
            spawned = true;
            throw new Error("must not spawn");
          },
          { deploymentRoot: directory },
        ),
        /deployment materials do not match the reviewed SHA-256/u,
      );
      assert.equal(spawned, false);
      await writeFile(path, original, "utf8");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment rejects local CloudBase CLI package or reported-version drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-cli-version-drift-"));
  try {
    const credentialText = credentialsBase64();
    const credentialsFile = join(directory, "credentials.b64");
    const fixture = await createDeploymentFixture(directory);
    await writeFile(credentialsFile, credentialText, "utf8");
    const reviewed = createApplicationVersionDeploymentMaterialsSummary(
      credentialText,
      directory,
    );
    const options = {
      envId: ENV_ID,
      credentialsFile,
      expectedSha256: sha256(credentialText),
      expectedMaterialsSha256: reviewed.sha256,
    };
    await writeFile(
      fixture.packagePath,
      fixture.packageText.replace(
        APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
        "3.8.2",
      ),
      "utf8",
    );
    let spawned = false;
    await assert.rejects(
      deployApplicationVersionApi(
        options,
        () => {
          spawned = true;
          throw new Error("must not spawn");
        },
        { deploymentRoot: directory },
      ),
      /must be exactly 3\.8\.1/u,
    );
    assert.equal(spawned, false);

    await writeFile(fixture.packagePath, fixture.packageText, "utf8");
    await writeFile(
      fixture.packageLockPath,
      fixture.packageLockText.replaceAll(
        APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
        "3.8.2",
      ),
      "utf8",
    );
    spawned = false;
    await assert.rejects(
      deployApplicationVersionApi(
        options,
        () => {
          spawned = true;
          throw new Error("must not spawn");
        },
        { deploymentRoot: directory },
      ),
      /must be exactly 3\.8\.1/u,
    );
    assert.equal(spawned, false);

    await writeFile(fixture.packageLockPath, fixture.packageLockText, "utf8");
    await writeFile(
      fixture.cliPackagePath,
      JSON.stringify({
        name: "@cloudbase/cli",
        version: "3.8.2",
        bin: { tcb: "bin/tcb" },
      }),
      "utf8",
    );
    spawned = false;
    await assert.rejects(
      deployApplicationVersionApi(
        options,
        () => {
          spawned = true;
          throw new Error("must not spawn");
        },
        { deploymentRoot: directory },
      ),
      /must be exactly 3\.8\.1/u,
    );
    assert.equal(spawned, false);

    await writeFile(fixture.cliPackagePath, fixture.cliPackageText, "utf8");
    const calls = [];
    await assert.rejects(
      deployApplicationVersionApi(
        options,
        fakeCloudBaseCliSpawn(calls, "3.8.2"),
        { deploymentRoot: directory },
      ),
      /must report exactly 3\.8\.1/u,
    );
    assert.equal(calls.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "Windows uses the real Node child semantics and ignores a PATH tcb.cmd",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "bifang-real-cmd-deploy-"));
    const pathDirectory = await mkdtemp(join(tmpdir(), "bifang-path-tcb-"));
    try {
      const localCapture = join(
        directory,
        "node_modules",
        "@cloudbase",
        "cli",
        "bin",
        "local-called.txt",
      );
      const pathCapture = join(pathDirectory, "path-called.txt");
      const expectedArgs = [
        "fn",
        "deploy",
        "application-version-api",
        "--force",
        "--config-file",
        "cloudbaserc.example.json",
        "-e",
        ENV_ID,
      ];
      const cliEntry = `const fs = require("node:fs");\nconst args = process.argv.slice(2);\nif (args[0] === "--version") {\n  console.log("CloudBase CLI 3.8.1");\n  console.log("Update hint intentionally ignored");\n} else {\n  const expected = ${JSON.stringify(expectedArgs)};\n  if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(11);\n  if (!process.env.APPLICATION_VERSION_CREDENTIALS_B64) process.exit(12);\n  if (process.env.BIFANG_TEST_UNRELATED_SECRET) process.exit(13);\n  fs.writeFileSync(${JSON.stringify(localCapture)}, "verified\\n");\n}\n`;
      await createDeploymentFixture(directory, { cliEntry });
      await writeFile(
        join(pathDirectory, "tcb.cmd"),
        `@echo off\r\n>"${pathCapture}" echo path-used\r\nexit /b 99\r\n`,
        "utf8",
      );
      const credentialText = credentialsBase64();
      const credentialsFile = join(directory, "credentials.b64");
      await writeFile(credentialsFile, credentialText, "utf8");
      const reviewed = createApplicationVersionDeploymentMaterialsSummary(
        credentialText,
        directory,
      );
      const result = await deployApplicationVersionApi(
        {
          envId: ENV_ID,
          credentialsFile,
          expectedSha256: sha256(credentialText),
          expectedMaterialsSha256: reviewed.sha256,
        },
        spawnChildProcess,
        {
          deploymentRoot: directory,
          environment: {
            ...process.env,
            PATH: `${pathDirectory}${delimiter}${process.env.PATH ?? ""}`,
            BIFANG_TEST_UNRELATED_SECRET: "must-not-reach-child",
          },
        },
      );
      assert.deepEqual(result, { status: "completed", exit_code: 0 });
      assert.equal((await readFile(localCapture, "utf8")).trim(), "verified");
      await assert.rejects(readFile(pathCapture, "utf8"), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(pathDirectory, { recursive: true, force: true });
    }
  },
);

test("the plan rejects credential bindings before the SCF environment reaches 4KB", () => {
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(
        mouseRegistry(),
        credentialsBase64(6),
        {
          envId: ENV_ID,
          origin: ORIGIN,
        },
      ),
    /3840-byte deployment safety limit/,
  );
});
