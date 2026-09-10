"use strict";

const { createDatabaseError } = require("./diagnostics");
const { createDefaultCloudBaseApp } = require("./reader");
const { isDottedVersion, isRfc3339 } = require("./validation");

function createCloudBaseVersionReader(options = {}) {
  const appFactory = options.appFactory || createDefaultCloudBaseApp;

  return async function readReleaseStreams({ apps, runtimeContext }) {
    const database = (await appFactory({ runtimeContext })).database();
    const summaries = [];

    for (const app of apps) {
      for (const stream of app.releaseStreams) {
        const result = await database
          .collection(app.versionCollection)
          .where({
            doc_type: "version_record",
            schema_version: 1,
            code: stream.code,
          })
          .orderBy("version_sort_key", "desc")
          .orderBy("updated_at", "desc")
          .orderBy("_id", "desc")
          .field({
            doc_type: true,
            schema_version: true,
            code: true,
            code_version: true,
            version_sort_key: true,
            forced_update: true,
            prompt_update: true,
            stop_update: true,
            updated_at: true,
          })
          .limit(1)
          .get();
        if (!Array.isArray(result?.data) || result.code) {
          throw createDatabaseError(result);
        }
        if (result.data.length > 1) {
          throw new Error("application_version_result_invalid");
        }
        summaries.push(
          result.data.length === 0
            ? emptyReleaseSummary(app, stream)
            : summarizeVersionDocument(result.data[0], app, stream),
        );
      }
    }

    return summaries;
  };
}

function emptyReleaseSummary(app, stream) {
  return {
    appId: app.appId,
    code: stream.code,
    platform: stream.platform,
    architecture: stream.architecture,
    channel: stream.channel,
    highestVersion: null,
    status: "empty",
    updatedAt: null,
  };
}

function summarizeVersionDocument(value, app, stream) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.doc_type !== "version_record" ||
    value.schema_version !== 1 ||
    value.code !== stream.code ||
    !isDottedVersion(value.code_version) ||
    value.version_sort_key !== createVersionSortKey(value.code_version) ||
    typeof value.forced_update !== "boolean" ||
    typeof value.prompt_update !== "boolean" ||
    typeof value.stop_update !== "boolean" ||
    !isRfc3339(value.updated_at) ||
    new Date(value.updated_at).toISOString() !== value.updated_at
  ) {
    throw new Error("application_version_document_invalid");
  }
  const enabledStates = [
    value.forced_update,
    value.prompt_update,
    value.stop_update,
  ].filter(Boolean).length;
  if (enabledStates > 1) {
    throw new Error("application_version_document_invalid");
  }

  const status = value.stop_update
    ? "stopped"
    : value.forced_update
      ? "forced"
      : value.prompt_update
        ? "prompt"
        : "normal";
  return {
    appId: app.appId,
    code: stream.code,
    platform: stream.platform,
    architecture: stream.architecture,
    channel: stream.channel,
    highestVersion: value.code_version,
    status,
    updatedAt: value.updated_at,
  };
}

function createVersionSortKey(value) {
  // Keep aligned with application-version-api/src/version.js. This function is
  // deployed independently, so it cannot import files from a sibling function.
  if (!isDottedVersion(value)) {
    throw new TypeError("numeric dotted version required");
  }
  const parts = value
    .split(".")
    .map((segment) => segment.replace(/^0+(?=\d)/, "") || "0");
  while (parts.length > 1 && parts.at(-1) === "0") parts.pop();
  return parts
    .map((segment) => `${String(segment.length).padStart(2, "0")}${segment}`)
    .join("");
}

module.exports = {
  createVersionSortKey,
  createCloudBaseVersionReader,
  emptyReleaseSummary,
  summarizeVersionDocument,
};
