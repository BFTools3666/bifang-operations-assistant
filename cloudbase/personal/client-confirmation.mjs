import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  createIntake,
  readPrivate,
  writePrivate,
  check,
} from "./private-files.mjs";
import { ROOT, hash } from "./spec.mjs";
import { safeFailure } from "./cli.mjs";

const require = createRequire(import.meta.url);
const {
  validateVersion,
  validateCode,
} = require("../functions/application-version-api/src/validation.js");
const {
  isSemVer,
  validateAndSanitizePayload,
} = require("../functions/telemetry/src/validation.js");
const TEMPLATE = join(
  ROOT,
  "skills/bifang-public-services-onboarding/assets/integration-input.template.json",
);
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, keys) =>
  plain(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const passes = (fn, value) => {
  try {
    fn(value);
    return true;
  } catch {
    return false;
  }
};
const id = (v) =>
  typeof v === "string" && /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(v);
const secret = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 512 &&
  !/[\s\u0000-\u001f\u007f]/u.test(v);
function urlAt(value, path) {
  try {
    const u = new URL(value);
    return (
      typeof value === "string" &&
      value === u.origin + path &&
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash
    );
  } catch {
    return false;
  }
}

// Fixed field paths only: malformed input is never reflected into diagnostic output.
export function validateConfirmation(input) {
  const missing = [];
  const need = (condition, field) => {
    if (!condition) missing.push(field);
  };
  if (
    !exact(input, [
      "schema_version",
      "purpose",
      "services",
      "app",
      "targets",
      "update",
      "telemetry",
    ])
  )
    return ["input.schema"];
  need(
    input.schema_version === 1 &&
      input.purpose === "personal-client-integration-confirmation",
    "input.schema",
  );
  if (
    !exact(input.services, ["update", "telemetry"]) ||
    Object.values(input.services).some((v) => typeof v !== "boolean") ||
    !Object.values(input.services).some(Boolean)
  )
    return ["services"];
  if (!exact(input.app, ["app_id", "display_name"])) return ["app.schema"];
  need(id(input.app.app_id), "app.app_id");
  need(
    typeof input.app.display_name === "string" &&
      input.app.display_name.trim().length > 0 &&
      [...input.app.display_name].length <= 100 &&
      !/[\u0000-\u001f\u007f]/u.test(input.app.display_name),
    "app.display_name",
  );
  if (
    !Array.isArray(input.targets) ||
    input.targets.length < 1 ||
    input.targets.length > 12
  )
    return [...missing, "targets"];
  const seen = new Set(),
    codes = new Set();
  input.targets.forEach((t, i) => {
    const field = "targets[" + i + "]";
    if (
      !exact(t, [
        "platform",
        "arch",
        "channel",
        "app_version",
        "update_code",
        "runtime_credential_id",
      ])
    ) {
      missing.push(field + ".schema");
      return;
    }
    need(
      ["windows", "macos", "linux"].includes(t.platform),
      field + ".platform",
    );
    need(["x64", "arm64", "ia32"].includes(t.arch), field + ".arch");
    need(
      typeof t.channel === "string" &&
        /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(t.channel),
      field + ".channel",
    );
    const key = JSON.stringify([t.platform, t.arch, t.channel]);
    need(!seen.has(key), field + ".duplicate_target");
    seen.add(key);
    if (input.services.update) {
      need(
        id(t.update_code) &&
          passes(validateCode, t.update_code) &&
          !codes.has(t.update_code),
        field + ".update_code",
      );
      codes.add(t.update_code);
      need(
        passes(validateVersion, t.app_version),
        field + ".app_version.update_numeric_dotted",
      );
      need(
        typeof t.runtime_credential_id === "string" &&
          /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(
            t.runtime_credential_id,
          ),
        field + ".runtime_credential_id",
      );
    }
    if (input.services.telemetry)
      need(isSemVer(t.app_version), field + ".app_version.telemetry_semver");
  });
  if (input.services.update) {
    if (
      !exact(input.update, [
        "protocol",
        "base_url",
        "credentials_file",
        "credentials",
      ])
    )
      missing.push("update.schema");
    else {
      need(
        input.update.protocol === "application-version-api-v1",
        "update.protocol",
      );
      need(
        urlAt(input.update.base_url, "/tools/version-control/v1"),
        "update.base_url",
      );
      need(
        typeof input.update.credentials_file === "string" &&
          Array.isArray(input.update.credentials) &&
          ((input.update.credentials_file.length > 0 &&
            input.update.credentials.length === 0) ||
            (input.update.credentials_file === "" &&
              input.update.credentials.length > 0)),
        "update.credentials_source",
      );
    }
  }
  if (input.services.telemetry) {
    if (!exact(input.telemetry, ["protocol", "url"]))
      missing.push("telemetry.schema");
    else {
      need(
        input.telemetry.protocol === "daily-active-v2",
        "telemetry.protocol",
      );
      need(
        urlAt(input.telemetry.url, "/apps/" + input.app.app_id + "/v1/track"),
        "telemetry.url",
      );
    }
  }
  return missing;
}

// Returns secret-bearing material for private storage. Callers must use publicPreview
// for output; this function performs no network I/O and never invokes a client.
export function prepareConfirmation(
  input,
  credentialRecords = [],
  now = new Date(),
) {
  const missing = validateConfirmation(input);
  if (missing.length) return { status: "needs-input", fields: missing };
  const requests = [],
    bound = [];
  if (input.services.update) {
    if (!Array.isArray(credentialRecords))
      return { status: "needs-input", fields: ["update.credentials"] };
    for (const [i, target] of input.targets.entries()) {
      const found = credentialRecords.filter(
        (c) => plain(c) && c.credential_id === target.runtime_credential_id,
      );
      const c = found[0];
      if (
        found.length !== 1 ||
        c.role !== "runtime" ||
        c.app_id !== input.app.app_id ||
        !Array.isArray(c.codes) ||
        c.codes.length !== 1 ||
        c.codes[0] !== target.update_code ||
        !secret(c.app_key) ||
        !secret(c.app_secret)
      ) {
        missing.push("targets[" + i + "].runtime_credential_binding");
      } else bound.push(c);
    }
    if (missing.length) return { status: "needs-input", fields: missing };
  }
  const previewInstallId = randomUUID();
  input.targets.forEach((target, i) => {
    const context = {
      platform: target.platform,
      arch: target.arch,
      channel: target.channel,
      app_version: target.app_version,
    };
    if (input.services.update)
      requests.push({
        service: "update",
        target: context,
        method: "GET",
        url:
          input.update.base_url +
          "/versions/" +
          encodeURIComponent(target.update_code) +
          "/" +
          encodeURIComponent(target.app_version),
        headers: {
          Accept: "application/json",
          "x-app-key": bound[i].app_key,
          "x-app-secret": bound[i].app_secret,
        },
        path_parameters: {
          code: target.update_code,
          version: target.app_version,
        },
        query: null,
        body: null,
        expected_http_status: 200,
      });
    if (input.services.telemetry) {
      const body = {
        schema_version: 2,
        event_id: randomUUID(),
        event: "daily_active",
        app_id: input.app.app_id,
        app_version: target.app_version,
        install_id: previewInstallId,
        platform: target.platform,
        arch: target.arch,
        sdk_version: "3.0.0",
        occurred_at: now.toISOString(),
      };
      check(validateAndSanitizePayload(body).ok, "INVALID_INPUT");
      requests.push({
        service: "telemetry",
        target: context,
        method: "POST",
        url: input.telemetry.url,
        headers: { "Content-Type": "application/json" },
        path_parameters: { app_id: input.app.app_id },
        query: null,
        body,
        expected_http_status: 202,
        expected_body: { ok: true },
      });
    }
  });
  return {
    schema_version: 1,
    status: "awaiting-customer-confirmation",
    confirmation_id: randomUUID(),
    generated_at: now.toISOString(),
    input_binding: hash([input, bound]),
    services: input.services,
    app: input.app,
    requests,
    defaults: {
      ...(input.services.update
        ? {
            update: {
              timeout_ms: 5000,
              startup_check: true,
              manual_check: true,
              periodic_check_minutes: 0,
              delivery: "external-link",
            },
          }
        : {}),
      ...(input.services.telemetry
        ? {
            telemetry: {
              timeout_ms: 2000,
              day_timezone: "Asia/Shanghai",
              max_attempts_per_day: 1,
              retry: false,
              retention_days: 30,
            },
          }
        : {}),
    },
    credential_verification: input.services.update
      ? "local-role-app-code-binding-only; cloud-auth-not-tested"
      : "not-required",
    sample_identity:
      "preview-only-random-UUIDs; never persist as production identity",
    cloud_requests: 0,
    customer_confirmed: false,
  };
}
export function publicPreview(result) {
  const output = structuredClone(result);
  delete output.input_binding;
  for (const r of output.requests || [])
    if (r.service === "update") {
      r.headers["x-app-key"] = "<从私有文件读取；不回显>";
      r.headers["x-app-secret"] = "<从私有文件读取；不回显>";
    }
  return output;
}
export async function runConfirmation(argv, { print = console.log } = {}) {
  const [mode, ...args] = argv;
  check(["init", "preview"].includes(mode), "INVALID_COMMAND");
  if (mode === "init") {
    check(args.length === 0, "INVALID_ARGUMENTS");
    const file = await createIntake(
      JSON.parse(await readFile(TEMPLATE, "utf8")),
      "integration-input.json",
    );
    print(
      JSON.stringify({
        status: "input-created",
        file,
        contains_credentials: false,
      }),
    );
    return;
  }
  check(
    args.length === 2 && args[0] === "--file" && typeof args[1] === "string",
    "INVALID_ARGUMENTS",
  );
  const file = resolve(args[1]),
    input = await readPrivate(file);
  const fields = validateConfirmation(input);
  if (fields.length) {
    print(JSON.stringify({ status: "needs-input", fields, cloud_requests: 0 }));
    return;
  }
  let credentials = [];
  if (input.services.update)
    credentials = input.update.credentials_file
      ? (await readPrivate(input.update.credentials_file)).version_credentials
      : input.update.credentials;
  const result = prepareConfirmation(input, credentials);
  if (result.status === "needs-input") {
    print(JSON.stringify(result));
    return;
  }
  const artifact = join(
    dirname(file),
    "request-examples-" + result.confirmation_id + ".json",
  );
  await writePrivate(artifact, result);
  print(
    JSON.stringify(
      { ...publicPreview(result), private_request_examples_file: artifact },
      null,
      2,
    ),
  );
}
if (
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(resolve(process.argv[1])).href.toLowerCase()
) {
  runConfirmation(process.argv.slice(2)).catch((e) => {
    console.error(JSON.stringify(safeFailure(e)));
    process.exitCode = 1;
  });
}
