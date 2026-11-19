import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  createCloudBaseConfig,
  validateRegistry,
  canonicalizeReleaseStreams,
} from "../generate-cloudbaserc.mjs";
import { validateAppLabelCoverage } from "../app-labels.mjs";
import { createSourceZip } from "../deploy-operations-dashboard-code.mjs";
import { check, noLinks } from "./private-files.mjs";
import { DASHBOARD_LABEL_MARKER, extendShared } from "./shared.mjs";

const require = createRequire(import.meta.url);
const {
  parseCredentials,
} = require("../functions/application-version-api/src/auth.js");
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const hash = (v) =>
  createHash("sha256")
    .update(typeof v === "string" || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest("hex");
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function keys(v, names) {
  check(
    plain(v) && same(Object.keys(v).sort(), [...names].sort()),
    "INVALID_INPUT_FIELDS",
  );
}
// Gate one validates only the environment and CAM credentials, before app/resource input.
export function validateAccessInput(value, now = Date.now()) {
  try {
    check(
      value?.schema_version === 1 &&
        value.purpose === "personal-cloudbase-resource-creation" &&
        value.acknowledge_zero_cost_only === true,
      "INVALID_INPUT",
    );
    keys(value.cloudbase, ["env_id", "region", "database_type", "http_origin"]);
    const c = value.cloudbase;
    check(
      /^[a-z0-9][a-z0-9-]{0,127}$/.test(c.env_id) &&
        ["ap-shanghai", "ap-beijing", "ap-guangzhou"].includes(c.region),
      "INVALID_ENVIRONMENT",
    );
    check(["", "postgresql"].includes(c.database_type), "POSTGRESQL_REQUIRED");
    check(typeof c.http_origin === "string", "INVALID_ORIGIN");
    if (c.http_origin) {
      const u = new URL(c.http_origin);
      check(
        u.protocol === "https:" &&
          !u.username &&
          !u.password &&
          !u.port &&
          u.pathname === "/" &&
          !u.search &&
          !u.hash &&
          u.hostname.endsWith(".app.tcloudbase.com"),
        "INVALID_ORIGIN",
      );
    }
    keys(value.credentials, [
      "mode",
      "SecretId",
      "SecretKey",
      "Token",
      "expires_at",
    ]);
    const cr = value.credentials;
    check(cr.mode === "api-key", "API_KEY_MODE_REQUIRED");
    check(
      [cr.SecretId, cr.SecretKey].every(
        (v) =>
          typeof v === "string" &&
          v.length > 0 &&
          v.length <= 8192 &&
          !/[\s\u0000-\u001f\u007f]/u.test(v),
      ),
      "MISSING_DEPLOYMENT_CREDENTIALS",
    );
    check(
      typeof cr.Token === "string" &&
        cr.Token.length <= 8192 &&
        !/[\u0000-\u001f\u007f]/u.test(cr.Token),
      "INVALID_SESSION_TOKEN",
    );
    check(typeof cr.expires_at === "string", "INVALID_EXPIRY");
    if (cr.Token)
      check(
        /Z$/.test(cr.expires_at) && Date.parse(cr.expires_at) > now + 60000,
        "TEMPORARY_CREDENTIAL_EXPIRED",
      );
    else check(cr.expires_at === "", "SESSION_TOKEN_REQUIRED");
    return { envId: c.env_id, region: c.region };
  } catch (error) {
    if (/^[A-Z_]+$/.test(error.message)) throw error;
    throw new Error("INVALID_INPUT");
  }
}
export function validateInput(value, now = Date.now()) {
  try {
    keys(value, [
      "schema_version",
      "purpose",
      "cloudbase",
      "credentials",
      "resources",
      "applications",
      "existing_resource_overrides",
      "existing_service_credentials_file",
      "acknowledge_zero_cost_only",
    ]);
    check(
      value.schema_version === 1 &&
        value.purpose === "personal-cloudbase-resource-creation" &&
        value.acknowledge_zero_cost_only === true,
      "INVALID_INPUT",
    );
    keys(value.resources, ["telemetry", "update", "dashboard"]);
    check(
      Object.values(value.resources).every((v) =>
        ["created", "missing", "unknown", "extend"].includes(v),
      ),
      "INVALID_RESOURCE_STATE",
    );
    if (Object.values(value.resources).every((v) => v === "created"))
      return { skipped: true };
    check(
      !Object.values(value.resources).includes("unknown"),
      "RESOURCE_STATE_UNKNOWN",
    );
    validateAccessInput(value, now);
    check(
      value.resources.telemetry !== "extend" &&
        (value.resources.update === "extend") ===
          (value.resources.dashboard === "extend"),
      "SHARED_MODE_REQUIRES_BOTH_SERVICES",
    );
    check(
      Array.isArray(value.existing_resource_overrides) &&
        value.existing_resource_overrides.length === 0 &&
        value.existing_service_credentials_file === "",
      "CUSTOM_RESOURCE_ADAPTER_REQUIRED",
    );
    check(
      Array.isArray(value.applications) &&
        value.applications.length > 0 &&
        value.applications.length <= 10,
      "INVALID_APPLICATIONS",
    );
    const registry = {
      schema_version: 3,
      apps: value.applications.map((app) => {
        keys(app, ["app_id", "display_name", "release_streams"]);
        return {
          app_id: app.app_id,
          release_streams: canonicalizeReleaseStreams(app.release_streams),
        };
      }),
    };
    const apps = validateRegistry(registry);
    validateAppLabelCoverage(
      registry,
      Object.fromEntries(
        value.applications.map((a) => [a.app_id, a.display_name]),
      ),
    );
    if (["missing", "extend"].includes(value.resources.update))
      check(
        apps.every((a) => a.releaseStreams.length > 0),
        "UPDATE_STREAM_REQUIRED",
      );
    return { skipped: false, input: value, registry, apps };
  } catch (e) {
    if (/^[A-Z_]+$/.test(e.message)) throw e;
    throw new Error("INVALID_INPUT");
  }
}
export function createServiceSecrets(validated) {
  const token = () => randomBytes(32).toString("base64url");
  const { input, apps } = validated;
  const credentials = [];
  if (["missing", "extend"].includes(input.resources.update))
    for (const app of apps) {
      for (const stream of app.releaseStreams)
        credentials.push({
          credential_id:
            "runtime-" + hash([app.appId, stream.code]).slice(0, 24),
          app_id: app.appId,
          codes: [stream.code],
          role: "runtime",
          app_key: token(),
          app_secret: token(),
        });
      for (const role of ["managementRead", "managementWrite"])
        credentials.push({
          credential_id:
            (role === "managementRead" ? "read-" : "write-") +
            hash(app.appId).slice(0, 24),
          app_id: app.appId,
          codes: app.releaseStreams.map((s) => s.code),
          role,
          app_key: token(),
          app_secret: token(),
        });
    }
  return {
    schema_version: 1,
    binding: secretBinding(validated),
    dashboard:
      input.resources.dashboard === "missing"
        ? { CLOUDBASE_METRICS_TOKEN: token(), DASHBOARD_ACCESS_TOKEN: token() }
        : {},
    version_credentials: credentials,
  };
}
function secretBinding(v) {
  return hash([
    v.input.cloudbase.env_id,
    v.input.cloudbase.region,
    v.registry,
    v.input.resources,
  ]);
}
function credentialConfig(v, secrets) {
  check(
    secrets.schema_version === 1 && secrets.binding === secretBinding(v),
    "SERVICE_SECRETS_TARGET_MISMATCH",
  );
  const expected = ["missing", "extend"].includes(v.input.resources.update)
    ? v.apps.flatMap((a) => [
        ...a.releaseStreams.map((s) => [a.appId, [s.code], "runtime"]),
        [a.appId, a.releaseStreams.map((s) => s.code), "managementRead"],
        [a.appId, a.releaseStreams.map((s) => s.code), "managementWrite"],
      ])
    : [];
  check(
    Array.isArray(secrets.version_credentials) &&
      secrets.version_credentials.length === expected.length,
    "INVALID_SERVICE_SECRETS",
  );
  const masks = { runtime: 1, managementRead: 18, managementWrite: 36 };
  const appIds = v.apps.map((a) => a.appId),
    codes = v.apps.flatMap((a) => a.releaseStreams.map((s) => s.code));
  const items = secrets.version_credentials.map((c, i) => {
    check(
      same([c.app_id, c.codes, c.role], expected[i]) &&
        [c.app_key, c.app_secret].every(
          (t) => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t),
        ),
      "INVALID_SERVICE_SECRETS",
    );
    const digest = (s) => createHash("sha256").update(s).digest("base64");
    return [
      c.credential_id,
      appIds.indexOf(c.app_id),
      c.codes.map((s) => codes.indexOf(s)),
      digest(c.app_key),
      [digest(c.app_secret)],
      masks[c.role],
    ];
  });
  const result = Buffer.from(
    JSON.stringify({
      schema_version: 2,
      app_ids: appIds,
      codes,
      credentials: items,
    }),
  ).toString("base64");
  if (items.length)
    check(parseCredentials(result, appIds) !== null, "INVALID_SERVICE_SECRETS");
  return result;
}
export async function sourceBundle(dir, labels, root = ROOT, cleanup = false) {
  const entries = [];
  async function walk(relative) {
    const full = join(root, dir, relative);
    await noLinks(full);
    const s = await lstat(full);
    if (s.isDirectory()) {
      for (const child of (await readdir(full)).sort())
        await walk(relative ? relative + "/" + child : child);
    } else {
      check(s.isFile() && s.size < 1000000, "INVALID_SOURCE");
      let body = await readFile(full);
      if (cleanup && relative === "index.js")
        body = Buffer.from(
          'exports.main = require("./src/cleanup.js").main;\n',
        );
      if (relative === "src/app-labels.json")
        body = Buffer.from(JSON.stringify(labels));
      entries.push({ name: relative, body });
    }
  }
  for (const entry of ["index.js", "package.json", "src"]) await walk(entry);
  if (dir.endsWith("operations-dashboard")) await walk("public");
  const zip = createSourceZip(entries);
  check(zip.length < 1500000, "SOURCE_TOO_LARGE");
  return zip;
}
export async function buildSpec(
  v,
  secrets,
  root = ROOT,
  sharedSnapshot = null,
) {
  const c = v.input.cloudbase,
    selected = v.input.resources;
  const b64 = credentialConfig(v, secrets);
  const shared =
    selected.update === "extend" ? extendShared(v, sharedSnapshot, b64) : [];
  const config = createCloudBaseConfig(v.registry);
  const labels = Object.fromEntries(
    v.input.applications.map((a) => [a.app_id, a.display_name]),
  );
  const functions = [];
  const triggers = [];
  for (const fn of config.functions) {
    const kind = fn.name.startsWith("telemetry-")
      ? "telemetry"
      : fn.name === "application-version-api"
        ? "update"
        : "dashboard";
    if (selected[kind] !== "missing") continue;
    const variables = { ...fn.envVariables, CLOUDBASE_ENV_ID: c.env_id };
    if (kind === "update") variables.APPLICATION_VERSION_CREDENTIALS_B64 = b64;
    if (kind === "dashboard") {
      const d = secrets.dashboard;
      check(
        d &&
          [d.CLOUDBASE_METRICS_TOKEN, d.DASHBOARD_ACCESS_TOKEN].every(
            (t) => typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t),
          ) &&
          d.CLOUDBASE_METRICS_TOKEN !== d.DASHBOARD_ACCESS_TOKEN,
        "INVALID_SERVICE_SECRETS",
      );
      variables.DASHBOARD_TOKEN_SHA256 = hash(d.CLOUDBASE_METRICS_TOKEN);
      variables.DASHBOARD_ACCESS_TOKEN_SHA256 = hash(d.DASHBOARD_ACCESS_TOKEN);
      variables.DASHBOARD_APP_LABELS_JSON = JSON.stringify(labels);
    }
    check(
      Object.entries(variables).reduce(
        (n, [k, val]) => n + Buffer.byteLength(k) + Buffer.byteLength(val),
        0,
      ) <= 3840,
      "FUNCTION_ENVIRONMENT_TOO_LARGE",
    );
    const zip = await sourceBundle(fn.dir, labels, root);
    const payload = {
      EnvId: c.env_id,
      FunctionName: fn.name,
      Type: "Event",
      Runtime: fn.runtime,
      Handler: fn.handler,
      Timeout: 3,
      MemorySize: 256,
      InstallDependency: "TRUE",
      Role: "TCB_QcsRole",
      CodeSource: "ZipFile",
      Environment: {
        Variables: Object.entries(variables)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([Key, Value]) => ({ Key, Value })),
      },
      Code: { ZipFile: zip.toString("base64") },
    };
    payload.Description =
      (kind === "dashboard" ? DASHBOARD_LABEL_MARKER : "personal-onboarding:") +
      hash([zip.toString("base64"), payload.Environment]).slice(0, 40);
    functions.push({ name: fn.name, payload });
    if (kind === "telemetry") {
      const cleanupName = "cleanup-" + variables.ALLOWED_APP_IDS;
      const cleanupZip = await sourceBundle(fn.dir, labels, root, true);
      const cleanupPayload = {
        ...payload,
        FunctionName: cleanupName,
        Handler: "index.main",
        Code: { ZipFile: cleanupZip.toString("base64") },
        Environment: {
          Variables: payload.Environment.Variables.filter((v) =>
            [
              "ALLOWED_APP_IDS",
              "TELEMETRY_COLLECTION",
              "CLOUDBASE_ENV_ID",
            ].includes(v.Key),
          ),
        },
      };
      cleanupPayload.Description =
        "personal-onboarding:" +
        hash([
          cleanupZip.toString("base64"),
          cleanupPayload.Environment,
          cleanupPayload.Handler,
        ]).slice(0, 40);
      functions.push({ name: cleanupName, payload: cleanupPayload });
      triggers.push({
        Namespace: c.env_id,
        FunctionName: cleanupName,
        TriggerName: "cleanup-expired",
        Type: "timer",
        TriggerDesc: "0 */15 * * * * *",
        Qualifier: "$LATEST",
        Enable: "OPEN",
        CustomArgument: "telemetry-cleanup-v1",
      });
    }
  }
  const collections = [];
  const index = (name, key, extra = {}) => ({ name, key, ...extra });
  for (const app of v.apps) {
    const suffix = app.appId.replaceAll("-", "_");
    if (selected.telemetry === "missing")
      collections.push({
        name: "telemetry_" + suffix,
        indexes: [index("expires_at_cleanup", { expires_at: 1, _id: 1 })],
      });
    if (["missing", "extend"].includes(selected.update))
      collections.push(
        {
          name: "versions_" + suffix,
          indexes: [
            index("versions_created", {
              doc_type: 1,
              code: 1,
              created_at: -1,
              _id: -1,
            }),
            index("versions_order", {
              doc_type: 1,
              code: 1,
              version_sort_key: -1,
              updated_at: -1,
              _id: -1,
            }),
          ],
        },
        {
          name: "ads_" + suffix,
          indexes: [
            index("ads_created", {
              doc_type: 1,
              app_code: 1,
              created_at: -1,
              _id: -1,
            }),
          ],
        },
        {
          name: "audit_" + suffix,
          indexes: [index("audit_time", { occurred_at: -1 })],
        },
      );
  }
  const routes = config.gateway.routes
    .filter((r) =>
      [...functions, ...shared].some((f) => r.target === "function:" + f.name),
    )
    .map((r) => ({
      Path: r.path,
      UpstreamResourceType: "SCF",
      UpstreamResourceName: r.target.slice(9),
      Enable: true,
      EnableAuth: false,
      EnablePathTransmission: true,
    }));
  return {
    envId: c.env_id,
    region: c.region,
    databaseType: "postgresql",
    origin: c.http_origin,
    dashboardLabels: labels,
    functions,
    shared,
    collections,
    routes,
    triggers,
    retention:
      selected.telemetry === "missing"
        ? {
            mode: "ordinary-index-and-scheduled-cleanup",
            expires_after_days: 30,
            schedule_minutes: 15,
            max_records_per_run: 100,
            deletion_scope:
              "configured-app-telemetry-only; expires_at <= server-start-time",
            timing: "eventual; backlog-or-failures-delay-deletion",
            live_cleanup_verified: false,
          }
        : null,
    skipped: Object.entries(selected)
      .filter(([, s]) => s === "created")
      .map(([k]) => k),
  };
}
