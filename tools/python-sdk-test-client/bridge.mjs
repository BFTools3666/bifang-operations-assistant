import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FetchTelemetryTransport,
  InstallIdentity,
  SDK_VERSION,
  TelemetryClient,
  UpdateChecker,
  buildUpdateUrl,
  isSafeExternalUrl,
  parseUpdateConfig,
} from "@bifang/telemetry-update-sdk";
import { NodeFileIdentityStorage } from "@bifang/telemetry-update-sdk/node";

const CAPTURE_ENDPOINT =
  "https://telemetry.example.invalid/python-sdk-test-client/capture";
const PREVIEW_UPDATE_BASE_URL =
  "https://updates.example.invalid/python-sdk-test-client/preview";
// The ten-device diagnostic is deliberately slow. It is an optional acceptance
// test, not production telemetry, and must not create a burst against a free
// CloudBase gateway.
const SIMULATION_POST_INTERVAL_MS = 500;
const SIMULATED_DEVICE_PLANS = Object.freeze([
  { platform: "windows", arch: "x64" },
  { platform: "windows", arch: "x64" },
  { platform: "windows", arch: "arm64" },
  { platform: "windows", arch: "ia32" },
  { platform: "macos", arch: "x64" },
  { platform: "macos", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "windows", arch: "x64" },
]);
const SERIAL_TELEMETRY_ACTIONS = new Set([
  "init_capture",
  "init_live",
  "send_daily_active",
  "simulate_devices",
  "check_update_url",
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
      const receipt = await this.transport.send(endpoint, event, signal);
      record.transport_result = "http_ok";
      record.http_status = receipt.httpStatus;
      record.ack = structuredClone(receipt.ack);
      return receipt;
    } catch (error) {
      record.transport_result = "dropped";
      record.error = error instanceof Error ? error.name : "unknown";
      throw error;
    }
  }
}

class ThrottledFetchTelemetryTransport {
  constructor(intervalMs = SIMULATION_POST_INTERVAL_MS) {
    this.intervalMs = intervalMs;
    this.transport = new FetchTelemetryTransport();
    this.queue = Promise.resolve();
    this.lastStartedAt = Number.NEGATIVE_INFINITY;
  }

  send(endpoint, event, signal) {
    const sendAfterPrevious = async () => {
      const remaining =
        this.intervalMs - (performance.now() - this.lastStartedAt);
      if (remaining > 0) {
        await abortableDelay(remaining, signal);
      }
      if (signal.aborted) {
        throw new Error("telemetry_aborted");
      }
      this.lastStartedAt = performance.now();
      return this.transport.send(endpoint, event, signal);
    };
    const result = this.queue.then(sendAfterPrevious, sendAfterPrevious);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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

function requireCanonicalExternalUrl(value, name) {
  const candidate = requireString(value, name);
  if (!isSafeExternalUrl(candidate)) {
    throw new BridgeRequestError(
      `unsafe_${name}`,
      `${name} must be an SDK-approved public HTTPS URL`,
    );
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BridgeRequestError(
      `unsafe_${name}`,
      `${name} must be a canonical public HTTPS URL`,
    );
  }
  if (parsed.hash !== "" || parsed.toString() !== candidate) {
    throw new BridgeRequestError(
      `unsafe_${name}`,
      `${name} must be a canonical public HTTPS URL without a fragment`,
    );
  }
  return candidate;
}

function deriveExactUpdateBaseUrl(updateUrl, appId, platform) {
  const parsed = new URL(updateUrl);
  const suffix = `/${appId}/${platform}.json`;
  if (parsed.search !== "" || !parsed.pathname.endsWith(suffix)) {
    throw new BridgeRequestError(
      "unsafe_update_url",
      "update_url must end with the canonical app_id/platform.json path",
    );
  }

  const base = new URL(parsed.toString());
  const basePath = parsed.pathname.slice(0, -suffix.length);
  base.pathname = basePath === "" ? "/" : basePath;
  base.search = "";
  base.hash = "";
  const baseUrl = base.toString();
  const rebuilt = buildUpdateUrl(baseUrl, appId, platform);
  if (rebuilt !== updateUrl) {
    throw new BridgeRequestError(
      "unsafe_update_url",
      "update_url must exactly match the SDK canonical update URL",
    );
  }
  return baseUrl;
}

function abortableDelay(delayMs, signal) {
  if (signal.aborted) {
    return Promise.reject(new Error("telemetry_aborted"));
  }
  return new Promise((resolveDelay, rejectDelay) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      rejectDelay(new Error("telemetry_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function uniqueStateDirectory(root, prefix) {
  return join(
    resolve(requireString(root, "state_dir")),
    `${prefix}-${randomUUID()}`,
  );
}

function publicDelivery(result, metadata = {}) {
  const acknowledged = result.outcome === "acknowledged";
  const failure = result.outcome === "failed" ? result.failure : null;
  return {
    ...metadata,
    event: result.event,
    event_id: result.eventId,
    acknowledged,
    status: acknowledged
      ? result.receipt.httpStatus
      : (failure?.httpStatus ?? null),
    ack: acknowledged ? structuredClone(result.receipt.ack) : null,
    error: failure
      ? {
          code: failure.code,
          ...(failure.httpStatus === undefined
            ? {}
            : { http_status: failure.httpStatus }),
          ...(failure.serverError === undefined
            ? {}
            : { server_error: failure.serverError }),
        }
      : null,
  };
}

function safeUpdateConfig(config) {
  if (!config) {
    return null;
  }
  return {
    app_id: config.app_id,
    platform: config.platform,
    enabled: config.enabled,
    latest_version: config.latest_version,
    min_supported_version: config.min_supported_version,
    force_update: config.force_update,
    rollout: config.rollout,
    title: config.title,
    message: config.message,
    download_url: config.download_url,
    release_notes_url: config.release_notes_url,
    published_at: config.published_at,
  };
}

function parseCheckedUpdateConfig(responseText, appId, platform) {
  if (typeof responseText !== "string" || responseText.length > 16_384) {
    return null;
  }
  try {
    return parseUpdateConfig(JSON.parse(responseText), appId, platform);
  } catch {
    return null;
  }
}

function telemetryConfig(request, identityStorage, extras) {
  return {
    appId: request.app_id,
    appVersion: request.app_version,
    platform: request.platform,
    arch: request.arch,
    identityStorage,
    scheduler: (task) => task(),
    ...extras,
  };
}

function appIdentityStorage(request, stateDirectory) {
  return new NodeFileIdentityStorage(stateDirectory, {
    appId: requireString(request.app_id, "app_id"),
  });
}

function publicClientState(client) {
  return {
    enabled: client.enabled,
    install_id: client.installId,
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

export function createBridgeDispatcher(options = {}) {
  const state = {
    capture: null,
    live: null,
  };
  const simulationTimeoutMs =
    Number.isInteger(options.simulationTimeoutMs) &&
    options.simulationTimeoutMs > 0 &&
    options.simulationTimeoutMs <= 30_000
      ? options.simulationTimeoutMs
      : 30_000;
  const simulationPostIntervalMs =
    Number.isInteger(options.simulationPostIntervalMs) &&
    options.simulationPostIntervalMs >= 1 &&
    options.simulationPostIntervalMs <= 5_000
      ? options.simulationPostIntervalMs
      : SIMULATION_POST_INTERVAL_MS;
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

    if (action === "send_daily_active") {
      requireNetworkConsent(request, "POST");
      const endpoint = requireCanonicalExternalUrl(
        request.endpoint,
        "endpoint",
      );
      const stateDirectory = uniqueStateDirectory(
        request.state_dir,
        "daily-active",
      );
      const logger = new BufferLogger();
      const client = await TelemetryClient.init(
        telemetryConfig(request, appIdentityStorage(request, stateDirectory), {
          enabled: true,
          endpoint,
          transport: new FetchTelemetryTransport(),
          logger,
          timeoutMs: 10_000,
        }),
      );
      const results = await client.drainResults();
      const deliveries = results.map((result) => publicDelivery(result));
      return {
        install_id: client.installId,
        platform: request.platform,
        arch: request.arch,
        deliveries,
        acknowledged_count: deliveries.filter(
          (delivery) => delivery.acknowledged,
        ).length,
        network_performed: deliveries.length > 0,
        debug: structuredClone(logger.records),
      };
    }

    if (action === "simulate_devices") {
      requireNetworkConsent(request, "POST");
      const endpoint = requireCanonicalExternalUrl(
        request.endpoint,
        "endpoint",
      );
      const stateRoot = resolve(requireString(request.state_dir, "state_dir"));
      const deviceSetups = [];
      const transport = new ThrottledFetchTelemetryTransport(
        simulationPostIntervalMs,
      );

      for (const [index, plan] of SIMULATED_DEVICE_PLANS.entries()) {
        const deviceNumber = index + 1;
        const stateDirectory = join(
          stateRoot,
          `device-${deviceNumber}-${randomUUID()}`,
        );
        const logger = new BufferLogger();
        const client = await TelemetryClient.init({
          appId: request.app_id,
          appVersion: request.app_version,
          platform: plan.platform,
          arch: plan.arch,
          identityStorage: appIdentityStorage(request, stateDirectory),
          scheduler: (task) => task(),
          enabled: true,
          endpoint,
          transport,
          logger,
          timeoutMs: simulationTimeoutMs,
        });
        const metadata = {
          device_number: deviceNumber,
          app_version: request.app_version,
          platform: plan.platform,
          arch: plan.arch,
          install_id: client.installId,
        };
        deviceSetups.push({ client, logger, metadata });
      }

      // Start every device before waiting so one hanging endpoint is bounded by
      // one shared timeout window instead of ten consecutive timeout windows.
      const devices = await Promise.all(
        deviceSetups.map(async ({ client, logger, metadata }) => {
          const deliveries = (await client.drainResults()).map((result) =>
            publicDelivery(result, {
              device_number: metadata.device_number,
            }),
          );
          return {
            ...metadata,
            deliveries,
            debug: structuredClone(logger.records),
          };
        }),
      );

      const deliveries = devices.flatMap((device) => device.deliveries);
      return {
        device_count: devices.length,
        devices,
        deliveries,
        acknowledged_count: deliveries.filter(
          (delivery) => delivery.acknowledged,
        ).length,
        network_performed: deliveries.length > 0,
      };
    }

    if (action === "check_update_url") {
      requireNetworkConsent(request, "GET");
      const updateUrl = requireCanonicalExternalUrl(
        request.update_url,
        "update_url",
      );
      const updateBaseUrl = deriveExactUpdateBaseUrl(
        updateUrl,
        request.app_id,
        request.platform,
      );
      const stateDirectory = resolve(
        requireString(request.state_dir, "state_dir"),
      );
      const logger = new BufferLogger();
      const identity = await new InstallIdentity(
        appIdentityStorage(request, stateDirectory),
        { logger },
      ).initialize();
      const fetchDiagnostic = {
        original_url: updateUrl,
        actual_url: updateUrl,
        attempted: false,
      };
      let responseText = null;
      let responseWasOk = false;
      const checker = new UpdateChecker({
        baseUrl: updateBaseUrl,
        appId: request.app_id,
        platform: request.platform,
        currentVersion: request.app_version,
        installId: identity.installId,
        enabled: true,
        logger,
        fetch: async (sdkRequestUrl, init) => {
          if (sdkRequestUrl !== updateUrl) {
            throw new BridgeRequestError(
              "unsafe_update_url",
              "SDK update URL does not exactly match update_url",
            );
          }
          fetchDiagnostic.attempted = true;
          fetchDiagnostic.sdk_request_url = sdkRequestUrl;
          fetchDiagnostic.method = init.method;
          fetchDiagnostic.cache = init.cache ?? "no-store";
          fetchDiagnostic.headers = structuredClone(init.headers);
          if (typeof globalThis.fetch !== "function") {
            fetchDiagnostic.error = { code: "fetch_unavailable" };
            throw new Error("fetch_unavailable");
          }

          let response;
          try {
            response = await globalThis.fetch(sdkRequestUrl, {
              method: init.method,
              headers: init.headers,
              signal: init.signal,
              cache: init.cache ?? "no-store",
              credentials: "omit",
              redirect: "error",
              referrerPolicy: "no-referrer",
            });
          } catch {
            fetchDiagnostic.error = { code: "network_error" };
            throw new Error("network_error");
          }
          responseWasOk = response.ok === true;
          fetchDiagnostic.http_status = Number.isInteger(response.status)
            ? response.status
            : null;
          fetchDiagnostic.http_ok = responseWasOk;
          if (!responseWasOk) {
            fetchDiagnostic.error = {
              code: "http_error",
              ...(Number.isInteger(response.status)
                ? { http_status: response.status }
                : {}),
            };
          }
          return {
            ok: responseWasOk,
            text: async () => {
              try {
                responseText = await response.text();
                return responseText;
              } catch {
                fetchDiagnostic.error = { code: "network_error" };
                throw new Error("network_error");
              }
            },
          };
        },
      });
      const decision = await checker.check();
      const parsedConfig = responseWasOk
        ? parseCheckedUpdateConfig(
            responseText,
            request.app_id,
            request.platform,
          )
        : null;
      return {
        decision,
        config: safeUpdateConfig(parsedConfig),
        install_id: identity.installId,
        is_first_install: identity.isFirstInstall,
        original_url: updateUrl,
        actual_url: updateUrl,
        fetch_diagnostic: fetchDiagnostic,
        debug: structuredClone(logger.records),
        network_performed: fetchDiagnostic.attempted,
      };
    }

    if (action === "init_capture") {
      const stateDirectory = requireString(request.state_dir, "state_dir");
      const transport = new CaptureTransport();
      const logger = new BufferLogger();
      const client = await TelemetryClient.init(
        telemetryConfig(request, appIdentityStorage(request, stateDirectory), {
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
        telemetryConfig(request, appIdentityStorage(request, stateDirectory), {
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
          "HTTP success plus an explicit server {ok:true} acknowledgement",
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
            cache: init.cache,
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
