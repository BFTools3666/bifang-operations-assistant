export const SDK_VERSION = "2.0.0" as const;
export const TELEMETRY_SCHEMA_VERSION = 2 as const;
export const UPDATE_SCHEMA_VERSION = 1 as const;

export const TELEMETRY_EVENT_NAMES = ["daily_active"] as const;

export const SUPPORTED_PLATFORMS = ["windows", "macos", "linux"] as const;
export const SUPPORTED_ARCHITECTURES = ["x64", "arm64", "ia32"] as const;

export const DEFAULT_TELEMETRY_TIMEOUT_MS = 2_000;
export const DEFAULT_UPDATE_TIMEOUT_MS = 3_000;
