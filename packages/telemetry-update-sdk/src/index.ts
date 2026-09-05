export {
  DEFAULT_TELEMETRY_TIMEOUT_MS,
  DEFAULT_UPDATE_TIMEOUT_MS,
  SDK_VERSION,
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_SCHEMA_VERSION,
  UPDATE_SCHEMA_VERSION,
} from "./constants.js";
export {
  InstallIdentity,
  MemoryIdentityStorage,
  isPersistedIdentity,
  type InstallIdentityOptions,
} from "./identity.js";
export { compareSemVer, isValidSemVer, parseSemVer } from "./semver.js";
export { TelemetryClient } from "./telemetry-client.js";
export {
  FetchTelemetryTransport,
  TelemetryTransportError,
} from "./transport.js";
export {
  UpdateChecker,
  buildUpdateUrl,
  decideUpdate,
  parseUpdateConfig,
  rolloutBucket,
  runUpdateHostHooks,
} from "./update-checker.js";
export {
  isAppId,
  isArchitecture,
  isIsoDate,
  isPlatform,
  isSafeExternalUrl,
  isTelemetryEventName,
  isUuidV4,
} from "./validation.js";
export type {
  Architecture,
  DebugLogger,
  AvailableUpdateDecision,
  IdentityReadOrCreateResult,
  IdentityStorage,
  InstallIdentityState,
  NoUpdateDecision,
  NoUpdateReason,
  OptionalUpdateDecision,
  PersistedInstallIdentity,
  Platform,
  RequiredUpdateDecision,
  TaskScheduler,
  TelemetryClientConfig,
  TelemetryDeliveryFailure,
  TelemetryDeliveryFailureCode,
  TelemetryDeliveryResult,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryServerAck,
  TelemetryTransport,
  TelemetryTransportErrorCode,
  TelemetryTransportReceipt,
  UpdateCheckerConfig,
  UpdateConfig,
  UpdateDecision,
  UpdateFetch,
  UpdateFetchResponse,
  UpdateHostHooks,
} from "./types.js";
