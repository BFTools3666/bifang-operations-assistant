import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  run,
  inspect,
  mutation,
} from "../cloudbase/personal/release-management.mjs";
import { prepareConfirmation } from "../cloudbase/personal/client-confirmation.mjs";
import handler from "../cloudbase/functions/application-version-api/src/handler.js";
import memory from "../cloudbase/functions/application-version-api/src/memory-repository.js";
import auth from "../cloudbase/functions/application-version-api/src/auth.js";

const code = "demo-win";
const app = "demo";
const target = {
  platform: "windows",
  arch: "x64",
  channel: "stable",
  app_version: "1.0",
  update_code: code,
  runtime_credential_id: "runtime",
};
const ctx = { app, code, current: "1.0", name: "演示" };
const older = {
  name: "演示",
  code,
  codeVersion: "2",
  downloadUrl: "https://downloads.example.com/app?private=url",
  promptContent: "有更新",
  updateContent: "说明",
  forcedUpdate: false,
  promptUpdate: true,
  stopUpdate: false,
  updateCriteria: "lt",
  versionCriteria: "1.5",
};
function fixture(simulate = (send) => send, extraTargets = []) {
  const scopes = {
    runtime: ["versions:check"],
    managementRead: ["versions:read", "ads:read"],
    managementWrite: ["versions:write", "ads:write"],
  };
  const keys = Object.keys(scopes).map((role) => ({
    role,
    credential_id: role.toLowerCase(),
    app_id: app,
    codes: [code],
    app_key: role + "-key",
    app_secret: role + "-secret",
  }));
  for (const t of extraTargets)
    keys.push({
      ...keys[0],
      credential_id: t.runtime_credential_id,
      codes: [t.update_code],
      app_key: t.update_code + "-key",
      app_secret: t.update_code + "-secret",
    });
  const input = {
    schema_version: 1,
    purpose: "personal-client-integration-confirmation",
    services: { update: true, telemetry: false },
    app: { app_id: app, display_name: "演示" },
    targets: [target, ...extraTargets],
    update: {
      protocol: "application-version-api-v1",
      base_url: "https://demo.example.com/tools/version-control/v1",
      credentials_file: "creds",
      credentials: [],
    },
    telemetry: {},
  };
  const files = new Map([
    [resolve("input"), input],
    [resolve("evidence"), prepareConfirmation(input, keys)],
    ["creds", { version_credentials: keys }],
  ]);
  const api = handler.createHandler({
    applications: [
      {
        appId: app,
        versionCollection: "versions_demo",
        adCollection: "ads_demo",
        auditCollection: "audit_demo",
      },
    ],
    credentials: {
      schema_version: 1,
      credentials: keys.map((k) => ({
        credential_id: k.credential_id,
        app_id: app,
        codes: k.codes,
        key_sha256: auth.hashCredential(k.app_key),
        secret_sha256: [auth.hashCredential(k.app_secret)],
        scopes: scopes[k.role],
      })),
    },
    repository: memory.createMemoryRepository(),
    rateLimiter: () => ({ allowed: true }),
    logger: { error: () => assert.fail("unexpected service failure") },
  });
  const writes = [];
  async function send(scope, role, method, suffix, body) {
    const k = keys.find((k) => k.role === role);
    const url = new URL(input.update.base_url + "/versions" + suffix);
    const res = await api({
      httpMethod: method,
      path: url.pathname,
      rawQueryString: url.search.slice(1),
      headers: {
        "x-app-key": k.app_key,
        "x-app-secret": k.app_secret,
        "Content-Type": "application/json",
      },
      body: body && JSON.stringify(body),
    });
    if (method !== "GET") writes.push([method, suffix, res.statusCode]);
    return {
      status: res.statusCode,
      data: res.body ? JSON.parse(res.body) : undefined,
    };
  }
  const transport = simulate(send);
  const process = (args) =>
    run(args, {
      send: transport,
      read: async (f) => structuredClone(files.get(f)),
      write: async (f, v) => {
        assert.ok(!files.has(f));
        files.set(f, structuredClone(v));
      },
    });
  const status = (current = "1.0") =>
    process([
      "inspect",
      "--input",
      "input",
      "--evidence",
      "evidence",
      "--code",
      code,
      "--current",
      current,
    ]);
  async function plan(action, fields = {}) {
    const { snapshot } = await status();
    const { form } = await process([
      "prepare",
      "--snapshot",
      snapshot,
      "--action",
      action,
    ]);
    Object.assign(files.get(form).release, fields);
    return process([
      "plan",
      "--snapshot",
      snapshot,
      "--action",
      action,
      "--form",
      form,
    ]);
  }
  const apply = (p) =>
    process(["apply", "--plan", p.plan, "--confirm", p.confirm]);
  return { status, plan, apply, process, files, writes };
}
test("empty stream, first publish, inspect details, promote, cancel and reset use the deployed HTTP contract", async () => {
  const f = fixture();
  assert.equal((await f.status()).release, null);
  const first = await f.plan("new", older);
  assert.equal(first.method, "POST");
  assert.equal(f.writes.length, 0);
  await assert.rejects(
    f.process(["apply", "--plan", first.plan, "--confirm", "wrong"]),
    /PLAN_CONFIRMATION_REQUIRED/,
  );
  const created = await f.apply(first);
  assert.equal(created.status, "verified");
  assert.equal(created.runtime.promptUpdate, true);
  assert.ok(!JSON.stringify(created).includes("private=url"));
  const current = await f.status("1.9");
  assert.equal(current.release.promptUpdate, true);
  assert.equal(current.runtime.update, false);
  const force = await f.plan("force");
  assert.equal(f.writes.length, 1);
  const promoted = await f.apply(force);
  assert.equal(promoted.runtime.forcedUpdate, true);
  assert.equal(promoted.release.versionCriteria, "1.5");
  assert.equal((await f.apply(force)).action, "already-matches");
  assert.equal(
    (await f.apply(await f.plan("cancel"))).runtime.stopUpdate,
    true,
  );
  assert.equal(
    (
      await f.apply(
        await f.plan("reset", { ...older, promptContent: "新提示" }),
      )
    ).runtime.promptUpdate,
    true,
  );
  const newest = await f.apply(
    await f.plan("new", { ...older, codeVersion: "10", promptContent: "新版" }),
  );
  assert.equal(newest.release.codeVersion, "10");
  assert.deepEqual(
    f.writes.map((w) => w[0]),
    ["POST", "PUT", "PUT", "PUT", "POST"],
  );
});
test("changes to the form or a newer live release invalidate a previously approved plan", async () => {
  const f = fixture();
  await f.apply(await f.plan("new", older));
  const force = await f.plan("force");
  const form = f.files.get(force.plan).form;
  f.files.get(form).release.promptContent = "改动";
  await assert.rejects(f.apply(force), /FORM_CHANGED_REPLAN/);
  const cancel = await f.plan("cancel");
  await f.apply(await f.plan("new", { ...older, codeVersion: "10" }));
  await assert.rejects(f.apply(cancel), /REMOTE_CHANGED_REPLAN/);
  assert.equal(f.writes.length, 2);
});
test("a lost write response followed by a failed readback can be verified without replay", async () => {
  let disrupt = true,
    failNextRead = false;
  const f = fixture((send) => async (...args) => {
    if (failNextRead) {
      failNextRead = false;
      throw new Error("OFFLINE");
    }
    const reply = await send(...args);
    if (disrupt && args[2] === "POST") {
      disrupt = false;
      failNextRead = true;
      throw new Error("TIMEOUT");
    }
    return reply;
  });
  const plan = await f.plan("new", older);
  const uncertain = await f.apply(plan);
  assert.equal(uncertain.status, "awaiting-verification");
  assert.equal(uncertain.writeStatus, "unknown");
  assert.ok(f.files.has(uncertain.receipt));
  const verified = await f.process(["verify", "--plan", plan.plan]);
  assert.equal(verified.status, "verified");
  assert.equal(f.writes.length, 1);
});
test("an explicit mode change goes straight to a reviewable target-specific plan, and a no-op skips writing", async () => {
  const f = fixture();
  const inspectArgs = [
    "inspect",
    "--input",
    "input",
    "--evidence",
    "evidence",
    "--platform",
    "windows",
  ];
  const empty = await f.process(inspectArgs);
  const nothing = await f.process([
    "review",
    "--snapshot",
    empty.snapshot,
    "--action",
    "cancel",
  ]);
  assert.equal(nothing.status, "unchanged-at-inspection");
  await f.apply(await f.plan("new", older));
  const { snapshot } = await f.process(inspectArgs);
  const review = await f.process([
    "review",
    "--snapshot",
    snapshot,
    "--action",
    "force",
  ]);
  assert.equal(review.status, "awaiting-confirmation");
  assert.deepEqual(review.changedFields.sort(), [
    "release.forcedUpdate",
    "release.promptUpdate",
  ]);
  assert.equal(f.writes.length, 1);
  const result = await f.apply(review);
  assert.equal(result.runtime.forcedUpdate, true);
  const actual = await f.process(inspectArgs);
  assert.equal(
    (
      await f.process([
        "review",
        "--snapshot",
        actual.snapshot,
        "--action",
        "force",
      ])
    ).status,
    "unchanged-at-inspection",
  );
  assert.equal(
    (
      await f.process([
        "review",
        "--snapshot",
        actual.snapshot,
        "--action",
        "reset",
      ])
    ).status,
    "awaiting-changes",
  );
  assert.equal(f.writes.length, 2);
});
test("known facts prefill a new release; missing or invalid fields are returned together and the same file can be reviewed", async () => {
  const f = fixture();
  const { snapshot } = await f.status();
  const args = ["review", "--snapshot", snapshot, "--action", "new"];
  const first = await f.process(args);
  assert.deepEqual(first.fields, [
    "release.codeVersion",
    "release.downloadUrl",
  ]);
  const record = f.files.get(first.form).release;
  Object.assign(record, {
    codeVersion: "v2",
    downloadUrl: "bad",
    promptContent: "",
    promptUpdate: true,
    forcedUpdate: true,
  });
  const problems = await f.process(["review", "--form", first.form]);
  assert.deepEqual(
    new Set(problems.fields),
    new Set([
      "release.codeVersion",
      "release.downloadUrl",
      "release.promptContent",
      "release.promptUpdate",
      "release.forcedUpdate",
    ]),
  );
  Object.assign(record, older);
  assert.equal(
    (await f.process(["review", "--form", first.form])).status,
    "awaiting-confirmation",
  );
  f.files.set("facts", {
    snapshot,
    release: { codeVersion: "2", downloadUrl: older.downloadUrl },
  });
  const ready = await f.process([...args, "--facts-file", "facts"]);
  assert.equal(ready.status, "awaiting-confirmation");
  assert.equal(ready.after.promptContent, "有新版本可用。");
  assert.ok(!JSON.stringify(ready).includes("private=url"));
  f.files.get("facts").snapshot = "another-target";
  await assert.rejects(
    f.process([...args, "--facts-file", "facts"]),
    /FACTS_TARGET_OR_FIELDS_INVALID/,
  );
  assert.equal(f.writes.length, 0);
});
test("reset can remove both conditions and flags reuse of an old download for a higher version", async () => {
  const f = fixture();
  await f.apply(await f.plan("new", older));
  const { snapshot } = await f.status();
  f.files.set("facts", {
    snapshot,
    release: { codeVersion: "3", updateCriteria: null, versionCriteria: null },
  });
  const review = await f.process([
    "review",
    "--snapshot",
    snapshot,
    "--action",
    "reset",
    "--facts-file",
    "facts",
  ]);
  assert.equal(review.reusesPreviousDownload, true);
  assert.deepEqual(review.changedFields.sort(), [
    "release.codeVersion",
    "release.updateCriteria",
    "release.versionCriteria",
  ]);
  assert.equal((await f.apply(review)).release.versionCriteria, undefined);
});
test("ambiguous targets require one selection before any remote access", async () => {
  let requests = 0;
  const f = fixture(
    (send) =>
      async (...args) => {
        requests++;
        return send(...args);
      },
    [
      {
        ...target,
        arch: "arm64",
        runtime_credential_id: "other",
        update_code: "demo-arm",
      },
    ],
  );
  const args = [
    "inspect",
    "--input",
    "input",
    "--evidence",
    "evidence",
    "--platform",
    "windows",
  ];
  await assert.rejects(f.process(args), (e) => {
    assert.equal(e.message, "SELECT_ONE_STREAM");
    assert.deepEqual(
      e.choices.map(({ choice, arch }) => [choice, arch]),
      [
        ["1", "x64"],
        ["4", "arm64"],
      ],
    );
    return true;
  });
  assert.equal(requests, 0);
  assert.equal((await f.process([...args, "--arch", "x64"])).target.code, code);
});
test("a runtime failure preserves management details for reading but cannot produce an actionable plan", async () => {
  let fail = false;
  const f = fixture(
    (send) =>
      async (...args) =>
        fail && args[1] === "runtime" ? { status: 429 } : send(...args),
  );
  await f.apply(await f.plan("new", older));
  fail = true;
  const partial = await f.status();
  assert.equal(partial.status, "runtime-unverified");
  assert.equal(partial.release.codeVersion, "2");
  assert.equal(partial.runtime, null);
  assert.equal(partial.runtimeHttp, 429);
  await assert.rejects(
    f.process(["review", "--snapshot", partial.snapshot, "--action", "cancel"]),
    /RUNTIME_RECHECK_REQUIRED/,
  );
  assert.equal(f.writes.length, 1);
});
test("request failures do not certify an empty stream and mode switches preserve other fields", async () => {
  await assert.rejects(
    inspect(ctx, async () => ({ status: 403 })),
    /LIST_HTTP_403/,
  );
  await assert.rejects(
    inspect(ctx, async () => ({
      status: 200,
      data: {
        result: { total: 1, datas: [] },
        page: { current: 1, size: 100, total_page: 1 },
      },
    })),
    /LIST_INCOMPLETE/,
  );
  const record = { id: "1000000000000000000", ...older };
  assert.throws(
    () =>
      mutation(ctx, record, "cancel", {
        ...older,
        promptUpdate: false,
        stopUpdate: true,
        promptContent: "changed",
      }),
    /ACTION_ONLY_CHANGES_MODE/,
  );
  assert.throws(
    () => mutation(ctx, record, "reset", { ...older, codeVersion: "1.8" }),
    /HIGHER_VERSION_REQUIRED/,
  );
});
