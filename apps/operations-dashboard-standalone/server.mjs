import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(APP_DIR, "public");
const DEFAULT_APPS_FILE = resolve(APP_DIR, "../../cloudbase/apps.json");
const DEFAULT_METRICS_ENDPOINT =
  "https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/admin/v1/metrics";
const SESSION_COOKIE = "bifang_dashboard_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const MAX_RELEASE_STREAMS_PER_APP = 12;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 8;

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/assets/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

const SECURITY_HEADERS = {
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
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export async function createDashboardServer(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const apps = options.apps ?? (await loadApps(env.DASHBOARD_APPS_FILE));
  const registry = readRegistry(apps);
  const metricsEndpoint = parseMetricsEndpoint(
    env.CLOUDBASE_METRICS_ENDPOINT ?? DEFAULT_METRICS_ENDPOINT,
  );
  const metricsToken = env.CLOUDBASE_METRICS_TOKEN?.trim() ?? "";
  const accessToken = env.DASHBOARD_ACCESS_TOKEN?.trim() ?? "";
  const secureCookie = parseBoolean(env.COOKIE_SECURE, true);
  const loginAttempts = new Map();

  return createServer(async (request, response) => {
    applyHeaders(response, SECURITY_HEADERS);
    try {
      const requestUrl = new URL(request.url ?? "/", "http://dashboard.local");

      if (requestUrl.pathname === "/healthz") {
        return sendJson(response, 200, { ok: true }, { cache: "no-store" });
      }

      if (requestUrl.pathname === "/api/session") {
        if (request.method === "GET") {
          const authenticated = isAuthenticated(request, accessToken);
          return sendJson(
            response,
            200,
            { authenticated },
            { cache: "no-store" },
          );
        }
        if (request.method === "POST") {
          return handleLogin({
            request,
            response,
            accessToken,
            secureCookie,
            loginAttempts,
          });
        }
        if (request.method === "DELETE") {
          response.setHeader(
            "Set-Cookie",
            serializeCookie("", { maxAge: 0, secure: secureCookie }),
          );
          return sendJson(response, 200, { ok: true }, { cache: "no-store" });
        }
        return methodNotAllowed(response, "GET, POST, DELETE");
      }

      if (requestUrl.pathname === "/api/metrics") {
        if (request.method !== "GET") return methodNotAllowed(response, "GET");
        if (!isAuthenticated(request, accessToken)) {
          return sendJson(
            response,
            401,
            { error: "authentication_required" },
            { cache: "no-store" },
          );
        }
        return proxyMetrics({
          request,
          response,
          requestUrl,
          metricsToken,
          metricsEndpoint,
          registry,
          fetchImpl,
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed(response, "GET, HEAD");
      }
      const staticFile = STATIC_FILES.get(requestUrl.pathname);
      if (!staticFile) return sendText(response, 404, "Not found");
      const [fileName, contentType] = staticFile;
      const body = await readFile(join(PUBLIC_DIR, fileName));
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType);
      response.setHeader(
        "Cache-Control",
        requestUrl.pathname === "/" || requestUrl.pathname === "/index.html"
          ? "no-store"
          : "public, max-age=3600",
      );
      response.setHeader("Content-Length", String(body.byteLength));
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      if (!response.headersSent) {
        sendJson(
          response,
          500,
          { error: "internal_error" },
          { cache: "no-store" },
        );
      } else {
        response.destroy();
      }
    }
  });
}

async function handleLogin({
  request,
  response,
  accessToken,
  secureCookie,
  loginAttempts,
}) {
  if (!isStrongSecret(accessToken)) {
    return sendJson(
      response,
      503,
      { error: "dashboard_not_configured" },
      { cache: "no-store" },
    );
  }

  const clientKey = request.socket.remoteAddress ?? "unknown";
  const now = Date.now();
  const history = (loginAttempts.get(clientKey) ?? []).filter(
    (time) => now - time < LOGIN_WINDOW_MS,
  );
  if (history.length >= LOGIN_LIMIT) {
    loginAttempts.set(clientKey, history);
    response.setHeader("Retry-After", "900");
    return sendJson(
      response,
      429,
      { error: "too_many_attempts" },
      { cache: "no-store" },
    );
  }

  let body;
  try {
    body = await readJsonBody(request, 8 * 1024);
  } catch {
    return sendJson(
      response,
      400,
      { error: "invalid_request" },
      { cache: "no-store" },
    );
  }

  const submitted =
    typeof body.accessToken === "string" ? body.accessToken : "";
  if (!constantTimeEqual(submitted, accessToken)) {
    history.push(now);
    loginAttempts.set(clientKey, history);
    return sendJson(
      response,
      401,
      { error: "invalid_access_token" },
      { cache: "no-store" },
    );
  }

  loginAttempts.delete(clientKey);
  response.setHeader(
    "Set-Cookie",
    serializeCookie(createSession(accessToken), {
      maxAge: SESSION_TTL_SECONDS,
      secure: secureCookie,
    }),
  );
  return sendJson(response, 200, { ok: true }, { cache: "no-store" });
}

async function proxyMetrics({
  request,
  response,
  requestUrl,
  metricsToken,
  metricsEndpoint,
  registry,
  fetchImpl,
}) {
  const query = parseMetricsQuery(requestUrl.searchParams, registry.appIds);
  if (!query) {
    return sendJson(
      response,
      400,
      { error: "invalid_query" },
      { cache: "no-store" },
    );
  }
  if (!isStrongSecret(metricsToken)) {
    return sendJson(
      response,
      503,
      { error: "metrics_not_configured" },
      { cache: "no-store" },
    );
  }

  try {
    const upstreamUrl = new URL(metricsEndpoint);
    upstreamUrl.searchParams.set("days", String(query.days));
    if (query.app !== "all") upstreamUrl.searchParams.set("app_id", query.app);

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 8_000);
    let upstream;
    let payload;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        headers: { Authorization: `Bearer ${metricsToken}` },
        cache: "no-store",
        signal: abort.signal,
      });
      if (!upstream.ok) throw new Error("metrics_unavailable");
      payload = await upstream.json();
    } finally {
      clearTimeout(timer);
    }
    if (!isDashboardSnapshot(payload, query.days, query.app, registry)) {
      throw new Error("invalid_metrics_shape");
    }
    return sendJson(
      response,
      200,
      toSafeDashboardSnapshot(payload, registry.appIds),
      { cache: "no-store" },
    );
  } catch {
    return sendJson(
      response,
      503,
      { error: "metrics_unavailable" },
      { cache: "no-store" },
    );
  }
}

function parseMetricsQuery(searchParams, appIds) {
  const keys = [...searchParams.keys()];
  if (
    keys.some(
      (key) =>
        !["days", "app"].includes(key) || searchParams.getAll(key).length !== 1,
    )
  ) {
    return null;
  }
  const daysRaw = searchParams.get("days") ?? "14";
  const app = searchParams.get("app") ?? "all";
  if (!["7", "14", "30"].includes(daysRaw)) return null;
  if (app !== "all" && !appIds.includes(app)) return null;
  return { days: Number(daysRaw), app };
}

function createSession(secret) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = randomBytes(16).toString("base64url");
  const payload = `v1.${expiresAt}.${nonce}`;
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function isAuthenticated(request, secret) {
  if (!isStrongSecret(secret)) return false;
  const cookie = parseCookies(request.headers.cookie ?? "")[SESSION_COOKIE];
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000) {
    return false;
  }
  const payload = parts.slice(0, 3).join(".");
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return constantTimeEqual(parts[3], expected);
}

function serializeCookie(value, { maxAge, secure }) {
  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : null,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index < 0
          ? [part, ""]
          : [part.slice(0, index), part.slice(index + 1)];
      }),
  );
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isStrongSecret(value) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 32;
}

async function readJsonBody(request, maxBytes) {
  if (
    !String(request.headers["content-type"] ?? "").startsWith(
      "application/json",
    )
  ) {
    throw new Error("invalid_content_type");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(value)) throw new Error("invalid_json");
  return value;
}

async function loadApps(fileName) {
  const contents = await readFile(
    resolve(fileName || DEFAULT_APPS_FILE),
    "utf8",
  );
  return JSON.parse(contents);
}

function readRegistry(value) {
  if (
    !isRecord(value) ||
    value.schema_version !== 3 ||
    !Array.isArray(value.apps)
  ) {
    throw new Error("invalid_apps_registry");
  }
  const appIds = [];
  const streams = [];
  const seenApps = new Set();
  const seenCodes = new Set();
  for (const app of value.apps) {
    if (
      !isRecord(app) ||
      typeof app.app_id !== "string" ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(app.app_id) ||
      seenApps.has(app.app_id) ||
      !Array.isArray(app.release_streams) ||
      app.release_streams.length === 0 ||
      app.release_streams.length > MAX_RELEASE_STREAMS_PER_APP
    ) {
      throw new Error("invalid_apps_registry");
    }
    seenApps.add(app.app_id);
    appIds.push(app.app_id);
    for (const stream of app.release_streams) {
      if (
        !isRecord(stream) ||
        typeof stream.code !== "string" ||
        !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(stream.code) ||
        seenCodes.has(stream.code) ||
        !["windows", "macos", "linux"].includes(stream.platform) ||
        !["x64", "arm64", "ia32"].includes(stream.architecture) ||
        typeof stream.channel !== "string" ||
        !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(stream.channel)
      ) {
        throw new Error("invalid_apps_registry");
      }
      seenCodes.add(stream.code);
      streams.push({
        appId: app.app_id,
        code: stream.code,
        platform: stream.platform,
        architecture: stream.architecture,
        channel: stream.channel,
      });
    }
  }
  if (appIds.length === 0) throw new Error("invalid_apps_registry");
  return { appIds, streams };
}

function parseMetricsEndpoint(value) {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== "/admin/v1/metrics"
  ) {
    throw new Error("invalid_metrics_endpoint");
  }
  return endpoint.toString();
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("invalid_boolean");
}

function toSafeDashboardSnapshot(payload, appIds) {
  return {
    schemaVersion: 2,
    mode: "live",
    connection: "connected",
    connectionNote: payload.connectionNote,
    environmentId: payload.environmentId,
    timezone: "Asia/Shanghai",
    generatedAt: payload.generatedAt,
    rangeDays: payload.rangeDays,
    selectedAppId: payload.selectedAppId,
    appIds,
    totals: {
      todayActive: payload.totals.todayActive,
      yesterdayActive: payload.totals.yesterdayActive,
      periodActive: payload.totals.periodActive,
      returningToday: payload.totals.returningToday,
      returningRate: payload.totals.returningRate,
      lastReceivedAt: payload.totals.lastReceivedAt,
    },
    trend: payload.trend.map((point) => ({
      date: point.date,
      total: point.total,
      byApp: Object.fromEntries(
        appIds.map((appId) => [appId, point.byApp[appId]]),
      ),
    })),
    versions: payload.versions.map(safeDistribution),
    platforms: payload.platforms.map(safeDistribution),
    architectures: payload.architectures.map(safeDistribution),
    releaseStreams: payload.releaseStreams.map((item) => ({
      appId: item.appId,
      code: item.code,
      platform: item.platform,
      architecture: item.architecture,
      channel: item.channel,
      highestVersion: item.highestVersion,
      status: item.status,
      updatedAt: item.updatedAt,
    })),
    alerts: payload.alerts.map((item) => ({
      id: item.id,
      tone: item.tone,
      title: item.title,
      detail: item.detail,
      time: item.time,
    })),
  };
}

function safeDistribution(item) {
  return {
    label: item.label,
    value: item.value,
    percent: item.percent,
    ...(item.tone ? { tone: item.tone } : {}),
  };
}

function isDashboardSnapshot(value, expectedDays, expectedApp, registry) {
  if (!isRecord(value)) return false;
  return (
    value.schemaVersion === 2 &&
    value.mode === "live" &&
    value.connection === "connected" &&
    isShortText(value.connectionNote, 200) &&
    value.timezone === "Asia/Shanghai" &&
    isIsoDate(value.generatedAt) &&
    value.environmentId === "bftoos-sh-d3ga7hahz59229f0a" &&
    value.rangeDays === expectedDays &&
    value.selectedAppId === expectedApp &&
    isTotals(value.totals) &&
    Array.isArray(value.trend) &&
    value.trend.length === expectedDays &&
    value.trend.every((point) => isTrendPoint(point, registry.appIds)) &&
    isDistribution(value.versions) &&
    isDistribution(value.platforms) &&
    isDistribution(value.architectures) &&
    isReleaseStreams(value.releaseStreams, expectedApp, registry) &&
    Array.isArray(value.alerts) &&
    value.alerts.every(isAlert)
  );
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isShortText(value, maxLength) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isIsoDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPercent(value) {
  return typeof value === "number" && value >= 0 && value <= 100;
}

function isTotals(value) {
  return (
    isRecord(value) &&
    isCount(value.todayActive) &&
    isCount(value.yesterdayActive) &&
    isCount(value.periodActive) &&
    isCount(value.returningToday) &&
    isPercent(value.returningRate) &&
    (value.lastReceivedAt === null || isIsoDate(value.lastReceivedAt))
  );
}

function isTrendPoint(value, appIds) {
  if (!isRecord(value) || !isRecord(value.byApp)) return false;
  return (
    typeof value.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    isCount(value.total) &&
    Object.keys(value.byApp).length === appIds.length &&
    appIds.every((appId) => isCount(value.byApp[appId]))
  );
}

function isDistribution(value) {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (item) =>
        isRecord(item) &&
        isShortText(item.label, 100) &&
        isCount(item.value) &&
        isPercent(item.percent) &&
        (item.tone === undefined ||
          ["mint", "lime", "amber", "ink"].includes(item.tone)),
    )
  );
}

function streamIdentity(value) {
  return [
    value.appId,
    value.code,
    value.platform,
    value.architecture,
    value.channel,
  ].join("\u0000");
}

function isReleaseStreams(value, expectedApp, registry) {
  if (!Array.isArray(value)) return false;
  const expected = registry.streams.filter(
    (stream) => expectedApp === "all" || stream.appId === expectedApp,
  );
  if (value.length !== expected.length) return false;
  const expectedIdentities = new Set(expected.map(streamIdentity));
  const seen = new Set();
  for (const item of value) {
    if (!isRecord(item)) return false;
    const identity = streamIdentity(item);
    if (!expectedIdentities.has(identity) || seen.has(identity)) return false;
    seen.add(identity);
    if (
      !["empty", "normal", "prompt", "forced", "stopped"].includes(
        item.status,
      ) ||
      (item.status === "empty" &&
        (item.highestVersion !== null || item.updatedAt !== null)) ||
      (item.status !== "empty" &&
        (typeof item.highestVersion !== "string" ||
          !/^[0-9]+(?:\.[0-9]+)*$/.test(item.highestVersion) ||
          item.highestVersion.length > 50 ||
          !isIsoDate(item.updatedAt)))
    ) {
      return false;
    }
  }
  return true;
}

function isAlert(value) {
  return (
    isRecord(value) &&
    isShortText(value.id, 100) &&
    ["warning", "success", "neutral"].includes(value.tone) &&
    isShortText(value.title, 200) &&
    isShortText(value.detail, 500) &&
    isShortText(value.time, 100)
  );
}

function applyHeaders(response, headers) {
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }
}

function sendJson(response, status, value, { cache = "no-store" } = {}) {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", cache);
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

function sendText(response, status, value) {
  const body = Buffer.from(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

function methodNotAllowed(response, allow) {
  response.setHeader("Allow", allow);
  return sendJson(
    response,
    405,
    { error: "method_not_allowed" },
    { cache: "no-store" },
  );
}

async function main() {
  const server = await createDashboardServer();
  const port = Number(process.env.PORT ?? "4173");
  const host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  server.listen(port, host, () => {
    console.log(
      `Bifang standalone dashboard listening on http://${host}:${port}`,
    );
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
