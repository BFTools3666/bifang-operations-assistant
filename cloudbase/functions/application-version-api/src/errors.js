"use strict";

class ApiError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.headers = options.headers || {};
    this.expose = options.expose !== false;
  }
}

function errorEnvelope(code, message) {
  return {
    model: "errors",
    errors: {
      model: "data.set",
      datas: [{ model: "error", code, message }],
    },
  };
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      Vary: "x-app-key, x-app-secret",
      ...extraHeaders,
    },
    isBase64Encoded: false,
    body: JSON.stringify(body),
  };
}

function emptyResponse(statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Cache-Control": "no-store",
      Vary: "x-app-key, x-app-secret",
    },
    isBase64Encoded: false,
    body: "",
  };
}

function errorResponse(error, logger = console) {
  if (error instanceof ApiError) {
    return jsonResponse(
      error.statusCode,
      errorEnvelope(error.code, error.message),
      error.headers,
    );
  }

  if (logger && typeof logger.error === "function") {
    try {
      logger.error("application_version_api_failed", safeDiagnostic(error));
    } catch {
      // Logging must never change the externally visible response.
    }
  }
  return jsonResponse(500, errorEnvelope("server.error", "服务暂时不可用"));
}

function safeDiagnostic(error) {
  if (!error || typeof error !== "object") return { kind: "unknown" };
  const code =
    typeof error.code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(error.code)
      ? error.code
      : undefined;
  const name =
    typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(error.name)
      ? error.name
      : "Error";
  return code ? { name, code } : { name };
}

module.exports = {
  ApiError,
  emptyResponse,
  errorEnvelope,
  errorResponse,
  jsonResponse,
  safeDiagnostic,
};
