"use strict";

const { createHash, createHmac, timingSafeEqual } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { ApiError, jsonResponse } = require("./errors");
const { validateVersion, invalidRequest } = require("./validation");
const {
  canonicalizeDottedVersion,
  selectHighestVersion,
  createVersionCheckResponse,
} = require("./version");

const { draft, mutation } = require("./release-form");

function conflict() {
  return new ApiError(
    409,
    "version.changed",
    "版本设置已变化，请重新查看并确认",
  );
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fields(record) {
  if (!record) return null;
  const { id, createdAt, updatedAt, versionKey, ...body } = record;
  return body;
}

async function dashboardRelease({
  input,
  token,
  tokenHash,
  credentials,
  repository,
  now,
  makeId,
  makeAuditId,
}) {
  if (
    typeof token !== "string" ||
    token.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(tokenHash || "") ||
    !timingSafeEqual(
      createHash("sha256").update(token).digest(),
      Buffer.from(tokenHash, "hex"),
    )
  ) {
    throw new ApiError(403, "dashboard.forbidden", "版本服务尚未绑定该后台");
  }
  const { appId, code, stage, action } = input;
  if (
    !credentials.some(
      (c) =>
        c.appId === appId &&
        c.codes.has(code) &&
        c.scopes.has("versions:write"),
    )
  )
    throw invalidRequest();
  const revision = await repository.releaseRevision(appId, code);
  const current = selectHighestVersion(
    await repository.listVersionsForCode(appId, code),
  );
  const before = fields(current);
  const baseline = digest([revision, current]);
  const ctx = { code, name: input.displayName || appId };
  const top = current ? { ...before, id: current.id } : null;
  if (stage === "details")
    return jsonResponse(200, {
      baseline,
      drafts: { new: draft(ctx, top, "new"), reset: draft(ctx, top, "reset") },
      record: before,
      id: current?.id ?? null,
      ...(current && input.clientVersion
        ? {
            clientResult: createVersionCheckResponse(
              current,
              validateVersion(input.clientVersion),
            ),
          }
        : {}),
    });
  if (
    !["preview", "apply"].includes(stage) ||
    !["new", "reset", "recommend", "force", "cancel"].includes(action)
  )
    throw invalidRequest();
  if (baseline !== input.baseline) throw conflict();
  if (!current && !["new", "reset"].includes(action)) throw invalidRequest();
  let op;
  try {
    const inputBody = ["new", "reset"].includes(action)
      ? input.release
      : draft(ctx, top, action);
    op = mutation(ctx, top, action, inputBody);
  } catch (error) {
    if (error.message === "HIGHER_VERSION_REQUIRED")
      throw invalidRequest(
        "请填写符合本次操作要求的版本号 release.codeVersion",
      );
    if (error.fields) throw invalidRequest("请核对 " + error.fields.join("、"));
    throw invalidRequest();
  }
  const after = op.body;
  const creates = op.method === "POST";
  const proof = createHmac("sha256", token)
    .update(JSON.stringify([appId, code, baseline, action, after]))
    .digest("hex");
  if (stage === "preview")
    return jsonResponse(200, {
      before,
      after,
      proof,
      unchanged: op.method === "NONE",
      method: op.method,
    });
  if (input.proof !== proof) throw conflict();
  let id = current?.id;
  if (op.method !== "NONE") {
    const timestamp = now().toISOString();
    if (creates) id = makeId();
    const audit = {
      id: makeAuditId(),
      action: creates ? "create" : "update",
      entity: "version",
      recordId: id,
      code,
      credentialFingerprint: "dashboard",
      occurredAt: timestamp,
      sourceIp: null,
    };
    const row = {
      ...after,
      versionKey: canonicalizeDottedVersion(after.codeVersion),
      id,
      updatedAt: timestamp,
    };
    if (creates)
      await repository.createVersion(
        appId,
        { ...row, createdAt: timestamp },
        audit,
        revision,
      );
    else if (
      !(await repository.updateVersion(
        appId,
        id,
        row,
        audit,
        new Set([code]),
        revision,
      ))
    )
      throw conflict();
  }
  const readback = selectHighestVersion(
    await repository.listVersionsForCode(appId, code),
  );
  if (readback?.id !== id || !isDeepStrictEqual(after, fields(readback)))
    throw new ApiError(
      409,
      "version.readback_changed",
      "保存后的当前记录与预览不一致，请查看最新设置",
    );
  return jsonResponse(200, {
    status: "verified",
    id,
    record: after,
    appId,
    code,
  });
}
module.exports = { dashboardRelease };
