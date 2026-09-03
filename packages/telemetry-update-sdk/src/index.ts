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
export { FetchTelemetryTransport } from "./transport.js";
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
  isChannel,
  isIsoDate,
  isPlatform,
  isSafeExternalUrl,
  isTelemetryEventName,
  isUuidV4,
  sanitizeEventProperties,
} from "./validation.js";
export type {
  Architecture,
  AvailableUpdateDecision,
  DebugLogger,
  EmptyTelemetryEventName,
  EventPropertiesMap,
  IdentityReadOrCreateResult,
  IdentityStorage,
  InstallIdentityState,
  NoUpdateDecision,
  NoUpdateReason,
  OptionalUpdateDecision,
  PersistedInstallIdentity,
  Platform,
  PrimitiveProperty,
  PropertyTelemetryEventName,
  RequiredUpdateDecision,
  SanitizedProperties,
  TaskScheduler,
  TelemetryClientConfig,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryTransport,
  UpdateCheckerConfig,
  UpdateClickAction,
  UpdateConfig,
  UpdateDecision,
  UpdateFetch,
  UpdateFetchResponse,
  UpdateHostHooks,
} from "./types.js";
