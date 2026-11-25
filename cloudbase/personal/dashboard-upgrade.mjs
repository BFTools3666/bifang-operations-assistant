import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { matchesUploadedSource } from "./deployed-source.mjs";
import {
  readPrivate,
  writePrivate,
  writePrivateBytes,
  assertPrivate,
  check,
} from "./private-files.mjs";
import { sourceBundle, validateAccessInput, hash } from "./spec.mjs";
import { createPersonalApi, costPreflight } from "./cloud.mjs";
import { variables, DASHBOARD_LABEL_MARKER } from "./shared.mjs";
import {
  createDashboardApplicationMapping,
  validateRegistry,
} from "../generate-cloudbaserc.mjs";
import { validateObservedAppLabels } from "../app-labels.mjs";
const require = createRequire(import.meta.url);
const {
  releaseToken,
} = require("../functions/operations-dashboard/src/release-service.js");
const {
  parseDashboardApps,
} = require("../functions/operations-dashboard/src/handler.js");
const {
  parseApplicationResources,
} = require("../functions/application-version-api/src/repository.js");
const {
  parseCredentials,
} = require("../functions/application-version-api/src/auth.js");

export function upgradeSettings(
  input,
  dashboard,
  version,
  observedLabels = {},
) {
  const envId = input.cloudbase.env_id;
  for (const [fn, name] of [
    [dashboard, "operations-dashboard-api"],
    [version, "application-version-api"],
  ]) {
    check(
      fn?.FunctionName === name &&
        fn.Namespace === envId &&
        fn.Status === "Active" &&
        fn.Handler === "index.main" &&
        fn.Runtime === "Nodejs20.19" &&
        /^personal-onboarding:(?:labels-v1:)?[a-f0-9]{40}$/.test(
          fn.Description,
        ),
      "PERSONAL_FUNCTION_BASELINE_REQUIRED",
    );
  }
  const d = variables(dashboard),
    v = variables(version);
  check(
    d.CLOUDBASE_ENV_ID === envId && v.CLOUDBASE_ENV_ID === envId,
    "ENVIRONMENT_MISMATCH",
  );
  const apps = parseDashboardApps(d.DASHBOARD_APPS_JSON);
  check(apps.length, "INVALID_DASHBOARD_REGISTRY");
  const registered = parseApplicationResources(v.APPLICATION_VERSION_APPS_JSON);
  const creds =
    registered &&
    parseCredentials(
      v.APPLICATION_VERSION_CREDENTIALS_B64,
      registered.map((a) => a.appId),
    );
  check(creds?.length, "INVALID_VERSION_CONFIGURATION");
  const additions = validateRegistry({
    schema_version: 3,
    apps: input.applications.map((a) => ({
      app_id: a.app_id,
      release_streams: a.release_streams,
    })),
  });
  for (const app of additions) {
    const existing = apps.find((a) => a.appId === app.appId);
    if (!existing) {
      apps.push(app);
      continue;
    }
    for (const s of app.releaseStreams) {
      const prior = existing.releaseStreams.find(
        (r) =>
          r.platform === s.platform &&
          r.architecture === s.architecture &&
          r.channel === s.channel,
      );
      check(!prior || prior.code === s.code, "STREAM_CODE_CONFLICT");
      if (!prior) existing.releaseStreams.push(s);
    }
  }
  const mapping = createDashboardApplicationMapping(apps);
  check(
    parseDashboardApps(mapping).length === apps.length,
    "RELEASE_MAPPING_CONFLICT",
  );
  const enabled = apps.flatMap((a) =>
    a.releaseStreams.map((s) => ({ appId: a.appId, code: s.code })),
  );
  check(
    enabled.length &&
      enabled.every((t) =>
        creds.some(
          (c) =>
            c.appId === t.appId &&
            c.codes.has(t.code) &&
            c.scopes.has("versions:write"),
        ),
      ),
    "PREPARE_VERSION_RESOURCES_FIRST",
  );
  const labels = d.DASHBOARD_APP_LABELS_JSON
    ? JSON.parse(d.DASHBOARD_APP_LABELS_JSON)
    : { ...observedLabels };
  for (const a of input.applications) {
    check(
      !Object.hasOwn(labels, a.app_id) ||
        labels[a.app_id] === a.display_name ||
        labels[a.app_id] === a.app_id,
      "EXISTING_NAME_CONFLICT",
    );
    labels[a.app_id] = a.display_name;
  }
  const names = validateObservedAppLabels(
    apps.map((a) => a.appId),
    labels,
  );
  const tokenHash = hash(releaseToken(d.DASHBOARD_ACCESS_TOKEN_SHA256, envId));
  check(
    !v.DASHBOARD_RELEASE_TOKEN_SHA256 ||
      v.DASHBOARD_RELEASE_TOKEN_SHA256 === tokenHash,
    "DASHBOARD_BINDING_CONFLICT",
  );
  function config(fn, vars) {
    check(
      Object.entries(vars).reduce(
        (n, [k, x]) => n + Buffer.byteLength(k) + Buffer.byteLength(x),
        0,
      ) <= 3840,
      "FUNCTION_ENVIRONMENT_TOO_LARGE",
    );
    return {
      Namespace: envId,
      FunctionName: fn.FunctionName,
      Environment: {
        Variables: Object.entries(vars).map(([Key, Value]) => ({ Key, Value })),
      },
    };
  }
  const dashboardConfig = config(dashboard, {
    ...d,
    DASHBOARD_APPS_JSON:
      JSON.stringify(parseDashboardApps(d.DASHBOARD_APPS_JSON)) ===
      JSON.stringify(parseDashboardApps(mapping))
        ? d.DASHBOARD_APPS_JSON
        : JSON.stringify(mapping),
    DASHBOARD_APP_LABELS_JSON: JSON.stringify(names),
  });
  if (!dashboard.Description.startsWith(DASHBOARD_LABEL_MARKER))
    dashboardConfig.Description =
      DASHBOARD_LABEL_MARKER + hash(names).slice(0, 40);
  return {
    labels: names,
    targets: enabled,
    version: config(version, {
      ...v,
      DASHBOARD_RELEASE_TOKEN_SHA256: tokenHash,
    }),
    dashboard: dashboardConfig,
  };
}

export async function prepare(
  args,
  {
    apiFactory = createPersonalApi,
    preflight = costPreflight,
    addressFor = codeAddress,
    backupFor = downloadBackup,
  } = {},
) {
  check(
    args[0] === "--file" &&
      (args.length === 2 || (args.length === 4 && args[2] === "--labels-file")),
    "INVALID_ARGUMENTS",
  );
  const file = resolve(args[1]),
    input = await readPrivate(file),
    target = validateAccessInput(input);
  const api = apiFactory(input);
  await preflight(api, target);
  const get = (name) =>
    api("scf", "GetFunction", {
      Namespace: target.envId,
      FunctionName: name,
      ShowCode: "FALSE",
    });
  const dashboard = await get("operations-dashboard-api"),
    version = await get("application-version-api");
  const material = upgradeSettings(
    input,
    dashboard,
    version,
    args[3] ? await readPrivate(resolve(args[3])) : {},
  );
  const runId = randomUUID(),
    folder = dirname(file),
    functions = [];
  for (const [fn, dir, settings] of [
    [version, "application-version-api", material.version],
    [dashboard, "operations-dashboard", material.dashboard],
  ]) {
    const address = await addressFor(input, fn.FunctionName);
    const backup = await backupFor(address);
    const backupFile = join(folder, dir + "-original-" + runId + ".zip");
    await writePrivateBytes(backupFile, backup);
    const zip = await sourceBundle(
      "cloudbase/functions/" + dir,
      material.labels,
    );
    const path = join(folder, dir + "-" + runId + ".zip");
    await writePrivateBytes(path, zip);
    functions.push({
      function: fn.FunctionName,
      baseline_mod_time: fn.ModTime,
      baseline_environment: fn.Environment,
      baseline_description: fn.Description,
      backup: backupFile,
      baseline_code_sha256: hash(backup),
      zip: path,
      zip_sha256: hash(zip),
      update_code: !matchesUploadedSource(zip, backup),
      update_configuration:
        !sameEnvironment(settings.Environment, fn.Environment) ||
        (settings.Description ?? fn.Description) !== fn.Description,
      settings,
    });
  }
  const manifest = {
    env_id: target.envId,
    region: target.region,
    targets: material.targets,
    functions,
  };
  const plan = join(folder, "dashboard-upgrade-" + runId + ".json");
  await writePrivate(plan, manifest);
  const sha256 = hash(manifest);
  console.log(
    JSON.stringify({
      plan,
      sha256,
      changes: functions.map((f) => ({
        function: f.function,
        update_code: f.update_code,
        update_configuration: f.update_configuration,
      })),
      targets: material.targets,
      cloud_writes: 0,
    }),
  );
  return { plan, sha256 };
}

async function codeAddress(input, name) {
  const op = {
    service: "scf",
    action: "GetFunctionAddress",
    payload: { Namespace: input.cloudbase.env_id, FunctionName: name },
  };
  const result = await createPersonalApi(input, [op])(
    op.service,
    op.action,
    op.payload,
  );
  check(
    /^[0-9a-f]{64}$/i.test(result.CodeSha256 || ""),
    "BASELINE_HASH_REQUIRED",
  );
  return result;
}
async function downloadBackup(address) {
  const u = new URL(address.Url);
  check(
    u.protocol === "https:" &&
      /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(u.hostname),
    "UNEXPECTED_BACKUP_HOST",
  );
  const response = await fetch(u, {
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  check(response.ok, "BACKUP_DOWNLOAD_FAILED");
  let size = 0;
  const chunks = [];
  for await (const b of response.body) {
    size += b.length;
    check(size <= 50000000, "BACKUP_TOO_LARGE");
    chunks.push(b);
  }
  const bytes = Buffer.concat(chunks);
  check(
    hash(bytes) === address.CodeSha256.toLowerCase(),
    "BACKUP_HASH_MISMATCH",
  );
  return bytes;
}
function sameEnvironment(actual, expected) {
  return (
    JSON.stringify(
      Object.entries(variables({ Environment: actual })).sort(),
    ) ===
    JSON.stringify(Object.entries(variables({ Environment: expected })).sort())
  );
}
export async function apply(
  args,
  {
    apiFactory = createPersonalApi,
    preflight = costPreflight,
    addressFor = codeAddress,
    backupFor = downloadBackup,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  check(
    args.length === 6 &&
      args[0] === "--file" &&
      args[2] === "--plan" &&
      args[4] === "--expected-plan",
    "INVALID_ARGUMENTS",
  );
  const inputFile = resolve(args[1]),
    planFile = resolve(args[3]),
    folder = dirname(inputFile);
  check(dirname(planFile) === folder, "PLAN_TARGET_MISMATCH");
  const input = await readPrivate(inputFile),
    plan = await readPrivate(planFile),
    target = validateAccessInput(input);
  check(
    hash(plan) === args[5] &&
      plan.env_id === target.envId &&
      plan.region === target.region &&
      JSON.stringify(plan.functions.map((x) => x.function)) ===
        JSON.stringify(["application-version-api", "operations-dashboard-api"]),
    "PLAN_TARGET_MISMATCH",
  );
  const api = apiFactory(input);
  const get = (name) =>
    api("scf", "GetFunction", {
      Namespace: target.envId,
      FunctionName: name,
      ShowCode: "FALSE",
    });
  async function checkBaseline(f) {
    const fn = await get(f.function);
    check(
      fn.Status === "Active" &&
        fn.ModTime === f.baseline_mod_time &&
        fn.Description === f.baseline_description &&
        sameEnvironment(fn.Environment, f.baseline_environment) &&
        (await addressFor(input, f.function)).CodeSha256.toLowerCase() ===
          f.baseline_code_sha256,
      "CLOUD_BASELINE_CHANGED",
    );
  }
  await preflight(api, target);
  const tasks = [];
  for (const f of plan.functions) {
    check(
      f.settings.Namespace === target.envId &&
        f.settings.FunctionName === f.function &&
        dirname(resolve(f.zip)) === folder &&
        dirname(resolve(f.backup)) === folder,
      "PLAN_TARGET_MISMATCH",
    );
    const zip = await readFile(await assertPrivate(f.zip));
    check(
      hash(zip) === f.zip_sha256 &&
        hash(await readFile(await assertPrivate(f.backup))) ===
          f.baseline_code_sha256,
      "PACKAGE_HASH_MISMATCH",
    );
    await checkBaseline(f);
    const code = {
      Namespace: target.envId,
      FunctionName: f.function,
      Handler: "index.main",
      InstallDependency: "TRUE",
      Publish: "FALSE",
      Code: { ZipFile: zip.toString("base64") },
    };
    tasks.push({ f, code, zip });
  }
  const log = join(folder, "upgrade-" + hash(plan) + ".started.json");
  await writePrivate(log, {
    plan_sha256: hash(plan),
    started_at: new Date().toISOString(),
  });
  const completed = [];
  try {
    for (const { f, code, zip } of tasks) {
      const writes = [];
      if (f.update_code)
        writes.push({
          service: "scf",
          action: "UpdateFunctionCode",
          payload: code,
        });
      if (f.update_configuration)
        writes.push({
          service: "scf",
          action: "UpdateFunctionConfiguration",
          payload: f.settings,
        });
      const write = apiFactory(input, writes);
      await preflight(api, target);
      await checkBaseline(f);
      for (const op of writes) {
        if (op.action === "UpdateFunctionConfiguration") {
          const current = await get(f.function);
          check(
            current.Status === "Active" &&
              current.Description === f.baseline_description &&
              sameEnvironment(current.Environment, f.baseline_environment),
            "CLOUD_BASELINE_CHANGED",
          );
        }
        await write(op.service, op.action, op.payload);
        let seen = false;
        for (let i = 0; i < 25; i++) {
          await sleep(2000);
          const current = await get(f.function);
          check(!/Failed$/.test(current.Status), "FUNCTION_UPDATE_FAILED");
          if (current.Status !== "Active") continue;
          if (op.action === "UpdateFunctionCode") {
            const address = await addressFor(input, f.function);
            seen =
              address.CodeSha256.toLowerCase() === f.zip_sha256 ||
              matchesUploadedSource(zip, await backupFor(address));
          } else
            seen =
              sameEnvironment(current.Environment, f.settings.Environment) &&
              current.Description ===
                (f.settings.Description ?? f.baseline_description);
          if (seen) break;
        }
        check(seen, "UPDATE_READBACK_INCOMPLETE");
        completed.push([f.function, op.action]);
      }
    }
  } finally {
    const receipt = join(folder, "upgrade-" + hash(plan) + ".receipt.json");
    await writePrivate(receipt, {
      completed,
      plan_sha256: hash(plan),
      live_page_verified: false,
    });
    console.log(JSON.stringify({ receipt, completed }));
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  (process.argv[2] === "apply"
    ? apply(process.argv.slice(3))
    : prepare(process.argv.slice(2))
  ).catch((e) => {
    console.error(
      /^[A-Z_]+$/.test(e.message) ? e.message : "UPGRADE_PREPARATION_FAILED",
    );
    process.exitCode = 1;
  });
