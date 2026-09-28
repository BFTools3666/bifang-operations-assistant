"use strict";

const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");

const SESSION_COOKIE = "bifang_dashboard_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;
const LOGIN_BUCKET_LIMIT = 1_000;
const MAX_BODY_BYTES = 8 * 1024;
const BASE_PATH_PLACEHOLDER = "__DASHBOARD_BASE_PATH__";

const STATIC_FILES = new Map([
  ["", ["index.html", "text/html; charset=utf-8"]],
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/assets/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
});

function createDashboardWebHandler(options = {}) {
  const webPath = options.webPath;
  const accessTokenHash = normalizeTokenHash(options.accessTokenHash);
  const handleMetrics = options.handleMetrics;
  const now = options.now || (() => new Date());
  const randomBytesImpl = options.randomBytes || randomBytes;
  const readFileImpl = options.readFile || readFile;
  const publicDirectory =
    options.publicDirectory || resolve(__dirname, "../public");
  const loginAttempts = options.loginAttempts || new Map();

  return async function handleDashboardWebRequest(request, context) {
    if (!webPath || !isWithinWebPath(request.path, webPath)) return null;
    const relativePath = request.path.slice(webPath.length);

    if (relativePath === "/api/session") {
      if (request.method === "GET") {
        return jsonResponse(200, {
          authenticated: isAuthenticated(
            request.headers,
            accessTokenHash,
            nowSeconds(now),
          ),
        });
      }
      if (request.method === "POST") {
        return handleLogin({
          request,
          accessTokenHash,
          loginAttempts,
          now,
          randomBytesImpl,
          webPath,
        });
      }
      if (request.method === "DELETE") {
        return jsonResponse(
          200,
          { ok: true },
          { "Set-Cookie": serializeCookie("", webPath, 0) },
        );
      }
      return jsonResponse(
        405,
        { error: "method_not_allowed" },
        { Allow: "GET, POST, DELETE" },
      );
    }

    if (relativePath === "/api/metrics") {
      if (request.method !== "GET") {
        return jsonResponse(
          405,
          { error: "method_not_allowed" },
          { Allow: "GET" },
        );
      }
      if (!isAuthenticated(request.headers, accessTokenHash, nowSeconds(now))) {
        return jsonResponse(401, { error: "authentication_required" });
      }
      if (typeof handleMetrics !== "function") {
        return jsonResponse(503, { error: "metrics_unavailable" });
      }
      const response = await handleMetrics(request, context);
      return withSecurityHeaders({
        ...response,
        headers: { ...(response.headers || {}), Vary: "Cookie" },
      });
    }

    const staticFile = STATIC_FILES.get(relativePath);
    if (!staticFile) return textResponse(404, "Not found");
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(405, "Method not allowed", { Allow: "GET, HEAD" });
    }

    const [fileName, contentType] = staticFile;
    try {
      let body = await readFileImpl(join(publicDirectory, fileName), "utf8");
      if (fileName === "index.html" || fileName === "app.js") {
        body = body.replaceAll(BASE_PATH_PLACEHOLDER, webPath);
      }
      const bodyLength = Buffer.byteLength(body, "utf8");
      return {
        statusCode: 200,
        headers: {
          ...SECURITY_HEADERS,
          "Cache-Control":
            fileName === "index.html" ? "no-store" : "public, max-age=300",
          "Content-Length": String(bodyLength),
          "Content-Type": contentType,
        },
        isBase64Encoded: false,
        body: request.method === "HEAD" ? "" : body,
      };
    } catch {
      return textResponse(503, "Dashboard unavailable");
    }
  };
}

async function handleLogin({
  request,
  accessTokenHash,
  loginAttempts,
  now,
  randomBytesImpl,
  webPath,
}) {
  if (!accessTokenHash) {
    return jsonResponse(503, { error: "dashboard_not_configured" });
  }

  const currentMilliseconds = nowMilliseconds(now);
  const clientKey = rateLimitKey(request.sourceIp, loginAttempts);
  const history = (loginAttempts.get(clientKey) || []).filter(
    (time) => currentMilliseconds - time < LOGIN_WINDOW_MS,
  );
  if (history.length >= LOGIN_LIMIT) {
    loginAttempts.set(clientKey, history);
    return jsonResponse(
      429,
      { error: "too_many_attempts" },
      { "Retry-After": String(Math.ceil(LOGIN_WINDOW_MS / 1000)) },
    );
  }

  let body;
  try {
    body = parseJsonBody(request);
  } catch {
    return jsonResponse(400, { error: "invalid_request" });
  }
  const submitted = body.accessToken;
  if (!matchesToken(submitted, accessTokenHash)) {
    history.push(currentMilliseconds);
    loginAttempts.set(clientKey, history);
    return jsonResponse(401, { error: "invalid_access_token" });
  }

  loginAttempts.delete(clientKey);
  const session = createSession(
    accessTokenHash,
    Math.floor(currentMilliseconds / 1000),
    randomBytesImpl,
  );
  return jsonResponse(
    200,
    { ok: true },
    {
      "Set-Cookie": serializeCookie(session, webPath, SESSION_TTL_SECONDS),
    },
  );
}

function createSession(accessTokenHash, currentSeconds, randomBytesImpl) {
  const expiresAt = currentSeconds + SESSION_TTL_SECONDS;
  const nonce = randomBytesImpl(16).toString("base64url");
  const payload = `v1.${expiresAt}.${nonce}`;
  const signature = signSession(payload, accessTokenHash);
  return `${payload}.${signature}`;
}

function isAuthenticated(headers, accessTokenHash, currentSeconds) {
  if (!accessTokenHash) return false;
  const cookieHeader = findHeader(headers, "cookie");
  if (typeof cookieHeader !== "string") return false;
  const session = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!session) return false;
  const parts = session.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= currentSeconds) {
    return false;
  }
  const payload = parts.slice(0, 3).join(".");
  return constantTimeEqual(parts[3], signSession(payload, accessTokenHash));
}

function signSession(payload, accessTokenHash) {
  return createHmac("sha256", Buffer.from(accessTokenHash, "hex"))
    .update(payload, "utf8")
    .digest("base64url");
}

function serializeCookie(value, webPath, maxAge) {
  const fields = [
    `${SESSION_COOKIE}=${value}`,
    `Path=${webPath}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (maxAge === 0) fields.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  return fields.join("; ");
}

function parseJsonBody(request) {
  const contentType = findHeader(request.headers, "content-type");
  if (
    typeof contentType !== "string" ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    throw new Error("invalid_content_type");
  }
  let parsed;
  if (typeof request.body === "string") {
    const raw = request.isBase64Encoded
      ? Buffer.from(request.body, "base64").toString("utf8")
      : request.body;
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      throw new Error("body_too_large");
    }
    parsed = JSON.parse(raw);
  } else if (isPlainObject(request.body)) {
    const serialized = JSON.stringify(request.body);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
      throw new Error("body_too_large");
    }
    parsed = request.body;
  } else {
    throw new Error("invalid_body");
  }
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).length !== 1 ||
    typeof parsed.accessToken !== "string"
  ) {
    throw new Error("invalid_body_shape");
  }
  return parsed;
}

function matchesToken(token, expectedHash) {
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") < 32 ||
    Buffer.byteLength(token, "utf8") > 256
  ) {
    return false;
  }
  const actual = createHash("sha256").update(token, "utf8").digest();
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function normalizeTokenHash(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function parseCookies(header) {
  const cookies = Object.create(null);
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    const name = index < 0 ? trimmed : trimmed.slice(0, index);
    const value = index < 0 ? "" : trimmed.slice(index + 1);
    if (!Object.hasOwn(cookies, name)) cookies[name] = value;
  }
  return cookies;
}

function findHeader(headers, name) {
  if (!headers || typeof headers !== "object") return undefined;
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (matches.length !== 1) return undefined;
  const value = matches[0][1];
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function rateLimitKey(sourceIp, loginAttempts) {
  const normalized =
    typeof sourceIp === "string" && sourceIp.length <= 128
      ? sourceIp
      : "unknown";
  if (
    loginAttempts.has(normalized) ||
    loginAttempts.size < LOGIN_BUCKET_LIMIT
  ) {
    return normalized;
  }
  return "overflow";
}

function nowMilliseconds(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("invalid_server_clock");
  }
  return value.getTime();
}

function nowSeconds(now) {
  return Math.floor(nowMilliseconds(now) / 1000);
}

function isWithinWebPath(path, webPath) {
  return path === webPath || path.startsWith(`${webPath}/`);
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function withSecurityHeaders(response) {
  return {
    ...response,
    headers: { ...SECURITY_HEADERS, ...(response.headers || {}) },
  };
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      Vary: "Cookie",
      ...extraHeaders,
    },
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
}

function textResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      ...SECURITY_HEADERS,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
    isBase64Encoded: false,
    body,
  };
}

module.exports = {
  BASE_PATH_PLACEHOLDER,
  SECURITY_HEADERS,
  SESSION_COOKIE,
  createDashboardWebHandler,
  createSession,
  isAuthenticated,
  matchesToken,
  parseJsonBody,
};
