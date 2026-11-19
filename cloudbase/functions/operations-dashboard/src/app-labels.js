"use strict";

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const UNSAFE_LABEL = /[\p{Cc}\p{Cf}<>]/u;

function validateAppLabels(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("app labels must be a plain object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new TypeError("app labels must not be empty");
  for (const [appId, label] of entries) {
    if (!APP_ID_PATTERN.test(appId)) {
      throw new TypeError("app label identity is invalid");
    }
    if (
      typeof label !== "string" ||
      label !== label.trim() ||
      Array.from(label).length < 1 ||
      Array.from(label).length > 100 ||
      UNSAFE_LABEL.test(label)
    ) {
      throw new TypeError("app label must be safe text of 1-100 characters");
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

// Display metadata only. Resource registration and enabled applications remain
// controlled by cloudbase/apps.json and the reviewed runtime app mapping.
const APP_LABELS = validateAppLabels(require("./app-labels.json"));

// The personal dashboard config supplies one display name per registered app.
// Deployments without this contract continue to use their packaged catalog.
function parseConfiguredAppLabels(value, apps) {
  try {
    const labels = validateAppLabels(JSON.parse(value));
    if (
      Object.keys(labels).length !== apps.length ||
      !apps.every(({ appId }) => Object.hasOwn(labels, appId))
    )
      return null;
    return labels;
  } catch {
    return null;
  }
}

function getAppLabel(appId, labels = APP_LABELS) {
  return Object.hasOwn(labels, appId) ? labels[appId] : appId;
}

function projectAppLabels(apps, labels = APP_LABELS) {
  return Object.fromEntries(
    apps.map((app) => {
      const appId = typeof app === "string" ? app : app.appId;
      return [appId, getAppLabel(appId, labels)];
    }),
  );
}

module.exports = {
  APP_LABELS,
  getAppLabel,
  parseConfiguredAppLabels,
  projectAppLabels,
  validateAppLabels,
};
