"use strict";

const { createHash } = require("node:crypto");
const { isIP } = require("node:net");

const { createBurstGuard } = require("./burst-guard");
const { isAppId, validateAndSanitizePayload } = require("./validation");
const { createCloudBaseWriter } = require("./writer");

const MAX_RAW_BODY_BYTES = 4096;
const TELEMETRY_RETENTION_DAYS = 30;
const TELEMETRY_RETENTION_MILLISECONDS =
  TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Max-Age": "600",
  "Content-Type": "application/json; charset=utf-8",
});

function createHandler(options = {}) {
  const expectedAppId = normalizeSingleAllowedAppId(
    options.allowedAppIds === undefined
      ? process.env.ALLOWED_APP_IDS
      : options.allowedAppIds,
  );
  // A deployed function belongs to exactly one app. Treat a missing or
  // accidentally comma-separated allow-list as a closed configuration instead
  // of mixing multiple apps into one collection.
  const trackPath = normalizeTrackPath(
    options.trackPath === undefined
      ? process.env.TRACK_PATH
      : options.trackPath,
  );
  const writeEvent = normalizeWriter(options.writer || createCloudBaseWriter());
  const burstGuard = options.burstGuard || createBurstGuard();
  const now = options.now || (() => new Date());
  const logger = options.logger || console;

  return async function telemetryHandler(event = {}, context = {}) {
    const request = extractRequest(event, context);

    if (request.path !== trackPath) {
      return jsonResponse(404, { ok: false, error: "not_found" });
    }

    if (request.method === "OPTIONS") {
      return emptyResponse(204);
    }

    if (request.method !== "POST") {
      return jsonResponse(
        405,
        { ok: false, error: "method_not_allowed" },
        { Allow: "POST, OPTIONS" },
      );
    }

    if (!isJsonContentType(request.headers) || request.isBase64Encoded) {
      return invalidPayloadResponse();
    }

    const parsedBody = parseBody(request.body);
    if (!parsedBody.ok) {
      return invalidPayloadResponse();
    }

    const validated = validateAndSanitizePayload(parsedBody.value);
    if (!validated.ok) {
      return invalidPayloadResponse();
    }

    if (validated.value.app_id !== expectedAppId) {
      return jsonResponse(403, { ok: false, error: "unknown_app" });
    }

    if (!burstGuard.allow(validated.value.app_id)) {
      return jsonResponse(
        429,
        { ok: false, error: "rate_limited" },
        { "Retry-After": "10" },
      );
    }

    try {
      const receivedAt = now();
      if (!(receivedAt instanceof Date) || Number.isNaN(receivedAt.getTime())) {
        throw new Error("invalid_server_clock");
      }

      const receivedAtIso = receivedAt.toISOString();
      const activeDate = toShanghaiDate(receivedAt);

      // Only a source address supplied by CloudBase's trusted request context is
      // accepted. In particular, X-Forwarded-For and all other client-controlled
      // headers are intentionally ignored.
      const storedEvent = {
        ...validated.value,
        _id: createDailyActiveId(
          validated.value.app_id,
          activeDate,
          validated.value.install_id,
        ),
        active_date: activeDate,
        received_at: receivedAtIso,
        // CloudBase stores Date values as BSON dates. The per-app collection
        // owns a TTL index on this field so source IP and install identifiers
        // are deleted together after the approved retention window.
        expires_at: new Date(
          receivedAt.getTime() + TELEMETRY_RETENTION_MILLISECONDS,
        ),
        source_ip: extractTrustedSourceIp(event, context),
      };

      await writeEvent(storedEvent);
      return jsonResponse(202, { ok: true });
    } catch (error) {
      // Never log the event, request, database details, credentials, or stack.
      if (logger && typeof logger.error === "function") {
        try {
          logger.error("telemetry_write_failed");
        } catch {
          // Logging is diagnostic only and must never change the HTTP contract.
        }
      }
      return jsonResponse(500, { ok: false, error: "internal_error" });
    }
  };
}

function toShanghaiDate(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function createDailyActiveId(appId, activeDate, installId) {
  return createHash("sha256")
    .update(`${appId}\u0000${activeDate}\u0000${installId}`, "utf8")
    .digest("hex");
}

function extractTrustedSourceIp(event, context) {
  const safeEvent = event && typeof event === "object" ? event : {};
  const safeContext = context && typeof context === "object" ? context : {};
  const requestContext =
    safeEvent.requestContext && typeof safeEvent.requestContext === "object"
      ? safeEvent.requestContext
      : {};
  const requestHttp =
    requestContext.http && typeof requestContext.http === "object"
      ? requestContext.http
      : {};
  const functionHttp =
    safeContext.httpContext && typeof safeContext.httpContext === "object"
      ? safeContext.httpContext
      : {};

  for (const candidate of [
    requestHttp.sourceIp,
    requestContext.sourceIp,
    functionHttp.sourceIp,
    functionHttp.clientIp,
  ]) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (isIP(normalized) !== 0) return normalized;
  }
  return null;
}

function normalizeSingleAllowedAppId(value) {
  let candidates;
  if (typeof value === "string") {
    candidates = value.split(",");
  } else if (Array.isArray(value)) {
    candidates = value;
  } else if (value instanceof Set) {
    candidates = [...value];
  } else {
    return null;
  }
  if (candidates.length !== 1 || typeof candidates[0] !== "string") {
    return null;
  }
  const appId = candidates[0].trim();
  return isAppId(appId) ? appId : null;
}

function normalizeTrackPath(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^\/[a-z0-9._/-]+$/.test(value) ||
    value.includes("//") ||
    value.endsWith("/")
  ) {
    throw new TypeError("TRACK_PATH must be a normalized absolute path");
  }
  return value;
}

function normalizeWriter(writer) {
  if (typeof writer === "function") return writer;
  if (writer && typeof writer.write === "function") {
    return writer.write.bind(writer);
  }
  throw new TypeError("writer must be a function or expose write(document)");
}

function extractRequest(event, context) {
  event = event && typeof event === "object" ? event : {};
  context = context && typeof context === "object" ? context : {};
  const eventHttpContext = event.requestContext && event.requestContext.http;
  const functionHttpContext = context && context.httpContext;
  const method = firstString(
    event.httpMethod,
    event.method,
    eventHttpContext && eventHttpContext.method,
    functionHttpContext && functionHttpContext.httpMethod,
    functionHttpContext && functionHttpContext.method,
  );
  const rawPath = firstString(
    event.path,
    event.rawPath,
    eventHttpContext && eventHttpContext.path,
    functionHttpContext && functionHttpContext.path,
    functionHttpContext && functionHttpContext.url,
    event.url,
  );

  return {
    method: method ? method.toUpperCase() : "",
    path: normalizePath(rawPath),
    headers:
      event.headers ||
      event.header ||
      (functionHttpContext && functionHttpContext.headers) ||
      {},
    body: event.body,
    isBase64Encoded:
      event.isBase64Encoded === true || event.isBase64Encoded === "true",
  };
}

function normalizePath(value) {
  if (!value) return "";
  try {
    if (/^https?:\/\//i.test(value)) return new URL(value).pathname;
  } catch {
    return "";
  }
  return value.split("?")[0];
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0);
}

function isJsonContentType(headers) {
  if (!headers || typeof headers !== "object") return false;
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "content-type",
  );
  if (!entry) return false;
  const value = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
  return (
    typeof value === "string" &&
    value.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}

function parseBody(body) {
  if (
    Buffer.isBuffer(body) ||
    ArrayBuffer.isView(body) ||
    body instanceof ArrayBuffer
  ) {
    return { ok: false };
  }

  let raw;
  if (typeof body === "string") {
    raw = body;
  } else if (body && typeof body === "object") {
    try {
      raw = JSON.stringify(body);
    } catch {
      return { ok: false };
    }
  } else {
    return { ok: false };
  }

  if (Buffer.byteLength(raw, "utf8") > MAX_RAW_BODY_BYTES) {
    return { ok: false };
  }

  try {
    const value = typeof body === "string" ? JSON.parse(raw) : body;
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, ...extraHeaders },
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
}

function emptyResponse(statusCode) {
  return {
    statusCode,
    headers: CORS_HEADERS,
    isBase64Encoded: false,
    body: "",
  };
}

function invalidPayloadResponse() {
  return jsonResponse(400, { ok: false, error: "invalid_payload" });
}

module.exports = {
  CORS_HEADERS,
  MAX_RAW_BODY_BYTES,
  TELEMETRY_RETENTION_DAYS,
  createDailyActiveId,
  createHandler,
  extractRequest,
  extractTrustedSourceIp,
  normalizeSingleAllowedAppId,
  normalizeTrackPath,
  parseBody,
  toShanghaiDate,
};
