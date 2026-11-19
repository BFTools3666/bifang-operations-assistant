import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { check } from "./private-files.mjs";
import { createDashboardApplicationMapping } from "../generate-cloudbaserc.mjs";

const require = createRequire(import.meta.url);
const {
  parseCredentials,
} = require("../functions/application-version-api/src/auth.js");
const {
  parseApplicationResources,
} = require("../functions/application-version-api/src/repository.js");
const {
  parseDashboardApps,
} = require("../functions/operations-dashboard/src/handler.js");
const {
  parseConfiguredAppLabels,
} = require("../functions/operations-dashboard/src/app-labels.js");
export const DASHBOARD_LABEL_MARKER = "personal-onboarding:labels-v1:";
export const SHARED_NAMES = [
  "application-version-api",
  "operations-dashboard-api",
];
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;

export function sharedBinding(v) {
  return digest([
    v.input.cloudbase.env_id,
    v.input.cloudbase.region,
    v.registry,
    v.input.resources,
  ]);
}

export function variables(fn) {
  const entries = fn?.Environment?.Variables;
  check(
    Array.isArray(entries) &&
      entries.every(
        (v) => typeof v?.Key === "string" && typeof v.Value === "string",
      ) &&
      new Set(entries.map((v) => v.Key)).size === entries.length,
    "SHARED_CONFIGURATION_INVALID",
  );
  return Object.fromEntries(entries.map((v) => [v.Key, v.Value]));
}

function environment(vars) {
  check(
    Object.entries(vars).reduce(
      (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v),
      0,
    ) <= 3840,
    "FUNCTION_ENVIRONMENT_TOO_LARGE",
  );
  return {
    Variables: Object.entries(vars)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([Key, Value]) => ({ Key, Value })),
  };
}

// Compare all returned configuration, including unknown fields, while excluding
// observation metadata that necessarily changes on an environment-only update.
function configuration(fn) {
  const value = structuredClone(fn);
  for (const key of [
    "RequestId",
    "ModTime",
    "Status",
    "StatusDesc",
    "CodeInfo",
    "CodeResult",
    "CodeError",
    "ErrNo",
  ])
    delete value[key];
  value.Environment = environment(variables(fn));
  return canonical(value);
}

export function sharedMatches(actual, expected, { beforeWrite = false } = {}) {
  if (!actual || actual.Status !== "Active") return false;
  return (
    same(configuration(actual), configuration(expected)) &&
    (!beforeWrite || actual.ModTime === expected.ModTime)
  );
}

export async function captureShared(api, v) {
  const functions = [];
  for (const name of SHARED_NAMES) {
    const fn = await api("scf", "GetFunction", {
      Namespace: v.input.cloudbase.env_id,
      FunctionName: name,
      ShowCode: "FALSE",
    });
    check(
      fn?.FunctionName === name &&
        fn.Namespace === v.input.cloudbase.env_id &&
        fn.Status === "Active" &&
        fn.Type === "Event" &&
        fn.Runtime === "Nodejs20.19" &&
        fn.Handler === "index.main" &&
        fn.MemorySize === 256 &&
        fn.Timeout === 3 &&
        fn.Role === "TCB_QcsRole" &&
        typeof fn.ModTime === "string" &&
        fn.ModTime.length > 0 &&
        Number.isInteger(fn.CodeSize) &&
        fn.CodeSize >= 0 &&
        typeof fn.Description === "string" &&
        (/^personal-onboarding:[a-f0-9]{40}$/.test(fn.Description) ||
          (name === "operations-dashboard-api" &&
            fn.Description.startsWith(DASHBOARD_LABEL_MARKER) &&
            /^[a-f0-9]{40}$/.test(
              fn.Description.slice(DASHBOARD_LABEL_MARKER.length),
            ))),
      "SHARED_CONTRACT_UNSUPPORTED",
    );
    functions.push(fn);
  }
  return { schema_version: 1, binding: sharedBinding(v), functions };
}

function mergeCredentials(oldValue, newValue, oldIds, newIds) {
  const old = parseCredentials(oldValue, oldIds),
    added = parseCredentials(newValue, newIds);
  check(old?.length && added?.length, "SHARED_CREDENTIALS_INVALID");
  const all = [...old, ...added],
    ids = [...oldIds, ...newIds];
  const oldCodes = new Set(old.flatMap((c) => [...c.codes]));
  check(
    added.every((c) => [...c.codes].every((code) => !oldCodes.has(code))),
    "SHARED_APPLICATION_CONFLICT",
  );
  const codes = [...new Set(all.flatMap((c) => [...c.codes]))];
  const scopeBits = {
    "versions:check": 1,
    "versions:read": 2,
    "versions:write": 4,
    "ads:show": 8,
    "ads:read": 16,
    "ads:write": 32,
  };
  const encoded = Buffer.from(
    JSON.stringify({
      schema_version: 2,
      app_ids: ids,
      codes,
      credentials: all.map((c) => [
        c.fingerprint,
        ids.indexOf(c.appId),
        [...c.codes].map((code) => codes.indexOf(code)),
        c.keyHash.toString("base64"),
        c.secretHashes.map((h) => h.toString("base64")),
        [...c.scopes].reduce((n, s) => n | scopeBits[s], 0),
      ]),
    }),
  ).toString("base64");
  const parsed = parseCredentials(encoded, ids);
  check(parsed?.length === all.length, "SHARED_CREDENTIALS_INVALID");
  // Includes both rotation hashes, the exact scopes, code bindings and identity.
  const material = (c) => [
    c.fingerprint,
    c.appId,
    [...c.codes],
    [...c.scopes],
    c.keyHash.toString("base64"),
    c.secretHashes.map((h) => h.toString("base64")),
  ];
  check(
    same(parsed.map(material), all.map(material)),
    "SHARED_CREDENTIALS_INVALID",
  );
  return encoded;
}

export function extendShared(v, snapshot, newCredentialConfig) {
  check(
    snapshot?.schema_version === 1 &&
      snapshot.binding === sharedBinding(v) &&
      snapshot.functions?.length === 2 &&
      snapshot.functions.every((fn, i) => fn.FunctionName === SHARED_NAMES[i]),
    "SHARED_SNAPSHOT_TARGET_MISMATCH",
  );
  const [version, dashboard] = snapshot.functions;
  const oldVersion = variables(version),
    oldDashboard = variables(dashboard);
  const env = v.input.cloudbase.env_id;
  check(
    oldVersion.CLOUDBASE_ENV_ID === env &&
      oldDashboard.CLOUDBASE_ENV_ID === env &&
      oldVersion.APPLICATION_VERSION_API_PATH === "/tools/version-control/v1" &&
      oldDashboard.DASHBOARD_PATH === "/admin/v1/metrics" &&
      oldDashboard.DASHBOARD_WEB_PATH === "/dashboard" &&
      [
        oldDashboard.DASHBOARD_TOKEN_SHA256,
        oldDashboard.DASHBOARD_ACCESS_TOKEN_SHA256,
      ].every((h) => /^[a-f0-9]{64}$/i.test(h)),
    "SHARED_CONTRACT_UNSUPPORTED",
  );
  const oldApps = parseApplicationResources(
    oldVersion.APPLICATION_VERSION_APPS_JSON,
  );
  const oldDashApps = parseDashboardApps(oldDashboard.DASHBOARD_APPS_JSON);
  check(oldApps?.length && oldDashApps.length, "SHARED_CONFIGURATION_INVALID");
  const newIds = v.apps.map((a) => a.appId),
    oldIds = oldApps.map((a) => a.appId);
  check(
    newIds.every(
      (id) => !oldIds.includes(id) && !oldDashApps.some((a) => a.appId === id),
    ),
    "SHARED_APPLICATION_CONFLICT",
  );
  const newCodes = v.apps.flatMap((a) => a.releaseStreams.map((s) => s.code));
  check(
    oldDashApps.every((a) =>
      a.releaseStreams.every((s) => !newCodes.includes(s.code)),
    ),
    "SHARED_APPLICATION_CONFLICT",
  );
  const addedApps = newIds.map((appId) => {
    const suffix = appId.replaceAll("-", "_");
    return {
      appId,
      versionCollection: `versions_${suffix}`,
      adCollection: `ads_${suffix}`,
      auditCollection: `audit_${suffix}`,
    };
  });
  const versionApps = [...oldApps, ...addedApps];
  check(
    parseApplicationResources(versionApps)?.length === versionApps.length,
    "SHARED_APPLICATION_CONFLICT",
  );
  const versionVars = {
    ...oldVersion,
    APPLICATION_VERSION_APPS_JSON: JSON.stringify(versionApps),
    APPLICATION_VERSION_CREDENTIALS_B64: mergeCredentials(
      oldVersion.APPLICATION_VERSION_CREDENTIALS_B64,
      newCredentialConfig,
      oldIds,
      newIds,
    ),
  };
  const mapping = createDashboardApplicationMapping([
    ...oldDashApps,
    ...v.apps,
  ]);
  const dashboardVars = {
    ...oldDashboard,
    DASHBOARD_APPS_JSON: JSON.stringify(mapping),
  };
  const configuredNames = dashboard.Description.startsWith(
    DASHBOARD_LABEL_MARKER,
  );
  const addedLabels = Object.fromEntries(
    v.input.applications.map((a) => [a.app_id, a.display_name]),
  );
  if (configuredNames) {
    const previous = parseConfiguredAppLabels(
      oldDashboard.DASHBOARD_APP_LABELS_JSON,
      oldDashApps,
    );
    check(previous, "SHARED_DASHBOARD_LABELS_INVALID");
    dashboardVars.DASHBOARD_APP_LABELS_JSON = JSON.stringify({
      ...previous,
      ...addedLabels,
    });
  } else {
    check(
      oldDashboard.DASHBOARD_APP_LABELS_JSON === undefined,
      "SHARED_CONTRACT_UNSUPPORTED",
    );
  }
  const parsedDashboard = parseDashboardApps(dashboardVars.DASHBOARD_APPS_JSON);
  check(
    parsedDashboard.length === oldDashApps.length + v.apps.length &&
      same(parsedDashboard.slice(0, oldDashApps.length), oldDashApps),
    "SHARED_APPLICATION_CONFLICT",
  );
  const changes = [versionVars, dashboardVars].map((vars, i) => {
    const before = snapshot.functions[i];
    const after = { ...before, Environment: environment(vars) };
    return {
      name: before.FunctionName,
      before,
      after,
      payload: {
        Namespace: env,
        FunctionName: before.FunctionName,
        Environment: after.Environment,
      },
      summary: {
        name: before.FunctionName,
        action: "UpdateFunctionConfiguration",
        added_app_ids: newIds,
        preserved_app_ids: i === 0 ? oldIds : oldDashApps.map((a) => a.appId),
        changed_variables:
          i === 0
            ? [
                "APPLICATION_VERSION_APPS_JSON",
                "APPLICATION_VERSION_CREDENTIALS_B64",
              ]
            : Object.keys(dashboardVars).filter(
                (key) => oldDashboard[key] !== dashboardVars[key],
              ),
        existing_credentials_preserved: true,
        code_replaced: false,
        ...(i === 1
          ? {
              expected_dashboard_labels: addedLabels,
              dashboard_label_source: configuredNames
                ? "environment"
                : "legacy-package",
              dashboard_label_status: configuredNames
                ? "live-verification-pending"
                : "verify-deployed-catalog-or-plan-label-only-repair",
            }
          : {}),
        dashboard_token:
          i === 1
            ? "preserved-remotely; plaintext-not-recovered-or-rotated"
            : undefined,
      },
    };
  });
  return changes;
}
