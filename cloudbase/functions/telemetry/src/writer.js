"use strict";

const DEFAULT_COLLECTION = "telemetry_events";

/**
 * Creates the production CloudBase writer without loading the SDK or opening a
 * database connection until the first accepted event. The event UUID is also
 * used as CloudBase's _id, whose built-in uniqueness makes retries idempotent.
 * A duplicate insert is treated as an already accepted event.
 */
function createCloudBaseWriter(options = {}) {
  const collectionName = options.collectionName || DEFAULT_COLLECTION;
  const appFactory = options.appFactory || createDefaultCloudBaseApp;
  let collection;

  return async function writeEvent(document) {
    if (!collection) {
      const app = await appFactory();
      collection = app.database().collection(collectionName);
    }

    const storedDocument = {
      ...document,
      _id: document.event_id,
    };

    try {
      await collection.add(storedDocument);
      return { duplicate: false };
    } catch (error) {
      if (isDuplicateWriteError(error)) {
        return { duplicate: true };
      }
      throw error;
    }
  };
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
  DEFAULT_COLLECTION,
  createCloudBaseWriter,
  createDefaultCloudBaseApp,
  isDuplicateWriteError,
};
