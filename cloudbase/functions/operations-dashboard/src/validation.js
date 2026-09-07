"use strict";

// Keep aligned with the deployed telemetry v2 and update-manifest v1 contracts.
// This function is deployed independently, so it cannot import sibling workspaces.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isSemVer(value) {
  return typeof value === "string" && value.length <= 64 && SEMVER.test(value);
}

function compareSemVer(left, right) {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  for (let i = 1; i <= 3; i += 1) {
    if (BigInt(a[i]) !== BigInt(b[i]))
      return BigInt(a[i]) > BigInt(b[i]) ? 1 : -1;
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const ap = a[4].split(".");
  const bp = b[4].split(".");
  for (let i = 0; i < Math.max(ap.length, bp.length); i += 1) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]);
    const bn = /^\d+$/.test(bp[i]);
    if (an && bn) return BigInt(ap[i]) > BigInt(bp[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
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

function isHttpsUrl(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !!url.hostname
    );
  } catch {
    return false;
  }
}

function isDisplayText(value, maxLength) {
  return (
    typeof value === "string" &&
    Array.from(value).length <= maxLength &&
    /[^\s\u200c\u200d\ufe00-\ufe0f]/u.test(value) &&
    !/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u.test(
      value,
    )
  );
}

module.exports = {
  UUID_V4,
  compareSemVer,
  isCalendarDate,
  isDisplayText,
  isHttpsUrl,
  isRfc3339,
  isSemVer,
};
