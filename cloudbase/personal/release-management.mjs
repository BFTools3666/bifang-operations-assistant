import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual as equal, parseArgs } from "node:util";
import { check, readPrivate, writePrivate } from "./private-files.mjs";
import { prepareConfirmation } from "./client-confirmation.mjs";
import { hash } from "./spec.mjs";
import validation from "../functions/application-version-api/src/validation.js";
import version from "../functions/application-version-api/src/version.js";

const modes = {
  force: { forcedUpdate: true, promptUpdate: false, stopUpdate: false },
  recommend: { forcedUpdate: false, promptUpdate: true, stopUpdate: false },
  cancel: { forcedUpdate: false, promptUpdate: false, stopUpdate: true },
};
const { compareDottedVersions, createVersionCheckResponse } = version;
function publicRecord(record) {
  if (!record) return null;
  // Full URLs (including opaque path tokens) stay in the private review file.
  return { ...record, downloadUrl: new URL(record.downloadUrl).origin + "/…" };
}
function cleanBody(value) {
  const { versionKey, ...body } = validation.validateVersionWrite(value);
  return body;
}
function releaseBody(record) {
  const { id, ...body } = record;
  return body;
}
const key = (ctx, role) => {
  const found = ctx.keys.filter(
    (k) =>
      k.role === role &&
      k.app_id === ctx.app &&
      Array.isArray(k.codes) &&
      k.codes.includes(ctx.code) &&
      (role !== "runtime" ||
        k.credential_id === ctx.target.runtime_credential_id),
  );
  check(
    found.length === 1 && found[0].app_key && found[0].app_secret,
    "ROLE_BINDING_MISSING",
  );
  return found[0];
};

async function context(source, read) {
  const input = await read(source.input);
  const evidence = await read(source.evidence);
  const secrets = await read(input.update.credentials_file);
  const keys = secrets.version_credentials;
  const confirmed = prepareConfirmation(input, keys);
  check(
    input.services.update &&
      confirmed.input_binding &&
      confirmed.input_binding === evidence.input_binding,
    "CONFIRMED_TARGET_CHANGED",
  );
  const targets = input.targets.filter(
    (t) =>
      (!source.code || t.update_code === source.code) &&
      (!source.platform || t.platform === source.platform) &&
      (!source.arch || t.arch === source.arch) &&
      (!source.channel || t.channel === source.channel),
  );
  if (targets.length !== 1) {
    const choices = (targets.length ? targets : input.targets).map(
      ({ platform, arch, channel }) => ({ platform, arch, channel }),
    );
    throw Object.assign(new Error("SELECT_ONE_STREAM"), { choices });
  }
  const target = targets[0];
  const current = validation.validateVersion(
    source.current || target.app_version,
  );
  return {
    app: input.app.app_id,
    name: input.app.display_name,
    target,
    current,
    code: target.update_code,
    base: input.update.base_url + "/versions",
    keys,
  };
}

function roleBinding(ctx) {
  return hash(
    ["managementRead", "managementWrite", "runtime"].map((role) =>
      key(ctx, role),
    ),
  );
}

async function request(ctx, role, method, path, body) {
  const cred = key(ctx, role);
  const response = await fetch(ctx.base + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      Accept: "application/json",
      "x-app-key": cred.app_key,
      "x-app-secret": cred.app_secret,
      ...(body && { "Content-Type": "application/json" }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (
    response.status !== 200 &&
    !(method === "GET" && response.status === 404)
  ) {
    await response.body?.cancel();
    return { status: response.status };
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    check(size <= 5 * 1024 * 1024, "RESPONSE_TOO_LARGE");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (response.status === 404) return { status: 404, data: JSON.parse(raw) };
  if (method !== "GET") {
    check(raw.length === 0, "WRITE_RESPONSE_UNEXPECTED");
    return { status: 200 };
  }
  return { status: 200, data: JSON.parse(raw) };
}

export async function inspect(
  ctx,
  send = request,
  { allowPartial = false } = {},
) {
  let total,
    count = 0,
    top = null;
  const ids = new Set(),
    versions = new Set();
  for (let page = 1; ; page++) {
    const { status, data } = await send(
      ctx,
      "managementRead",
      "GET",
      "?page=" + page + "&size=100",
    );
    check(status === 200, "LIST_HTTP_" + status);
    total ??= data?.result?.total;
    const rows = data?.result?.datas;
    check(
      Number.isSafeInteger(total) &&
        total >= 0 &&
        total <= 10000 &&
        data.result.total === total &&
        data.page?.current === page &&
        data.page?.size === 100 &&
        data.page?.total_page === Math.ceil(total / 100) &&
        Array.isArray(rows) &&
        rows.length === Math.min(total - count, 100),
      "LIST_INCOMPLETE",
    );
    for (const row of rows) {
      validation.validateVersionId(row.id);
      check(!ids.has(row.id), "LIST_CHANGED");
      ids.add(row.id);
      if (row.code !== ctx.code) continue;
      const body = cleanBody(releaseBody(row));
      const canonical = version.canonicalizeDottedVersion(body.codeVersion);
      check(!versions.has(canonical), "DUPLICATE_VERSION");
      versions.add(canonical);
      if (!top || compareDottedVersions(body.codeVersion, top.codeVersion) > 0)
        top = { id: row.id, ...body };
    }
    count += rows.length;
    if (count === total) break;
  }
  try {
    return { top, ...(await checkRuntime(ctx, top, send)) };
  } catch (error) {
    if (!allowPartial) throw error;
    return {
      top,
      decision: null,
      runtimeStatus: error.runtimeStatus ?? null,
      runtimeError: diagnostic(error).code,
    };
  }
}

async function checkRuntime(ctx, top, send) {
  const probe = await send(
    ctx,
    "runtime",
    "GET",
    "/" + encodeURIComponent(ctx.code) + "/" + encodeURIComponent(ctx.current),
  );
  if (
    !top &&
    probe.status === 404 &&
    probe.data?.errors?.datas?.[0]?.code === "resource.not_found"
  )
    return { decision: null, runtimeStatus: 404 };
  if (!top || probe.status !== 200)
    throw Object.assign(
      new Error(
        top ? "RUNTIME_HTTP_" + probe.status : "EMPTY_LIST_RUNTIME_MISMATCH",
      ),
      { runtimeStatus: probe.status },
    );
  const expected = createVersionCheckResponse(top, ctx.current);
  if (!equal(probe.data, expected))
    throw Object.assign(new Error("RUNTIME_RECORD_MISMATCH"), {
      runtimeStatus: probe.status,
    });
  const { update, forcedUpdate, promptUpdate, stopUpdate } = expected;
  return {
    decision: { update, forcedUpdate, promptUpdate, stopUpdate },
    runtimeStatus: 200,
  };
}

function draft(ctx, top, action) {
  const blank = {
    name: ctx.name,
    code: ctx.code,
    codeVersion: "",
    downloadUrl: "",
    promptContent: "有新版本可用。",
    updateContent: "",
    ...modes.recommend,
  };
  if (action === "new") return blank;
  if (action === "reset") return top ? releaseBody(top) : blank;
  check(
    Object.hasOwn(modes, action) && top,
    "ACTION_REQUIRES_EXISTING_RELEASE",
  );
  return { ...releaseBody(top), ...modes[action] };
}

const modeFields = Object.keys(modes.force);
function fieldIssues(input) {
  const issues = new Set();
  const field = (k, test) => {
    try {
      if (!test(input?.[k])) issues.add(k);
    } catch {
      issues.add(k);
    }
  };
  // The service validates the entire body. Isolate each field in a valid local
  // sample so its own rules produce the complete correction list in one pass.
  const sample = {
    name: "校验",
    code: "check",
    codeVersion: "1",
    downloadUrl: "https://example.com/file",
    promptContent: "校验",
    forcedUpdate: false,
    promptUpdate: false,
    stopUpdate: false,
  };
  for (const k of Object.keys(sample))
    field(k, (v) => cleanBody({ ...sample, [k]: v }));
  if (modeFields.filter((k) => input?.[k] === true).length > 1)
    modeFields.filter((k) => input[k] === true).forEach((k) => issues.add(k));
  if (input?.updateContent !== undefined)
    field(
      "updateContent",
      (v) => typeof validation.sanitizeRichText(v, 10000) === "string",
    );
  if (
    input?.versionCriteria !== undefined ||
    input?.updateCriteria !== undefined
  ) {
    field("updateCriteria", (v) => ["ge", "gt", "le", "lt"].includes(v));
    field("versionCriteria", validation.validateVersion);
  }
  return [...issues].map((k) => "release." + k);
}

export function mutation(ctx, top, action, input) {
  let body;
  try {
    body = cleanBody(input);
  } catch (error) {
    const fields = fieldIssues(input);
    if (!fields.length) throw error;
    const missing = fields.every((f) =>
      [undefined, ""].includes(input?.[f.slice("release.".length)]),
    );
    throw Object.assign(
      new Error(missing ? "MISSING_RELEASE_FIELDS" : "INVALID_RELEASE_FIELDS"),
      { fields },
    );
  }
  check(body.code === ctx.code, "STREAM_CHANGED");
  if (!["reset", "new"].includes(action)) {
    check(
      equal(body, cleanBody(draft(ctx, top, action))),
      "ACTION_ONLY_CHANGES_MODE",
    );
  }
  const order = top
    ? compareDottedVersions(body.codeVersion, top.codeVersion)
    : 1;
  if (order < 0 || (action === "new" && order === 0))
    throw Object.assign(new Error("HIGHER_VERSION_REQUIRED"), {
      fields: ["release.codeVersion"],
    });
  if (!order) {
    body.codeVersion = top.codeVersion;
    if (equal(body, releaseBody(top)))
      return { method: "NONE", path: "", body };
    return { method: "PUT", path: "/" + top.id, body };
  }
  return { method: "POST", path: "", body };
}

async function saveNext(write, parent, kind, value) {
  const file = join(dirname(parent), kind + "-" + randomUUID() + ".json");
  await write(file, value);
  return file;
}
function scope(ctx) {
  const { platform, arch, channel } = ctx.target;
  return {
    app: ctx.app,
    code: ctx.code,
    platform,
    arch,
    channel,
    current: ctx.current,
    endpoint: ctx.base,
  };
}
function publicState(ctx, observed) {
  return {
    target: scope(ctx),
    release: publicRecord(observed.top),
    runtime: observed.decision,
    runtimeHttp: observed.runtimeStatus,
    ...(observed.runtimeError && { runtimeError: observed.runtimeError }),
  };
}

export async function run(
  argv,
  { read = readPrivate, write = writePrivate, send = request } = {},
) {
  const [command, ...args] = argv;
  const { values: v } = parseArgs({
    args,
    options: Object.fromEntries(
      [
        "input",
        "evidence",
        "code",
        "current",
        "platform",
        "arch",
        "channel",
        "facts-file",
        "snapshot",
        "action",
        "form",
        "plan",
        "confirm",
      ].map((k) => [k, { type: "string" }]),
    ),
  });
  if (command === "inspect") {
    const source = {
      input: resolve(v.input),
      evidence: resolve(v.evidence),
      code: v.code,
      platform: v.platform,
      arch: v.arch,
      channel: v.channel,
      current: v.current || "",
    };
    const ctx = await context(source, read);
    source.code = ctx.code;
    const observed = await inspect(ctx, send, { allowPartial: true });
    const snapshot = await saveNext(write, source.input, "release-status", {
      source,
      target: scope(ctx),
      observed,
      checkedAt: new Date().toISOString(),
    });
    return {
      status: observed.runtimeError ? "runtime-unverified" : "inspected",
      ...publicState(ctx, observed),
      snapshot,
    };
  }
  if (["prepare", "plan", "review"].includes(command)) {
    const editing = Boolean(v.form);
    check(command !== "plan" || editing, "SETTINGS_FILE_REQUIRED");
    check(
      !editing || (command !== "prepare" && !v["facts-file"]),
      "CONFLICTING_FORM_OPTIONS",
    );
    let input = editing ? await read(v.form) : null;
    const snapshotPath = resolve(v.snapshot ?? input?.snapshot);
    const action = v.action ?? input?.action;
    const snapshot = await read(snapshotPath);
    check(!snapshot.observed.runtimeError, "RUNTIME_RECHECK_REQUIRED");
    const ctx = await context(snapshot.source, read);
    check(equal(scope(ctx), snapshot.target), "TARGET_CHANGED");
    let form = v.form;
    if (!editing) {
      if (
        command === "review" &&
        !snapshot.observed.top &&
        action === "cancel" &&
        !v["facts-file"]
      )
        return {
          status: "unchanged-at-inspection",
          ...publicState(ctx, snapshot.observed),
        };
      const release = draft(ctx, snapshot.observed.top, action);
      if (v["facts-file"]) {
        const facts = await read(v["facts-file"]);
        check(
          ["new", "reset"].includes(action) &&
            facts.snapshot === snapshotPath &&
            validation.isPlainObject(facts.release) &&
            Object.keys(facts.release).every(
              (k) =>
                Object.hasOwn(release, k) ||
                ["updateCriteria", "versionCriteria"].includes(k),
            ) &&
            (!Object.hasOwn(facts.release, "code") ||
              facts.release.code === ctx.code),
          "FACTS_TARGET_OR_FIELDS_INVALID",
        );
        Object.assign(release, facts.release);
        if (
          facts.release.updateCriteria === null &&
          facts.release.versionCriteria === null
        ) {
          delete release.updateCriteria;
          delete release.versionCriteria;
        }
      }
      input = { snapshot: snapshotPath, action, release };
      form = await saveNext(write, snapshotPath, "release-settings", input);
      if (command === "prepare") return { form, action };
      if (action === "reset" && snapshot.observed.top && !v["facts-file"])
        return {
          status: "awaiting-changes",
          form,
          action,
          target: snapshot.target,
        };
    }
    check(
      input.snapshot === snapshotPath && input.action === action,
      "FORM_TARGET_CHANGED",
    );
    let op;
    try {
      op = mutation(ctx, snapshot.observed.top, action, input.release);
    } catch (error) {
      if (command !== "review" || !error.fields) throw error;
      return {
        status: "needs-input",
        form,
        fields: error.fields,
        reason: diagnostic(error).code,
      };
    }
    const after = createVersionCheckResponse(op.body, ctx.current);
    const { downloadUrl, ...preview } = after;
    if (op.method === "NONE")
      return {
        form,
        status: "unchanged-at-inspection",
        ...publicState(ctx, snapshot.observed),
      };
    const plan = {
      source: snapshot.source,
      target: snapshot.target,
      before: snapshot.observed,
      form: resolve(form),
      formHash: hash(input),
      credentialsBinding: roleBinding(ctx),
      action,
      op,
    };
    const file = await saveNext(write, form, "release-plan", plan);
    return {
      plan: file,
      status: "awaiting-confirmation",
      form,
      confirm: hash(plan),
      changedFields: [
        ...new Set([
          ...Object.keys(
            snapshot.observed.top ? releaseBody(snapshot.observed.top) : {},
          ),
          ...Object.keys(op.body),
        ]),
      ]
        .filter((k) => !equal(snapshot.observed.top?.[k], op.body[k]))
        .map((k) => "release." + k),
      target: plan.target,
      action: plan.action,
      method: op.method,
      url: ctx.base + op.path,
      before: publicRecord(plan.before.top),
      after: publicRecord(op.body),
      expected: preview,
      reusesPreviousDownload: Boolean(
        op.method === "POST" &&
        plan.before.top?.downloadUrl === op.body.downloadUrl,
      ),
    };
  }
  check(command === "apply" || command === "verify", "UNKNOWN_COMMAND");
  const plan = await read(v.plan);
  const digest = hash(plan);
  check(
    command === "verify" || digest === v.confirm,
    "PLAN_CONFIRMATION_REQUIRED",
  );
  const ctx = await context(plan.source, read);
  check(equal(scope(ctx), plan.target), "TARGET_CHANGED");
  const observed = await inspect(ctx, send);
  const matches = (state) =>
    Boolean(
      state.top &&
      equal(releaseBody(state.top), plan.op.body) &&
      (plan.op.method !== "PUT" || "/" + state.top.id === plan.op.path),
    );
  async function result(state, details) {
    const outcome = {
      status: matches(state) ? "verified" : "desired-state-not-verified",
      ...publicState(ctx, state),
      ...details,
    };
    const receipt = await saveNext(write, v.plan, "release-result", {
      ...outcome,
      plan: digest,
      checkedAt: new Date().toISOString(),
    });
    return { ...outcome, receipt };
  }
  if (command === "verify") return result(observed, { action: "read-only" });
  const form = await read(plan.form);
  check(hash(form) === plan.formHash, "FORM_CHANGED_REPLAN");
  check(
    plan.credentialsBinding === roleBinding(ctx),
    "CREDENTIALS_CHANGED_REPLAN",
  );
  if (matches(observed)) return result(observed, { action: "already-matches" });
  check(equal(observed, plan.before), "REMOTE_CHANGED_REPLAN");
  const op = mutation(ctx, observed.top, plan.action, form.release);
  check(
    equal(op, plan.op) && ["POST", "PUT"].includes(op.method),
    "PLAN_CHANGED",
  );
  // Exclusive creation prevents replay of an attempted write, including after a crash.
  const attempt = join(dirname(v.plan), "release-attempt-" + digest + ".json");
  await write(attempt, { digest, startedAt: new Date().toISOString() });
  let writeStatus = "unknown";
  try {
    writeStatus = (
      await send(ctx, "managementWrite", op.method, op.path, op.body)
    ).status;
  } catch {
    /* Reconcile through readback. */
  }
  let after;
  try {
    after = await inspect(ctx, send);
  } catch (error) {
    const outcome = {
      status: "awaiting-verification",
      target: scope(ctx),
      writeStatus,
      attempt,
      check: diagnostic(error).code,
    };
    const receipt = await saveNext(write, v.plan, "release-result", {
      ...outcome,
      plan: digest,
      checkedAt: new Date().toISOString(),
    });
    return { ...outcome, receipt };
  }
  return result(after, { writeStatus, attempt });
}

function diagnostic(error) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message
    : error.code === "EEXIST"
      ? "ATTEMPT_EXISTS_USE_VERIFY"
      : "CHECK_INPUT_FIELDS_OR_TRANSPORT";
  return {
    status: "incomplete",
    code,
    ...(error.fields && { fields: error.fields }),
    ...(code === "SELECT_ONE_STREAM" && { choices: error.choices }),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (
        [
          "awaiting-verification",
          "desired-state-not-verified",
          "runtime-unverified",
        ].includes(result.status)
      )
        process.exitCode = 2;
    })
    .catch((error) => {
      console.error(JSON.stringify(diagnostic(error)));
      process.exitCode = 1;
    });
}
