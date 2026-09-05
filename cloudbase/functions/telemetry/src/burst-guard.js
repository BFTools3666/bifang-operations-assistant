"use strict";

const DEFAULT_LIMIT = 120;
const DEFAULT_WINDOW_MS = 10_000;

/**
 * A deliberately small, in-memory fixed-window guard for accidental bursts.
 * It applies to one warm function instance only. It is NOT a global rate
 * limiter and must be complemented by CloudBase HTTP access/API Gateway limits.
 */
function createBurstGuard(options = {}) {
  const limit = positiveIntegerOr(options.limit, DEFAULT_LIMIT);
  const windowMs = positiveIntegerOr(options.windowMs, DEFAULT_WINDOW_MS);
  const nowMs = options.nowMs || Date.now;
  const windows = new Map();

  return {
    allow(key) {
      const currentTime = nowMs();
      const current = windows.get(key);

      if (!current || currentTime - current.startedAt >= windowMs) {
        windows.set(key, { count: 1, startedAt: currentTime });
        pruneExpiredWindows(windows, currentTime, windowMs);
        return true;
      }

      if (current.count >= limit) {
        return false;
      }

      current.count += 1;
      return true;
    },
  };
}

function positiveIntegerOr(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function pruneExpiredWindows(windows, currentTime, windowMs) {
  // Each function accepts one ALLOWED_APP_IDS value, so this map stays tiny.
  // Pruning on a new window still prevents stale entries surviving indefinitely
  // in warm workers.
  for (const [key, value] of windows) {
    if (currentTime - value.startedAt >= windowMs) {
      windows.delete(key);
    }
  }
}

module.exports = {
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_MS,
  createBurstGuard,
};
