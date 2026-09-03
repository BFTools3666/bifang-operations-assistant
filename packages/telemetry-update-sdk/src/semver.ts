export interface SemanticVersion {
  major: string;
  minor: string;
  patch: string;
  prerelease: readonly string[];
  build: readonly string[];
}

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemVer(value: string): SemanticVersion | null {
  if (value.length === 0 || value.length > 64) {
    return null;
  }
  const match = SEMVER_PATTERN.exec(value);
  if (!match) {
    return null;
  }

  const [, major, minor, patch, prerelease, build] = match;
  if (!major || !minor || !patch) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    prerelease: prerelease?.split(".") ?? [],
    build: build?.split(".") ?? [],
  };
}

export function isValidSemVer(value: unknown): value is string {
  return typeof value === "string" && parseSemVer(value) !== null;
}

export function compareSemVer(left: string, right: string): -1 | 0 | 1 {
  const parsedLeft = parseSemVer(left);
  const parsedRight = parseSemVer(right);
  if (!parsedLeft || !parsedRight) {
    throw new TypeError("compareSemVer requires valid Semantic Version values");
  }

  for (const key of ["major", "minor", "patch"] as const) {
    const comparison = compareNumericIdentifier(
      parsedLeft[key],
      parsedRight[key],
    );
    if (comparison !== 0) return comparison;
  }

  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function comparePrerelease(
  left: readonly string[],
  right: readonly string[],
): -1 | 0 | 1 {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifier(leftPart, rightPart);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }

  return 0;
}

function compareNumericIdentifier(left: string, right: string): -1 | 0 | 1 {
  if (left.length < right.length) return -1;
  if (left.length > right.length) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
