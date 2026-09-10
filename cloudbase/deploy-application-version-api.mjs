import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  APPLICATION_VERSION_DEPLOYMENT_CONTROL_FILES,
  APPLICATION_VERSION_DEPLOYMENT_DIRECTORY_TREES,
  APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION,
  createApplicationVersionDeploymentMaterialsSummary,
  normalizeCredentialConfiguration,
  validateApplicationVersionDeploymentInputs,
} from "./plan-application-version-api-deployment.mjs";

const ENV_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_OUTPUT_MAX_BYTES = 4_096;
const VERSION_CHECK_TIMEOUT_MAX_MS = 15_000;
const DEPLOYMENT_TIMEOUT_MAX_MS = 10 * 60_000;
const STAGING_DIRECTORY_PREFIX = "bifang-application-version-api-deploy-";
const MINIMAL_ENVIRONMENT_KEYS = Object.freeze([
  "APPDATA",
  "COMSPEC",
  "HOME",
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

function readEnvironmentValue(environment, name) {
  const normalizedName = name.toUpperCase();
  const entry = Object.entries(environment).find(
    ([key]) => key.toUpperCase() === normalizedName,
  );
  return entry?.[1];
}

function createMinimalEnvironment(environment, additions = {}) {
  const result = {};
  for (const name of MINIMAL_ENVIRONMENT_KEYS) {
    const value = readEnvironmentValue(environment, name);
    if (typeof value === "string" && value.length > 0) result[name] = value;
  }
  return { ...result, ...additions };
}

function createLocalTcbSpawnSpec({
  environment,
  deploymentRoot,
  mode,
  envId,
  credentialText,
}) {
  const additions =
    mode === "deploy"
      ? {
          APPLICATION_VERSION_CREDENTIALS_B64: credentialText,
          NO_UPDATE_NOTIFIER: "1",
        }
      : { NO_UPDATE_NOTIFIER: "1" };
  const childEnvironment = createMinimalEnvironment(environment, additions);
  const cliEntry = resolve(
    deploymentRoot,
    "node_modules",
    "@cloudbase",
    "cli",
    "bin",
    "tcb",
  );
  return {
    command: process.execPath,
    args:
      mode === "deploy"
        ? [
            cliEntry,
            "fn",
            "deploy",
            "application-version-api",
            "--force",
            "--config-file",
            "cloudbaserc.example.json",
            "-e",
            envId,
          ]
        : [cliEntry, "--version"],
    options: {
      cwd: deploymentRoot,
      env: childEnvironment,
      shell: false,
      stdio: mode === "deploy" ? "ignore" : ["ignore", "pipe", "ignore"],
      windowsHide: true,
    },
  };
}

function assertExpectedSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function normalizeTimeout(value, maximum, label) {
  const normalized = value === undefined ? maximum : value;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > maximum
  ) {
    throw new TypeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return normalized;
}

async function createPrivateDeploymentStagingSnapshot(
  credentialText,
  expectedMaterialsSha256,
  deploymentRoot,
) {
  const stagingRoot = await mkdtemp(join(tmpdir(), STAGING_DIRECTORY_PREFIX));
  try {
    for (const path of APPLICATION_VERSION_DEPLOYMENT_CONTROL_FILES) {
      const destination = resolve(stagingRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(resolve(deploymentRoot, path), destination);
    }
    for (const path of APPLICATION_VERSION_DEPLOYMENT_DIRECTORY_TREES) {
      const destination = resolve(stagingRoot, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(resolve(deploymentRoot, path), destination, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    }
    verifyApplicationVersionDeploymentMaterials(
      credentialText,
      expectedMaterialsSha256,
      stagingRoot,
    );
    return stagingRoot;
  } catch (error) {
    await removePrivateDeploymentStagingSnapshot(stagingRoot);
    throw error;
  }
}

async function removePrivateDeploymentStagingSnapshot(stagingRoot) {
  const resolvedStagingRoot = resolve(stagingRoot);
  const resolvedTemporaryRoot = resolve(tmpdir());
  if (
    dirname(resolvedStagingRoot) !== resolvedTemporaryRoot ||
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

export function verifyCredentialConfigurationForDeployment(
  value,
  expectedSha256,
) {
  assertExpectedSha256(expectedSha256, "expected_sha256");
  const normalized = normalizeCredentialConfiguration(value);
  const actualSha256 = createHash("sha256")
    .update(normalized, "utf8")
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new TypeError(
      "credential configuration does not match the reviewed SHA-256",
    );
  }
  return normalized;
}

export function verifyApplicationVersionDeploymentMaterials(
  credentialConfigurationBase64,
  expectedMaterialsSha256,
  deploymentRoot = repositoryRoot,
) {
  assertExpectedSha256(expectedMaterialsSha256, "expected_materials_sha256");
  const summary = createApplicationVersionDeploymentMaterialsSummary(
    credentialConfigurationBase64,
    deploymentRoot,
  );
  if (summary.sha256 !== expectedMaterialsSha256) {
    throw new TypeError(
      "deployment materials do not match the reviewed SHA-256",
    );
  }
  return summary;
}

async function verifyLocalCloudBaseCli(deploymentRoot) {
  const packagePath = resolve(
    deploymentRoot,
    "node_modules",
    "@cloudbase",
    "cli",
    "package.json",
  );
  const cliEntryPath = resolve(
    deploymentRoot,
    "node_modules",
    "@cloudbase",
    "cli",
    "bin",
    "tcb",
  );
  let metadata;
  try {
    metadata = JSON.parse(await readFile(packagePath, "utf8"));
    await access(cliEntryPath);
  } catch {
    throw new TypeError(
      `repository-local @cloudbase/cli ${APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION} is required`,
    );
  }
  if (
    metadata?.name !== "@cloudbase/cli" ||
    metadata?.version !== APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION ||
    metadata?.bin?.tcb !== "bin/tcb"
  ) {
    throw new TypeError(
      `repository-local @cloudbase/cli must be exactly ${APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION}`,
    );
  }
}

function parseLocalCloudBaseCliVersion(output) {
  const firstNonEmptyLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (
    firstNonEmptyLine !==
    `CloudBase CLI ${APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION}`
  ) {
    throw new TypeError(
      `repository-local @cloudbase/cli must report exactly ${APPLICATION_VERSION_DEPLOYMENT_CLI_VERSION}`,
    );
  }
}

async function runLocalCloudBaseCliVersionCheck(
  spawnImplementation,
  spawnSpec,
  timeoutMs,
) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImplementation(
      spawnSpec.command,
      spawnSpec.args,
      spawnSpec.options,
    );
    let output = Buffer.alloc(0);
    let oversized = false;
    let settled = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const terminate = () => {
      try {
        child.kill?.("SIGKILL");
      } catch {
        // The timeout still fails closed even if the host reports that the
        // already-ending child cannot be signalled again.
      }
    };
    const onData = (chunk) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (output.length + data.length > VERSION_OUTPUT_MAX_BYTES) {
        oversized = true;
        terminate();
        return;
      }
      output = Buffer.concat([output, data]);
    };
    const onError = () =>
      settle(() =>
        rejectPromise(
          new Error("unable to start the repository-local CloudBase CLI"),
        ),
      );
    const onClose = (code, signal) =>
      settle(() => {
        if (oversized || code !== 0 || signal !== null || !child.stdout) {
          rejectPromise(
            new Error("unable to verify the repository-local CloudBase CLI"),
          );
          return;
        }
        try {
          parseLocalCloudBaseCliVersion(output.toString("utf8"));
          resolvePromise();
        } catch (error) {
          rejectPromise(error);
        }
      });
    child.stdout?.on("data", onData);
    child.once("error", onError);
    child.once("close", onClose);
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      terminate();
      rejectPromise(
        new Error("repository-local CloudBase CLI version check timed out"),
      );
    }, timeoutMs);
  });
}

function deploymentFailureMessage(code, signal) {
  if (Number.isSafeInteger(code)) {
    return `CloudBase CLI deployment failed with exit code ${code}; raw output was suppressed`;
  }
  if (typeof signal === "string" && /^[A-Z0-9]+$/u.test(signal)) {
    return `CloudBase CLI deployment failed with signal ${signal}; raw output was suppressed`;
  }
  return "CloudBase CLI deployment failed; raw output was suppressed";
}

async function runLocalCloudBaseCliDeployment(
  spawnImplementation,
  spawnSpec,
  timeoutMs,
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImplementation(
      spawnSpec.command,
      spawnSpec.args,
      spawnSpec.options,
    );
    let settled = false;
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onError = () =>
      settle(() =>
        rejectPromise(new Error("unable to start the CloudBase CLI")),
      );
    const onClose = (code, signal) =>
      settle(() => {
        if (code === 0 && signal === null) {
          resolvePromise({ status: "completed", exit_code: 0 });
        } else {
          rejectPromise(new Error(deploymentFailureMessage(code, signal)));
        }
      });
    child.once("error", onError);
    child.once("close", onClose);
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        child.kill?.("SIGKILL");
      } catch {
        // A timeout is already a terminal failure; never surface raw child
        // details while attempting the final termination signal.
      }
      rejectPromise(
        new Error(
          "CloudBase CLI deployment timed out; raw output was suppressed",
        ),
      );
    }, timeoutMs);
  });
}

export async function deployApplicationVersionApi(
  { envId, credentialsFile, expectedSha256, expectedMaterialsSha256 },
  spawnImplementation = spawn,
  {
    deploymentRoot = repositoryRoot,
    environment = process.env,
    versionTimeoutMs,
    deploymentTimeoutMs,
  } = {},
) {
  if (typeof envId !== "string" || !ENV_ID_PATTERN.test(envId)) {
    throw new TypeError("env_id must be a plain CloudBase environment id");
  }
  const credentialText = verifyCredentialConfigurationForDeployment(
    await readFile(credentialsFile, "utf8"),
    expectedSha256,
  );
  verifyApplicationVersionDeploymentMaterials(
    credentialText,
    expectedMaterialsSha256,
    deploymentRoot,
  );
  const normalizedVersionTimeout = normalizeTimeout(
    versionTimeoutMs,
    VERSION_CHECK_TIMEOUT_MAX_MS,
    "version_timeout_ms",
  );
  const normalizedDeploymentTimeout = normalizeTimeout(
    deploymentTimeoutMs,
    DEPLOYMENT_TIMEOUT_MAX_MS,
    "deployment_timeout_ms",
  );
  const stagingRoot = await createPrivateDeploymentStagingSnapshot(
    credentialText,
    expectedMaterialsSha256,
    deploymentRoot,
  );
  let operationFailed = false;
  try {
    const registry = JSON.parse(
      await readFile(resolve(stagingRoot, "cloudbase", "apps.json"), "utf8"),
    );
    validateApplicationVersionDeploymentInputs(registry, credentialText, {
      envId,
    });
    await verifyLocalCloudBaseCli(stagingRoot);
    await runLocalCloudBaseCliVersionCheck(
      spawnImplementation,
      createLocalTcbSpawnSpec({
        environment,
        deploymentRoot: stagingRoot,
        mode: "version",
      }),
      normalizedVersionTimeout,
    );
    verifyApplicationVersionDeploymentMaterials(
      credentialText,
      expectedMaterialsSha256,
      stagingRoot,
    );
    return await runLocalCloudBaseCliDeployment(
      spawnImplementation,
      createLocalTcbSpawnSpec({
        environment,
        deploymentRoot: stagingRoot,
        mode: "deploy",
        envId,
        credentialText,
      }),
      normalizedDeploymentTimeout,
    );
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await removePrivateDeploymentStagingSnapshot(stagingRoot);
    } catch {
      throw new Error(
        operationFailed
          ? "application-version deployment failed and private staging cleanup also failed"
          : "unable to remove private deployment staging snapshot",
      );
    }
  }
}

function parseArguments(args) {
  if (
    args.length !== 8 ||
    args[0] !== "--env-id" ||
    args[2] !== "--credentials-b64-file" ||
    args[4] !== "--expected-sha256" ||
    args[6] !== "--expected-materials-sha256"
  ) {
    throw new TypeError(
      "usage: node cloudbase/deploy-application-version-api.mjs --env-id <env_id> --credentials-b64-file <untracked_path> --expected-sha256 <reviewed_credential_sha256> --expected-materials-sha256 <reviewed_materials_sha256>",
    );
  }
  return {
    envId: args[1],
    credentialsFile: resolve(args[3]),
    expectedSha256: args[5],
    expectedMaterialsSha256: args[7],
  };
}

async function main() {
  await deployApplicationVersionApi(parseArguments(process.argv.slice(2)));
  process.stdout.write(
    "application-version-api deployment command completed; run the reviewed post-write verification\n",
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
