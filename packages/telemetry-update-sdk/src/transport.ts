import type {
  TelemetryEvent,
  TelemetryTransport,
  TelemetryTransportErrorCode,
  TelemetryTransportReceipt,
} from "./types.js";

const MAX_RESPONSE_CHARACTERS = 4_096;
const SAFE_SERVER_ERROR = /^[a-z][a-z0-9_]{0,63}$/;

export class TelemetryTransportError extends Error {
  readonly code: TelemetryTransportErrorCode;
  readonly httpStatus?: number;
  readonly serverError?: string;

  constructor(
    code: TelemetryTransportErrorCode,
    details: { httpStatus?: number; serverError?: string } = {},
  ) {
    super(code);
    this.name = "TelemetryTransportError";
    this.code = code;
    if (isHttpStatus(details.httpStatus)) {
      this.httpStatus = details.httpStatus;
    }
    if (isSafeServerError(details.serverError)) {
      this.serverError = details.serverError;
    }
  }
}

export class FetchTelemetryTransport implements TelemetryTransport {
  async send(
    endpoint: string,
    event: Readonly<TelemetryEvent>,
    signal: AbortSignal,
  ): Promise<TelemetryTransportReceipt> {
    if (typeof globalThis.fetch !== "function") {
      throw new TelemetryTransportError("fetch_unavailable");
    }

    let response: Response;
    try {
      response = await globalThis.fetch(endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(event),
        signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new TelemetryTransportError("network_error");
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch {
      throw new TelemetryTransportError("network_error", {
        httpStatus: response.status,
      });
    }

    const responseBody = parseResponseBody(responseText);
    const serverError = readServerError(responseBody);

    if (isRejectedResponse(responseBody)) {
      throw new TelemetryTransportError("server_rejected", {
        httpStatus: response.status,
        serverError,
      });
    }

    if (!response.ok) {
      throw new TelemetryTransportError("http_error", {
        httpStatus: response.status,
        serverError,
      });
    }

    if (!isAcknowledgement(responseBody)) {
      throw new TelemetryTransportError("invalid_response", {
        httpStatus: response.status,
      });
    }

    return {
      httpStatus: response.status,
      ack: { ok: true },
    };
  }
}

function parseResponseBody(value: string): unknown {
  if (value.length > MAX_RESPONSE_CHARACTERS) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isAcknowledgement(value: unknown): value is { ok: true } {
  return isRecord(value) && value.ok === true;
}

function isRejectedResponse(value: unknown): value is { ok: false } {
  return isRecord(value) && value.ok === false;
}

function readServerError(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return isSafeServerError(value.error) ? value.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpStatus(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
  );
}

function isSafeServerError(value: unknown): value is string {
  return typeof value === "string" && SAFE_SERVER_ERROR.test(value);
}
