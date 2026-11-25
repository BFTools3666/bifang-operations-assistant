"use strict";
const { isDeepStrictEqual: equal } = require("node:util");
const validation = require("./validation");
const { compareDottedVersions } = require("./version");
function check(condition, code) {
  if (!condition) throw new Error(code);
}
const modes = {
  force: { forcedUpdate: true, promptUpdate: false, stopUpdate: false },
  recommend: { forcedUpdate: false, promptUpdate: true, stopUpdate: false },
  cancel: { forcedUpdate: false, promptUpdate: false, stopUpdate: true },
};
function cleanBody(value) {
  const { versionKey, ...body } = validation.validateVersionWrite(value);
  return body;
}
function releaseBody(record) {
  const { id, ...body } = record;
  return body;
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

function mutation(ctx, top, action, input) {
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

module.exports = { cleanBody, releaseBody, draft, mutation };
