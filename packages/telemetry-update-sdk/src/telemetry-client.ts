import {
  DEFAULT_CHANNEL,
  DEFAULT_TELEMETRY_TIMEOUT_MS,
  SDK_VERSION,
  TELEMETRY_SCHEMA_VERSION,
} from "./constants.js";
import { InstallIdentity } from "./identity.js";
import {
  FetchTelemetryTransport,
  TelemetryTransportError,
} from "./transport.js";
import type {
  AvailableUpdateDecision,
  EmptyTelemetryEventName,
  EventPropertiesMap,
  InstallIdentityState,
  PropertyTelemetryEventName,
  SanitizedProperties,
  TelemetryClientConfig,
  TelemetryDeliveryFailure,
  TelemetryDeliveryResult,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryTransport,
  TelemetryTransportReceipt,
} from "./types.js";
import {
  isAppId,
  isArchitecture,
  isChannel,
  isIsoDate,
  isPlatform,
  isSafeExternalUrl,
  isTelemetryEventName,
  isUuidV4,
  sanitizeEventProperties,
} from "./validation.js";
import { isValidSemVer } from "./semver.js";

interface ClientContext {
  appId: string;
  appVersion: string;
  platform: TelemetryClientConfig["platform"];
  arch: TelemetryClientConfig["arch"];
  channel: string;
  endpoint: string;
  identity: InstallIdentityState;
}

interface DeliveryRecord {
  readonly promise: Promise<TelemetryDeliveryResult>;
  settled: boolean;
  consumed: boolean;
}

const MAX_RETAINED_DELIVERY_RESULTS = 100;

export class TelemetryClient {
  readonly #config: TelemetryClientConfig;
  readonly #context: ClientContext;
  readonly #transport: TelemetryTransport;
  readonly #enabled: boolean;
  readonly #timeoutMs: number;
  readonly #pending = new Set<Promise<TelemetryDeliveryResult>>();
  readonly #deliveries: DeliveryRecord[] = [];

  private constructor(
    config: TelemetryClientConfig,
    identity: InstallIdentityState,
  ) {
    this.#config = config;
    const channel = normalizeChannel(config.channel);
    this.#context = {
      appId: config.appId,
      appVersion: config.appVersion,
      platform: config.platform,
      arch: config.arch,
      channel,
      endpoint: config.endpoint ?? "",
      identity,
    };
    this.#transport = config.transport ?? new FetchTelemetryTransport();
    this.#timeoutMs = normalizeTimeout(
      config.timeoutMs,
      DEFAULT_TELEMETRY_TIMEOUT_MS,
    );
    this.#enabled = config.enabled === true && isValidClientConfig(config);
    if (config.enabled === true && !this.#enabled) {
      this.#debug("telemetry_disabled_invalid_config");
    }
  }

  static async init(config: TelemetryClientConfig): Promise<TelemetryClient> {
    let identity: InstallIdentityState;
    try {
      identity = await new InstallIdentity(config.identityStorage, {
        logger: config.logger,
        now: config.now,
        uuid: config.uuid,
      }).initialize();
    } catch {
      // InstallIdentity is designed to be failure-silent; this final fallback
      // keeps initialization safe even if a caller supplies hostile objects.
      identity = {
        installId: safeUuid(config.uuid),
        sessionId: safeUuid(config.uuid),
        isFirstInstall: false,
      };
    }

    const client = new TelemetryClient(config, identity);
    if (identity.isFirstInstall) {
      client.track("app_install");
    }
    client.track("app_start");
    return client;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get installId(): string {
    return this.#context.identity.installId;
  }

  get sessionId(): string {
    return this.#context.identity.sessionId;
  }

  track(
    event: EmptyTelemetryEventName,
    properties?: Readonly<Record<string, never>>,
  ): void;
  track<EventName extends PropertyTelemetryEventName>(
    event: EventName,
    properties: EventPropertiesMap[EventName],
  ): void;
  track(event: TelemetryEventName, properties: unknown = {}): void {
    try {
      if (!this.#enabled || !isTelemetryEventName(event)) {
        return;
      }
      const sanitized = sanitizeEventProperties(event, properties);
      if (!sanitized) {
        this.#debug("telemetry_event_dropped_invalid_properties", { event });
        return;
      }

      const payload = this.#buildEvent(event, sanitized);
      this.#schedule(payload);
    } catch {
      // Telemetry must never escape into the host application's control flow.
    }
  }

  trackUpdatePromptShown(decision: AvailableUpdateDecision): void {
    this.track("update_prompt_shown", {
      target_version: decision.config.latest_version,
    });
  }

  trackUpdateClicked(decision: AvailableUpdateDecision): void {
    this.track("update_clicked", {
      target_version: decision.config.latest_version,
    });
  }

  /** Waits only for currently queued sends. It never retries failed events. */
  async drain(): Promise<void> {
    const pending = [...this.#pending];
    this.#takeDeliveryRecords();
    await Promise.all(pending);
    this.#trimDeliveryHistory();
  }

  /**
   * Waits for and returns the uncollected delivery results queued so far.
   * A result is `acknowledged` only when the HTTP service returned `{ok:true}`;
   * legacy custom transports that resolve `void` are reported as `sent`.
   * Pending results are never dropped; at most 100 completed results are kept
   * when a host never calls either drain method.
   */
  async drainResults(): Promise<TelemetryDeliveryResult[]> {
    const records = this.#takeDeliveryRecords();
    const results = await Promise.all(records.map((record) => record.promise));
    this.#trimDeliveryHistory();
    return results;
  }

  #buildEvent(
    event: TelemetryEventName,
    properties: SanitizedProperties,
  ): TelemetryEvent {
    return {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      event_id: safeUuid(this.#config.uuid),
      event,
      app_id: this.#context.appId,
      app_version: this.#context.appVersion,
      install_id: this.#context.identity.installId,
      session_id: this.#context.identity.sessionId,
      platform: this.#context.platform,
      arch: this.#context.arch,
      channel: this.#context.channel,
      sdk_version: SDK_VERSION,
      occurred_at: safeNow(this.#config.now),
      properties,
    } as TelemetryEvent;
  }

  #schedule(payload: TelemetryEvent): void {
    const scheduler = this.#config.scheduler ?? defaultScheduler;
    let resolvePending: ((result: TelemetryDeliveryResult) => void) | undefined;
    const pending = new Promise<TelemetryDeliveryResult>((resolve) => {
      resolvePending = resolve;
    });
    const record: DeliveryRecord = {
      promise: pending,
      settled: false,
      consumed: false,
    };
    this.#pending.add(pending);
    this.#deliveries.push(record);
    void pending.then(() => {
      record.settled = true;
      this.#pending.delete(pending);
      this.#trimDeliveryHistory();
    });

    let started = false;
    const schedulerTimeout = setTimeout(() => {
      if (started) {
        return;
      }
      started = true;
      resolvePending?.(failedDelivery(payload, { code: "scheduler_error" }));
    }, this.#timeoutMs);

    try {
      scheduler(() => {
        if (started) {
          return;
        }
        started = true;
        clearTimeout(schedulerTimeout);
        void this.#send(payload).then((result) => resolvePending?.(result));
      });
    } catch {
      // A broken injected scheduler is treated like any other telemetry failure.
      if (!started) {
        started = true;
        clearTimeout(schedulerTimeout);
        resolvePending?.(failedDelivery(payload, { code: "scheduler_error" }));
      }
    }
  }

  async #send(payload: TelemetryEvent): Promise<TelemetryDeliveryResult> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error("telemetry_timeout"));
        controller.abort();
      }, this.#timeoutMs);
    });

    try {
      const transportResult = await Promise.race([
        this.#transport.send(
          this.#context.endpoint,
          payload,
          controller.signal,
        ),
        timeoutPromise,
      ]);
      const receipt = normalizeTransportReceipt(transportResult);
      if (receipt) {
        return {
          event: payload.event,
          eventId: payload.event_id,
          outcome: "acknowledged",
          receipt,
        };
      }
      return {
        event: payload.event,
        eventId: payload.event_id,
        outcome: "sent",
        receipt: null,
      };
    } catch (error) {
      this.#debug("telemetry_send_dropped", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return failedDelivery(payload, deliveryFailure(error));
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }

  #debug(message: string, context?: Readonly<Record<string, unknown>>): void {
    try {
      this.#config.logger?.debug(message, context);
    } catch {
      // Debug logging is optional and isolated from host application behavior.
    }
  }

  #takeDeliveryRecords(): DeliveryRecord[] {
    const records = this.#deliveries.filter((record) => !record.consumed);
    for (const record of records) {
      record.consumed = true;
    }
    return records;
  }

  #trimDeliveryHistory(): void {
    for (let index = this.#deliveries.length - 1; index >= 0; index -= 1) {
      const record = this.#deliveries[index];
      if (record?.settled && record.consumed) {
        this.#deliveries.splice(index, 1);
      }
    }

    let retained = this.#deliveries.filter(
      (record) => record.settled && !record.consumed,
    ).length;
    for (
      let index = 0;
      retained > MAX_RETAINED_DELIVERY_RESULTS &&
      index < this.#deliveries.length;
    ) {
      const record = this.#deliveries[index];
      if (record?.settled && !record.consumed) {
        this.#deliveries.splice(index, 1);
        retained -= 1;
      } else {
        index += 1;
      }
    }
  }
}

function normalizeTransportReceipt(
  value: void | TelemetryTransportReceipt,
): TelemetryTransportReceipt | null {
  if (value === undefined) {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isInteger(value.httpStatus) ||
    typeof value.ack !== "object" ||
    value.ack === null ||
    value.ack.ok !== true
  ) {
    throw new TelemetryTransportError("invalid_response");
  }
  if (value.httpStatus < 200 || value.httpStatus > 299) {
    throw new TelemetryTransportError("http_error", {
      httpStatus: value.httpStatus,
    });
  }
  return { httpStatus: value.httpStatus, ack: { ok: true } };
}

function deliveryFailure(error: unknown): TelemetryDeliveryFailure {
  if (error instanceof TelemetryTransportError) {
    return {
      code: error.code,
      ...(error.httpStatus === undefined
        ? {}
        : { httpStatus: error.httpStatus }),
      ...(error.serverError === undefined
        ? {}
        : { serverError: error.serverError }),
    };
  }
  if (error instanceof Error && error.message === "telemetry_timeout") {
    return { code: "timeout" };
  }
  return { code: "transport_error" };
}

function failedDelivery(
  payload: Readonly<TelemetryEvent>,
  failure: TelemetryDeliveryFailure,
): TelemetryDeliveryResult {
  return {
    event: payload.event,
    eventId: payload.event_id,
    outcome: "failed",
    receipt: null,
    failure,
  };
}

function isValidClientConfig(config: TelemetryClientConfig): boolean {
  return (
    isAppId(config.appId) &&
    isValidSemVer(config.appVersion) &&
    isPlatform(config.platform) &&
    isArchitecture(config.arch) &&
    (config.channel === undefined || isChannel(config.channel)) &&
    isSafeExternalUrl(config.endpoint)
  );
}

function normalizeChannel(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_CHANNEL;
  }
  return typeof value === "string" ? value : "";
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 30_000
    ? value
    : fallback;
}

function safeUuid(factory: (() => string) | undefined): string {
  try {
    const value = (factory ?? (() => globalThis.crypto.randomUUID()))();
    return isUuidV4(value) ? value : globalThis.crypto.randomUUID();
  } catch {
    return globalThis.crypto.randomUUID();
  }
}

function safeNow(factory: (() => Date) | undefined): string {
  try {
    const value = (factory ?? (() => new Date()))().toISOString();
    return isIsoDate(value) ? value : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function defaultScheduler(task: () => void): void {
  setTimeout(task, 0);
}
