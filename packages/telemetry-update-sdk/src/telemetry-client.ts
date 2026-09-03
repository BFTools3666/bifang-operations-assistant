import {
  DEFAULT_TELEMETRY_TIMEOUT_MS,
  SDK_VERSION,
  TELEMETRY_SCHEMA_VERSION,
} from "./constants.js";
import { InstallIdentity } from "./identity.js";
import { FetchTelemetryTransport } from "./transport.js";
import type {
  AvailableUpdateDecision,
  EmptyTelemetryEventName,
  EventPropertiesMap,
  InstallIdentityState,
  PropertyTelemetryEventName,
  SanitizedProperties,
  TelemetryClientConfig,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryTransport,
  UpdateClickAction,
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

export class TelemetryClient {
  readonly #config: TelemetryClientConfig;
  readonly #context: ClientContext;
  readonly #transport: TelemetryTransport;
  readonly #enabled: boolean;
  readonly #timeoutMs: number;
  readonly #pending = new Set<Promise<void>>();

  private constructor(
    config: TelemetryClientConfig,
    identity: InstallIdentityState,
  ) {
    this.#config = config;
    this.#context = {
      appId: config.appId,
      appVersion: config.appVersion,
      platform: config.platform,
      arch: config.arch,
      channel: config.channel,
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
      latest_version: decision.config.latest_version,
      required: decision.kind === "required",
    });
  }

  trackUpdateClicked(
    decision: AvailableUpdateDecision,
    action: UpdateClickAction,
  ): void {
    if (
      (action === "remind_later" && decision.kind === "required") ||
      (action === "exit" && decision.kind === "optional")
    ) {
      return;
    }
    this.track("update_clicked", {
      latest_version: decision.config.latest_version,
      action,
    });
  }

  /** Waits only for currently queued sends. It never retries failed events. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
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
    };
  }

  #schedule(payload: TelemetryEvent): void {
    const scheduler = this.#config.scheduler ?? defaultScheduler;
    let resolvePending: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      resolvePending = resolve;
    });
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));

    try {
      scheduler(() => {
        void this.#send(payload).finally(() => resolvePending?.());
      });
    } catch {
      // A broken injected scheduler is treated like any other telemetry failure.
      resolvePending?.();
    }
  }

  async #send(payload: TelemetryEvent): Promise<void> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error("telemetry_timeout"));
      }, this.#timeoutMs);
    });

    try {
      await Promise.race([
        this.#transport.send(
          this.#context.endpoint,
          payload,
          controller.signal,
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      this.#debug("telemetry_send_dropped", {
        error: error instanceof Error ? error.name : "unknown",
      });
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
}

function isValidClientConfig(config: TelemetryClientConfig): boolean {
  return (
    isAppId(config.appId) &&
    isValidSemVer(config.appVersion) &&
    isPlatform(config.platform) &&
    isArchitecture(config.arch) &&
    isChannel(config.channel) &&
    isSafeExternalUrl(config.endpoint)
  );
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
