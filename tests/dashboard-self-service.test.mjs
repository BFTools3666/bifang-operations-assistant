import assert from "node:assert/strict";
import { mutation } from "../cloudbase/personal/release-management.mjs";
import { createSourceZip } from "../cloudbase/deploy-operations-dashboard-code.mjs";
import { matchesUploadedSource } from "../cloudbase/personal/deployed-source.mjs";
import test from "node:test";

test("upgrade readback compares all reviewed source files while allowing installed dependencies", () => {
  const file = (name, body) => ({ name, body: Buffer.from(body) });
  const index = file("index.js", "exports.main=()=>true");
  const src = createSourceZip([index]);
  assert.ok(matchesUploadedSource(src, src));
  assert.ok(
    matchesUploadedSource(
      src,
      createSourceZip([index, file("node_modules/demo/index.js", "ok")]),
    ),
  );
  assert.equal(
    matchesUploadedSource(src, createSourceZip([file("index.js", "other")])),
    false,
  );
  assert.equal(
    matchesUploadedSource(
      src,
      createSourceZip([index, file("handler.js", "other")]),
    ),
    false,
  );
});
import { createHash } from "node:crypto";
import dashboard from "../cloudbase/functions/operations-dashboard/src/handler.js";
import web from "../cloudbase/functions/operations-dashboard/src/web.js";
import service from "../cloudbase/functions/application-version-api/src/handler.js";
import memory from "../cloudbase/functions/application-version-api/src/memory-repository.js";
import {
  buildSpec,
  validateInput,
  createServiceSecrets,
} from "../cloudbase/personal/spec.mjs";
import { upgradeSettings } from "../cloudbase/personal/dashboard-upgrade.mjs";
import { prepare, apply } from "../cloudbase/personal/dashboard-upgrade.mjs";
import { createIntake } from "../cloudbase/personal/private-files.mjs";
import { dirname } from "node:path";
import { rm } from "node:fs/promises";
const hash = (s) => createHash("sha256").update(s).digest("hex");

test("old deployment is backed up, exact plan is enforced, applied and read back against a simulated control plane", async () => {
  const { input, df, vf } = await setup();
  vf.Environment.Variables = vf.Environment.Variables.filter(
    (v) => v.Key !== "DASHBOARD_RELEASE_TOKEN_SHA256",
  );
  const old = createSourceZip([{ name: "index.js", body: Buffer.from("old") }]);
  const functions = new Map(
    [df, vf].map((f) => [
      f.FunctionName,
      { ...f, ModTime: "original", zip: old },
    ]),
  );
  const writes = [];
  const simulated = {
    apiFactory: () => async (_s, action, p) => {
      const fn = functions.get(p.FunctionName);
      if (action === "GetFunction") return structuredClone(fn);
      writes.push(action);
      if (action === "UpdateFunctionCode")
        fn.zip = Buffer.from(p.Code.ZipFile, "base64");
      else if (action === "UpdateFunctionConfiguration") {
        fn.Environment = p.Environment;
        if (p.Description) fn.Description = p.Description;
      } else throw Error(action);
      fn.ModTime = String(writes.length);
      return {};
    },
    preflight: async () => {},
    sleep: async () => {},
    addressFor: async (_, name) => ({
      CodeSha256: hash(functions.get(name).zip),
      name,
    }),
    backupFor: async (address) => functions.get(address.name).zip,
  };
  const inputFile = await createIntake(input);
  try {
    const { plan, sha256 } = await prepare(["--file", inputFile], simulated);
    const args = [
      "--file",
      inputFile,
      "--plan",
      plan,
      "--expected-plan",
      sha256,
    ];
    assert.deepEqual(writes, []);
    await assert.rejects(
      apply([...args.slice(0, -1), "bad"], simulated),
      /PLAN_TARGET_MISMATCH/,
    );
    const live = functions.get(df.FunctionName);
    live.ModTime = "drift";
    await assert.rejects(apply(args, simulated), /CLOUD_BASELINE_CHANGED/);
    assert.deepEqual(writes, []);
    live.ModTime = "original";
    await apply(args, simulated);
    assert.deepEqual(writes, [
      "UpdateFunctionCode",
      "UpdateFunctionConfiguration",
      "UpdateFunctionCode",
    ]);
    await assert.rejects(apply(args, simulated), /CLOUD_BASELINE_CHANGED/);
  } finally {
    await rm(dirname(inputFile), { recursive: true, force: true });
  }
});
async function setup() {
  const stream = {
    platform: "windows",
    architecture: "x64",
    channel: "stable",
    code: "notes-win",
  };
  const input = {
    schema_version: 1,
    purpose: "personal-cloudbase-resource-creation",
    acknowledge_zero_cost_only: true,
    cloudbase: {
      env_id: "demo-notes",
      database_type: "postgresql",
      region: "ap-shanghai",
      http_origin: "",
    },
    credentials: {
      mode: "api-key",
      SecretId: "fake-cam-id",
      SecretKey: "fake-cam-secret",
      Token: "",
      expires_at: "",
    },
    resources: {
      telemetry: "missing",
      update: "missing",
      dashboard: "missing",
    },
    applications: [
      { app_id: "notes", display_name: "便签", release_streams: [stream] },
    ],
    existing_resource_overrides: [],
    existing_service_credentials_file: "",
  };
  const v = validateInput(input),
    secrets = createServiceSecrets(v),
    spec = await buildSpec(v, secrets);
  const fn = (name) => {
    const { payload } = spec.functions.find((f) => f.name === name);
    return { ...payload, Namespace: payload.EnvId, Status: "Active" };
  };
  const env = (f) =>
    Object.fromEntries(
      f.Environment.Variables.map(({ Key, Value }) => [Key, Value]),
    );
  const vf = fn("application-version-api"),
    df = fn("operations-dashboard-api"),
    ve = env(vf),
    de = env(df);
  const repository = memory.createMemoryRepository();
  const version = service.createHandler({
    repository,
    applications: ve.APPLICATION_VERSION_APPS_JSON,
    credentials: ve.APPLICATION_VERSION_CREDENTIALS_B64,
    dashboardTokenHash: ve.DASHBOARD_RELEASE_TOKEN_SHA256,
  });
  const handler = dashboard.createHandler({
    apps: de.DASHBOARD_APPS_JSON,
    appLabelsJson: de.DASHBOARD_APP_LABELS_JSON,
    webPath: "/dashboard",
    environmentId: input.cloudbase.env_id,
    accessTokenHash: de.DASHBOARD_ACCESS_TOKEN_SHA256,
    invokeRelease: (event) => version(event),
  });
  const cookie =
    "bifang_dashboard_session=" +
    web.createSession(
      hash(secrets.dashboard.DASHBOARD_ACCESS_TOKEN),
      Math.floor(Date.now() / 1000),
      () => Buffer.alloc(16, 1),
    );
  const send = async (body, headers = {}) => {
    const r = await handler({
      httpMethod: "POST",
      path: "/dashboard/api/releases",
      headers: {
        cookie,
        "content-type": "application/json",
        "x-dashboard-request": "release",
        ...headers,
      },
      body: JSON.stringify({ appId: "notes", code: "notes-win", ...body }),
    });
    return [r.statusCode, JSON.parse(r.body)];
  };
  return { send, repository, input, df, vf, version, secrets, handler };
}
test("dashboard session publishes, reads back, changes modes, edits, cancels and enforces stale confirmations", async () => {
  const { send, repository, version, secrets, handler } = await setup();
  assert.equal((await send({ stage: "details" }, { cookie: "" }))[0], 401);
  assert.equal(
    (await send({ stage: "details" }, { "sec-fetch-site": "same-site" }))[0],
    403,
  );
  assert.equal((await send({ stage: "details", appId: "other" }))[0], 400);
  assert.equal(
    (
      await version({
        dashboardRelease: { stage: "details" },
        dashboardToken: "0".repeat(64),
      })
    ).statusCode,
    403,
  );
  for (const path of ["/dashboard/releases", "/dashboard/assets/releases.js"]) {
    const r = await handler({ path, httpMethod: "GET" });
    assert.equal(r.statusCode, 200);
    assert.ok(!r.body.includes("__DASHBOARD_BASE_PATH__"));
  }
  const release = {
    name: "便签",
    code: "notes-win",
    codeVersion: "1.2",
    downloadUrl: "https://downloads.example.com/notes.exe",
    promptContent: "发现新版本",
    updateContent: "",
    forcedUpdate: false,
    promptUpdate: true,
    stopUpdate: false,
  };
  for (const [action, extra] of [
    ["new", { release }],
    ["force", {}],
    ["recommend", {}],
    ["cancel", {}],
    ["reset", { release: { ...release, updateContent: "更新说明" } }],
  ]) {
    const [status, state] = await send({ stage: "details" });
    assert.equal(status, 200);
    const payload = { action, ...extra, baseline: state.baseline };
    const [previewStatus, plan] = await send({ ...payload, stage: "preview" });
    assert.equal(previewStatus, 200);
    assert.equal(
      (await send({ ...payload, stage: "apply", proof: "wrong" }))[0],
      409,
    );
    const [saved, result] = await send({
      ...payload,
      stage: "apply",
      proof: plan.proof,
    });
    assert.equal(saved, 200, JSON.stringify(result));
    assert.deepEqual(result.record, plan.after);
    assert.equal(
      (await send({ ...payload, stage: "apply", proof: plan.proof }))[0],
      409,
    );
    const runtime = secrets.version_credentials.find(
      (c) => c.role === "runtime",
    );
    const response = await version({
      httpMethod: "GET",
      path: "/tools/version-control/v1/versions/notes-win/1.0",
      headers: {
        "x-app-key": runtime.app_key,
        "x-app-secret": runtime.app_secret,
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).forcedUpdate, action === "force");
    assert.equal(JSON.parse(response.body).stopUpdate, action === "cancel");
  }
  assert.equal(repository.snapshot("notes").audit.length, 5);
});
test("web forms and file settings produce identical drafts, writes and field corrections", async () => {
  const { send, repository } = await setup();
  const ctx = { name: "便签", code: "notes-win" };
  let top = null;
  const blank = {
    ...ctx,
    codeVersion: "",
    downloadUrl: "",
    promptContent: "有新版本可用。",
    updateContent: "",
    forcedUpdate: false,
    promptUpdate: true,
    stopUpdate: false,
  };
  for (const [action, edits, method] of [
    [
      "new",
      {
        codeVersion: "1.0",
        downloadUrl: "https://example.com/win",
        promptContent: "旧文案",
        updateContent: "旧说明",
        updateCriteria: "lt",
        versionCriteria: "1",
      },
      "POST",
    ],
    ["reset", { codeVersion: "1.0.0", name: "新名称" }, "PUT"],
    ["reset", { codeVersion: "2" }, "POST"],
    [
      "reset",
      {
        forcedUpdate: false,
        promptUpdate: false,
        stopUpdate: false,
        updateCriteria: null,
        versionCriteria: null,
      },
      "PUT",
    ],
    ["reset", {}, "NONE"],
  ]) {
    const [, state] = await send({ stage: "details" });
    assert.deepEqual(state.drafts.new, blank);
    assert.deepEqual(state.drafts.reset, state.record ?? blank);
    const release = { ...state.drafts[action], ...edits };
    if (release.updateCriteria === null) {
      delete release.updateCriteria;
      delete release.versionCriteria;
    }
    const expected = mutation(ctx, top, action, release);
    assert.equal(expected.method, method);
    const req = { action, release, baseline: state.baseline };
    const [status, plan] = await send({ ...req, stage: "preview" });
    assert.equal(status, 200);
    assert.deepEqual(plan.after, expected.body);
    assert.equal(plan.method, method);
    const [saved, result] = await send({
      ...req,
      stage: "apply",
      proof: plan.proof,
    });
    assert.equal(saved, 200);
    if (top) assert.equal(result.id === top.id, method !== "POST");
    top = { id: result.id, ...result.record };
  }
  assert.equal(repository.snapshot("notes").audit.length, 4);
  const [, state] = await send({ stage: "details" });
  for (const edits of [
    { codeVersion: "1" },
    { downloadUrl: "http://example.com", promptContent: "" },
    { updateCriteria: "gt" },
    { forcedUpdate: true, stopUpdate: true },
  ]) {
    const release = { ...state.record, ...edits };
    const [status, body] = await send({
      action: "reset",
      release,
      stage: "preview",
      baseline: state.baseline,
    });
    assert.equal(status, 400);
    assert.throws(
      () => mutation(ctx, top, "reset", release),
      (error) =>
        error.fields.length > 0 &&
        error.fields.every((field) => body.error.includes(field)),
    );
  }
});
test("existing personal installation upgrades preserve credentials and restore the missing release binding", async () => {
  const { input, df, vf } = await setup();
  const without = (f, k) => {
    f.Environment.Variables = f.Environment.Variables.filter(
      (x) => x.Key !== k,
    );
  };
  without(vf, "DASHBOARD_RELEASE_TOKEN_SHA256");
  without(df, "DASHBOARD_APP_LABELS_JSON");
  df.Description = "personal-onboarding:" + "0".repeat(40);
  const plan = upgradeSettings(input, df, vf, { notes: "便签" });
  assert.deepEqual(plan.targets, [{ appId: "notes", code: "notes-win" }]);
  assert.equal(
    plan.version.Environment.Variables.find(
      (x) => x.Key === "APPLICATION_VERSION_CREDENTIALS_B64",
    ).Value,
    vf.Environment.Variables.find(
      (x) => x.Key === "APPLICATION_VERSION_CREDENTIALS_B64",
    ).Value,
  );
  assert.match(plan.dashboard.Description, /labels-v1/);
  assert.ok(
    plan.version.Environment.Variables.some(
      (x) => x.Key === "DASHBOARD_RELEASE_TOKEN_SHA256",
    ),
  );
  assert.throws(() =>
    upgradeSettings(input, df, { ...vf, Namespace: "foreign" }),
  );
});
