import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const adapters = [
  require("../cloudbase/functions/telemetry/src/writer.js"),
  require("../cloudbase/functions/application-version-api/src/repository.js"),
  require("../cloudbase/functions/operations-dashboard/src/reader.js"),
];

test("all three pgdoc adapters sign with current invocation STS using the real Node SDK, without network", async () => {
  const transport = require(
    join(dirname(require.resolve("@cloudbase/node-sdk")), "utils/request.js"),
  );
  const original = transport.extraRequest;
  let expectedToken;
  let calls = 0;
  transport.extraRequest = async (options) => {
    calls++;
    assert.ok(options.url.includes("/admin"));
    assert.ok(options.headers.Authorization);
    assert.equal(options.body.sessionToken, expectedToken);
    assert.equal(
      JSON.stringify(options).includes("fake-runtime-secret-key"),
      false,
    );
    return { statusCode: 200, body: { data: { list: [] } } };
  };
  try {
    for (const adapter of adapters) {
      for (const token of ["fake-session-first", "fake-session-refreshed"]) {
        expectedToken = token;
        const app = adapter.createDefaultCloudBaseApp({
          envOverride: "personal-offline-pgdoc",
          runtimeContext: {
            extendedContext: {
              tmpSecret: {
                secretId: "fake-runtime-id",
                secretKey: "fake-runtime-secret-key",
                token,
              },
            },
          },
        });
        const db = app.database();
        assert.equal(typeof db.runTransaction, "function");
        const result = await db.collection("telemetry_test").limit(1).get();
        assert.deepEqual(result.data, []);
      }
    }
    assert.equal(calls, 6);
  } finally {
    transport.extraRequest = original;
  }
});

test("telemetry writer does not cache a previous invocation's credentials", async () => {
  const contexts = [];
  const writer = adapters[0].createCloudBaseWriter({
    collectionName: "telemetry_test",
    appFactory: ({ runtimeContext }) => {
      contexts.push(runtimeContext);
      return {
        database: () => ({ collection: () => ({ add: async () => {} }) }),
      };
    },
  });
  const first = { requestId: "first" },
    second = { requestId: "second" };
  await writer({ _id: "first-document" }, { runtimeContext: first });
  await writer({ _id: "second-document" }, { runtimeContext: second });
  assert.deepEqual(contexts, [first, second]);
});

test("cleanup uses real SDK bounded queries and expiry-guarded deletion without network", async () => {
  const {
    createCleanupHandler,
  } = require("../cloudbase/functions/telemetry/src/cleanup.js");
  const transport = require(
    join(dirname(require.resolve("@cloudbase/node-sdk")), "utils/request.js"),
  );
  const original = transport.extraRequest;
  const instant = Date.parse("2026-11-18T00:00:00Z"),
    requests = [];
  transport.extraRequest = async (options) => {
    requests.push(options);
    if (requests.length === 1)
      return {
        statusCode: 200,
        body: {
          data: {
            list: [
              JSON.stringify({
                _id: "only-expired-id",
                expires_at: { $date: new Date(instant - 1).toISOString() },
              }),
            ],
          },
        },
      };
    return { statusCode: 200, body: { data: { deleted: 1 } } };
  };
  try {
    const handler = createCleanupHandler({
      appId: "offline-app",
      collectionName: "telemetry_offline_app",
      now: () => instant,
      log: () => {},
      appFactory: (options) =>
        adapters[0].createDefaultCloudBaseApp({
          ...options,
          envOverride: "personal-offline-pgdoc",
        }),
    });
    const result = await handler(
      {
        Type: "Timer",
        TriggerName: "cleanup-expired",
        Message: "telemetry-cleanup-v1",
      },
      {
        extendedContext: {
          tmpSecret: {
            secretId: "fake-runtime-id",
            secretKey: "fake-runtime-secret",
            token: "fake-session",
          },
        },
      },
    );
    assert.equal(result.deleted, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.limit, 100);
    const query = JSON.parse(requests[1].body.query);
    assert.deepEqual(query._id, { $in: ["only-expired-id"] });
    assert.equal(query.app_id, "offline-app");
    assert.ok(query.expires_at.$lte);
    assert.ok(requests.every((r) => r.timeout === 800));
  } finally {
    transport.extraRequest = original;
  }
});
