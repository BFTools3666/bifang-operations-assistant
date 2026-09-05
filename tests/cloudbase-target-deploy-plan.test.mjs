import assert from "node:assert/strict";
import test from "node:test";

import {
  createAppDeploymentPlan,
  planAppDeployment,
} from "../cloudbase/plan-app-deployment.mjs";

const ENV_ID = "bifang-telemetry-prod-d8efa6a8d3";
const ORIGIN =
  "https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com";

function registry() {
  return {
    schema_version: 2,
    apps: [
      { app_id: "bifang-tools", platforms: ["windows"] },
      {
        app_id: "bifang-screen-recorder",
        platforms: ["windows", "macos"],
      },
    ],
  };
}

test("the target-only plan contains only the selected app write commands", () => {
  const plan = createAppDeploymentPlan(registry(), "bifang-screen-recorder", {
    envId: ENV_ID,
    origin: ORIGIN,
  });

  assert.equal(plan.mode, "target-only-preview");
  assert.equal(plan.requires_stage_4_confirmation, true);
  assert.equal(plan.env_id, ENV_ID);
  assert.equal(plan.app_id, "bifang-screen-recorder");
  assert.deepEqual(plan.excluded_app_ids, ["bifang-tools"]);
  assert.equal(plan.resources.function, "telemetry-bifang-screen-recorder");
  assert.equal(plan.resources.collection, "telemetry_bifang_screen_recorder");
  assert.equal(plan.resources.collection_permission, "ADMINONLY");
  assert.deepEqual(plan.resources.manifests, [
    "/updates/bifang-screen-recorder/windows.json",
    "/updates/bifang-screen-recorder/macos.json",
  ]);

  const commands = plan.write_steps_after_confirmation
    .filter(({ kind }) => kind === "command")
    .map(({ argv }) => argv);
  assert.deepEqual(commands[0], [
    "tcb",
    "fn",
    "deploy",
    "telemetry-bifang-screen-recorder",
    "--json",
  ]);
  assert.deepEqual(commands[2], [
    "tcb",
    "hosting",
    "deploy",
    "cloudbase/updates/bifang-screen-recorder/windows.json",
    "updates/bifang-screen-recorder/windows.json",
    "-e",
    ENV_ID,
    "--json",
  ]);
  assert.deepEqual(commands[3], [
    "tcb",
    "hosting",
    "deploy",
    "cloudbase/updates/bifang-screen-recorder/macos.json",
    "updates/bifang-screen-recorder/macos.json",
    "-e",
    ENV_ID,
    "--json",
  ]);
  for (const argv of commands) {
    assert.equal(argv.includes("--all"), false);
    assert.equal(argv.includes("--force"), false);
    assert.equal(argv.includes("--prune"), false);
    assert.equal(argv.includes("bifang-tools"), false);
  }
});

test("the target-only route command uses the exact default domain and isolated function", () => {
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
    "bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com",
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

test("the deployment preview rejects unknown apps, unsafe origins, and unsafe environment ids", () => {
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
    `${ORIGIN}/updates`,
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

test("the checked-in target plan passes all local registry and manifest gates", async () => {
  const plan = await planAppDeployment("bifang-screen-recorder", {
    envId: ENV_ID,
    origin: ORIGIN,
  });

  assert.equal(plan.app_id, "bifang-screen-recorder");
  assert.deepEqual(plan.resources.manifests, [
    "/updates/bifang-screen-recorder/windows.json",
    "/updates/bifang-screen-recorder/macos.json",
  ]);
});
