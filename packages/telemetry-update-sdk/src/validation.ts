import {
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PLATFORMS,
  TELEMETRY_EVENT_NAMES,
} from "./constants.js";
import type { Architecture, Platform, TelemetryEventName } from "./types.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UNSAFE_DISPLAY_CHARACTER_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u;
const VISIBLE_DISPLAY_CONTENT_PATTERN = /[^\s\u200c\u200d\ufe00-\ufe0f]/u;

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

export function isAppId(value: unknown): value is string {
  return typeof value === "string" && APP_ID_PATTERN.test(value);
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
    !isPotentiallyPublicHostname(hostname) ||
    isNonPublicIpv4(hostname) ||
    isNonPublicIpv6(hostname)
  ) {
    return false;
  }

  return true;
}

function isPotentiallyPublicHostname(hostname: string): boolean {
  if (!hostname.includes(".") && !hostname.includes(":")) {
    return false;
  }
  return ![
    ".example",
    ".home.arpa",
    ".internal",
    ".invalid",
    ".local",
    ".localhost",
    ".onion",
    ".test",
  ].some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix));
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

  const [first, second, third] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
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
