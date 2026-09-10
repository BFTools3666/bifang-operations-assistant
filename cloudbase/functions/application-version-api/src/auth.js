"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { ApiError } = require("./errors");
const { validateCode } = require("./validation");

const ALLOWED_SCOPES = new Set([
  "versions:check",
  "versions:read",
  "versions:write",
  "ads:show",
  "ads:read",
  "ads:write",
]);
const SCOPE_BUNDLES = Object.freeze({
  runtime: [
    new Set(["versions:check"]),
    new Set(["versions:check", "ads:show"]),
  ],
  managementRead: [new Set(["versions:read", "ads:read"])],
  managementWrite: [new Set(["versions:write", "ads:write"])],
});
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const MAX_CREDENTIAL_CONFIGURATION_BASE64_BYTES = 4_096;

function parseCredentials(value, registeredAppIds) {
  const appIds = new Set(registeredAppIds || []);
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      const normalized = parsed.trim();
      if (
        Buffer.byteLength(normalized, "utf8") >
          MAX_CREDENTIAL_CONFIGURATION_BASE64_BYTES ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
        normalized.length % 4 !== 0
      ) {
        return null;
      }
      const bytes = Buffer.from(normalized, "base64");
      if (bytes.toString("base64") !== normalized) return null;
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch {
      return null;
    }
  }
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).sort().join(",") !== "credentials,schema_version" ||
    parsed.schema_version !== 1 ||
    !Array.isArray(parsed.credentials) ||
    parsed.credentials.length < 1 ||
    parsed.credentials.length > 100
  ) {
    return null;
  }

  const credentials = [];
  for (const value of parsed.credentials) {
    if (!isPlainObject(value)) return null;
    if (
      Object.keys(value).sort().join(",") !==
      "app_id,codes,credential_id,key_sha256,scopes,secret_sha256"
    ) {
      return null;
    }
    if (
      typeof value.credential_id !== "string" ||
      !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value.credential_id) ||
      typeof value.app_id !== "string" ||
      !APP_ID_PATTERN.test(value.app_id) ||
      !appIds.has(value.app_id) ||
      typeof value.key_sha256 !== "string" ||
      !HASH_PATTERN.test(value.key_sha256) ||
      !Array.isArray(value.secret_sha256) ||
      value.secret_sha256.length < 1 ||
      value.secret_sha256.length > 2 ||
      value.secret_sha256.some(
        (hash) => typeof hash !== "string" || !HASH_PATTERN.test(hash),
      ) ||
      new Set(value.secret_sha256).size !== value.secret_sha256.length ||
      !Array.isArray(value.codes) ||
      value.codes.length < 1 ||
      value.codes.length > 100 ||
      !Array.isArray(value.scopes) ||
      value.scopes.length < 1 ||
      value.scopes.length > ALLOWED_SCOPES.size
    ) {
      return null;
    }
    let codes;
    try {
      codes = value.codes.map((code) => validateCode(code));
    } catch {
      return null;
    }
    const scopes = new Set(value.scopes);
    const role = classifyScopeBundle(scopes);
    if (
      new Set(codes).size !== codes.length ||
      value.scopes.some(
        (scope) => typeof scope !== "string" || !ALLOWED_SCOPES.has(scope),
      ) ||
      new Set(value.scopes).size !== value.scopes.length ||
      role === null ||
      (role === "runtime" && codes.length !== 1)
    ) {
      return null;
    }
    credentials.push({
      appId: value.app_id,
      codes: new Set(codes),
      keyHash: Buffer.from(value.key_sha256, "hex"),
      scopes,
      secretHashes: value.secret_sha256.map((hash) => Buffer.from(hash, "hex")),
      fingerprint: value.credential_id,
    });
  }
  if (
    new Set(credentials.map(({ keyHash }) => keyHash.toString("hex"))).size !==
      credentials.length ||
    new Set(credentials.map(({ fingerprint }) => fingerprint)).size !==
      credentials.length
  ) {
    return null;
  }
  return credentials;
}

function classifyScopeBundle(scopes) {
  for (const [role, bundles] of Object.entries(SCOPE_BUNDLES)) {
    if (bundles.some((bundle) => hasExactScopes(scopes, bundle))) return role;
  }
  return null;
}

function hasExactScopes(actual, expected) {
  return (
    actual.size === expected.size &&
    [...expected].every((scope) => actual.has(scope))
  );
}

function authenticate(headers, credentials) {
  if (!credentials) {
    throw new ApiError(500, "server.unavailable", "服务暂时不可用");
  }
  const key = findHeader(headers, "x-app-key");
  const secret = findHeader(headers, "x-app-secret");
  if (
    typeof key !== "string" ||
    typeof secret !== "string" ||
    key.length < 1 ||
    key.length > 512 ||
    secret.length < 1 ||
    secret.length > 512
  ) {
    throw new ApiError(401, "auth.invalid", "请求未通过验证");
  }

  const keyHash = createHash("sha256").update(key, "utf8").digest();
  const secretHash = createHash("sha256").update(secret, "utf8").digest();
  let matched = null;
  for (const credential of credentials) {
    const keyMatches = timingSafeEqual(keyHash, credential.keyHash);
    let secretMatches = false;
    for (const expectedSecret of credential.secretHashes) {
      secretMatches =
        timingSafeEqual(secretHash, expectedSecret) || secretMatches;
    }
    if (keyMatches && secretMatches) matched = credential;
  }
  if (!matched) {
    throw new ApiError(401, "auth.invalid", "请求未通过验证");
  }
  return matched;
}

function authorize(principal, scope, code) {
  if (!principal.scopes.has(scope)) {
    throw new ApiError(403, "auth.forbidden", "没有访问权限");
  }
  if (code !== undefined && !principal.codes.has(code)) {
    throw new ApiError(403, "auth.forbidden", "没有访问权限");
  }
}

function findHeader(headers, name) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (matches.length !== 1) return undefined;
  const value = matches[0][1];
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function hashCredential(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

module.exports = {
  ALLOWED_SCOPES,
  MAX_CREDENTIAL_CONFIGURATION_BASE64_BYTES,
  authenticate,
  authorize,
  findHeader,
  hashCredential,
  parseCredentials,
};
