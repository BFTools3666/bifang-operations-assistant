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
