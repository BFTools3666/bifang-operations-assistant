import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FetchTelemetryTransport,
  SDK_VERSION,
  TelemetryClient,
  UpdateChecker,
  buildUpdateUrl,
  isSafeExternalUrl,
} from "@bifang/telemetry-update-sdk";
import { NodeFileIdentityStorage } from "@bifang/telemetry-update-sdk/node";

const CAPTURE_ENDPOINT =
  "https://telemetry.example.invalid/python-sdk-test-client/capture";
const PREVIEW_UPDATE_BASE_URL =
  "https://updates.example.invalid/python-sdk-test-client/preview";
const SERIAL_TELEMETRY_ACTIONS = new Set([
  "init_capture",
  "track_capture",
  "init_live",
  "track_live",
  "reset_sessions",
]);

export class BridgeRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BridgeRequestError";
    this.code = code;
  }
}

class CaptureTransport {
  events = [];

  async send(_endpoint, event) {
    this.events.push(structuredClone(event));
  }
}

class ObservedFetchTelemetryTransport {
  records = [];

  constructor() {
    this.transport = new FetchTelemetryTransport();
  }

  async send(endpoint, event, signal) {
    const record = {
      event: event.event,
      event_id: event.event_id,
      transport_result: "pending",
    };
    this.records.push(record);
    try {
      await this.transport.send(endpoint, event, signal);
      record.transport_result = "http_ok";
    } catch (error) {
      record.transport_result = "dropped";
      record.error = error instanceof Error ? error.name : "unknown";
      throw error;
    }
  }
}

class BufferLogger {
  records = [];

  debug(message, context) {
    this.records.push({ message, ...(context ? { context } : {}) });
  }
}

function requireObject(value, name = "request") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BridgeRequestError(
      "invalid_request",
      `${name} must be an object`,
    );
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeRequestError(
      "invalid_request",
      `${name} must be a non-empty string`,
    );
  }
  return value;
}

function requireNetworkConsent(request, verb) {
  if (request.allow_network !== true || request.confirmation !== verb) {
    throw new BridgeRequestError(
      "network_consent_required",
      `this action requires explicit ${verb} consent`,
    );
  }
}

function telemetryConfig(request, identityStorage, extras) {
  const config = {
    appId: request.app_id,
    appVersion: request.app_version,
    platform: request.platform,
    arch: request.arch,
    identityStorage,
    scheduler: (task) => task(),
    ...extras,
  };
  if (Object.hasOwn(request, "channel")) {
    config.channel = request.channel;
  }
  return config;
}

function publicClientState(client) {
  return {
    enabled: client.enabled,
    install_id: client.installId,
    session_id: client.sessionId,
  };
}

function currentInstallId(state) {
  const client = state.live?.client ?? state.capture?.client;
  if (!client) {
    throw new BridgeRequestError(
      "sdk_not_initialized",
      "initialize a capture or live SDK session first",
    );
  }
  return client.installId;
}

export function createBridgeDispatcher() {
  const state = {
    capture: null,
    live: null,
  };
  let telemetryQueue = Promise.resolve();

  const dispatch = async function dispatch(rawRequest) {
    const request = requireObject(rawRequest);
    const action = requireString(request.action, "action");

    if (action === "ping") {
      return {
        sdk_version: SDK_VERSION,
        network_performed: false,
      };
    }

    if (action === "status") {
      return {
        sdk_version: SDK_VERSION,
        capture: state.capture ? publicClientState(state.capture.client) : null,
        live: state.live
          ? {
              ...publicClientState(state.live.client),
              endpoint: state.live.endpoint,
            }
          : null,
        network_performed: false,
      };
    }

    if (action === "reset_sessions") {
      state.capture = null;
      state.live = null;
      return { reset: true, network_performed: false };
    }

    if (action === "init_capture") {
      const stateDirectory = requireString(request.state_dir, "state_dir");
      const transport = new CaptureTransport();
      const logger = new BufferLogger();
      const client = await TelemetryClient.init(
        telemetryConfig(request, new NodeFileIdentityStorage(stateDirectory), {
          enabled: true,
          endpoint: CAPTURE_ENDPOINT,
          transport,
          logger,
        }),
      );
      await client.drain();
      state.capture = { client, transport, logger };
      return {
        client: publicClientState(client),
        events: structuredClone(transport.events),
        debug: structuredClone(logger.records),
        network_performed: false,
      };
    }

    if (action === "track_capture") {
      if (!state.capture) {
        throw new BridgeRequestError(
          "sdk_not_initialized",
          "initialize the capture SDK session first",
        );
      }
      const startIndex = state.capture.transport.events.length;
      state.capture.client.track(request.event, request.properties);
      await state.capture.client.drain();
      const events = state.capture.transport.events.slice(startIndex);
      return {
        accepted_by_sdk: events.length > 0,
        events: structuredClone(events),
        network_performed: false,
      };
    }

    if (action === "init_live") {
      requireNetworkConsent(request, "POST");
      const endpoint = requireString(request.endpoint, "endpoint");
      if (!isSafeExternalUrl(endpoint)) {
        throw new BridgeRequestError(
          "unsafe_endpoint",
          "endpoint must be an SDK-approved public HTTPS URL",
        );
      }
      const stateDirectory = requireString(request.state_dir, "state_dir");
      const transport = new ObservedFetchTelemetryTransport();
      const logger = new BufferLogger();
      const client = await TelemetryClient.init(
        telemetryConfig(request, new NodeFileIdentityStorage(stateDirectory), {
          enabled: true,
          endpoint,
          transport,
          logger,
        }),
      );
      await client.drain();
      state.live = { client, endpoint, transport, logger };
      return {
        client: publicClientState(client),
        transport_records: structuredClone(transport.records),
        debug: structuredClone(logger.records),
        network_performed: transport.records.length > 0,
        receipt_scope:
          "HTTP response only; this does not prove backend persistence",
      };
    }

    if (action === "track_live") {
      requireNetworkConsent(request, "POST");
      if (!state.live) {
        throw new BridgeRequestError(
          "sdk_not_initialized",
          "initialize the live SDK session first",
        );
      }
      const endpoint = requireString(request.endpoint, "endpoint");
      if (endpoint !== state.live.endpoint) {
        throw new BridgeRequestError(
          "endpoint_mismatch",
          "the entered endpoint must exactly match the live session endpoint",
        );
      }
      const startIndex = state.live.transport.records.length;
      state.live.client.track(request.event, request.properties);
      await state.live.client.drain();
      const records = state.live.transport.records.slice(startIndex);
      return {
        accepted_by_sdk: records.length > 0,
        transport_records: structuredClone(records),
        network_performed: records.length > 0,
        receipt_scope:
          "HTTP response only; this does not prove backend persistence",
      };
    }

    if (action === "preview_update") {
      requireObject(request.manifest, "manifest");
      const requests = [];
      const logger = new BufferLogger();
      const checker = new UpdateChecker({
        baseUrl: PREVIEW_UPDATE_BASE_URL,
        appId: request.app_id,
        platform: request.platform,
        currentVersion: request.app_version,
        installId: currentInstallId(state),
        enabled: true,
        logger,
        fetch: async (url, init) => {
          requests.push({
            url,
            method: init.method,
            headers: structuredClone(init.headers),
          });
          return {
            ok: true,
            text: async () => JSON.stringify(request.manifest),
          };
        },
      });
      const decision = await checker.check();
      return {
        decision,
        sdk_requests: requests,
        debug: structuredClone(logger.records),
        network_performed: false,
      };
    }

    if (action === "build_update_url") {
      const baseUrl = requireString(request.base_url, "base_url");
      const requestUrl = buildUpdateUrl(
        baseUrl,
        request.app_id,
        request.platform,
      );
      if (!requestUrl) {
        throw new BridgeRequestError(
          "unsafe_update_url",
          "base_url must build an SDK-approved public HTTPS update URL",
        );
      }
      return {
        request_url: requestUrl,
        network_performed: false,
      };
    }

    if (action === "check_update_live") {
      requireNetworkConsent(request, "GET");
      const baseUrl = requireString(request.base_url, "base_url");
      const requestUrl = buildUpdateUrl(
        baseUrl,
        request.app_id,
        request.platform,
      );
      if (!requestUrl) {
        throw new BridgeRequestError(
          "unsafe_update_url",
          "base_url must build an SDK-approved public HTTPS update URL",
        );
      }
      const logger = new BufferLogger();
      const checker = new UpdateChecker({
        baseUrl,
        appId: request.app_id,
        platform: request.platform,
        currentVersion: request.app_version,
        installId: currentInstallId(state),
        enabled: true,
        logger,
      });
      const decision = await checker.check();
      return {
        decision,
        request_url: requestUrl,
        debug: structuredClone(logger.records),
        network_authorized: true,
      };
    }

    throw new BridgeRequestError(
      "unknown_action",
      `unsupported action: ${action}`,
    );
  };

  return async function queuedDispatch(rawRequest) {
    const request = requireObject(rawRequest);
    const action = requireString(request.action, "action");
    if (!SERIAL_TELEMETRY_ACTIONS.has(action)) {
      return dispatch(request);
    }

    const pending = telemetryQueue.then(
      () => dispatch(request),
      () => dispatch(request),
    );
    telemetryQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
}

function errorResponse(requestId, error) {
  const isRequestError = error instanceof BridgeRequestError;
  return {
    request_id: requestId,
    ok: false,
    error: {
      code: isRequestError ? error.code : "bridge_internal_error",
      message: isRequestError ? error.message : "unexpected bridge failure",
    },
  };
}

export function startJsonLinesBridge({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const dispatch = createBridgeDispatcher();
  const lines = createInterface({ input, crlfDelay: Infinity });

  lines.on("line", (line) => {
    if (line.trim() === "") {
      return;
    }
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      output.write(
        `${JSON.stringify(errorResponse(null, new BridgeRequestError("invalid_json", "request must be valid JSON")))}\n`,
      );
      return;
    }

    const requestId =
      typeof request === "object" &&
      request !== null &&
      !Array.isArray(request) &&
      typeof request.request_id === "string"
        ? request.request_id
        : null;

    void dispatch(request)
      .then((result) => {
        output.write(
          `${JSON.stringify({ request_id: requestId, ok: true, result })}\n`,
        );
      })
      .catch((error) => {
        output.write(`${JSON.stringify(errorResponse(requestId, error))}\n`);
      });
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (invokedPath === import.meta.url) {
  startJsonLinesBridge();
}
