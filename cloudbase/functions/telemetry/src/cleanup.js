"use strict";

const {
  createDefaultCloudBaseApp,
  normalizeCollectionName,
} = require("./writer.js");
const BATCH_SIZE = 100;

function createCleanupHandler({
  appId = process.env.ALLOWED_APP_IDS,
  collectionName = process.env.TELEMETRY_COLLECTION,
  appFactory = createDefaultCloudBaseApp,
  now = Date.now,
  log = (summary) => console.log(JSON.stringify(summary)),
} = {}) {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(appId || "") ||
    normalizeCollectionName(collectionName) !==
      "telemetry_" + appId.replaceAll("-", "_")
  ) {
    throw new Error("cleanup_configuration_invalid");
  }
  return async function cleanup(event, runtimeContext) {
    // No HTTP route is provisioned. Configuration, never request parameters,
    // selects the application/collection and the deletion boundary.
    if (
      !event ||
      event.Type !== "Timer" ||
      event.TriggerName !== "cleanup-expired" ||
      event.Message !== "telemetry-cleanup-v1" ||
      event.httpMethod ||
      event.requestContext
    ) {
      throw new Error("cleanup_trigger_invalid");
    }
    try {
      const started = now();
      if (!Number.isFinite(started)) throw new Error("clock_invalid");
      const cutoff = new Date(started);
      const app = await appFactory({ runtimeContext, requestTimeoutMs: 800 });
      const db = app.database();
      const command = db.command;
      const collection = db.collection(collectionName);
      const condition = {
        app_id: appId,
        schema_version: 2,
        event: "daily_active",
        expires_at: command.lte(cutoff),
      };
      const result = await collection
        .where(condition)
        .orderBy("expires_at", "asc")
        .orderBy("_id", "asc")
        .field({ _id: true, expires_at: true })
        .limit(BATCH_SIZE)
        .get();
      if (
        result?.code ||
        !Array.isArray(result?.data) ||
        result.data.length > BATCH_SIZE
      )
        throw new Error("read_failed");
      const rows = result.data;
      if (
        rows.some(
          (r) =>
            typeof r?._id !== "string" ||
            !r._id ||
            !(r.expires_at instanceof Date) ||
            !Number.isFinite(r.expires_at.getTime()) ||
            r.expires_at.getTime() > started,
        ) ||
        new Set(rows.map((r) => r._id)).size !== rows.length
      )
        throw new Error("read_invalid");
      // Leave room for one bounded delete request under the free 3-second cap.
      if (now() - started >= 1600) throw new Error("budget_exhausted");
      let deleted = 0;
      if (rows.length) {
        // Re-check eligibility when deleting: a concurrent expiry extension or
        // replacement is not removed. Duplicate invocations are idempotent.
        const removed = await collection
          .where({ ...condition, _id: command.in(rows.map((r) => r._id)) })
          .remove();
        if (!(
          typeof removed?.deleted === "number" ||
          (typeof removed?.deleted === "string" &&
            /^\d+$/.test(removed.deleted))
        ))
          throw new Error("delete_failed");
        deleted = Number(removed.deleted);
        if (
          removed?.code ||
          !Number.isInteger(deleted) ||
          deleted < 0 ||
          deleted > rows.length
        )
          throw new Error("delete_failed");
      }
      const summary = {
        status: "cleanup-completed",
        scanned: rows.length,
        deleted,
        batch_full: rows.length === BATCH_SIZE,
      };
      log(summary);
      return summary;
    } catch {
      log({ status: "cleanup-failed" });
      throw new Error("telemetry_cleanup_failed");
    }
  };
}

exports.createCleanupHandler = createCleanupHandler;
exports.main = (event, context) => createCleanupHandler()(event, context);
