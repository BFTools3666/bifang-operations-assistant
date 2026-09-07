"use strict";

const CODES = new Set([
  "DATABASE_ERROR",
  "DATABASE_REQUEST_FAILED",
  "DATABASE_REQUEST_FAIL",
  "DATABASE_PERMISSION_DENIED",
  "DATABASE_COLLECTION_NOT_EXIST",
  "DATABASE_INDEX_NOT_FOUND",
  "PERMISSION_DENIED",
  "ACCESS_DENIED",
  "UNAUTHORIZED",
  "AUTH_FAILED",
  "INVALID_CREDENTIALS",
  "INVALID_CONTEXT",
  "INVALID_PARAM",
  "INVALID_ENV",
  "ENV_NOT_EXIST",
  "SYS_ERR",
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "ERR_REQUIRE_ESM",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "SUCCESS",
]);
const NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "AbortError",
]);
const MESSAGES = new Set([
  "database_result_invalid",
  "database_query_limit_exceeded",
  "database_cursor_invalid",
  "database_permission_denied",
  "database_collection_missing",
  "database_index_unavailable",
  "runtime_credentials_unavailable",
  "runtime_environment_unavailable",
  "runtime_dependency_unavailable",
  "request_timeout",
  "network_unavailable",
  "sdk_database_unavailable",
  "query_parameters_invalid",
  "server_clock_invalid",
  "database_unexpected_success_code",
  "database_query_failed",
  "metrics_query_failed",
]);

function safeErrorCode(value) {
  return typeof value === "string" && CODES.has(value) ? value : "UNKNOWN";
}

function safeDiagnostic(error, fallback = "metrics_query_failed") {
  const source = error && typeof error === "object" ? error : {};
  const code =
    [source.code, source.errCode, source.errorCode, source.cause?.code]
      .map(safeErrorCode)
      .find((value) => value !== "UNKNOWN") || "UNKNOWN";
  const name = NAMES.has(source.name) ? source.name : "Error";
  // Inspect only a bounded prefix for classification. Never return or log it.
  const text = `${code} ${typeof source.message === "string" ? source.message.slice(0, 2048) : ""}`;
  let message = MESSAGES.has(source.message) ? source.message : fallback;
  if (/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM/.test(code))
    message = "runtime_dependency_unavailable";
  else if (
    /PERMISSION|ACCESS_DENIED|not authorized|permission denied|权限|鉴权失败/i.test(
      text,
    )
  )
    message = "database_permission_denied";
  else if (
    /credential|secret(?:id|key)|signature|UNAUTHORIZED|AUTH_FAILED|INVALID_CONTEXT|登录|身份|签名/i.test(
      text,
    )
  )
    message = "runtime_credentials_unavailable";
  else if (
    /cloudbase_environment_unavailable|INVALID_ENV|ENV_NOT_EXIST|environment.+(?:missing|not exist|unavailable)/i.test(
      text,
    )
  )
    message = "runtime_environment_unavailable";
  else if (
    /collection.+(?:not exist|missing)|DATABASE_COLLECTION_NOT_EXIST|集合不存在/i.test(
      text,
    )
  )
    message = "database_collection_missing";
  else if (
    /index.+(?:not found|missing|required)|DATABASE_INDEX_NOT_FOUND|索引/i.test(
      text,
    )
  )
    message = "database_index_unavailable";
  else if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(`${text} ${name}`))
    message = "request_timeout";
  else if (/ENOTFOUND|EAI_AGAIN|ECONN|fetch failed|network/i.test(text))
    message = "network_unavailable";
  else if (/dashboard_query_limit_exceeded/.test(text))
    message = "database_query_limit_exceeded";
  else if (/dashboard_query_invalid_cursor/.test(text))
    message = "database_cursor_invalid";
  else if (/invalid_server_clock/.test(text)) message = "server_clock_invalid";
  else if (code === "SUCCESS") message = "database_unexpected_success_code";
  else if (/INVALID_PARAM|invalid query|query param/i.test(text))
    message = "query_parameters_invalid";
  else if (
    /database.+not a function|command.+undefined|(?:gte|lte|orderBy|field).+not a function/i.test(
      text,
    )
  )
    message = "sdk_database_unavailable";
  return {
    code,
    name,
    message: MESSAGES.has(message) ? message : "metrics_query_failed",
  };
}

function createDatabaseError(result) {
  const details = safeDiagnostic(
    result,
    Array.isArray(result?.data)
      ? "database_query_failed"
      : "database_result_invalid",
  );
  const error = new Error(details.message);
  error.code = details.code;
  return error;
}

module.exports = { createDatabaseError, safeDiagnostic, safeErrorCode };
