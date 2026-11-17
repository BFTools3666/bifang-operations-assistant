import type {
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  TELEMETRY_EVENT_NAMES,
} from "./constants.js";

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
export type Architecture = (typeof SUPPORTED_ARCHITECTURES)[number];
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export interface TelemetryEvent {
  schema_version: 2;
  event_id: string;
  event: "daily_active";
  app_id: string;
  app_version: string;
  install_id: string;
  platform: Platform;
  arch: Architecture;
  sdk_version: "3.0.0";
  occurred_at: string;
}

export interface DebugLogger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface IdentityStorage {
  read(): Promise<unknown | null>;
  write(record: PersistedInstallIdentity): Promise<void>;
  /**
   * Atomically claims one Asia/Shanghai calendar day before any request starts.
   * Returning false means this installation already attempted its daily report.
   * Throwing must fail closed: the SDK will not send when it cannot persist the
   * gate, which protects a rate-limited endpoint from restart storms.
   */
  claimActivityDay(day: string): Promise<boolean>;
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
