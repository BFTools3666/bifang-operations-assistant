"use strict";

const { createBurstGuard } = require("./burst-guard");
const { isAppId, validateAndSanitizePayload } = require("./validation");
const { createCloudBaseWriter } = require("./writer");

const TRACK_PATH = "/v1/track";
const MAX_RAW_BODY_BYTES = 4096;

const CORS_HEADERS = Object.freeze({
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Max-Age": "600",
  "Content-Type": "application/json; charset=utf-8",
});

function createHandler(options = {}) {
  const allowedAppIds = normalizeAllowedAppIds(
    options.allowedAppIds === undefined
      ? process.env.ALLOWED_APP_IDS
      : options.allowedAppIds,
  );
  const writeEvent = normalizeWriter(options.writer || createCloudBaseWriter());
  const burstGuard = options.burstGuard || createBurstGuard();
  const now = options.now || (() => new Date());
  const logger = options.logger || console;

  return async function telemetryHandler(event = {}, context = {}) {
    const request = extractRequest(event, context);

    if (request.path !== TRACK_PATH) {
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

    if (!allowedAppIds.has(validated.value.app_id)) {
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

      // Selectively reconstructed data prevents raw headers, client IPs, unknown
      // fields, and a client-supplied received_at value from reaching storage.
      const storedEvent = {
        ...validated.value,
        _id: validated.value.event_id,
        received_at: receivedAt.toISOString(),
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

function normalizeAllowedAppIds(value) {
  let candidates;
  if (typeof value === "string") {
    candidates = value.split(",");
  } else if (Array.isArray(value) || value instanceof Set) {
    candidates = [...value];
  } else {
    candidates = [];
  }

  return new Set(
    candidates
      .filter((candidate) => typeof candidate === "string")
      .map((candidate) => candidate.trim())
      .filter((candidate) => isAppId(candidate)),
  );
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
  TRACK_PATH,
  createHandler,
  extractRequest,
  normalizeAllowedAppIds,
  parseBody,
};
