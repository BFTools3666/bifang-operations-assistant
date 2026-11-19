"use strict";

const COLLECTION_NAME_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * Creates the production CloudBase writer without loading the SDK or opening a
 * database connection until the first accepted event. The handler supplies a
 * deterministic daily-active _id; CloudBase's built-in uniqueness therefore
 * deduplicates the same app installation on the same Shanghai calendar day.
 * A duplicate insert is treated as an already accepted event.
 */
function createCloudBaseWriter(options = {}) {
  const collectionName = normalizeCollectionName(
    options.collectionName === undefined
      ? process.env.TELEMETRY_COLLECTION
      : options.collectionName,
  );
  const appFactory = options.appFactory || createDefaultCloudBaseApp;
  return async function writeEvent(document, { runtimeContext } = {}) {
    if (
      !document ||
      typeof document !== "object" ||
      typeof document._id !== "string" ||
      document._id.length === 0
    ) {
      throw new TypeError("document._id is required");
    }
    if (collectionName === null) {
      throw new Error("telemetry_collection_not_configured");
    }

    // Do not retain one invocation's temporary signing credentials.
    const app = await appFactory({ runtimeContext });
    const collection = app.database().collection(collectionName);

    try {
      await collection.add({ ...document });
      return { duplicate: false };
    } catch (error) {
      if (isDuplicateWriteError(error)) {
        return { duplicate: true };
      }
      throw error;
    }
  };
}

function normalizeCollectionName(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value !== "string" || !COLLECTION_NAME_PATTERN.test(value)) {
    throw new TypeError(
      "TELEMETRY_COLLECTION must be 1-60 lowercase letters, digits, or underscores and start with a letter",
    );
  }
  return value;
}

function createDefaultCloudBaseApp(options = {}) {
  const cloudbaseModule =
    options.cloudbaseModule || require("@cloudbase/node-sdk");
  const cloudbase = cloudbaseModule.default || cloudbaseModule;
  const configuredEnv =
    options.envOverride === undefined
      ? process.env.CLOUDBASE_ENV_ID
      : options.envOverride;
  const currentEnv =
    cloudbase.SYMBOL_CURRENT_ENV || cloudbaseModule.SYMBOL_CURRENT_ENV;
  const env =
    (typeof configuredEnv === "string" && configuredEnv.trim()) || currentEnv;
  if (!env) throw new Error("cloudbase_environment_unavailable");
  const context = extractRuntimeSdkContext(options.runtimeContext);
  // Node SDK v3 consumes sessionToken in init; JS SDK's tmpSecret-only config
  // does not supply signing credentials here. Only accept runtime STS context.
  const secret = context?.extendedContext.tmpSecret;
  return cloudbase.init({
    env,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { timeout: options.requestTimeoutMs }),
    ...(secret
      ? {
          secretId: secret.secretId,
          secretKey: secret.secretKey,
          sessionToken: secret.token,
        }
      : {}),
  });
}

function extractRuntimeSdkContext(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== "object") return null;
  const direct = runtimeContext.extendedContext?.tmpSecret;
  if (isSessionSecret(direct)) {
    return {
      extendedContext: {
        tmpSecret: {
          secretId: direct.secretId,
          secretKey: direct.secretKey,
          token: direct.token,
        },
      },
    };
  }
  let environment = runtimeContext.environment;
  if (typeof environment === "string" && environment.length <= 65_536) {
    try {
      environment = JSON.parse(environment);
    } catch {
      environment = null;
    }
  }
  if (
    !environment &&
    typeof runtimeContext.environ === "string" &&
    runtimeContext.environ.length <= 65_536
  ) {
    environment = Object.fromEntries(
      runtimeContext.environ
        .split(";")
        .filter((item) => item.includes("="))
        .map((item) => {
          const offset = item.indexOf("=");
          return [item.slice(0, offset), item.slice(offset + 1)];
        }),
    );
  }
  const secret = {
    secretId: environment?.TENCENTCLOUD_SECRETID,
    secretKey: environment?.TENCENTCLOUD_SECRETKEY,
    token: environment?.TENCENTCLOUD_SESSIONTOKEN,
  };
  return isSessionSecret(secret)
    ? { extendedContext: { tmpSecret: secret } }
    : null;
}

function isSessionSecret(value) {
  return (
    value &&
    [value.secretId, value.secretKey, value.token].every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 8192,
    )
  );
}

function isDuplicateWriteError(error) {
  if (!error || typeof error !== "object") return false;
  const candidates = [error.code, error.errCode, error.errorCode, error.message]
    .filter((value) => typeof value === "string" || typeof value === "number")
    .join(" ");
  return /(?:^|\D)11000(?:\D|$)|duplicate\s+(?:key|document)|already\s+exists/i.test(
    candidates,
  );
}

module.exports = {
  COLLECTION_NAME_PATTERN,
  createCloudBaseWriter,
  createDefaultCloudBaseApp,
  isDuplicateWriteError,
  normalizeCollectionName,
};
