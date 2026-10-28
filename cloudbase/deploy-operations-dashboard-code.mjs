import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateAppLabelCoverage } from "./app-labels.mjs";
import {
  createDashboardApplicationMapping,
  validateRegistry,
} from "./generate-cloudbaserc.mjs";
import {
  createTencentCloudClient,
  readTencentCredentials,
} from "./tencent-cloud-api.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTION = "operations-dashboard-api";
const SOURCE = "cloudbase/functions/operations-dashboard";
const CONTROL = [
  "cloudbase/deploy-operations-dashboard-code.mjs",
  "cloudbase/tencent-cloud-api.mjs",
  "cloudbase/app-labels.mjs",
  "cloudbase/generate-cloudbaserc.mjs",
  "cloudbase/apps.json",
  "package.json",
  "package-lock.json",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const PRESERVED_FUNCTION_FIELDS = [
  "FunctionId",
  "Description",
  "Timeout",
  "InitTimeout",
  "MemorySize",
  "Runtime",
  "VpcConfig",
  "Handler",
  "UseGpu",
  "Role",
  "FunctionName",
  "Namespace",
  "L5Enable",
  "DnsCache",
  "EipConfig",
  "Layers",
  "DeadLetterConfig",
  "OnsEnable",
  "NodeType",
  "NodeSpec",
  "SFType",
  "PublicNetConfig",
  "DeployMode",
  "ProtocolType",
  "OverClockConfig",
  "DiskSize",
  "CpuSize",
  "Triggers",
  "ResourceId",
  "ClsLogsetId",
  "ClsTopicId",
  "LogFormat",
  "Tags",
  "Type",
  "CfsConfig",
  "CosFsConfig",
  "GooseFsConfigs",
  "AsyncRunEnable",
  "TraceEnable",
  "LogType",
  "IgnoreSysLog",
  "ProtocolParams",
  "ImageConfig",
  "ApmConfig",
  "InstanceConcurrencyConfig",
  "IntranetConfig",
  "Plugins",
  "ClusterName",
];

// A deterministic ZIP32 with stored entries. The small source bundle does not
// need compression, external executables, or a dependency on the deployment CLI.
export function createSourceZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, body } of entries) {
    assert(
      /^[a-zA-Z0-9_./-]+$/.test(name) &&
        !name.startsWith("/") &&
        !name.split("/").includes(".."),
      "unsafe ZIP entry",
    );
    const filename = Buffer.from(name);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, body);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(offset, 42);
    central.push(record, filename);
    offset += header.length + filename.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, directory, end]);
  assert(zip.length < 1_500_000, "source ZIP exceeds direct upload limit");
  return zip;
}

async function sourceEntries(root) {
  const entries = [];
  async function visit(name) {
    const path = resolve(root, SOURCE, name);
    const stats = await lstat(path);
    assert(!stats.isSymbolicLink(), "symbolic links cannot be deployed");
    if (stats.isDirectory()) {
      for (const child of (await readdir(path)).sort()) {
        await visit(`${name}/${child}`);
      }
      return;
    }
    assert(
      stats.isFile() && /\.(?:js|json|html|css)$/.test(name),
      "unexpected dashboard source file",
    );
    entries.push({ name, body: await readFile(path) });
  }
  for (const name of ["index.js", "package.json", "public", "src"]) {
    await visit(name);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizedMapping(mapping) {
  assert(
    mapping?.schema_version === 2 && Array.isArray(mapping.apps),
    "live dashboard mapping is incompatible",
  );
  return mapping.apps
    .map(([appId, streams]) => [appId, streams.map((s) => s.join("|")).sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function decodeMapping(value) {
  try {
    let mapping = JSON.parse(value);
    if (typeof mapping === "string") mapping = JSON.parse(mapping);
    return normalizedMapping(mapping);
  } catch {
    throw new Error("live dashboard mapping cannot be decoded");
  }
}

export function validateCloudState({
  envId,
  region,
  domain,
  applications,
  env,
  fn,
  billing,
  route,
  functions,
  quota,
  usage,
}) {
  assert(
    env.EnvId === envId && env.Region === region && env.Status === "NORMAL",
    "target environment is unavailable or differs from the preview",
  );
  assert(
    env.PackageId === "baas_trial" &&
      billing.PackageId === "baas_trial" &&
      billing.Status === "NORMAL" &&
      billing.PayMode === "PREPAYMENT" &&
      billing.IsAutoRenew === false &&
      billing.EnableOverrun === false &&
      Array.isArray(billing.ExtPackageCode) &&
      billing.ExtPackageCode.length === 0 &&
      !billing.TipList &&
      Object.values(billing.OrderInfo || {}).every((v) => !v),
    "free-plan billing gate failed; no write is permitted",
  );
  assert(
    Number.isFinite(quota) &&
      quota > 0 &&
      Number.isFinite(usage.DeductValue) &&
      usage.DeductValue >= 0 &&
      usage.DeductValue < quota &&
      usage.PackageDeductValue === 0 &&
      usage.ReportValue === 0,
    "resource quota or overage gate failed; no write is permitted",
  );
  assert(
    fn.FunctionName === FUNCTION &&
      fn.Namespace === envId &&
      fn.Status === "Active" &&
      fn.Type === "Event" &&
      fn.Runtime === "Nodejs20.19" &&
      fn.Handler === "index.main" &&
      fn.Timeout === 3 &&
      fn.MemorySize === 256,
    "dashboard function differs from its reviewed configuration",
  );
  const variables = [...(fn.Environment?.Variables || [])].sort((a, b) =>
    a.Key.localeCompare(b.Key),
  );
  const values = Object.fromEntries(variables.map((v) => [v.Key, v.Value]));
  assert(
    values.CLOUDBASE_ENV_ID === envId &&
      values.DASHBOARD_PATH === "/admin/v1/metrics" &&
      values.DASHBOARD_WEB_PATH === "/dashboard" &&
      /^[a-f0-9]{64}$/.test(values.DASHBOARD_TOKEN_SHA256 || "") &&
      /^[a-f0-9]{64}$/.test(values.DASHBOARD_ACCESS_TOKEN_SHA256 || "") &&
      values.DASHBOARD_TOKEN_SHA256 !== values.DASHBOARD_ACCESS_TOKEN_SHA256,
    "existing dashboard authentication configuration is incomplete",
  );
  assert(
    same(
      decodeMapping(values.DASHBOARD_APPS_JSON),
      normalizedMapping(createDashboardApplicationMapping(applications)),
    ),
    "live application inventory differs from the local name catalog",
  );
  assert(
    route.TotalCount === 1 && route.Domains?.length === 1,
    "default-domain route inventory is incomplete",
  );
  const d = route.Domains[0];
  assert(
    d.Domain === domain &&
      d.IsDefault === true &&
      d.Enable === true &&
      d.Status === "SUCCESS" &&
      d.DNSStatus === "OK",
    "default HTTPS domain is not healthy",
  );
  const expected = [
    ["/admin/v1/metrics", FUNCTION, 2],
    ["/dashboard", FUNCTION, 10],
    ["/tools/version-control/v1", "application-version-api", 10],
    ...applications.map(({ appId }) => [
      `/apps/${appId}/v1/track`,
      `telemetry-${appId}`,
      10,
    ]),
  ];
  assert(d.Routes?.length === expected.length, "unexpected route inventory");
  for (const [path, target, clientLimit] of expected) {
    const routes = d.Routes.filter((r) => r.Path === path);
    const r = routes[0];
    assert(
      routes.length === 1 &&
        r.UpstreamResourceName === target &&
        r.UpstreamResourceType === "SCF" &&
        r.Enable === true &&
        r.EnableAuth === false &&
        r.EnablePathTransmission === true &&
        r.QPSPolicy?.QPSTotal === 100 &&
        r.QPSPolicy?.QPSPerClient?.LimitBy === "ClientIP" &&
        r.QPSPolicy?.QPSPerClient?.LimitValue === clientLimit,
      "an existing route differs from the reviewed configuration",
    );
  }
  const expectedFunctions = [...new Set(expected.map((r) => r[1]))].sort();
  assert(
    same(functions.map((f) => f.FunctionName).sort(), expectedFunctions) &&
      functions.every((f) => f.Status === "Active"),
    "function inventory is incomplete or unhealthy",
  );
  return {
    // This digest binds the preserved values without exposing either auth hash.
    preservedStateSha256: sha256(
      JSON.stringify({
        variables,
        configuration: Object.fromEntries(
          PRESERVED_FUNCTION_FIELDS.map((k) => [k, fn[k]]),
        ),
        domain: d.Domain,
        routes: [...d.Routes].sort((a, b) => a.Path.localeCompare(b.Path)),
      }),
    ),
    functionId: fn.FunctionId,
    routeCount: d.Routes.length,
    functionCount: functions.length,
    quota,
    usedCredits: usage.DeductValue,
    expireTime: billing.ExpireTime,
  };
}

async function inspect({ envId, region, origin, api, root = ROOT }) {
  assert(/^[a-z0-9][a-z0-9-]{0,127}$/.test(envId), "invalid environment ID");
  assert(region === "ap-shanghai", "this deployment is restricted to Shanghai");
  const url = new URL(origin);
  assert(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      url.hostname.startsWith(`${envId}-`) &&
      url.hostname.endsWith(`.${region}.app.tcloudbase.com`),
    "invalid default-domain origin",
  );
  const registry = JSON.parse(
    await readFile(resolve(root, "cloudbase/apps.json"), "utf8"),
  );
  const applications = validateRegistry(registry);
  const labels = JSON.parse(
    await readFile(resolve(root, SOURCE, "src/app-labels.json"), "utf8"),
  );
  validateAppLabelCoverage(registry, labels);
  const entries = await sourceEntries(root);
  const zip = createSourceZip(entries);
  const [environments, fn, billingInfo, route, circle, packages, address] =
    await Promise.all([
      api("tcb", "DescribeEnvs", { EnvId: envId }),
      api("scf", "GetFunction", {
        FunctionName: FUNCTION,
        Namespace: envId,
        ShowCode: "FALSE",
      }),
      api("tcb", "DescribeBillingInfo", { EnvId: envId }),
      api("tcb", "DescribeHTTPServiceRoute", {
        EnvId: envId,
        Filters: [{ Name: "Domain", Values: [url.hostname] }],
        Limit: 100,
        Offset: 0,
      }),
      api("tcb", "DescribeEnvAccountCircle", { EnvId: envId }),
      api("tcb", "DescribeBaasPackageList", {
        PaymentChannel: "qcloud",
        PackageTypeList: ["default", "vip", "basic", "trial"],
      }),
      api("scf", "GetFunctionAddress", {
        FunctionName: FUNCTION,
        Namespace: envId,
        Qualifier: "$LATEST",
      }),
    ]);
  const startDate = circle.StartTime?.slice(0, 10);
  const endDate = circle.EndTime?.slice(0, 10);
  assert(
    /^\d{4}-\d{2}-\d{2}$/.test(startDate) &&
      /^\d{4}-\d{2}-\d{2}$/.test(endDate),
    "billing cycle is unavailable",
  );
  const usage = await api("tcb", "DescribeCreditsUsage", {
    EnvId: envId,
    StartDate: startDate,
    EndDate: endDate,
  });
  const functions = [];
  let functionTotal;
  for (let offset = 0; offset < 1000; offset += 20) {
    const page = await api("scf", "ListFunctions", {
      Namespace: envId,
      Limit: 20,
      Offset: offset,
    });
    functionTotal = page.TotalCount;
    functions.push(...(page.Functions || []));
    if (functions.length >= functionTotal || !page.Functions?.length) break;
  }
  assert(
    functions.length === functionTotal &&
      new Set(functions.map((f) => f.FunctionName)).size === functionTotal,
    "function pagination is incomplete",
  );
  const selected = packages.PackageList?.filter(
    (p) => p.PackageName === "baas_trial",
  );
  assert(selected?.length === 1, "current package quota cannot be identified");
  const quota = Number(JSON.parse(selected[0].ResourceLimit).Credits?.MaxSize);
  const envs = environments.EnvList?.filter((e) => e.EnvId === envId);
  const bills = billingInfo.EnvBillingInfoList?.filter(
    (b) => b.EnvId === envId,
  );
  assert(
    envs?.length === 1 && bills?.length === 1,
    "target environment is ambiguous",
  );
  const state = validateCloudState({
    envId,
    region,
    domain: url.hostname,
    applications,
    env: envs[0],
    fn,
    billing: bills[0],
    route,
    functions,
    quota,
    usage,
  });
  assert(
    /^[a-f0-9]{64}$/i.test(address.CodeSha256 || ""),
    "existing code digest is unavailable",
  );
  const controls = [];
  for (const path of CONTROL)
    controls.push([path, sha256(await readFile(resolve(root, path)))]);
  const binding = {
    envId,
    region,
    origin: url.origin,
    codeSha256: sha256(zip),
    baselineCodeSha256: address.CodeSha256.toLowerCase(),
    preservedStateSha256: state.preservedStateSha256,
    controls,
  };
  const plan = {
    schema_version: 1,
    action: "update-function-code-only",
    env_id: envId,
    region,
    function: FUNCTION,
    function_id: state.functionId,
    application_count: applications.length,
    release_stream_count: applications.reduce(
      (n, a) => n + a.releaseStreams.length,
      0,
    ),
    desired_app_labels: labels,
    source_file_count: entries.length,
    source_zip_bytes: zip.length,
    source_zip_sha256: binding.codeSha256,
    baseline_code_sha256: binding.baselineCodeSha256,
    preserved_state_sha256: state.preservedStateSha256,
    function_count: state.functionCount,
    preserved_route_count: state.routeCount,
    configuration_action: "preserve-all-existing-values",
    billing: {
      package_id: "baas_trial",
      expire_time: state.expireTime,
      auto_renew: false,
      enable_overrun: false,
      cycle_start: startDate,
      cycle_end: endDate,
      used_credits: state.usedCredits,
      quota_credits: quota,
      resource_pack_usage: 0,
      pay_as_you_go_usage: 0,
    },
    materials_sha256: sha256(JSON.stringify(binding)),
    deletes: [],
  };
  return { plan, zip, address };
}

export async function createDashboardCodePlan(options) {
  return (await inspect(options)).plan;
}

export async function deployDashboardCode({
  expectedPlanSha256,
  fetchImplementation = fetch,
  waitImplementation = (ms) => new Promise((r) => setTimeout(r, ms)),
  backupDirectory = resolve(ROOT, ".cloudbase/dashboard-code-backups"),
  ...options
}) {
  assert(
    /^[a-f0-9]{64}$/.test(expectedPlanSha256 || ""),
    "reviewed material digest is required",
  );
  const { plan, zip, address } = await inspect(options);
  assert(
    plan.materials_sha256 === expectedPlanSha256,
    "deployment materials or preserved cloud state changed; refresh the preview",
  );
  const download = new URL(address.Url);
  assert(
    download.protocol === "https:" &&
      /\.(?:myqcloud\.com|tencentcos\.cn)$/.test(download.hostname),
    "unexpected backup download endpoint",
  );
  let backup;
  try {
    const response = await fetchImplementation(download, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, "backup download failed");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert(bytes <= 50_000_000, "backup is too large");
      chunks.push(chunk);
    }
    backup = Buffer.concat(chunks);
  } catch {
    throw new Error(
      "unable to obtain a verified rollback ZIP; no write was made",
    );
  }
  assert(
    sha256(backup) === plan.baseline_code_sha256,
    "rollback ZIP digest differs; no write was made",
  );
  await mkdir(backupDirectory, { recursive: true });
  const backupFile = join(
    backupDirectory,
    `${options.envId}-${plan.baseline_code_sha256}.zip`,
  );
  await writeFile(backupFile, backup, { mode: 0o600 });
  const refreshed = await inspect(options);
  assert(
    refreshed.plan.materials_sha256 === expectedPlanSha256,
    "cloud state or reviewed files changed during backup; no write was made",
  );
  await options.api("scf", "UpdateFunctionCode", {
    FunctionName: FUNCTION,
    Namespace: options.envId,
    Handler: "index.main",
    InstallDependency: "TRUE",
    Publish: "FALSE",
    Code: { ZipFile: zip.toString("base64") },
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    await waitImplementation(3000);
    const fn = await options.api("scf", "GetFunction", {
      FunctionName: FUNCTION,
      Namespace: options.envId,
      ShowCode: "FALSE",
    });
    assert(
      !/Failed$/.test(fn.Status || ""),
      "function update failed; verified rollback ZIP is available locally",
    );
    if (fn.Status === "Active") {
      const after = await createDashboardCodePlan(options);
      assert(
        after.preserved_state_sha256 === plan.preserved_state_sha256,
        "post-deploy configuration preservation check failed",
      );
      if (after.baseline_code_sha256 === plan.baseline_code_sha256) continue;
      return {
        status: "code-updated-awaiting-functional-verification",
        function: FUNCTION,
        backup_file: backupFile,
        plan: after,
      };
    }
  }
  throw new Error(
    "function update is still pending; verify cloud state before any retry",
  );
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  assert(
    ["plan", "deploy"].includes(mode) && args.length % 2 === 0,
    "expected plan or deploy with named arguments",
  );
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    assert(
      [
        "--env-id",
        "--origin",
        "--credential-file",
        "--expected-materials-sha256",
      ].includes(args[i]) && !values.has(args[i]),
      "unknown or duplicate deployment argument",
    );
    values.set(args[i], args[i + 1]);
  }
  const credentialFile = resolve(
    values.get("--credential-file") || "cloudbase/.env.dashboard-deploy.local",
  );
  assert(
    !relative(ROOT, credentialFile).startsWith(".."),
    "credential file must be inside this repository's ignored local area",
  );
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", credentialFile], {
      cwd: ROOT,
      stdio: "ignore",
    });
    assert(
      !execFileSync("git", ["ls-files", "--", credentialFile], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim(),
      "credential file is tracked",
    );
  } catch {
    throw new Error("credential file must be Git-ignored and untracked");
  }
  const credentials = await readTencentCredentials(credentialFile);
  const options = {
    envId: values.get("--env-id"),
    region: "ap-shanghai",
    origin: values.get("--origin"),
    api: createTencentCloudClient({ credentials, region: "ap-shanghai" }),
  };
  const result =
    mode === "plan"
      ? await createDashboardCodePlan(options)
      : await deployDashboardCode({
          ...options,
          expectedPlanSha256: values.get("--expected-materials-sha256"),
        });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(resolve(process.argv[1])).href.toLowerCase()
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
