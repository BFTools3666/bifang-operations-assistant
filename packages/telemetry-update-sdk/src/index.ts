export {
  DEFAULT_TELEMETRY_TIMEOUT_MS,
  DEFAULT_APPLICATION_VERSION_TIMEOUT_MS,
  SDK_VERSION,
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  TELEMETRY_EVENT_NAMES,
  TELEMETRY_SCHEMA_VERSION,
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
  ApplicationVersionChecker,
  buildApplicationVersionCheckUrl,
  decideApplicationVersion,
  isApplicationCode,
  isApplicationVersion,
  isCanonicalApplicationVersionBaseUrl,
  parseApplicationVersionData,
  runApplicationVersionHostHooks,
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
  ApplicationVersionCheckerConfig,
  ApplicationVersionData,
  ApplicationVersionDecision,
  ApplicationVersionFetch,
  ApplicationVersionFetchResponse,
  ApplicationVersionHostHooks,
  AvailableApplicationVersionDecision,
  DebugLogger,
  IdentityReadOrCreateResult,
  IdentityStorage,
  InstallIdentityState,
  NoApplicationVersionDecision,
  NoApplicationVersionReason,
  OptionalApplicationVersionDecision,
  PersistedInstallIdentity,
  Platform,
  RequiredApplicationVersionDecision,
  StoppedApplicationVersionDecision,
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
} from "./types.js";
export {
  CLIENT_UPDATE_ORIGIN,
  LOCAL_CLIENT_UPDATE_ORIGIN,
  ClientUpdateService,
  isSameInstallTarget,
  parseClientUpdateSnapshot,
} from "./client-update.js";
export type {
  ClientUpdateArtifact,
  ClientUpdateServiceConfig,
  ClientUpdateRequest,
  ClientUpdateResult,
  ClientUpdateSnapshot,
  UpdateTrigger,
} from "./client-update.js";
