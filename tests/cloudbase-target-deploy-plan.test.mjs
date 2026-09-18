import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppDeploymentPlan,
  planAppDeployment,
} from "../cloudbase/plan-app-deployment.mjs";

const ENV_ID = "bftoos-sh-d3ga7hahz59229f0a";
const ORIGIN =
  "https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com";

const releaseStream = (platform, architecture, code) => ({
  platform,
  architecture,
  channel: "stable",
  code,
});

function registry() {
  return {
    schema_version: 3,
    apps: [
      {
        app_id: "bifang-tools",
        release_streams: [releaseStream("windows", "x64", "bifang-tools")],
      },
      {
        app_id: "bifang-screen-recorder",
        release_streams: [
          releaseStream("windows", "x64", "bifang-screen-recorder-windows-x64"),
          releaseStream("macos", "arm64", "bifang-screen-recorder-macos-arm64"),
        ],
      },
    ],
  };
}

test("the target-only plan contains telemetry writes for only the selected app", () => {
  const plan = createAppDeploymentPlan(registry(), "bifang-screen-recorder", {
    envId: ENV_ID,
    origin: ORIGIN,
  });

  assert.equal(plan.schema_version, 2);
  assert.equal(plan.mode, "telemetry-target-only-preview");
  assert.equal(plan.requires_stage_4_confirmation, true);
  assert.equal(plan.env_id, ENV_ID);
  assert.equal(plan.app_id, "bifang-screen-recorder");
  assert.deepEqual(plan.excluded_app_ids, ["bifang-tools"]);
  assert.equal(plan.resources.function, "telemetry-bifang-screen-recorder");
  assert.equal(plan.resources.collection, "telemetry_bifang_screen_recorder");
  assert.equal(plan.resources.collection_permission, "ADMINONLY");
  assert.deepEqual(plan.resources.collection_indexes, [
    {
      name: "expires_at_ttl",
      key: { expires_at: 1 },
      expireAfterSeconds: 0,
    },
  ]);
  assert.deepEqual(
    plan.release_streams.map(({ code }) => code),
    [
      "bifang-screen-recorder-windows-x64",
      "bifang-screen-recorder-macos-arm64",
    ],
  );

  const commands = plan.write_steps_after_confirmation
    .filter(({ kind }) => kind === "command")
    .map(({ argv }) => argv);
  assert.deepEqual(commands[1], [
    "tcb",
    "fn",
    "deploy",
    "telemetry-bifang-screen-recorder",
    "--config-file",
    "cloudbaserc.example.json",
    "-e",
    ENV_ID,
    "--json",
  ]);
  assert.equal(commands.length, 3);
  for (const argv of commands) {
    assert.equal(argv.includes("--all"), false);
    assert.equal(argv.includes("--force"), false);
    assert.equal(argv.includes("--prune"), false);
    assert.equal(argv.includes("bifang-tools"), false);
    assert.equal(argv.includes("hosting"), false);
    assert.equal(argv.includes("application-version-api"), false);
  }
  assert.equal(JSON.stringify(plan).includes("manifest"), false);
});

test("the target-only plan creates and verifies the exact telemetry TTL index", () => {
  const plan = createAppDeploymentPlan(registry(), "bifang-screen-recorder", {
    envId: ENV_ID,
    origin: ORIGIN,
  });
  const createStep = plan.write_steps_after_confirmation.find(
    ({ resource }) => resource === "collection-index",
  );
  assert.deepEqual(createStep.argv.slice(0, 5), [
    "tcb",
    "db",
    "nosql",
    "execute",
    "--command",
  ]);
  assert.equal(createStep.argv[createStep.argv.indexOf("-e") + 1], ENV_ID);
  const createCommands = JSON.parse(
    createStep.argv[createStep.argv.indexOf("--command") + 1],
  );
  assert.equal(createCommands.length, 1);
  assert.equal(createCommands[0].TableName, "telemetry_bifang_screen_recorder");
  assert.equal(createCommands[0].CommandType, "COMMAND");
  assert.deepEqual(JSON.parse(createCommands[0].Command), {
    createIndexes: "telemetry_bifang_screen_recorder",
    indexes: [
      {
        name: "expires_at_ttl",
        key: { expires_at: 1 },
        expireAfterSeconds: 0,
      },
    ],
  });

  const verifyStep = plan.post_write_verification.find(
    ({ resource } = {}) => resource === "collection-index",
  );
  const verifyCommands = JSON.parse(
    verifyStep.argv[verifyStep.argv.indexOf("--command") + 1],
  );
  assert.deepEqual(JSON.parse(verifyCommands[0].Command), {
    listIndexes: "telemetry_bifang_screen_recorder",
    cursor: {},
  });
  assert.match(verifyStep.success_condition, /expires_at_ttl/);
  assert.match(verifyStep.success_condition, /expires_at:1/);
  assert.match(verifyStep.success_condition, /expireAfterSeconds:0/);
});

test("the target-only route command uses the exact default domain and isolated telemetry function", () => {
  const plan = createAppDeploymentPlan(registry(), "bifang-screen-recorder", {
    envId: ENV_ID,
    origin: ORIGIN,
  });
  const routeStep = plan.write_steps_after_confirmation.find(
    ({ resource }) => resource === "route",
  );
  assert.deepEqual(routeStep.argv.slice(0, 6), [
    "tcb",
    "api",
    "tcb",
    "CreateHTTPServiceRoute",
    "--api-version",
    "2018-06-08",
  ]);
  const routeData = JSON.parse(
    routeStep.argv[routeStep.argv.indexOf("--body") + 1],
  );

  assert.equal(
    routeData.Domain.Domain,
    "bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com",
  );
  assert.equal(routeData.EnvId, ENV_ID);
  assert.equal(
    routeData.Domain.Routes[0].Path,
    "/apps/bifang-screen-recorder/v1/track",
  );
  assert.equal(routeData.Domain.Routes[0].UpstreamResourceType, "SCF");
  assert.equal(
    routeData.Domain.Routes[0].UpstreamResourceName,
    "telemetry-bifang-screen-recorder",
  );
  assert.deepEqual(routeData.Domain.Routes[0].QPSPolicy, {
    QPSTotal: 100,
    QPSPerClient: { LimitBy: "ClientIP", LimitValue: 10 },
  });
});

test("the deployment preview rejects unknown apps and unsafe target values", () => {
  assert.throws(
    () =>
      createAppDeploymentPlan(registry(), "unknown-tool", {
        envId: ENV_ID,
        origin: ORIGIN,
      }),
    /not registered/,
  );
  assert.throws(
    () =>
      createAppDeploymentPlan(registry(), "bifang-screen-recorder", {
        envId: "$(unsafe)",
        origin: ORIGIN,
      }),
    /environment id/,
  );
  for (const origin of [
    "http://example.com",
    "https://user:password@example.tcloudbaseapp.com",
    "https://example.tcloudbaseapp.com",
    "https://example.com",
    `${ORIGIN}/unexpected-path`,
  ]) {
    assert.throws(
      () =>
        createAppDeploymentPlan(registry(), "bifang-screen-recorder", {
          envId: ENV_ID,
          origin,
        }),
      /default HTTPS origin/,
    );
  }
});

test("the checked-in target plan is telemetry-only", async () => {
  const plan = await planAppDeployment("bifang-screen-recorder", {
    envId: ENV_ID,
    origin: ORIGIN,
  });

  assert.equal(plan.app_id, "bifang-screen-recorder");
  assert.equal(plan.mode, "telemetry-target-only-preview");
  assert.deepEqual(Object.keys(plan.resources).sort(), [
    "collection",
    "collection_indexes",
    "collection_permission",
    "function",
    "route",
  ]);
  assert.equal(
    plan.write_steps_after_confirmation.some(
      ({ resource }) => resource === "function" || resource === "route",
    ),
    true,
  );
});
