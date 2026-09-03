import type {
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  TELEMETRY_EVENT_NAMES,
} from "./constants.js";

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
export type Architecture = (typeof SUPPORTED_ARCHITECTURES)[number];
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export type PrimitiveProperty = string | number | boolean;

export interface EventPropertiesMap {
  app_install: Readonly<Record<string, never>>;
  app_start: Readonly<Record<string, never>>;
  feature_used: {
    feature_id: string;
  };
  task_started: {
    task_type: string;
  };
  task_succeeded: {
    task_type: string;
    duration_ms: number;
  };
  task_failed: {
    task_type: string;
    error_code: string;
  };
  update_prompt_shown: {
    target_version: string;
  };
  update_clicked: {
    target_version: string;
  };
}

export type SanitizedProperties = EventPropertiesMap[TelemetryEventName];
export type EmptyTelemetryEventName = "app_install" | "app_start";
export type PropertyTelemetryEventName = Exclude<
  TelemetryEventName,
  EmptyTelemetryEventName
>;

interface TelemetryEventEnvelope {
  schema_version: 1;
  event_id: string;
  app_id: string;
  app_version: string;
  install_id: string;
  session_id: string;
  platform: Platform;
  arch: Architecture;
  channel: string;
  sdk_version: "1.0.0";
  occurred_at: string;
}

export type TelemetryEvent<
  EventName extends TelemetryEventName = TelemetryEventName,
> = TelemetryEventEnvelope &
  {
    [Name in EventName]: {
      event: Name;
      properties: EventPropertiesMap[Name];
    };
  }[EventName];

export interface DebugLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface IdentityStorage {
  read(): Promise<unknown | null>;
  write(record: PersistedInstallIdentity): Promise<void>;
  /**
   * Atomically returns a valid existing record or persists the candidate.
   * Implement this when multiple storage instances or processes can share the
   * same backing store.
   */
  readOrCreate?(
    candidate: PersistedInstallIdentity,
  ): Promise<IdentityReadOrCreateResult>;
}

export interface IdentityReadOrCreateResult {
  record: unknown;
  created: boolean;
}

export interface PersistedInstallIdentity {
  schema_version: 1;
  installed: true;
  install_id: string;
  created_at: string;
}

export interface InstallIdentityState {
  installId: string;
  sessionId: string;
  isFirstInstall: boolean;
}

export interface TelemetryTransport {
  send(
    endpoint: string,
    event: Readonly<TelemetryEvent>,
    signal: AbortSignal,
  ): Promise<void | TelemetryTransportReceipt>;
}

/** Sanitized acknowledgement returned by the default HTTP transport. */
export interface TelemetryServerAck {
  ok: true;
}

/**
 * Proof that the HTTP request completed and the service explicitly returned
 * `{ ok: true }`. Custom transports may keep returning `void` for backwards
 * compatibility when they cannot provide this stronger acknowledgement.
 */
export interface TelemetryTransportReceipt {
  httpStatus: number;
  ack: TelemetryServerAck;
}

export type TelemetryTransportErrorCode =
  | "fetch_unavailable"
  | "network_error"
  | "http_error"
  | "invalid_response"
  | "server_rejected";

export type TelemetryDeliveryFailureCode =
  | TelemetryTransportErrorCode
  | "timeout"
  | "scheduler_error"
  | "transport_error";

export interface TelemetryDeliveryFailure {
  code: TelemetryDeliveryFailureCode;
  httpStatus?: number;
  /** A bounded machine-readable code such as `unknown_app`, never raw text. */
  serverError?: string;
}

interface TelemetryDeliveryIdentity {
  event: TelemetryEventName;
  eventId: string;
}

export type TelemetryDeliveryResult = TelemetryDeliveryIdentity &
  (
    | {
        outcome: "acknowledged";
        receipt: TelemetryTransportReceipt;
      }
    | {
        /** A backwards-compatible custom transport resolved without an ack. */
        outcome: "sent";
        receipt: null;
      }
    | {
        outcome: "failed";
        receipt: null;
        failure: TelemetryDeliveryFailure;
      }
  );

export type TaskScheduler = (task: () => void) => void;

export interface TelemetryClientConfig {
  appId: string;
  appVersion: string;
  platform: Platform;
  arch: Architecture;
  channel?: string;
  endpoint?: string;
  enabled?: boolean;
  identityStorage: IdentityStorage;
  timeoutMs?: number;
  transport?: TelemetryTransport;
  logger?: DebugLogger;
  scheduler?: TaskScheduler;
  now?: () => Date;
  uuid?: () => string;
}

export interface UpdateConfig {
  schema_version: 1;
  app_id: string;
  platform: Platform;
  enabled: boolean;
  latest_version: string;
  min_supported_version: string;
  force_update: boolean;
  rollout: number;
  /** Untrusted remote plain text. Hosts must never interpret it as markup. */
  title: string;
  /** Untrusted remote plain text. Hosts must never interpret it as markup. */
  message: string;
  download_url: string;
  release_notes_url: string;
  sha256: string;
  published_at: string;
}

export type NoUpdateReason =
  "disabled" | "unavailable" | "invalid_config" | "up_to_date" | "rollout";

export interface NoUpdateDecision {
  kind: "none";
  reason: NoUpdateReason;
}

export interface OptionalUpdateDecision {
  kind: "optional";
  config: UpdateConfig;
}

export interface RequiredUpdateDecision {
  kind: "required";
  config: UpdateConfig;
}

export type AvailableUpdateDecision =
  OptionalUpdateDecision | RequiredUpdateDecision;

export type UpdateDecision = NoUpdateDecision | AvailableUpdateDecision;

export interface UpdateFetchResponse {
  ok: boolean;
  text(): Promise<string>;
}

export type UpdateFetch = (
  url: string,
  init: {
    method: "GET";
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
    cache?: "no-store";
  },
) => Promise<UpdateFetchResponse>;

export interface UpdateCheckerConfig {
  baseUrl: string;
  appId: string;
  platform: Platform;
  currentVersion: string;
  installId: string;
  enabled?: boolean;
  timeoutMs?: number;
  fetch?: UpdateFetch;
  logger?: DebugLogger;
}

export interface UpdateHostHooks {
  onOptionalUpdate?: (
    decision: Readonly<OptionalUpdateDecision>,
  ) => void | Promise<void>;
  onRequiredUpdate?: (
    decision: Readonly<RequiredUpdateDecision>,
  ) => void | Promise<void>;
  onNoUpdate?: (decision: Readonly<NoUpdateDecision>) => void | Promise<void>;
}
