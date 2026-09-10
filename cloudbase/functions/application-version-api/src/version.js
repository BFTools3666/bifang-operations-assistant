"use strict";

const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+)*$/;

function assertDottedVersion(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 50 ||
    !VERSION_PATTERN.test(value)
  ) {
    throw new TypeError("numeric dotted version required");
  }
  return value;
}

function normalizeNumericSegment(value) {
  const normalized = value.replace(/^0+(?=\d)/, "");
  return normalized || "0";
}

function canonicalizeDottedVersion(value) {
  const parts = assertDottedVersion(value)
    .split(".")
    .map(normalizeNumericSegment);
  while (parts.length > 1 && parts.at(-1) === "0") parts.pop();
  return parts.join(".");
}

function createVersionSortKey(value) {
  // Each normalized numeric segment is prefixed with its two-digit length.
  // VERSION_PATTERN caps the full input at 50 characters, so lexicographic
  // ordering of this digits-only key is identical to arbitrary-precision
  // dotted-version ordering without converting any segment to Number.
  return canonicalizeDottedVersion(value)
    .split(".")
    .map((segment) => `${String(segment.length).padStart(2, "0")}${segment}`)
    .join("");
}

function compareDottedVersions(left, right) {
  const leftParts = assertDottedVersion(left)
    .split(".")
    .map(normalizeNumericSegment);
  const rightParts = assertDottedVersion(right)
    .split(".")
    .map(normalizeNumericSegment);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || "0";
    const rightPart = rightParts[index] || "0";
    if (leftPart.length !== rightPart.length) {
      return leftPart.length < rightPart.length ? -1 : 1;
    }
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function criteriaMatches(currentVersion, operator, versionCriteria) {
  const comparison = compareDottedVersions(currentVersion, versionCriteria);
  switch (operator) {
    case "lt":
      return comparison < 0;
    case "le":
      return comparison <= 0;
    case "gt":
      return comparison > 0;
    case "ge":
      return comparison >= 0;
    default:
      throw new TypeError("unsupported update operator");
  }
}

function decideUpdate(record, currentVersion) {
  const newer = compareDottedVersions(currentVersion, record.codeVersion) < 0;
  const eligible =
    record.updateCriteria === undefined ||
    criteriaMatches(
      currentVersion,
      record.updateCriteria,
      record.versionCriteria,
    );
  const update = newer && eligible && !record.stopUpdate;
  return {
    update,
    forcedUpdate: update && record.forcedUpdate,
    promptUpdate: update && record.promptUpdate,
    stopUpdate: record.stopUpdate,
  };
}

function createVersionCheckResponse(record, currentVersion) {
  const decision = decideUpdate(record, currentVersion);
  return {
    update: decision.update,
    downloadUrl: record.downloadUrl,
    promptContent: record.promptContent,
    forcedUpdate: decision.forcedUpdate,
    promptUpdate: decision.promptUpdate,
    stopUpdate: decision.stopUpdate,
    updateContent: record.updateContent,
  };
}

function selectHighestVersion(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  return records.reduce((selected, candidate) => {
    if (!selected) return candidate;
    const comparison = compareDottedVersions(
      candidate.codeVersion,
      selected.codeVersion,
    );
    if (comparison !== 0) return comparison > 0 ? candidate : selected;
    const candidateTime = candidate.updatedAt || "";
    const selectedTime = selected.updatedAt || "";
    if (candidateTime !== selectedTime) {
      return candidateTime > selectedTime ? candidate : selected;
    }
    return candidate.id > selected.id ? candidate : selected;
  }, null);
}

module.exports = {
  VERSION_PATTERN,
  assertDottedVersion,
  canonicalizeDottedVersion,
  compareDottedVersions,
  createVersionSortKey,
  createVersionCheckResponse,
  criteriaMatches,
  decideUpdate,
  selectHighestVersion,
};
