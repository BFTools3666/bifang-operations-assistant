"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createCleanupHandler } = require("../src/cleanup.js");
const event = {
  Type: "Timer",
  TriggerName: "cleanup-expired",
  Message: "telemetry-cleanup-v1",
};
const instant = Date.parse("2026-11-18T00:00:00Z");
const row = (id, patch = {}) => ({
  _id: id,
  app_id: "test-app",
  schema_version: 2,
  event: "daily_active",
  expires_at: new Date(instant - 1),
  ...patch,
});

function fixture(
  rows,
  { beforeDelete = () => {}, now = () => instant, failRead = false } = {},
) {
  const logs = [],
    requests = [],
    contexts = [];
  const matches = (r, c) =>
    Object.entries(c).every(([k, v]) =>
      v && typeof v === "object" && v.op === "lte"
        ? r[k] instanceof Date && r[k] <= v.value
        : v && typeof v === "object" && v.op === "in"
          ? v.value.includes(r[k])
          : r[k] === v,
    );
  const appFactory = (context) => {
    contexts.push(context);
    return {
      database: () => ({
        command: {
          lte: (value) => ({ op: "lte", value }),
          in: (value) => ({ op: "in", value }),
        },
        collection: (name) => {
          assert.equal(name, "telemetry_test_app");
          return {
            where: (condition) => {
              const query = {
                orderBy: () => query,
                field: () => query,
                limit: (n) => {
                  assert.equal(n, 100);
                  return query;
                },
                get: async () => {
                  requests.push({ type: "get", condition });
                  if (failRead) throw new Error("secret-id document-content");
                  return {
                    data: rows
                      .filter((r) => matches(r, condition))
                      .slice(0, 100)
                      .map((r) => ({ ...r })),
                  };
                },
                remove: async () => {
                  beforeDelete(rows);
                  requests.push({ type: "remove", condition });
                  let deleted = 0;
                  for (let i = rows.length - 1; i >= 0; i--)
                    if (matches(rows[i], condition)) {
                      rows.splice(i, 1);
                      deleted++;
                    }
                  return { deleted };
                },
              };
              return query;
            },
          };
        },
      }),
    };
  };
  return {
    handler: createCleanupHandler({
      appId: "test-app",
      collectionName: "telemetry_test_app",
      appFactory,
      now,
      log: (s) => logs.push(s),
    }),
    rows,
    logs,
    requests,
    contexts,
  };
}

test("cleanup bounds each batch, protects other apps and future records, and is repeatable", async () => {
  const f = fixture([
    ...Array.from({ length: 105 }, (_, i) => row("old-" + i)),
    row("future", { expires_at: new Date(instant + 1) }),
    row("foreign", { app_id: "other" }),
    row("wrong-event", { event: "other" }),
    row("no-date", { expires_at: null }),
  ]);
  assert.deepEqual(await f.handler(event, { requestId: "first" }), {
    status: "cleanup-completed",
    scanned: 100,
    deleted: 100,
    batch_full: true,
  });
  assert.equal((await f.handler(event, { requestId: "second" })).deleted, 5);
  assert.equal((await f.handler(event)).deleted, 0);
  assert.equal(f.rows.length, 4);
  assert.equal(f.requests.filter((r) => r.type === "remove").length, 2);
  assert.equal(f.contexts[0].requestTimeoutMs, 800);
  assert.equal(f.contexts[1].runtimeContext.requestId, "second");
  assert.ok(!JSON.stringify(f.logs).includes("old-"));
});

test("cleanup rechecks expiry during deletion and does not delete a refreshed record", async () => {
  const f = fixture([row("refreshed"), row("expired")], {
    beforeDelete: (rows) => {
      rows[0].expires_at = new Date(instant + 1000);
    },
  });
  assert.equal((await f.handler(event)).deleted, 1);
  assert.deepEqual(
    f.rows.map((r) => r._id),
    ["refreshed"],
  );
});

test("cleanup rejects HTTP and untrusted selection inputs and stops when its budget expires", async () => {
  const f = fixture([row("old")]);
  for (const bad of [
    {},
    { ...event, httpMethod: "POST" },
    { ...event, Message: "other" },
  ])
    await assert.rejects(f.handler(bad), /cleanup_trigger_invalid/);
  assert.equal(f.requests.length, 0);
  assert.throws(
    () =>
      createCleanupHandler({
        appId: "test-app",
        collectionName: "versions_test_app",
      }),
    /configuration_invalid/,
  );
  let ticks = 0;
  const slow = fixture([row("old")], {
    now: () => instant + (ticks++ ? 1600 : 0),
  });
  await assert.rejects(slow.handler(event), /telemetry_cleanup_failed/);
  assert.equal(slow.requests.length, 1);
  assert.equal(slow.rows.length, 1);
});

test("cleanup failures retain records and expose only fixed diagnostics", async () => {
  const f = fixture([row("private-document")], { failRead: true });
  await assert.rejects(f.handler(event), /^Error: telemetry_cleanup_failed$/);
  assert.deepEqual(f.logs, [{ status: "cleanup-failed" }]);
  assert.equal(f.rows.length, 1);
});
