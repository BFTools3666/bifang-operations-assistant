import {
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  TELEMETRY_EVENT_NAMES,
} from "./constants.js";
import { isValidSemVer } from "./semver.js";
import type {
  Architecture,
  Platform,
  SanitizedProperties,
  TelemetryEventName,
  UpdateClickAction,
} from "./types.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const PROPERTY_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAC_ADDRESS_PATTERN =
  /^(?:(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}|[0-9a-f]{12}|[0-9a-f]{4}(?:\.[0-9a-f]{4}){2})$/i;
const PHONE_LIKE_PATTERN = /^(?=(?:\D*\d){7,15}\D*$)\d[\d._:-]*\d$/;
const CHINESE_ID_PATTERN = /^\d{17}[\dXx]$/;
const UUID_LIKE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_BLOB_PATTERN = /^[0-9a-f]{16,}$/i;
const JWT_LIKE_PATTERN =
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const BASE64URL_LIKE_PATTERN =
  /^(?=.{20,64}$)(?=.*[A-Z])(?=.*[a-z])(?=.*\d)[A-Za-z0-9_-]+$/;
const UPDATE_ACTIONS = new Set<UpdateClickAction>([
  "update_now",
  "remind_later",
  "exit",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function isAppId(value: unknown): value is string {
  return typeof value === "string" && APP_ID_PATTERN.test(value);
}

export function isChannel(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_PATTERN.test(value);
}

export function isPlatform(value: unknown): value is Platform {
  return (
    typeof value === "string" &&
    (SUPPORTED_PLATFORMS as readonly string[]).includes(value)
  );
}

export function isArchitecture(value: unknown): value is Architecture {
  return (
    typeof value === "string" &&
    (SUPPORTED_ARCHITECTURES as readonly string[]).includes(value)
  );
}

export function isTelemetryEventName(
  value: unknown,
): value is TelemetryEventName {
  return (
    typeof value === "string" &&
    (TELEMETRY_EVENT_NAMES as readonly string[]).includes(value)
  );
}

export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === ""
  ) {
    return false;
  }

  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isNonPublicIpv4(hostname) ||
    isNonPublicIpv6(hostname)
  ) {
    return false;
  }

  return true;
}

function isNonPublicIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) {
    return true;
  }

  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isNonPublicIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) {
    return false;
  }
  const normalized = hostname.toLowerCase();
  return (
    normalized.startsWith("::") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fec") ||
    normalized.startsWith("fed") ||
    normalized.startsWith("fee") ||
    normalized.startsWith("fef") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:")
  );
}

function cleanIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim();
  if (
    cleaned.length === 0 ||
    cleaned.length > maxLength ||
    !PROPERTY_IDENTIFIER_PATTERN.test(cleaned) ||
    looksSensitiveIdentifier(cleaned)
  ) {
    return null;
  }
  return cleaned;
}

function looksSensitiveIdentifier(value: string): boolean {
  return (
    MAC_ADDRESS_PATTERN.test(value) ||
    PHONE_LIKE_PATTERN.test(value) ||
    CHINESE_ID_PATTERN.test(value) ||
    UUID_LIKE_PATTERN.test(value) ||
    HEX_BLOB_PATTERN.test(value) ||
    JWT_LIKE_PATTERN.test(value) ||
    BASE64URL_LIKE_PATTERN.test(value)
  );
}

function cleanDuration(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 604_800_000
    ? value
    : undefined;
}

export function sanitizeEventProperties(
  event: TelemetryEventName,
  properties: unknown,
): SanitizedProperties | null {
  if (!isRecord(properties)) {
    return null;
  }

  switch (event) {
    case "app_install":
    case "app_start":
      return {};
    case "feature_used": {
      const feature = cleanIdentifier(properties.feature, 64);
      return feature ? { feature } : null;
    }
    case "task_started":
    case "task_succeeded": {
      const taskType = cleanIdentifier(properties.task_type, 64);
      if (!taskType) {
        return null;
      }
      const durationMs = cleanDuration(properties.duration_ms);
      return durationMs === undefined
        ? { task_type: taskType }
        : { task_type: taskType, duration_ms: durationMs };
    }
    case "task_failed": {
      const errorCode = cleanIdentifier(properties.error_code, 64);
      return errorCode ? { error_code: errorCode } : null;
    }
    case "update_prompt_shown": {
      if (
        !isValidSemVer(properties.latest_version) ||
        typeof properties.required !== "boolean"
      ) {
        return null;
      }
      return {
        latest_version: properties.latest_version,
        required: properties.required,
      };
    }
    case "update_clicked": {
      if (
        !isValidSemVer(properties.latest_version) ||
        typeof properties.action !== "string" ||
        !UPDATE_ACTIONS.has(properties.action as UpdateClickAction)
      ) {
        return null;
      }
      return {
        latest_version: properties.latest_version,
        action: properties.action,
      };
    }
  }
}
