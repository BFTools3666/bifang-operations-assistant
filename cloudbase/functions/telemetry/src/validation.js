"use strict";

const MAX_IDENTIFIER_LENGTH = 64;

const EVENTS = new Set(["daily_active"]);

const PLATFORMS = new Set(["windows", "macos", "linux"]);
const ARCHITECTURES = new Set(["x64", "arm64", "ia32"]);

const REQUIRED_INPUT_KEYS = [
  "schema_version",
  "event_id",
  "event",
  "app_id",
  "app_version",
  "install_id",
  "platform",
  "arch",
  "sdk_version",
  "occurred_at",
];

const ALLOWED_INPUT_KEYS = new Set(REQUIRED_INPUT_KEYS);

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/;

function validateAndSanitizePayload(payload) {
  if (!isPlainRecord(payload) || !hasExactInputShape(payload)) {
    return invalid();
  }

  if (
    payload.schema_version !== 2 ||
    !isUuidV4(payload.event_id) ||
    payload.event !== "daily_active" ||
    !isAppId(payload.app_id) ||
    !isSemVer(payload.app_version) ||
    !isUuidV4(payload.install_id) ||
    !PLATFORMS.has(payload.platform) ||
    !ARCHITECTURES.has(payload.arch) ||
    payload.sdk_version !== "3.0.0" ||
    !isIso8601(payload.occurred_at)
  ) {
    return invalid();
  }

  return {
    ok: true,
    value: {
      schema_version: 2,
      event_id: payload.event_id.toLowerCase(),
      event: "daily_active",
      app_id: payload.app_id,
      app_version: payload.app_version,
      install_id: payload.install_id.toLowerCase(),
      platform: payload.platform,
      arch: payload.arch,
      sdk_version: "3.0.0",
      occurred_at: payload.occurred_at,
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

function invalid() {
  return { ok: false };
}

module.exports = {
  ARCHITECTURES,
  EVENTS,
  PLATFORMS,
  isAppId,
  isIso8601,
  isSemVer,
  isUuidV4,
  validateAndSanitizePayload,
};
