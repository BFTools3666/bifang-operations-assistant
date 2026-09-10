import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createApplicationVersionDeploymentPlan,
  planApplicationVersionDeployment,
} from "../cloudbase/plan-application-version-api-deployment.mjs";

const ENV_ID = "bifang-telemetry-prod-d8efa6a8d3";
const ORIGIN =
  "https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com";
const KEY = "test-management-key-never-deployed";
const SECRET = "test-management-secret-never-deployed";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function registry() {
  return {
    schema_version: 2,
    apps: [
      { app_id: "bifang-mouse-clicker", platforms: ["windows"] },
      {
        app_id: "bifang-screen-recorder",
        platforms: ["windows", "macos"],
      },
    ],
  };
}

function credentialsBase64(credentialCount = 1) {
  return Buffer.from(
    JSON.stringify({
      schema_version: 1,
      credentials: Array.from({ length: credentialCount }, (_, index) => {
        const suffix = index === 0 ? "" : `-${index}`;
        return {
          credential_id: `e2e-runtime-2026-09${suffix}`,
          key_sha256: sha256(index === 0 ? KEY : `${KEY}${suffix}`),
          secret_sha256: [sha256(index === 0 ? SECRET : `${SECRET}${suffix}`)],
          app_id: "bifang-mouse-clicker",
          codes: ["original-tool"],
          scopes: ["versions:check", "ads:show"],
        };
      }),
    }),
    "utf8",
  ).toString("base64");
}

test("the service-only plan freezes one v1 route and all per-app collections", () => {
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    credentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN },
  );

  assert.equal(plan.mode, "service-only-preview");
  assert.equal(plan.requires_stage_4_confirmation, true);
  assert.equal(plan.env_id, ENV_ID);
  assert.equal(plan.base_url, `${ORIGIN}/tools/version-control/v1`);
  assert.equal(plan.resources.function, "application-version-api");
  assert.equal(plan.resources.route.path, "/tools/version-control/v1");
  assert.equal(plan.resources.route.path.includes("/v1/v1"), false);
  assert.deepEqual(plan.function_environment_budget, {
    estimated_utf8_bytes: plan.function_environment_budget.estimated_utf8_bytes,
    enforced_maximum_bytes: 3_584,
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
    /absent or empty/,
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
  assert.match(routePreflight.instruction, /exact path .* to be absent/);
  const routePreflightBody = JSON.parse(
    routePreflight.argv[routePreflight.argv.indexOf("--body") + 1],
  );
  assert.deepEqual(routePreflightBody.Filters, [
    { Name: "Domain", Values: [new URL(ORIGIN).hostname] },
  ]);
  assert.match(
    plan.read_only_preflight.find(({ resource }) => resource === "functions")
      .instruction,
    /function with that exact name already exists.*do not overwrite/i,
  );
  assert.doesNotMatch(
    JSON.stringify(plan.read_only_preflight),
    /VerifyHTTPServiceRoute/,
  );
});

test("credential material is validated but only a fingerprint and binding summary are emitted", () => {
  const encoded = credentialsBase64();
  const plan = createApplicationVersionDeploymentPlan(registry(), encoded, {
    envId: ENV_ID,
    origin: ORIGIN,
  });

  assert.equal(plan.credential_config_sha256, sha256(encoded));
  assert.deepEqual(plan.credential_bindings, [
    {
      credential_id: "e2e-runtime-2026-09",
      app_id: "bifang-mouse-clicker",
      codes: ["original-tool"],
      scopes: ["versions:check", "ads:show"],
      secret_versions: 1,
    },
  ]);
  const serialized = JSON.stringify(plan);
  assert.doesNotMatch(serialized, new RegExp(KEY));
  assert.doesNotMatch(serialized, new RegExp(SECRET));
  assert.doesNotMatch(serialized, /key_sha256|secret_sha256/);
});

test("the plan contains no broad, delete, force, telemetry, hosting, or dashboard writes", () => {
  const plan = createApplicationVersionDeploymentPlan(
    registry(),
    credentialsBase64(),
    { envId: ENV_ID, origin: ORIGIN },
  );
  const commands = plan.write_steps_after_confirmation
    .filter(({ kind }) => kind === "command")
    .map(({ argv }) => argv);
  assert.deepEqual(commands[0], [
    "tcb",
    "fn",
    "deploy",
    "application-version-api",
    "--config-file",
    "cloudbaserc.json.example",
    "-e",
    ENV_ID,
  ]);
  assert.match(
    plan.write_steps_after_confirmation.find(
      ({ resource }) => resource === "function",
    ).output_policy,
    /sensitive deployment output/,
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
  for (const forbidden of ["--all", "--force", "--prune", "delete"]) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false);
  }

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

  const directory = await mkdtemp(join(tmpdir(), "bifang-version-plan-"));
  try {
    const credentialsFile = join(directory, "credentials.b64");
    await writeFile(credentialsFile, "not-base64", "utf8");
    await assert.rejects(
      planApplicationVersionDeployment({
        envId: ENV_ID,
        origin: ORIGIN,
        credentialsFile,
      }),
      /base64 text/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the plan rejects credential bindings before the SCF environment reaches 4KB", () => {
  assert.throws(
    () =>
      createApplicationVersionDeploymentPlan(registry(), credentialsBase64(8), {
        envId: ENV_ID,
        origin: ORIGIN,
      }),
    /3584-byte deployment safety limit/,
  );
});
