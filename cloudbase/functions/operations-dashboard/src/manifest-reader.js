"use strict";

const {
  compareSemVer,
  isDisplayText,
  isHttpsUrl,
  isRfc3339,
  isSemVer,
} = require("./validation");
const MANIFEST_KEYS =
  "app_id,download_url,enabled,force_update,latest_version,message,min_supported_version,platform,published_at,release_notes_url,rollout,schema_version,sha256,title";

function createManifestReader(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const baseUrl = normalizeBaseUrl(
    options.baseUrl === undefined
      ? process.env.DASHBOARD_UPDATES_BASE_URL
      : options.baseUrl,
  );

  return async function readManifests(apps) {
    const tasks = apps.flatMap((app) =>
      app.platforms.map(async (platform) => {
        const manifestUrl = baseUrl
          ? `${baseUrl}/${app.appId}/${platform}.json`
          : "";
        try {
          if (!baseUrl || typeof fetchImpl !== "function")
            throw new Error("manifest_not_configured");
          const response = await fetchImpl(manifestUrl, {
            signal: AbortSignal.timeout(3_000),
            headers: { accept: "application/json" },
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
          });
          if (!response.ok) throw new Error("manifest_unavailable");
          const value = JSON.parse(await readBoundedText(response));
          return summarizeManifest(value, app.appId, platform, manifestUrl);
        } catch {
          return fallbackManifest(app.appId, platform, manifestUrl);
        }
      }),
    );
    return Promise.all(tasks);
  };
}

function summarizeManifest(value, appId, platform, manifestUrl) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== MANIFEST_KEYS ||
    value.schema_version !== 1 ||
    value.app_id !== appId ||
    value.platform !== platform ||
    typeof value.enabled !== "boolean" ||
    typeof value.force_update !== "boolean" ||
    !Number.isInteger(value.rollout) ||
    value.rollout < 0 ||
    value.rollout > 100 ||
    !isSemVer(value.latest_version) ||
    !isSemVer(value.min_supported_version) ||
    compareSemVer(value.min_supported_version, value.latest_version) > 0 ||
    !isRfc3339(value.published_at) ||
    !isDisplayText(value.title, 120) ||
    !isDisplayText(value.message, 1000) ||
    !isHttpsUrl(value.download_url) ||
    !isHttpsUrl(value.release_notes_url) ||
    typeof value.sha256 !== "string" ||
    !/^(?:|[a-f0-9]{64})$/i.test(value.sha256)
  ) {
    throw new TypeError("invalid_manifest");
  }
  return {
    appId,
    platform,
    enabled: value.enabled,
    forceUpdate: value.force_update,
    rollout: value.rollout,
    latestVersion: value.latest_version,
    minSupportedVersion: value.min_supported_version,
    publishedAt: value.published_at,
    manifestUrl,
    source: "cloudbase",
  };
}

function fallbackManifest(appId, platform, manifestUrl) {
  return {
    appId,
    platform,
    enabled: false,
    forceUpdate: false,
    rollout: 0,
    latestVersion: "0.0.0",
    minSupportedVersion: "0.0.0",
    publishedAt: "1970-01-01T00:00:00.000Z",
    manifestUrl,
    source: "unavailable",
  };
}

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (!isHttpsUrl(value.trim()) || url.search || url.hash) return null;
  return url.href.replace(/\/$/, "");
}

async function readBoundedText(response) {
  const maxBytes = 16_384;
  if (Number(response.headers?.get("content-length")) > maxBytes)
    throw new Error("manifest_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes)
      throw new Error("manifest_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("manifest_too_large");
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

module.exports = {
  createManifestReader,
  fallbackManifest,
  normalizeBaseUrl,
  summarizeManifest,
};
