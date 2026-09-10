"use strict";

function createRateLimiter(options = {}) {
  const limit = options.limit || 10;
  const windowMs = options.windowMs || 1_000;
  const now = options.now || Date.now;
  const buckets = new Map();

  return function checkRate(key) {
    const currentTime = now();
    let bucket = buckets.get(key);
    if (!bucket || currentTime >= bucket.startedAt + windowMs) {
      bucket = { startedAt: currentTime, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (buckets.size > 1_000) {
      for (const [candidate, value] of buckets) {
        if (currentTime >= value.startedAt + windowMs)
          buckets.delete(candidate);
      }
    }

    const remainingMs = Math.max(1, bucket.startedAt + windowMs - currentTime);
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
    };
  };
}

module.exports = { createRateLimiter };
