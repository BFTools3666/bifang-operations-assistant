"use strict";

const { createHash, timingSafeEqual } = require("node:crypto");
const { safeDiagnostic } = require("./diagnostics");

const {
  addDays,
  createDashboardSnapshot,
  toShanghaiDate,
} = require("./aggregate");
const { createManifestReader } = require("./manifest-reader");
const { createCloudBaseEventReader } = require("./reader");

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

function createHandler(options = {}) {
  const path = normalizePathValue(
    options.path === undefined ? process.env.DASHBOARD_PATH : options.path,
  );
  const tokenHash = normalizeTokenHash(
    options.tokenHash === undefined
      ? process.env.DASHBOARD_TOKEN_SHA256
      : options.tokenHash,
  );
  const apps = parseDashboardApps(
    options.apps === undefined ? process.env.DASHBOARD_APPS_JSON : options.apps,
  );
  const readEvents = options.reader || createCloudBaseEventReader();
  const readManifests = options.manifestReader || createManifestReader();
  const now = options.now || (() => new Date());
  const logger = options.logger || console;
  const environmentId = normalizeEnvironmentId(
    options.environmentId === undefined
      ? process.env.CLOUDBASE_ENV_ID ||
          process.env.TCB_ENV ||
          process.env.SCF_NAMESPACE
      : options.environmentId,
  );

  return async function operationsDashboardHandler(event = {}, context = {}) {
    const request = extractRequest(event, context);
    if (request.path !== path) return jsonResponse(404, { error: "not_found" });
    if (request.method !== "GET") {
      return jsonResponse(
        405,
        { error: "method_not_allowed" },
        { Allow: "GET" },
      );
    }
    if (!isAuthorized(request.headers, tokenHash)) {
      return jsonResponse(
        401,
        { error: "unauthorized" },
        { "WWW-Authenticate": "Bearer" },
      );
    }

    if (!apps.length || !environmentId) {
      return jsonResponse(503, { error: "metrics_unavailable" });
    }
    const query = parseQuery(request.url, request.querySources);
    if (!query.ok) return jsonResponse(400, { error: "invalid_query" });
    if (
      query.appId !== "all" &&
      !apps.some((app) => app.appId === query.appId)
    ) {
      return jsonResponse(400, { error: "invalid_query" });
    }

    try {
      const currentTime = now();
      if (
        !(currentTime instanceof Date) ||
        Number.isNaN(currentTime.getTime())
      ) {
        throw new Error("invalid_server_clock");
      }
      const selectedApps =
        query.appId === "all"
          ? apps
          : apps.filter((app) => app.appId === query.appId);
      const [events, manifests] = await Promise.all([
        readEvents({
          apps: selectedApps,
          startDate: addDays(toShanghaiDate(currentTime), -29),
          endDate: toShanghaiDate(currentTime),
          receivedBefore: currentTime.toISOString(),
          // Only the platform-supplied second argument is trusted for identity.
          runtimeContext: context,
        }),
        readManifests(selectedApps),
      ]);
      const snapshot = createDashboardSnapshot({
        apps,
        days: query.days,
        environmentId,
        events,
        manifests,
        now: currentTime,
        selectedAppId: query.appId,
      });
      return jsonResponse(200, snapshot);
    } catch (error) {
      if (logger && typeof logger.error === "function") {
        try {
          logger.error(
            "operations_dashboard_query_failed",
            safeDiagnostic(error),
          );
        } catch {
          // Diagnostic logging must not affect the response.
        }
      }
      return jsonResponse(503, { error: "metrics_unavailable" });
    }
  };
}

function parseDashboardApps(value) {
  let parsed = value;
  // CloudBase CLI 3.8.1 revives JSON-shaped strings into objects. A JSON-encoded
  // string survives that parser as a string; accept at most that extra layer.
  for (let depth = 0; depth < 2 && typeof parsed === "string"; depth += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const apps = [];
  for (const item of parsed) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).sort().join(",") !== "appId,collectionName,platforms" ||
      typeof item.appId !== "string" ||
      !APP_ID_PATTERN.test(item.appId) ||
      typeof item.collectionName !== "string" ||
      !COLLECTION_PATTERN.test(item.collectionName) ||
      !Array.isArray(item.platforms) ||
      item.platforms.length === 0 ||
      item.platforms.some(
        (platform) => !["windows", "macos"].includes(platform),
      ) ||
      new Set(item.platforms).size !== item.platforms.length
    ) {
      return [];
    }
    apps.push({
      appId: item.appId,
      collectionName: item.collectionName,
      platforms: [...item.platforms],
    });
  }
  return new Set(apps.map((app) => app.appId)).size === apps.length &&
    new Set(apps.map((app) => app.collectionName)).size === apps.length
    ? apps
    : [];
}

function isAuthorized(headers, expectedHash) {
  if (!expectedHash) return false;
  const header = findHeader(headers, "authorization");
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  if (token.length < 32 || token.length > 256) return false;
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeTokenHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function normalizeEnvironmentId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized !== "current" &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(normalized)
    ? normalized
    : null;
}

function normalizePathValue(value) {
  return typeof value === "string" && /^\/[a-z0-9._/-]+$/.test(value)
    ? value
    : null;
}

function parseQuery(urlValue, querySources = []) {
  let url;
  try {
    url = new URL(urlValue || "/", "https://dashboard.invalid");
  } catch {
    return { ok: false };
  }
  const values = new Map();
  for (const source of [url.searchParams, ...querySources]) {
    if (source === undefined || source === null || source === "") continue;
    let entries;
    if (source instanceof URLSearchParams || typeof source === "string") {
      entries = [...new URLSearchParams(source).entries()];
    } else if (typeof source === "object" && !Array.isArray(source)) {
      entries = Object.entries(source).map(([key, value]) => [
        key,
        Array.isArray(value) && value.length === 1 ? value[0] : value,
      ]);
    } else return { ok: false };
    const seen = new Set();
    for (const [key, value] of entries) {
      if (
        !["app_id", "days"].includes(key) ||
        typeof value !== "string" ||
        seen.has(key) ||
        value === "" ||
        (values.has(key) && values.get(key) !== value)
      )
        return { ok: false };
      seen.add(key);
      values.set(key, value);
    }
  }
  const daysText = values.get("days") || "14";
  const appId = values.get("app_id") || "all";
  if (!["7", "14", "30"].includes(daysText)) return { ok: false };
  if (appId !== "all" && !APP_ID_PATTERN.test(appId)) return { ok: false };
  return { ok: true, days: Number(daysText), appId };
}

function extractRequest(event, context) {
  const safeEvent = event && typeof event === "object" ? event : {};
  const safeContext = context && typeof context === "object" ? context : {};
  const requestHttp = safeEvent.requestContext?.http || {};
  const functionHttp = safeContext.httpContext || {};
  const method = firstString(
    safeEvent.httpMethod,
    safeEvent.method,
    requestHttp.method,
    functionHttp.httpMethod,
    functionHttp.method,
  );
  const url =
    firstString(
      safeEvent.url,
      safeEvent.rawPath,
      safeEvent.path,
      requestHttp.path,
      functionHttp.url,
      functionHttp.path,
    ) || "";
  return {
    method: method ? method.toUpperCase() : "",
    path: normalizeRequestPath(url),
    url,
    // API Gateway may keep path query-free and put the query in these fields.
    // Merge equivalent representations, but reject ambiguous or duplicate values.
    querySources: [
      safeEvent.rawQueryString,
      safeEvent.multiValueQueryStringParameters,
      safeEvent.queryStringParameters,
      functionHttp.rawQueryString,
      functionHttp.multiValueQueryStringParameters,
      functionHttp.queryStringParameters,
    ],
    headers:
      safeEvent.headers || safeEvent.header || functionHttp.headers || {},
  };
}

function normalizeRequestPath(value) {
  try {
    return new URL(value, "https://dashboard.invalid").pathname;
  } catch {
    return "";
  }
}

function findHeader(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  const value = entry?.[1];
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      Vary: "Authorization",
      ...extraHeaders,
    },
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
}

module.exports = {
  createHandler,
  extractRequest,
  isAuthorized,
  normalizeTokenHash,
  parseDashboardApps,
  parseQuery,
};
