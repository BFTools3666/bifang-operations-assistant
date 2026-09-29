import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const APP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLOUD_BASE_CLI_VERSION = "3.8.1";
const FUNCTION_NAME = "operations-dashboard-api";
const STAGING_DIRECTORY_PREFIX = "bifang-operations-dashboard-deploy-";
const DEPLOYMENT_TIMEOUT_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 15_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CONTROL_FILES = Object.freeze([
  "cloudbase/apps.json",
  "cloudbase/deploy-operations-dashboard.mjs",
  "cloudbase/generate-cloudbaserc.mjs",
  "cloudbase/verify-operations-dashboard.mjs",
  "cloudbaserc.example.json",
  "package-lock.json",
  "package.json",
]);
const DIRECTORY_TREES = Object.freeze([
  "cloudbase/functions/operations-dashboard",
  "node_modules/@cloudbase/cli",
]);
const MINIMAL_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
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

export function parseSecretFile(source) {
  if (typeof source !== "string") {
    throw new TypeError("secret file must contain UTF-8 text");
  }
  const values = new Map();
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) {
      throw new TypeError(`secret file line ${index + 1} is malformed`);
    }
    if (values.has(match[1])) {
      throw new TypeError(`secret file repeats ${match[1]}`);
    }
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  const metricsToken = values.get("CLOUDBASE_METRICS_TOKEN") || "";
  const accessToken = values.get("DASHBOARD_ACCESS_TOKEN") || "";
  for (const [name, value] of [
    ["CLOUDBASE_METRICS_TOKEN", metricsToken],
    ["DASHBOARD_ACCESS_TOKEN", accessToken],
  ]) {
    const length = Buffer.byteLength(value, "utf8");
    if (length < 32 || length > 256) {
      throw new TypeError(`${name} must contain 32-256 UTF-8 bytes`);
    }
  }
  if (metricsToken === accessToken) {
    throw new TypeError("dashboard tokens must be distinct");
  }
  return {
    metricsTokenHash: sha256(metricsToken),
    accessTokenHash: sha256(accessToken),
    metricsTokenBytes: Buffer.byteLength(metricsToken, "utf8"),
    accessTokenBytes: Buffer.byteLength(accessToken, "utf8"),
  };
}

export async function createDeploymentMaterialsSummary(
  secretConfiguration,
  deploymentRoot = repositoryRoot,
  appIds,
) {
  assertSecretConfiguration(secretConfiguration);
  const normalizedAppIds = normalizeAppIds(appIds);
  const relativePaths = [...CONTROL_FILES];
  for (const directory of DIRECTORY_TREES) {
    relativePaths.push(
      ...(await listFiles(resolve(deploymentRoot, directory))).map((path) =>
        relative(deploymentRoot, path).replaceAll("\\", "/"),
      ),
    );
  }
  relativePaths.sort();
  const digest = createHash("sha256");
  digest.update("bifang-operations-dashboard-deployment-v1\0", "utf8");
  digest.update(
    normalizedAppIds === undefined
      ? "all-registered-apps"
      : normalizedAppIds.join(","),
    "utf8",
  );
  digest.update("\0", "utf8");
  digest.update(secretConfiguration.metricsTokenHash, "utf8");
  digest.update("\0", "utf8");
  digest.update(secretConfiguration.accessTokenHash, "utf8");
  digest.update("\0", "utf8");
  let totalBytes = 0;
  for (const path of relativePaths) {
    const body = await readFile(resolve(deploymentRoot, path));
    totalBytes += body.byteLength;
    digest.update(path, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(body.byteLength), "utf8");
    digest.update("\0", "utf8");
    digest.update(body);
    digest.update("\0", "utf8");
  }
  return {
    schema_version: 1,
    sha256: digest.digest("hex"),
    files: relativePaths.length,
    bytes: totalBytes,
    cli_version: CLOUD_BASE_CLI_VERSION,
    app_ids: normalizedAppIds ?? "all-registered-apps",
  };
}

export async function createDeploymentPlan({ envId, secretFile, appIds }) {
  assertEnvId(envId);
  const normalizedAppIds = normalizeAppIds(appIds);
  const secretConfiguration = parseSecretFile(
    await readFile(secretFile, "utf8"),
  );
  const materials = await createDeploymentMaterialsSummary(
    secretConfiguration,
    repositoryRoot,
    normalizedAppIds,
  );
  return {
    schema_version: 1,
    mode: "operations-dashboard-cloudbase-web-preview",
    requires_confirmation: true,
    env_id: envId,
    app_scope: normalizedAppIds ?? "all-registered-apps",
    function: {
      action: "update-in-place",
      name: FUNCTION_NAME,
      runtime: "Nodejs20.19",
      timeout_seconds: 3,
      memory_mb: 256,
      environment_keys: [
        "CLOUDBASE_ENV_ID",
        "DASHBOARD_ACCESS_TOKEN_SHA256",
        "DASHBOARD_APPS_JSON",
        "DASHBOARD_PATH",
        "DASHBOARD_TOKEN_SHA256",
        "DASHBOARD_WEB_PATH",
      ],
    },
    route: {
      action: "create-after-separate-live-preflight",
      path: "/dashboard",
      target: `function:${FUNCTION_NAME}`,
      enable_auth: false,
      enable_path_transmission: true,
      qps_total: 100,
      qps_per_client_ip: 10,
    },
    raw_secret_uploads: 0,
    token_checks: {
      metrics_token_bytes: secretConfiguration.metricsTokenBytes,
      access_token_bytes: secretConfiguration.accessTokenBytes,
      distinct: true,
    },
    materials,
    deletes: [],
    excluded: [
      "all database collections and records",
      "telemetry functions and routes",
      "application-version function and route",
      "the existing /admin/v1/metrics route",
      "plans, billing, domains and certificates",
    ],
  };
}

export async function deployOperationsDashboard(
  { envId, secretFile, expectedMaterialsSha256, appIds },
  spawnImplementation = spawn,
  { deploymentRoot = repositoryRoot, environment = process.env } = {},
) {
  assertEnvId(envId);
  assertSha256(expectedMaterialsSha256, "expected materials SHA-256");
  const normalizedAppIds = normalizeAppIds(appIds);
  const secretConfiguration = parseSecretFile(
    await readFile(secretFile, "utf8"),
  );
  const before = await createDeploymentMaterialsSummary(
    secretConfiguration,
    deploymentRoot,
    normalizedAppIds,
  );
  if (before.sha256 !== expectedMaterialsSha256) {
    throw new TypeError(
      "deployment materials do not match the reviewed SHA-256",
    );
  }

  const stagingRoot = await createStagingSnapshot(
    deploymentRoot,
    secretConfiguration,
    expectedMaterialsSha256,
    normalizedAppIds,
  );
  let operationFailed = false;
  try {
    await verifyCli(stagingRoot, spawnImplementation, environment);
    await runDeployment({
      envId,
      secretConfiguration,
      spawnImplementation,
      stagingRoot,
      environment,
    });
    return { status: "completed", function: FUNCTION_NAME };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await removeStagingSnapshot(stagingRoot);
    } catch {
      throw new Error(
        operationFailed
          ? "dashboard deployment failed and staging cleanup also failed"
          : "unable to remove dashboard deployment staging snapshot",
      );
    }
  }
}

async function createStagingSnapshot(
  deploymentRoot,
  secretConfiguration,
  expectedMaterialsSha256,
  appIds,
) {
  const stagingRoot = await mkdtemp(join(tmpdir(), STAGING_DIRECTORY_PREFIX));
  try {
    for (const path of CONTROL_FILES) {
      const source = resolve(deploymentRoot, path);
      const destination = resolve(stagingRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { errorOnExist: true, force: false });
    }
    for (const path of DIRECTORY_TREES) {
      const source = resolve(deploymentRoot, path);
      const destination = resolve(stagingRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    }
    const staged = await createDeploymentMaterialsSummary(
      secretConfiguration,
      stagingRoot,
      appIds,
    );
    if (staged.sha256 !== expectedMaterialsSha256) {
      throw new TypeError("staged deployment materials changed unexpectedly");
    }
    const fullConfig = JSON.parse(
      await readFile(resolve(stagingRoot, "cloudbaserc.example.json"), "utf8"),
    );
    const dashboardFunction = fullConfig.functions?.find(
      ({ name }) => name === FUNCTION_NAME,
    );
    if (!dashboardFunction) {
      throw new TypeError("generated config is missing the dashboard function");
    }
    filterDashboardAppsEnvironment(dashboardFunction, appIds);
    const minimalConfig = { ...fullConfig, functions: [dashboardFunction] };
    delete minimalConfig.gateway;
    await writeFile(
      resolve(stagingRoot, "cloudbaserc.dashboard.json"),
      `${JSON.stringify(minimalConfig, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return stagingRoot;
  } catch (error) {
    await removeStagingSnapshot(stagingRoot);
    throw error;
  }
}

export function filterDashboardAppsEnvironment(dashboardFunction, appIds) {
  const normalizedAppIds = normalizeAppIds(appIds);
  if (normalizedAppIds === undefined) return dashboardFunction;
  const encodedApps = dashboardFunction?.envVariables?.DASHBOARD_APPS_JSON;
  if (typeof encodedApps !== "string") {
    throw new TypeError("dashboard function is missing DASHBOARD_APPS_JSON");
  }
  let mapping;
  try {
    mapping = JSON.parse(JSON.parse(encodedApps));
  } catch {
    throw new TypeError("dashboard application mapping is malformed");
  }
  const compact =
    mapping &&
    typeof mapping === "object" &&
    !Array.isArray(mapping) &&
    mapping.schema_version === 2 &&
    Object.keys(mapping).sort().join(",") === "apps,schema_version" &&
    Array.isArray(mapping.apps);
  const apps = compact ? mapping.apps : mapping;
  if (!Array.isArray(apps)) {
    throw new TypeError("dashboard application mapping must contain apps");
  }
  const requested = new Set(normalizedAppIds);
  const readAppId = (item) => (compact ? item?.[0] : item?.appId);
  const filtered = apps.filter((item) => requested.has(readAppId(item)));
  const found = new Set(filtered.map(readAppId));
  const missing = normalizedAppIds.filter((appId) => !found.has(appId));
  if (missing.length > 0) {
    throw new TypeError(
      `dashboard application mapping is missing: ${missing.join(", ")}`,
    );
  }
  const filteredMapping = compact ? { ...mapping, apps: filtered } : filtered;
  dashboardFunction.envVariables.DASHBOARD_APPS_JSON = JSON.stringify(
    JSON.stringify(filteredMapping),
  );
  return dashboardFunction;
}

async function verifyCli(stagingRoot, spawnImplementation, environment) {
  const packageMetadata = JSON.parse(
    await readFile(
      resolve(stagingRoot, "node_modules/@cloudbase/cli/package.json"),
      "utf8",
    ),
  );
  const cliEntry = resolve(stagingRoot, "node_modules/@cloudbase/cli/bin/tcb");
  await access(cliEntry);
  if (
    packageMetadata.name !== "@cloudbase/cli" ||
    packageMetadata.version !== CLOUD_BASE_CLI_VERSION
  ) {
    throw new TypeError(
      `repository-local @cloudbase/cli must be ${CLOUD_BASE_CLI_VERSION}`,
    );
  }
  const result = await runChild(
    spawnImplementation,
    {
      command: process.execPath,
      args: [cliEntry, "--version"],
      options: {
        cwd: stagingRoot,
        env: createMinimalEnvironment(environment, {
          NO_UPDATE_NOTIFIER: "1",
        }),
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    },
    VERSION_TIMEOUT_MS,
    true,
  );
  if (!result.includes(`CloudBase CLI ${CLOUD_BASE_CLI_VERSION}`)) {
    throw new TypeError("unable to verify repository-local CloudBase CLI");
  }
}

async function runDeployment({
  envId,
  secretConfiguration,
  spawnImplementation,
  stagingRoot,
  environment,
}) {
  const cliEntry = resolve(stagingRoot, "node_modules/@cloudbase/cli/bin/tcb");
  await runChild(
    spawnImplementation,
    {
      command: process.execPath,
      args: [
        cliEntry,
        "fn",
        "deploy",
        FUNCTION_NAME,
        "--force",
        "--config-file",
        "cloudbaserc.dashboard.json",
        "-e",
        envId,
      ],
      options: {
        cwd: stagingRoot,
        env: createMinimalEnvironment(environment, {
          DASHBOARD_ACCESS_TOKEN_SHA256: secretConfiguration.accessTokenHash,
          DASHBOARD_TOKEN_SHA256: secretConfiguration.metricsTokenHash,
          NO_UPDATE_NOTIFIER: "1",
        }),
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    },
    DEPLOYMENT_TIMEOUT_MS,
    false,
  );
}

function runChild(spawnImplementation, spawnSpec, timeoutMs, captureOutput) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImplementation(
      spawnSpec.command,
      spawnSpec.args,
      spawnSpec.options,
    );
    const output = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill?.("SIGKILL");
      } catch {
        // Timeout is already a terminal failure.
      }
      rejectPromise(new Error("CloudBase CLI operation timed out"));
    }, timeoutMs);
    if (captureOutput) {
      child.stdout?.on("data", (chunk) => {
        if (Buffer.concat(output).byteLength < 4_096) output.push(chunk);
      });
    }
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(
        new Error("unable to start repository-local CloudBase CLI"),
      );
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0 || signal !== null) {
        rejectPromise(
          new Error(
            Number.isSafeInteger(code)
              ? `CloudBase CLI operation failed with exit code ${code}; raw output suppressed`
              : "CloudBase CLI operation failed; raw output suppressed",
          ),
        );
        return;
      }
      resolvePromise(
        captureOutput ? Buffer.concat(output).toString("utf8") : "",
      );
    });
  });
}

async function listFiles(root) {
  const rootStats = await stat(root);
  if (!rootStats.isDirectory())
    throw new TypeError(`${root} is not a directory`);
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError(
        `deployment materials contain a symbolic link: ${path}`,
      );
    }
    if (entry.isDirectory()) result.push(...(await listFiles(path)));
    else if (entry.isFile()) result.push(path);
    else
      throw new TypeError(
        `deployment materials contain an unsupported entry: ${path}`,
      );
  }
  return result;
}

async function removeStagingSnapshot(stagingRoot) {
  const resolvedStagingRoot = resolve(stagingRoot);
  if (
    dirname(resolvedStagingRoot) !== resolve(tmpdir()) ||
    !basename(resolvedStagingRoot).startsWith(STAGING_DIRECTORY_PREFIX)
  ) {
    throw new TypeError("refusing to remove an unexpected staging directory");
  }
  await rm(resolvedStagingRoot, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

function createMinimalEnvironment(environment, additions) {
  const result = {};
  for (const name of MINIMAL_ENVIRONMENT_KEYS) {
    const value = Object.entries(environment).find(
      ([key]) => key.toUpperCase() === name,
    )?.[1];
    if (typeof value === "string" && value.length > 0) result[name] = value;
  }
  return { ...result, ...additions };
}

function assertSecretConfiguration(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !SHA256_PATTERN.test(value.metricsTokenHash) ||
    !SHA256_PATTERN.test(value.accessTokenHash)
  ) {
    throw new TypeError("dashboard secret configuration is invalid");
  }
}

function assertEnvId(value) {
  if (typeof value !== "string" || !ENV_ID_PATTERN.test(value)) {
    throw new TypeError("env id is invalid");
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

function normalizeAppIds(value) {
  if (value === undefined) return undefined;
  const values = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  if (
    values.length === 0 ||
    values.some((appId) => !APP_ID_PATTERN.test(appId)) ||
    new Set(values).size !== values.length
  ) {
    throw new TypeError("dashboard app ids are invalid");
  }
  return [...values];
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseArguments(args) {
  const mode = args[0];
  if (!["plan", "deploy"].includes(mode)) {
    throw new TypeError("first argument must be plan or deploy");
  }
  const values = new Map();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key)) {
      throw new TypeError("dashboard deployment arguments are malformed");
    }
    values.set(key, value);
  }
  const expectedKeys =
    mode === "plan"
      ? ["--env-id", "--secret-file"]
      : ["--env-id", "--expected-materials-sha256", "--secret-file"];
  const allowedKeys = [...expectedKeys, "--app-ids"];
  if (
    values.size < expectedKeys.length ||
    values.size > allowedKeys.length ||
    [...values.keys()].some((key) => !allowedKeys.includes(key)) ||
    expectedKeys.some((key) => !values.has(key))
  ) {
    throw new TypeError(
      `usage: node cloudbase/deploy-operations-dashboard.mjs ${mode} --env-id <env_id> --secret-file <ignored_env_file>${
        mode === "deploy"
          ? " --expected-materials-sha256 <reviewed_sha256>"
          : ""
      } [--app-ids <comma_separated_app_ids>]`,
    );
  }
  return {
    mode,
    envId: values.get("--env-id"),
    secretFile: resolve(values.get("--secret-file")),
    expectedMaterialsSha256: values.get("--expected-materials-sha256"),
    appIds: values.has("--app-ids")
      ? normalizeAppIds(values.get("--app-ids"))
      : undefined,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "plan") {
    process.stdout.write(
      `${JSON.stringify(await createDeploymentPlan(options), null, 2)}\n`,
    );
    return;
  }
  await deployOperationsDashboard(options);
  process.stdout.write(
    "operations-dashboard-api deployment completed; run reviewed post-write verification\n",
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
