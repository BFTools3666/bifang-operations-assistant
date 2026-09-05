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
  let collection;

  return async function writeEvent(document) {
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

    if (!collection) {
      const app = await appFactory();
      collection = app.database().collection(collectionName);
    }

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
  // CommonJS is intentional: normal CloudBase Event functions use a CommonJS
  // entrypoint. @cloudbase/js-sdk selects its built-in Node adapter through the
  // package's conditional export. Current-environment auth is supplied by the
  // function runtime; no public-client secret or API key is accepted here.
  const cloudbaseModule =
    options.cloudbaseModule || require("@cloudbase/js-sdk");
  const cloudbase = cloudbaseModule.default || cloudbaseModule;
  const configuredEnv =
    options.envOverride === undefined
      ? process.env.CLOUDBASE_ENV_ID
      : options.envOverride;

  // In an Event function the Node adapter resolves SYMBOL_CURRENT_ENV from the
  // runtime's TCB_ENV/SCF_NAMESPACE values. Local processes without those
  // runtime variables cannot exercise this path faithfully.
  const hasConfiguredEnv =
    typeof configuredEnv === "string" && configuredEnv.trim().length > 0;
  const currentEnv =
    cloudbase.SYMBOL_CURRENT_ENV || cloudbaseModule.SYMBOL_CURRENT_ENV;
  if (!hasConfiguredEnv && !currentEnv) {
    throw new Error("cloudbase_environment_unavailable");
  }
  const initOptions = {
    env: hasConfiguredEnv ? configuredEnv.trim() : currentEnv,
  };
  return cloudbase.init(initOptions);
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
