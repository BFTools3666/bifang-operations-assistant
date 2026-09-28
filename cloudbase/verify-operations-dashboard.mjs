import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export async function verifyOperationsDashboard({
  origin,
  secretFile,
  fetchImplementation = globalThis.fetch,
  waitImplementation = wait,
}) {
  const normalizedOrigin = normalizeOrigin(origin);
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("fetch implementation is unavailable");
  }
  const { metricsToken, accessToken } = parseRawSecrets(
    await readFile(secretFile, "utf8"),
  );
  const dashboardUrl = new URL("/dashboard", normalizedOrigin);
  const sessionUrl = new URL("/dashboard/api/session", normalizedOrigin);
  const browserMetricsUrl = new URL(
    "/dashboard/api/metrics?days=7&app_id=all",
    normalizedOrigin,
  );
  const adminMetricsUrl = new URL(
    "/admin/v1/metrics?days=7&app_id=all",
    normalizedOrigin,
  );
  const checks = [];

  const page = await request(fetchImplementation, dashboardUrl);
  assertStatus(page, 200, "dashboard page");
  assertHeaderStartsWith(page, "content-type", "text/html");
  assertSecurityHeaders(page);
  assertTextIncludes(page.body, "/dashboard/assets/app.js", "dashboard page");
  assertNoSecrets(page.body, metricsToken, accessToken, "dashboard page");
  checks.push({ name: "dashboard_page", status: 200 });

  for (const [name, path, expectedType] of [
    ["dashboard_javascript", "/dashboard/assets/app.js", "text/javascript"],
    ["dashboard_styles", "/dashboard/assets/styles.css", "text/css"],
  ]) {
    const asset = await request(
      fetchImplementation,
      new URL(path, normalizedOrigin),
    );
    assertStatus(asset, 200, name);
    assertHeaderStartsWith(asset, "content-type", expectedType);
    assertNoSecrets(asset.body, metricsToken, accessToken, name);
    checks.push({ name, status: 200 });
  }

  const initialSession = await request(fetchImplementation, sessionUrl);
  assertStatus(initialSession, 200, "initial session");
  assertJson(initialSession, { authenticated: false }, "initial session");
  checks.push({ name: "initial_session", status: 200, authenticated: false });

  const unauthenticatedMetrics = await request(
    fetchImplementation,
    browserMetricsUrl,
  );
  assertStatus(unauthenticatedMetrics, 401, "unauthenticated browser metrics");
  checks.push({ name: "unauthenticated_metrics", status: 401 });

  const wrongAccessToken =
    accessToken === "x".repeat(64) ? "y".repeat(64) : "x".repeat(64);
  const wrongLogin = await request(fetchImplementation, sessionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: wrongAccessToken }),
  });
  assertStatus(wrongLogin, 401, "wrong access key");
  checks.push({ name: "wrong_access_key", status: 401 });

  const login = await request(fetchImplementation, sessionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken }),
  });
  assertStatus(login, 200, "correct access key");
  const setCookie = login.headers.get("set-cookie") || "";
  if (
    !/^bifang_dashboard_session=v1\./u.test(setCookie) ||
    !/;\s*Path=\/dashboard(?:;|$)/iu.test(setCookie) ||
    !/;\s*HttpOnly(?:;|$)/iu.test(setCookie) ||
    !/;\s*Secure(?:;|$)/iu.test(setCookie) ||
    !/;\s*SameSite=Strict(?:;|$)/iu.test(setCookie)
  ) {
    throw new Error(
      "correct access key did not return the required secure cookie",
    );
  }
  assertNoSecrets(setCookie, metricsToken, accessToken, "session cookie");
  const cookie = setCookie.split(";", 1)[0];
  checks.push({ name: "secure_login_cookie", status: 200 });

  const authenticatedSession = await request(fetchImplementation, sessionUrl, {
    headers: { Cookie: cookie },
  });
  assertStatus(authenticatedSession, 200, "authenticated session");
  assertJson(
    authenticatedSession,
    { authenticated: true },
    "authenticated session",
  );
  checks.push({
    name: "authenticated_session",
    status: 200,
    authenticated: true,
  });

  const browserMetrics = await request(fetchImplementation, browserMetricsUrl, {
    headers: { Cookie: cookie },
  });
  assertStatus(browserMetrics, 200, "authenticated browser metrics");
  const browserSnapshot = validateSnapshot(
    browserMetrics,
    metricsToken,
    accessToken,
    "authenticated browser metrics",
  );
  checks.push({
    name: "authenticated_metrics",
    status: 200,
    selected_app_id: browserSnapshot.selectedAppId,
    range_days: browserSnapshot.rangeDays,
  });

  // The preserved admin route intentionally permits only two requests per
  // ClientIP each second. Space the negative and positive checks so the
  // verifier validates authentication rather than tripping that route limit.
  await waitImplementation(1_100);
  const missingAdminToken = await request(fetchImplementation, adminMetricsUrl);
  assertStatus(missingAdminToken, 401, "missing admin token");
  checks.push({ name: "missing_admin_token", status: 401 });

  const wrongMetricsToken =
    metricsToken === "z".repeat(64) ? "y".repeat(64) : "z".repeat(64);
  await waitImplementation(1_100);
  const wrongAdminToken = await request(fetchImplementation, adminMetricsUrl, {
    headers: { Authorization: `Bearer ${wrongMetricsToken}` },
  });
  assertStatus(wrongAdminToken, 401, "wrong admin token");
  checks.push({ name: "wrong_admin_token", status: 401 });

  await waitImplementation(1_100);
  const adminMetrics = await request(fetchImplementation, adminMetricsUrl, {
    headers: { Authorization: `Bearer ${metricsToken}` },
  });
  assertStatus(adminMetrics, 200, "correct admin token");
  validateSnapshot(
    adminMetrics,
    metricsToken,
    accessToken,
    "correct admin token",
  );
  checks.push({ name: "correct_admin_token", status: 200 });

  const logout = await request(fetchImplementation, sessionUrl, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assertStatus(logout, 200, "logout");
  if (!/Max-Age=0/iu.test(logout.headers.get("set-cookie") || "")) {
    throw new Error("logout did not expire the session cookie");
  }
  checks.push({ name: "logout", status: 200 });

  return {
    status: "passed",
    origin: normalizedOrigin.origin,
    dashboard_url: dashboardUrl.href,
    checks,
  };
}

function wait(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

async function request(fetchImplementation, url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(url, {
      ...init,
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("dashboard verification response exceeded size limit");
    }
    return { status: response.status, headers: response.headers, body };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("dashboard verification request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateSnapshot(response, metricsToken, accessToken, label) {
  let snapshot;
  try {
    snapshot = JSON.parse(response.body);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (
    !snapshot ||
    snapshot.schemaVersion !== 2 ||
    snapshot.mode !== "live" ||
    snapshot.selectedAppId !== "all" ||
    snapshot.rangeDays !== 7 ||
    !Array.isArray(snapshot.appIds) ||
    !snapshot.totals ||
    typeof snapshot.totals.todayActive !== "number" ||
    !Array.isArray(snapshot.trend) ||
    snapshot.trend.length !== 7 ||
    !Array.isArray(snapshot.releaseStreams)
  ) {
    throw new Error(`${label} returned an invalid dashboard snapshot`);
  }
  const serialized = JSON.stringify(snapshot);
  assertNoSecrets(serialized, metricsToken, accessToken, label);
  for (const forbidden of [
    "install_id",
    "event_id",
    "source_ip",
    "download_url",
    "prompt_content",
    "update_content",
    "credential",
    "secret",
    "token",
  ]) {
    if (serialized.toLowerCase().includes(forbidden)) {
      throw new Error(`${label} exposed a forbidden field`);
    }
  }
  return snapshot;
}

function assertSecurityHeaders(response) {
  const contentSecurityPolicy =
    response.headers.get("content-security-policy") || "";
  if (!contentSecurityPolicy.includes("frame-ancestors 'none'")) {
    throw new Error("dashboard page is missing the required CSP");
  }
  if ((response.headers.get("x-content-type-options") || "") !== "nosniff") {
    throw new Error("dashboard page is missing nosniff");
  }
  if ((response.headers.get("x-frame-options") || "") !== "DENY") {
    throw new Error("dashboard page is missing frame protection");
  }
}

function assertJson(response, expected, label) {
  let actual;
  try {
    actual = JSON.parse(response.body);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} returned an unexpected JSON response`);
  }
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(
      `${label} returned HTTP ${response.status}, expected ${expected}`,
    );
  }
}

function assertHeaderStartsWith(response, name, prefix) {
  const value = response.headers.get(name) || "";
  if (!value.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error(`${name} did not start with ${prefix}`);
  }
}

function assertTextIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not contain the expected page reference`);
  }
}

function assertNoSecrets(value, metricsToken, accessToken, label) {
  if (value.includes(metricsToken) || value.includes(accessToken)) {
    throw new Error(`${label} exposed a raw token`);
  }
}

function parseRawSecrets(source) {
  const values = new Map();
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || values.has(match[1])) {
      throw new TypeError(`secret file line ${index + 1} is malformed`);
    }
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  const metricsToken = values.get("CLOUDBASE_METRICS_TOKEN") || "";
  const accessToken = values.get("DASHBOARD_ACCESS_TOKEN") || "";
  for (const value of [metricsToken, accessToken]) {
    const length = Buffer.byteLength(value, "utf8");
    if (length < 32 || length > 256) {
      throw new TypeError("dashboard verification token is invalid");
    }
  }
  if (metricsToken === accessToken) {
    throw new TypeError("dashboard verification tokens must be distinct");
  }
  return { metricsToken, accessToken };
}

function normalizeOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("origin must be a valid HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("origin must be an HTTPS origin without a path");
  }
  return url;
}

function parseArguments(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--origin" ||
    args[2] !== "--secret-file"
  ) {
    throw new TypeError(
      "usage: node cloudbase/verify-operations-dashboard.mjs --origin <https_origin> --secret-file <ignored_env_file>",
    );
  }
  return { origin: args[1], secretFile: resolve(args[3]) };
}

async function main() {
  const result = await verifyOperationsDashboard(
    parseArguments(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isMain =
  process.argv[1] &&
  import.meta.url.toLowerCase() ===
    pathToFileURL(resolve(process.argv[1])).href.toLowerCase();

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
