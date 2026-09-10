"use strict";

// Keep aligned with the deployed telemetry v2 and application-version v1 contracts.
// This function is deployed independently, so it cannot import sibling workspaces.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSemVer(value) {
  return typeof value === "string" && value.length <= 64 && SEMVER.test(value);
}

function isDottedVersion(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 50 &&
    /^[0-9]+(?:\.[0-9]+)*$/.test(value)
  );
}

function isRfc3339(value) {
  if (typeof value !== "string" || value.length > 35) return false;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (
    !match ||
    !isCalendarDate(match[1]) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    return false;
  if (
    match[5] !== "Z" &&
    (Number(match[7]) > 14 ||
      Number(match[8]) > 59 ||
      (Number(match[7]) === 14 && Number(match[8]) !== 0))
  )
    return false;
  return Number.isFinite(Date.parse(value));
}

function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}

module.exports = {
  UUID_V4,
  isCalendarDate,
  isDottedVersion,
  isRfc3339,
  isSemVer,
};
