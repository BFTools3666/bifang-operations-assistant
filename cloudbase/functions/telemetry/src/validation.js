"use strict";

const MAX_PROPERTIES = 20;
const MAX_PROPERTY_STRING_LENGTH = 200;
const MAX_IDENTIFIER_LENGTH = 64;
const MAX_DURATION_MS = 604_800_000;

const EVENTS = new Set([
  "app_install",
  "app_start",
  "feature_used",
  "task_started",
  "task_succeeded",
  "task_failed",
  "update_prompt_shown",
  "update_clicked",
]);

const PLATFORMS = new Set(["windows", "macos", "linux"]);
const ARCHITECTURES = new Set(["x64", "arm64", "ia32"]);

const REQUIRED_INPUT_KEYS = [
  "schema_version",
  "event_id",
  "event",
  "app_id",
  "app_version",
  "install_id",
  "session_id",
  "platform",
  "arch",
  "channel",
  "sdk_version",
  "occurred_at",
  "properties",
];

// received_at is tolerated only so a stale/misbehaving client cannot influence
// it. It is never copied. Every other unknown top-level field is rejected.
const ALLOWED_INPUT_KEYS = new Set([...REQUIRED_INPUT_KEYS, "received_at"]);

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
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
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const BASE64_DATA_PATTERN = /^(?:data:[^,]{0,100};base64,|base64:)/i;

function validateAndSanitizePayload(payload) {
  if (!isPlainRecord(payload) || !hasExactInputShape(payload)) {
    return invalid();
  }

  if (
    payload.schema_version !== 1 ||
    !isUuidV4(payload.event_id) ||
    !EVENTS.has(payload.event) ||
    !isAppId(payload.app_id) ||
    !isSemVer(payload.app_version) ||
    !isUuidV4(payload.install_id) ||
    !isUuidV4(payload.session_id) ||
    !PLATFORMS.has(payload.platform) ||
    !ARCHITECTURES.has(payload.arch) ||
    !isChannel(payload.channel) ||
    !isSemVer(payload.sdk_version) ||
    !isIso8601(payload.occurred_at)
  ) {
    return invalid();
  }

  const sanitizedProperties = validateProperties(
    payload.event,
    payload.properties,
  );
  if (!sanitizedProperties.ok) {
    return invalid();
  }

  return {
    ok: true,
    value: {
      schema_version: 1,
      event_id: payload.event_id.toLowerCase(),
      event: payload.event,
      app_id: payload.app_id,
      app_version: payload.app_version,
      install_id: payload.install_id.toLowerCase(),
      session_id: payload.session_id.toLowerCase(),
      platform: payload.platform,
      arch: payload.arch,
      channel: payload.channel,
      sdk_version: payload.sdk_version,
      occurred_at: payload.occurred_at,
      properties: sanitizedProperties.value,
    },
  };
}

function hasExactInputShape(payload) {
  const keys = Object.keys(payload);
  if (keys.some((key) => !ALLOWED_INPUT_KEYS.has(key))) {
    return false;
  }
  return REQUIRED_INPUT_KEYS.every((key) => Object.hasOwn(payload, key));
}

function validateProperties(eventName, properties) {
  if (!isPlainRecord(properties)) {
    return invalid();
  }

  const keys = Object.keys(properties);
  if (keys.length > MAX_PROPERTIES || !hasSafeScalarValues(properties)) {
    return invalid();
  }

  switch (eventName) {
    case "app_install":
    case "app_start":
      return keys.length === 0 ? valid({}) : invalid();

    case "feature_used":
      if (!hasOnlyKeys(properties, ["feature_id"], ["feature_id"]))
        return invalid();
      if (!isIdentifier(properties.feature_id)) return invalid();
      return valid({ feature_id: properties.feature_id });

    case "task_started":
      if (!hasOnlyKeys(properties, ["task_type"], ["task_type"]))
        return invalid();
      if (!isIdentifier(properties.task_type)) return invalid();
      return valid({ task_type: properties.task_type });

    case "task_succeeded":
      if (
        !hasOnlyKeys(
          properties,
          ["task_type", "duration_ms"],
          ["task_type", "duration_ms"],
        )
      ) {
        return invalid();
      }
      if (!isIdentifier(properties.task_type)) return invalid();
      if (!isDuration(properties.duration_ms)) return invalid();
      return valid({
        task_type: properties.task_type,
        duration_ms: properties.duration_ms,
      });

    case "task_failed":
      if (
        !hasOnlyKeys(
          properties,
          ["task_type", "error_code"],
          ["task_type", "error_code"],
        )
      ) {
        return invalid();
      }
      if (!isIdentifier(properties.task_type)) return invalid();
      if (!isIdentifier(properties.error_code)) return invalid();
      return valid({
        task_type: properties.task_type,
        error_code: properties.error_code,
      });

    case "update_prompt_shown":
    case "update_clicked":
      if (!hasOnlyKeys(properties, ["target_version"], ["target_version"]))
        return invalid();
      if (!isSemVer(properties.target_version)) return invalid();
      return valid({ target_version: properties.target_version });

    default:
      return invalid();
  }
}

function hasSafeScalarValues(properties) {
  return Object.values(properties).every((value) => {
    if (typeof value === "string") {
      return (
        Array.from(value).length <= MAX_PROPERTY_STRING_LENGTH &&
        !CONTROL_CHARACTER_PATTERN.test(value) &&
        !BASE64_DATA_PATTERN.test(value)
      );
    }
    if (typeof value === "number") {
      return Number.isFinite(value);
    }
    return typeof value === "boolean";
  });
}

function hasOnlyKeys(value, allowedKeys, requiredKeys) {
  const allowed = new Set(allowedKeys);
  const keys = Object.keys(value);
  return (
    keys.every((key) => allowed.has(key)) &&
    requiredKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUuidV4(value) {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

function isAppId(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    APP_ID_PATTERN.test(value)
  );
}

function isChannel(value) {
  return typeof value === "string" && CHANNEL_PATTERN.test(value);
}

function isIdentifier(value) {
  return (
    typeof value === "string" &&
    IDENTIFIER_PATTERN.test(value) &&
    !looksSensitiveIdentifier(value)
  );
}

function looksSensitiveIdentifier(value) {
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

function isSemVer(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    SEMVER_PATTERN.test(value)
  );
}

function isIso8601(value) {
  if (typeof value !== "string" || value.length > 35) return false;
  const match = ISO_8601_PATTERN.exec(value);
  if (!match) return false;

  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    zone,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (day < 1 || day > daysInMonth(year, month)) return false;

  if (zone !== "Z") {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }

  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isDuration(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DURATION_MS;
}

function valid(value) {
  return { ok: true, value };
}

function invalid() {
  return { ok: false };
}

module.exports = {
  ARCHITECTURES,
  EVENTS,
  MAX_DURATION_MS,
  MAX_PROPERTIES,
  MAX_PROPERTY_STRING_LENGTH,
  PLATFORMS,
  isAppId,
  isIso8601,
  isSemVer,
  isUuidV4,
  validateAndSanitizePayload,
};
