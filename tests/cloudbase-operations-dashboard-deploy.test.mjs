import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  createDeploymentMaterialsSummary,
  createDeploymentPlan,
  deployOperationsDashboard,
  filterDashboardAppsEnvironment,
  parseSecretFile,
} from "../cloudbase/deploy-operations-dashboard.mjs";
import { verifyOperationsDashboard } from "../cloudbase/verify-operations-dashboard.mjs";

const METRICS_TOKEN = "m".repeat(64);
const ACCESS_TOKEN = "a".repeat(64);

test("dashboard deploy secret parser returns only hashes and rejects unsafe input", () => {
  const parsed = parseSecretFile(
    [
      `CLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}`,
      `DASHBOARD_ACCESS_TOKEN="${ACCESS_TOKEN}"`,
      "COOKIE_SECURE=true",
    ].join("\n"),
  );
  assert.equal(parsed.metricsTokenBytes, 64);
  assert.equal(parsed.accessTokenBytes, 64);
  assert.match(parsed.metricsTokenHash, /^[0-9a-f]{64}$/);
  assert.match(parsed.accessTokenHash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(parsed).includes(METRICS_TOKEN), false);
  assert.equal(JSON.stringify(parsed).includes(ACCESS_TOKEN), false);

  assert.throws(
    () =>
      parseSecretFile(
        `CLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}\nDASHBOARD_ACCESS_TOKEN=${METRICS_TOKEN}`,
      ),
    /must be distinct/,
  );
  assert.throws(
    () =>
      parseSecretFile(
        `CLOUDBASE_METRICS_TOKEN=short\nDASHBOARD_ACCESS_TOKEN=${ACCESS_TOKEN}`,
      ),
    /32-256/,
  );
  assert.throws(
    () =>
      parseSecretFile(
        `CLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}\nCLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}\nDASHBOARD_ACCESS_TOKEN=${ACCESS_TOKEN}`,
      ),
    /repeats/,
  );
});

test("dashboard deployment preview binds the reviewed bytes and has no delete step", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bifang-dashboard-plan-test-"),
  );
  const secretFile = join(directory, ".env.server.local");
  try {
    await writeFile(
      secretFile,
      `CLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}\nDASHBOARD_ACCESS_TOKEN=${ACCESS_TOKEN}\n`,
      "utf8",
    );
    const plan = await createDeploymentPlan({
      envId: "bftoos-sh-d3ga7hahz59229f0a",
      secretFile,
    });
    assert.equal(plan.requires_confirmation, true);
    assert.equal(plan.function.name, "operations-dashboard-api");
    assert.equal(plan.function.action, "update-in-place");
    assert.equal(plan.route.path, "/dashboard");
    assert.deepEqual(plan.deletes, []);
    assert.match(plan.materials.sha256, /^[0-9a-f]{64}$/);
    assert.equal(plan.materials.cli_version, "3.8.1");
    const serialized = JSON.stringify(plan);
    assert.equal(serialized.includes(METRICS_TOKEN), false);
    assert.equal(serialized.includes(ACCESS_TOKEN), false);

    const parsed = parseSecretFile(await readFile(secretFile, "utf8"));
    const summary = await createDeploymentMaterialsSummary(parsed);
    assert.deepEqual(summary, plan.materials);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard deployment can bind and filter an explicit app scope", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bifang-dashboard-scoped-plan-test-"),
  );
  const secretFile = join(directory, ".env.server.local");
  const selectedAppIds = ["bifang-screen-recorder", "bifang-vm-sync-agentless"];
  try {
    await writeFile(
      secretFile,
      `CLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}\nDASHBOARD_ACCESS_TOKEN=${ACCESS_TOKEN}\n`,
      "utf8",
    );
    const plan = await createDeploymentPlan({
      envId: "bftoos-sh-d3ga7hahz59229f0a",
      secretFile,
      appIds: selectedAppIds,
    });
    assert.deepEqual(plan.app_scope, selectedAppIds);
    assert.deepEqual(plan.materials.app_ids, selectedAppIds);

    const config = {
      envVariables: {
        DASHBOARD_APPS_JSON: JSON.stringify(
          JSON.stringify({
            schema_version: 2,
            apps: [
              ["bifang-screen-recorder", []],
              ["bifang-vm-sync-agentless", []],
              ["bifang-lan-file-transfer", []],
            ],
          }),
        ),
      },
    };
    filterDashboardAppsEnvironment(config, selectedAppIds);
    const filteredMapping = JSON.parse(
      JSON.parse(config.envVariables.DASHBOARD_APPS_JSON),
    );
    assert.equal(filteredMapping.schema_version, 2);
    assert.deepEqual(
      filteredMapping.apps.map(([appId]) => appId),
      selectedAppIds,
    );
    assert.throws(
      () => filterDashboardAppsEnvironment(config, ["missing-app"]),
      /mapping is missing/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dashboard deploy helper targets one function and passes only token hashes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bifang-dashboard-deploy-test-"),
  );
  const secretFile = join(directory, ".env.server.local");
  try {
    await writeFile(
      secretFile,
      `CLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}\nDASHBOARD_ACCESS_TOKEN=${ACCESS_TOKEN}\n`,
      "utf8",
    );
    const plan = await createDeploymentPlan({
      envId: "bftoos-sh-d3ga7hahz59229f0a",
      secretFile,
    });
    const calls = [];
    const fakeSpawn = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        if (args.includes("--version")) {
          child.stdout.end("CloudBase CLI 3.8.1\n");
        }
        child.emit("close", 0, null);
      });
      return child;
    };
    const result = await deployOperationsDashboard(
      {
        envId: "bftoos-sh-d3ga7hahz59229f0a",
        secretFile,
        expectedMaterialsSha256: plan.materials.sha256,
      },
      fakeSpawn,
    );
    assert.deepEqual(result, {
      status: "completed",
      function: "operations-dashboard-api",
    });
    assert.equal(calls.length, 2);
    const deployment = calls[1];
    assert.deepEqual(deployment.args.slice(1), [
      "fn",
      "deploy",
      "operations-dashboard-api",
      "--force",
      "--config-file",
      "cloudbaserc.dashboard.json",
      "-e",
      "bftoos-sh-d3ga7hahz59229f0a",
    ]);
    assert.match(
      deployment.options.env.DASHBOARD_TOKEN_SHA256,
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      deployment.options.env.DASHBOARD_ACCESS_TOKEN_SHA256,
      /^[0-9a-f]{64}$/,
    );
    assert.equal(
      JSON.stringify(deployment.options.env).includes(METRICS_TOKEN),
      false,
    );
    assert.equal(
      JSON.stringify(deployment.options.env).includes(ACCESS_TOKEN),
      false,
    );
    assert.equal(
      "APPLICATION_VERSION_CREDENTIALS_B64" in deployment.options.env,
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-deploy verifier covers the web session and preserved admin API without exposing tokens", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "bifang-dashboard-verify-test-"),
  );
  const secretFile = join(directory, ".env.server.local");
  const sessionCookie = "bifang_dashboard_session=v1.1.nonce.signature";
  const securityHeaders = {
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  const snapshot = {
    schemaVersion: 2,
    mode: "live",
    selectedAppId: "all",
    rangeDays: 7,
    appIds: ["bifang-tools"],
    appLabels: { "bifang-tools": "毕方小工具" },
    totals: { todayActive: 1 },
    trend: Array.from({ length: 7 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      total: index === 6 ? 1 : 0,
    })),
    releaseStreams: [],
  };
  const registry = {
    schema_version: 3,
    apps: [{ app_id: "bifang-tools", release_streams: [] }],
  };
  const calls = [];
  const fakeFetch = async (urlValue, init = {}) => {
    assert.equal(init.redirect, "error");
    const url = new URL(urlValue);
    const method = init.method || "GET";
    const headers = new Headers(init.headers || {});
    calls.push({ path: `${url.pathname}${url.search}`, method });
    if (url.pathname === "/dashboard") {
      return new Response('<script src="/dashboard/assets/app.js"></script>', {
        status: 200,
        headers: { ...securityHeaders, "Content-Type": "text/html" },
      });
    }
    if (url.pathname === "/dashboard/assets/app.js") {
      return new Response("const dashboard = true;", {
        status: 200,
        headers: { "Content-Type": "text/javascript" },
      });
    }
    if (url.pathname === "/dashboard/assets/styles.css") {
      return new Response("body {}", {
        status: 200,
        headers: { "Content-Type": "text/css" },
      });
    }
    if (url.pathname === "/dashboard/api/session" && method === "GET") {
      return Response.json({
        authenticated: headers.get("cookie") === sessionCookie,
      });
    }
    if (url.pathname === "/dashboard/api/session" && method === "POST") {
      const accessToken = JSON.parse(init.body).accessToken;
      if (accessToken !== ACCESS_TOKEN) {
        return Response.json(
          { error: "invalid_access_token" },
          { status: 401 },
        );
      }
      return Response.json(
        { ok: true },
        {
          headers: {
            "Set-Cookie": `${sessionCookie}; Path=/dashboard; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
          },
        },
      );
    }
    if (url.pathname === "/dashboard/api/session" && method === "DELETE") {
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": `${sessionCookie}; Max-Age=0` } },
      );
    }
    if (url.pathname === "/dashboard/api/metrics") {
      return headers.get("cookie") === sessionCookie
        ? Response.json(snapshot)
        : Response.json({ error: "authentication_required" }, { status: 401 });
    }
    if (url.pathname === "/admin/v1/metrics") {
      return headers.get("authorization") === `Bearer ${METRICS_TOKEN}`
        ? Response.json(snapshot)
        : Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    await writeFile(
      secretFile,
      `CLOUDBASE_METRICS_TOKEN=${METRICS_TOKEN}\nDASHBOARD_ACCESS_TOKEN=${ACCESS_TOKEN}\n`,
      "utf8",
    );
    const result = await verifyOperationsDashboard({
      origin: "https://dashboard.example.test",
      secretFile,
      registry,
      fetchImplementation: fakeFetch,
      waitImplementation: async () => {},
    });
    assert.equal(result.status, "passed");
    assert.equal(result.checks.length, 13);
    assert.equal(
      result.dashboard_url,
      "https://dashboard.example.test/dashboard",
    );
    assert.equal(JSON.stringify(result).includes(METRICS_TOKEN), false);
    assert.equal(JSON.stringify(result).includes(ACCESS_TOKEN), false);
    assert.ok(
      calls.some(
        ({ path }) => path === "/dashboard/api/metrics?days=7&app_id=all",
      ),
    );
    assert.equal(
      result.checks.find(({ name }) => name === "authenticated_metrics")
        .named_application_count,
      1,
    );
    for (const appLabels of [
      undefined,
      {},
      { "bifang-tools": "bifang-tools" },
      { "bifang-tools": "其他中文名称" },
      { "bifang-tools": "毕方小工具", "unregistered-app": "额外工具" },
    ]) {
      snapshot.appLabels = appLabels;
      await assert.rejects(
        verifyOperationsDashboard({
          origin: "https://dashboard.example.test",
          secretFile,
          registry,
          fetchImplementation: fakeFetch,
          waitImplementation: async () => {},
        }),
        /incomplete or unreviewed application names/,
      );
    }
    snapshot.appLabels = { "bifang-tools": "毕方小工具" };
    const incompleteRegistry = {
      ...registry,
      apps: [
        ...registry.apps,
        { app_id: "bifang-screen-recorder", release_streams: [] },
      ],
    };
    await assert.rejects(
      verifyOperationsDashboard({
        origin: "https://dashboard.example.test",
        secretFile,
        registry: incompleteRegistry,
        fetchImplementation: fakeFetch,
        waitImplementation: async () => {},
      }),
      /incomplete or unreviewed application names/,
    );
    const stream = {
      platform: "windows",
      architecture: "x64",
      channel: "stable",
      code: "bifang-tools",
    };
    const streamRegistry = {
      ...registry,
      apps: [{ app_id: "bifang-tools", release_streams: [stream] }],
    };
    const verifyStreamRegistry = () =>
      verifyOperationsDashboard({
        origin: "https://dashboard.example.test",
        secretFile,
        registry: streamRegistry,
        fetchImplementation: fakeFetch,
        waitImplementation: async () => {},
      });
    for (const streams of [
      [],
      [{ ...stream, appId: "bifang-tools", code: "wrong-code" }],
      [
        { ...stream, appId: "bifang-tools" },
        { ...stream, appId: "bifang-tools" },
      ],
    ]) {
      snapshot.releaseStreams = streams;
      await assert.rejects(
        verifyStreamRegistry(),
        /incomplete or unreviewed release streams/,
      );
    }
    snapshot.releaseStreams = [{ ...stream, appId: "bifang-tools" }];
    assert.equal((await verifyStreamRegistry()).status, "passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
