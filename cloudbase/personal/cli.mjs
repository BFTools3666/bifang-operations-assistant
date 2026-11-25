import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { guides } = createRequire(import.meta.url)(
  "../../skills/bifang-public-services-onboarding/assets/console-guides.json",
);
import {
  assertPrivate,
  createIntake,
  readPrivate,
  writePrivate,
  writePrivateBytes,
  check,
} from "./private-files.mjs";
import {
  validateInput,
  validateAccessInput,
  createServiceSecrets,
  buildSpec,
  hash,
  ROOT,
} from "./spec.mjs";
import {
  createPersonalApi,
  costPreflight,
  planResources,
  applyResources,
} from "./cloud.mjs";
import { captureShared } from "./shared.mjs";

const TEMPLATE = join(
  ROOT,
  "skills/bifang-public-services-onboarding/assets/resource-input.template.json",
);
// Before .29 the HTTP telemetry ZIP also contained an unused cleanup module.
// Recognize the released ZIP (including LF/CRLF checkouts) from prior local
// deployment materials. Only its digest is trusted; it is never uploaded.
const priorTelemetryDigests = new Set([
  "4fe1fe772114b1d302a8c90dd0bef2c24d0a07f25678c236e6bfce993aaec892",
  "78e150721d26ad20d96e691f0c543bc76b2ff583cbc7386f51e612d257f13484",
  "f328e99bfb08c0b26e4d8d2db4c7602f3227cb634aaf5ab9b6e30acbc047bab0",
]);
async function priorTelemetryMarkers(folder, fn) {
  const markers = new Set();
  for (const entry of await readdir(folder)) {
    const manual = entry.startsWith(fn.name + "-") && entry.endsWith(".zip");
    const plan = /^resource-plan-[a-f0-9-]{36}\.json$/.test(entry);
    if (!manual && !plan) continue;
    const path = await assertPrivate(join(folder, entry));
    const size = (await stat(path)).size;
    if (size > (manual ? 30_000 : 16_000_000)) continue;
    let bytes;
    if (manual) bytes = await readFile(path);
    else {
      const previous = JSON.parse(await readFile(path, "utf8"));
      const upload = previous.operations?.find(
        (op) =>
          op.service === "tcb" &&
          op.action === "CreateFunction" &&
          op.payload?.EnvId === fn.payload.EnvId &&
          op.payload.FunctionName === fn.name,
      )?.payload.Code?.ZipFile;
      if (typeof upload !== "string" || upload.length > 40_000) continue;
      bytes = Buffer.from(upload, "base64");
    }
    if (priorTelemetryDigests.has(hash(bytes)))
      markers.add(
        "personal-onboarding:" +
          hash([bytes.toString("base64"), fn.payload.Environment]).slice(0, 40),
      );
  }
  return markers;
}
export async function run(
  argv,
  { print = console.log, apiFactory = createPersonalApi, now = Date.now } = {},
) {
  const [mode, ...args] = argv;
  check(
    [
      "init",
      "access",
      "validate",
      "prepare",
      "plan",
      "apply",
      "verify",
    ].includes(mode),
    "INVALID_COMMAND",
  );
  if (mode === "init") {
    check(args.length === 0, "INVALID_ARGUMENTS");
    const file = await createIntake(
      JSON.parse(await readFile(TEMPLATE, "utf8")),
    );
    print(
      JSON.stringify({
        status: "input-created",
        file,
        contains_credentials: false,
        console_guides: [guides.environment, guides.camKey],
      }),
    );
    return;
  }
  check(
    args[0] === "--file" &&
      typeof args[1] === "string" &&
      (mode === "apply"
        ? args.length === 4 && args[2] === "--expected-plan"
        : args.length === 2),
    "INVALID_ARGUMENTS",
  );
  const file = resolve(args[1]);
  const data = await readPrivate(file);
  if (mode === "access") {
    const target = validateAccessInput(data, now());
    const cost = await costPreflight(apiFactory(data), target, now());
    const result = {
      status: "access-verified",
      env_id: target.envId,
      region: target.region,
      credentials: "usable-for-environment-read-preflight",
      cost,
      database: cost.database,
      cloud_writes: 0,
      resource_permissions_verified: false,
      checked_at: new Date(now()).toISOString(),
    };
    const receipt = join(dirname(file), "access-" + randomUUID() + ".json");
    await writePrivate(receipt, result);
    print(JSON.stringify({ ...result, receipt }));
    return;
  }
  const validated = validateInput(data);
  if (validated.skipped) {
    check(mode !== "verify", "EXISTING_RESOURCES_VERIFICATION_REQUIRED");
    print(
      JSON.stringify({
        status: "creation-skipped-verification-required",
        cloud_requests: 0,
        technical_verification: false,
      }),
    );
    return;
  }
  if (mode === "validate") {
    print(
      JSON.stringify({
        status: "input-valid",
        credentials: "present-not-verified",
        applications: validated.apps.length,
        cloud_requests: 0,
      }),
    );
    return;
  }
  const secretsFile = join(dirname(file), "service-credentials.json");
  let secrets;
  try {
    secrets = await readPrivate(secretsFile);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    check(mode !== "verify", "VERIFICATION_MATERIALS_REQUIRED");
    secrets = createServiceSecrets(validated);
    await writePrivate(secretsFile, secrets);
  }
  const sharedFile = join(dirname(file), "shared-baseline.json");
  let shared = null;
  if (data.resources.update === "extend") {
    try {
      shared = await readPrivate(sharedFile);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      check(!["prepare", "verify"].includes(mode), "SHARED_SNAPSHOT_REQUIRED");
      const api = apiFactory(data);
      await costPreflight(
        api,
        { envId: data.cloudbase.env_id, region: data.cloudbase.region },
        now(),
      );
      shared = await captureShared(api, validated);
      await writePrivate(sharedFile, shared);
    }
  }
  const spec = await buildSpec(validated, secrets, ROOT, shared);
  if (mode === "prepare") {
    const materialId = randomUUID();
    const functions = [];
    for (const fn of spec.functions) {
      const zip = join(dirname(file), fn.name + "-" + materialId + ".zip");
      await writePrivateBytes(
        zip,
        Buffer.from(fn.payload.Code.ZipFile, "base64"),
      );
      const { Code, ...settings } = fn.payload;
      functions.push({ zip_file: zip, settings });
    }
    const materials = join(
      dirname(file),
      "manual-resources-" + materialId + ".json",
    );
    const consoleGuides = [
      guides.postgres,
      ...(spec.collections.length ? [guides.collections] : []),
      ...(spec.collections.some((c) => c.indexes.length)
        ? [guides.indexes]
        : []),
      ...(functions.length ? [guides.functionCreate, guides.functionCode] : []),
      ...(functions.length || spec.shared?.length
        ? [guides.functionConfig]
        : []),
      ...(spec.routes.length ? [guides.domain, guides.routes] : []),
    ];
    await writePrivate(materials, {
      console_guides: consoleGuides,
      env_id: spec.envId,
      region: spec.region,
      database: {
        type: "postgresql",
        document_api: "pgdoc",
        requires_plugin: true,
        enable_api: "EnablePGDocumentExt",
        readiness: "verify-required",
        existing_document_database:
          "stop-before-enabling; no-migration-or-clearing",
      },
      collections: spec.collections.map((c) => ({ ...c, acl: "ADMINONLY" })),
      functions,
      shared_function_updates: (spec.shared || []).map((f) => ({
        settings: f.payload,
        summary: f.summary,
      })),
      expected_dashboard_labels: spec.dashboardLabels,
      routes: spec.routes,
      skipped: spec.skipped,
    });
    print(
      JSON.stringify({
        status: "manual-materials-prepared",
        console_guides: consoleGuides,
        materials_file: materials,
        function_zip_files: functions.map((f) => f.zip_file),
        service_credentials_file: secretsFile,
        cloud_requests: 0,
        customer_completion_required: true,
      }),
    );
    return;
  }
  const readApi = apiFactory(data);
  const priorMarkers = new Map();
  const isPriorTelemetry = async (fn, marker) => {
    if (!priorMarkers.has(fn.name))
      priorMarkers.set(fn.name, await priorTelemetryMarkers(dirname(file), fn));
    return priorMarkers.get(fn.name).has(marker);
  };
  const plan = await planResources(readApi, spec, now(), isPriorTelemetry);
  if (mode === "verify") {
    check(plan.operations.length === 0, "FINAL_READBACK_INCOMPLETE");
    const result = {
      status: "resources-control-plane-verified",
      ...plan.summary.resource_details,
      origin: plan.summary.origin,
      skipped_customer_confirmed: spec.skipped,
      cloud_writes: 0,
      live_http_gui_exe_tested: false,
    };
    const receipt = join(
      dirname(file),
      "verification-" + randomUUID() + ".json",
    );
    await writePrivate(receipt, result);
    print(JSON.stringify({ ...result, receipt }));
    return;
  }
  if (mode === "plan") {
    const planFile = join(
      dirname(file),
      "resource-plan-" + randomUUID() + ".json",
    );
    await writePrivate(planFile, {
      summary: plan.summary,
      operations: plan.operations,
      shared_baseline_file: shared ? sharedFile : null,
    });
    print(
      JSON.stringify(
        {
          ...plan.summary,
          service_credentials_file: secretsFile,
          plan_file: planFile,
          ...(shared ? { shared_baseline_file: sharedFile } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  check(plan.digest === args[3], "PLAN_CHANGED_REVIEW_REQUIRED");
  const api = apiFactory(data, plan.operations);
  const events = [];
  try {
    const result = await applyResources(api, spec, args[3], {
      isPriorTelemetry,
      onProgress: (e) => {
        events.push(e);
        print(JSON.stringify(e));
      },
    });
    const receipt = join(dirname(file), "receipt-" + randomUUID() + ".json");
    await writePrivate(receipt, { ...result, plan_sha256: args[3], events });
    print(
      JSON.stringify({
        ...result,
        receipt,
        service_credentials_file: secretsFile,
      }),
    );
  } catch (e) {
    // A failed run leaves created resources in place. Preserve a non-secret
    // journal and require a new preview; never delete resources as rollback.
    const receipt = join(dirname(file), "partial-" + randomUUID() + ".json");
    await writePrivate(receipt, {
      status: "incomplete-replan-required",
      plan_sha256: args[3],
      events,
      failure: safeFailure(e),
    });
    print(JSON.stringify({ status: "incomplete-replan-required", receipt }));
    throw e;
  }
}
export function safeFailure(error) {
  const code = error?.message;
  // Only our closed, static codes are printed. In particular JSON parse errors,
  // server messages, paths from exceptions and unknown API codes are not echoed.
  const known = new Set([
    "INVALID_COMMAND",
    "INVALID_ARGUMENTS",
    "PRIVATE_PERMISSIONS_REQUIRED",
    "PRIVATE_INTAKE_PATH_REQUIRED",
    "PRIVATE_FILE_REQUIRED",
    "PRIVATE_FILE_INSIDE_GIT",
    "UNSAFE_PATH",
    "INPUT_TOO_LARGE",
    "INVALID_PRIVATE_JSON",
    "INVALID_INPUT",
    "INVALID_INPUT_FIELDS",
    "INVALID_RESOURCE_STATE",
    "SHARED_MODE_REQUIRES_BOTH_SERVICES",
    "SHARED_SNAPSHOT_REQUIRED",
    "SHARED_SNAPSHOT_TARGET_MISMATCH",
    "SHARED_CONFIGURATION_INVALID",
    "SHARED_CREDENTIALS_INVALID",
    "SHARED_DASHBOARD_LABELS_INVALID",
    "SHARED_APPLICATION_CONFLICT",
    "SHARED_CONTRACT_UNSUPPORTED",
    "SHARED_FUNCTION_CHANGED_REPLAN_REQUIRED",
    "RESOURCE_STATE_UNKNOWN",
    "INVALID_ENVIRONMENT",
    "POSTGRESQL_REQUIRED",
    "INVALID_ORIGIN",
    "API_KEY_MODE_REQUIRED",
    "MISSING_DEPLOYMENT_CREDENTIALS",
    "INVALID_SESSION_TOKEN",
    "INVALID_EXPIRY",
    "TEMPORARY_CREDENTIAL_EXPIRED",
    "SESSION_TOKEN_REQUIRED",
    "CUSTOM_RESOURCE_ADAPTER_REQUIRED",
    "INVALID_APPLICATIONS",
    "UPDATE_STREAM_REQUIRED",
    "SERVICE_SECRETS_TARGET_MISMATCH",
    "INVALID_SERVICE_SECRETS",
    "INVALID_SOURCE",
    "SOURCE_TOO_LARGE",
    "FUNCTION_ENVIRONMENT_TOO_LARGE",
    "API_ACTION_NOT_AUTHORIZED",
    "API_TARGET_MISMATCH",
    "INVALID_DATABASE_RESULT",
    "DATABASE_COMMAND_FAILED",
    "INCOMPLETE_INDEX_INVENTORY",
    "INVALID_INDEX_INVENTORY",
    "AMBIGUOUS_ENVIRONMENT",
    "FREE_ENVIRONMENT_REQUIRED",
    "POSTGRESQL_NOT_CONFIRMED",
    "INVALID_POSTGRESQL_RESULT",
    "PGDOC_PARTIAL_INSTALLATION",
    "PGDOC_LEGACY_DATABASE_CONFLICT",
    "PGDOC_ENABLE_NOT_CONFIRMED",
    "DATABASE_STATE_CHANGED_REPLAN_REQUIRED",
    "POST_ENABLE_PLAN_CHANGED_REVIEW_REQUIRED",
    "FREE_BILLING_GATE_FAILED",
    "ENVIRONMENT_EXPIRED",
    "QUOTA_NOT_CONFIRMED",
    "BILLING_CYCLE_NOT_CONFIRMED",
    "FREE_QUOTA_GATE_FAILED",
    "FREE_FUNCTION_QUOTA_NOT_CONFIRMED",
    "FUNCTION_CHANGED_REPLAN_REQUIRED",
    "INVALID_DOMAIN_INVENTORY",
    "DOMAIN_INVENTORY_DRIFT",
    "INCOMPLETE_DOMAIN_INVENTORY",
    "DEFAULT_DOMAIN_NOT_READY",
    "ORIGIN_TARGET_MISMATCH",
    "INVALID_ROUTE_INVENTORY",
    "INVALID_FUNCTION_INVENTORY",
    "FUNCTION_INVENTORY_DRIFT",
    "INCOMPLETE_FUNCTION_INVENTORY",
    "COLLECTION_ACL_CONFLICT",
    "INDEX_CONFLICT",
    "INDEX_CHANGED_REPLAN_REQUIRED",
    "FUNCTION_CONFLICT",
    "ROUTE_CONFLICT",
    "ROUTE_CHANGED_REPLAN_REQUIRED",
    "EXPECTED_PLAN_REQUIRED",
    "PLAN_CHANGED_REVIEW_REQUIRED",
    "FUNCTION_CREATION_FAILED",
    "READBACK_TIMEOUT_REVIEW_REQUIRED",
    "FINAL_READBACK_INCOMPLETE",
    "EXISTING_RESOURCES_VERIFICATION_REQUIRED",
    "VERIFICATION_MATERIALS_REQUIRED",
  ]);
  const cloudErrors = {
    ResourceNotFound: "CLOUD_RESOURCE_NOT_FOUND",
    UnauthorizedOperation: "CLOUD_PERMISSION_DENIED",
    AuthFailure: "CLOUD_AUTHENTICATION_FAILED",
    LimitExceeded: "CLOUD_LIMIT_EXCEEDED",
    InvalidParameter: "CLOUD_PARAMETER_REJECTED",
    FailedOperation: "CLOUD_OPERATION_FAILED",
    OperationDenied: "CLOUD_OPERATION_DENIED",
    InvalidAction: "CLOUD_API_UNAVAILABLE",
    UnsupportedOperation: "CLOUD_OPERATION_UNSUPPORTED",
  };
  const cloudCode = Object.entries(cloudErrors).find(
    ([prefix]) =>
      code === "Tencent Cloud API error: " + prefix ||
      code?.startsWith("Tencent Cloud API error: " + prefix + "."),
  )?.[1];
  const allowedActions = new Set([
    "DescribeEnvs",
    "DescribeBillingInfo",
    "DescribeEnvAccountCircle",
    "DescribeBaasPackageList",
    "DescribeCreditsUsage",
    "DescribeHTTPServiceRoute",
    "DescribeTable",
    "DescribeDatabaseACL",
    "RunCommands",
    "ExecutePGSql",
    "EnablePGDocumentExt",
    "ListFunctions",
    "UpdateTable",
    "GetFunction",
    "UpdateFunctionConfiguration",
    "CreateTable",
    "CreateFunction",
    "CreateHTTPServiceRoute",
  ]);
  return {
    status: "failed",
    code: known.has(code) ? code : cloudCode || "PRIVATE_OPERATION_FAILED",
    ...(cloudCode &&
    /^Tencent Cloud API error: [A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(code)
      ? { api_error_code: code.slice("Tencent Cloud API error: ".length) }
      : {}),
    ...(typeof error?.apiRequestId === "string" &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(error.apiRequestId)
      ? { api_request_id: error.apiRequestId }
      : {}),
    ...(["tcb", "scf"].includes(error?.apiService) &&
    allowedActions.has(error?.apiAction)
      ? { api_service: error.apiService, api_action: error.apiAction }
      : {}),
    retry: "fix-or-replan; no-automatic-rollback",
  };
}
if (
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(resolve(process.argv[1])).href.toLowerCase()
) {
  run(process.argv.slice(2)).catch((e) => {
    console.error(JSON.stringify(safeFailure(e)));
    process.exitCode = 1;
  });
}
