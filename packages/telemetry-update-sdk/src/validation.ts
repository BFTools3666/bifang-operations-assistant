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
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
const VISIBLE_DISPLAY_CONTENT_PATTERN = /[^\s\u200c\u200d\ufe00-\ufe0f]/u;
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
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

export function isRfc3339Date(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 35) {
    return false;
  }
  const match = RFC3339_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (match[7] !== "Z") {
    const offsetHour = Number(match[9]);
    const offsetMinute = Number(match[10]);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }

  return true;
}

export function isSafeDisplayText(
  value: unknown,
  maxCodePoints: number,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const codePointLength = Array.from(value).length;
  return (
    codePointLength >= 1 &&
    codePointLength <= maxCodePoints &&
    VISIBLE_DISPLAY_CONTENT_PATTERN.test(value) &&
    !UNSAFE_DISPLAY_CHARACTER_PATTERN.test(value)
  );
}

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^(?:|[0-9a-f]{64})$/i.test(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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
      return hasExactKeys(properties, []) ? {} : null;
    case "feature_used": {
      if (!hasExactKeys(properties, ["feature_id"])) {
        return null;
      }
      const featureId = cleanIdentifier(properties.feature_id, 64);
      return featureId ? { feature_id: featureId } : null;
    }
    case "task_started": {
      if (!hasExactKeys(properties, ["task_type"])) {
        return null;
      }
      const taskType = cleanIdentifier(properties.task_type, 64);
      return taskType ? { task_type: taskType } : null;
    }
    case "task_succeeded": {
      if (!hasExactKeys(properties, ["task_type", "duration_ms"])) {
        return null;
      }
      const taskType = cleanIdentifier(properties.task_type, 64);
      const durationMs = cleanDuration(properties.duration_ms);
      return taskType && durationMs !== undefined
        ? { task_type: taskType, duration_ms: durationMs }
        : null;
    }
    case "task_failed": {
      if (!hasExactKeys(properties, ["task_type", "error_code"])) {
        return null;
      }
      const taskType = cleanIdentifier(properties.task_type, 64);
      const errorCode = cleanIdentifier(properties.error_code, 64);
      return taskType && errorCode
        ? { task_type: taskType, error_code: errorCode }
        : null;
    }
    case "update_prompt_shown":
    case "update_clicked": {
      if (!hasExactKeys(properties, ["target_version"])) {
        return null;
      }
      return isValidSemVer(properties.target_version)
        ? { target_version: properties.target_version }
        : null;
    }
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}
