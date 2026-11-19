"use strict";

const { createDatabaseError } = require("./diagnostics");

const PAGE_SIZE = 100;
const MAX_PAGES_PER_COLLECTION = 100;

function createCloudBaseEventReader(options = {}) {
  const appFactory = options.appFactory || createDefaultCloudBaseApp;

  return async function readEvents({
    apps,
    startDate,
    endDate,
    receivedBefore,
    runtimeContext,
  }) {
    // Context credentials are short-lived and may change between invocations.
    // Never retain one invocation's context-backed SDK instance for the next.
    const database = (await appFactory({ runtimeContext })).database();
    const command = database.command;
    const allEvents = [];

    for (const app of apps) {
      const collection = database.collection(app.collectionName);
      let cursor;
      for (let page = 0; page < MAX_PAGES_PER_COLLECTION; page += 1) {
        const condition = {
          app_id: app.appId,
          schema_version: 2,
          event: "daily_active",
          active_date: command.gte(startDate).and(command.lte(endDate)),
          received_at: command.lte(receivedBefore),
          ...(cursor ? { _id: command.gt(cursor) } : {}),
        };
        const result = await collection
          .where(condition)
          .orderBy("_id", "asc")
          .field({
            _id: true,
            schema_version: true,
            event: true,
            app_id: true,
            app_version: true,
            install_id: true,
            platform: true,
            arch: true,
            active_date: true,
            received_at: true,
          })
          .limit(PAGE_SIZE)
          .get();
        if (!Array.isArray(result?.data) || result.code) {
          throw createDatabaseError(result);
        }
        const rows = result.data;
        for (const row of rows) {
          if (
            !row ||
            typeof row._id !== "string" ||
            !row._id ||
            (cursor !== undefined && row._id <= cursor)
          ) {
            throw new Error("dashboard_query_invalid_cursor");
          }
          cursor = row._id;
        }
        allEvents.push(...rows);
        if (rows.length < PAGE_SIZE) break;
        if (page === MAX_PAGES_PER_COLLECTION - 1) {
          throw new Error("dashboard_query_limit_exceeded");
        }
      }
    }

    return allEvents;
  };
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

module.exports = {
  MAX_PAGES_PER_COLLECTION,
  PAGE_SIZE,
  createCloudBaseEventReader,
  createDefaultCloudBaseApp,
  extractRuntimeSdkContext,
};
