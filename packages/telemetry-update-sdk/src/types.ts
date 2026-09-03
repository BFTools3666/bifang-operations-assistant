import type {
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  TELEMETRY_EVENT_NAMES,
} from "./constants.js";

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
export type Architecture = (typeof SUPPORTED_ARCHITECTURES)[number];
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

export type PrimitiveProperty = string | number | boolean;
export type SanitizedProperties = Record<string, PrimitiveProperty>;

export interface EventPropertiesMap {
  app_install: Readonly<Record<string, never>>;
  app_start: Readonly<Record<string, never>>;
  feature_used: {
    feature: string;
  };
  task_started: {
    task_type: string;
    duration_ms?: number;
  };
  task_succeeded: {
    task_type: string;
    duration_ms?: number;
  };
  task_failed: {
    error_code: string;
  };
  update_prompt_shown: {
    latest_version: string;
    required: boolean;
  };
  update_clicked: {
    latest_version: string;
    action: UpdateClickAction;
  };
}

export type UpdateClickAction = "update_now" | "remind_later" | "exit";
export type EmptyTelemetryEventName = "app_install" | "app_start";
export type PropertyTelemetryEventName = Exclude<
  TelemetryEventName,
  EmptyTelemetryEventName
>;

export interface TelemetryEvent {
  schema_version: 1;
  event_id: string;
  event: TelemetryEventName;
  app_id: string;
  app_version: string;
  install_id: string;
  session_id: string;
  platform: Platform;
  arch: Architecture;
  channel: string;
  sdk_version: "1.0.0";
  occurred_at: string;
  properties: SanitizedProperties;
}

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
  ): Promise<void>;
}

export type TaskScheduler = (task: () => void) => void;

export interface TelemetryClientConfig {
  appId: string;
  appVersion: string;
  platform: Platform;
  arch: Architecture;
  channel: string;
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
  download_url: string;
  release_notes_url: string;
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
