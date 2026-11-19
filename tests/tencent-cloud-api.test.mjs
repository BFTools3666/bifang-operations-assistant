import assert from "node:assert/strict";
import test from "node:test";

import {
  createTencentCloudClient,
  parseTencentCredentialFile,
  readTencentCredentials,
} from "../cloudbase/tencent-cloud-api.mjs";

const credentials = {
  secretId: "AKIDEXAMPLE",
  secretKey: "test-secret-key",
  token: "test-session-token",
};
const envId = "dashboard-test-env";

test("Tencent credential parser supports local templates without reflecting secret values", () => {
  assert.deepEqual(
    parseTencentCredentialFile(
      "\uFEFF# local only\r\nSecretId=\"AKIDEXAMPLE\"\r\nSecretKey='test-secret-key'\r\nToken=test-session-token\r\n",
    ),
    credentials,
  );
  assert.deepEqual(parseTencentCredentialFile("SecretId=a\nSecretKey=b\n"), {
    secretId: "a",
    secretKey: "b",
    token: "",
  });
  for (const source of [
    "SecretId=private-value\nSecretKey=private-value\nCookie=private-value",
    "SecretId=private-value\nSecretKey=private-value\nSecretId=duplicate",
    "SecretId=private-value\nSecretKey=private-value\u0000",
    'SecretId=private-value\nSecretKey="private-value',
    "SecretId=private-value\nToken=private-value",
    "SecretId=\nSecretKey=private-value",
    123,
  ]) {
    assert.throws(
      () => parseTencentCredentialFile(source),
      (error) => {
        assert.equal(error.message.includes("private-value"), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});

test("credential file read errors do not disclose the path or original error", async () => {
  await assert.rejects(
    readTencentCredentials("missing-sensitive-file-name"),
    (error) => {
      assert.equal(error.message, "Unable to read Tencent credential file");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("Tencent TC3 request signs a fixed vector and uses bounded HTTPS settings", async () => {
  const calls = [];
  const client = createTencentCloudClient({
    credentials,
    region: "ap-shanghai",
    nowImplementation: () => 1_700_000_000_000,
    fetchImplementation: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ Response: { Status: "Active" } });
    },
  });
  assert.deepEqual(
    await client("scf", "GetFunction", {
      FunctionName: "operations-dashboard-api",
      Namespace: envId,
      ShowCode: "FALSE",
    }),
    { Status: "Active" },
  );
  const { url, init } = calls[0];
  assert.equal(url, "https://scf.tencentcloudapi.com");
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
  assert.equal(init.headers["X-TC-Version"], "2018-04-16");
  assert.equal(init.headers["X-TC-Token"], credentials.token);
  assert.equal(init.headers["X-TC-Region"], "ap-shanghai");
  assert.equal(init.headers["X-TC-Timestamp"], "1700000000");
  assert.equal(
    init.headers.Authorization,
    "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2023-11-14/scf/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=2984c2ab174acda769d48722ddf32d918d3c75e3da9f957f00bc0e70fa470d5c",
  );
  assert.equal(
    init.headers.Authorization.includes(credentials.secretKey),
    false,
  );
  await client("tcb", "DescribeEnvs", { EnvId: envId });
  assert.equal(calls[1].url, "https://tcb.tencentcloudapi.com");
  assert.equal(calls[1].init.headers["X-TC-Version"], "2018-06-08");
});

test("API allowlist rejects configuration writes and broad code update targets before fetch", async () => {
  let calls = 0;
  const client = createTencentCloudClient({
    credentials,
    region: "ap-shanghai",
    fetchImplementation: async () => {
      calls++;
      return Response.json({ Response: { Success: true } });
    },
  });
  for (const action of [
    "UpdateFunctionConfiguration",
    "DeleteFunction",
    "CreateFunction",
  ]) {
    await assert.rejects(client("scf", action, {}), /action is not allowed/u);
  }
  await assert.rejects(client("sts", "GetCallerIdentity", {}), /not allowed/u);
  await assert.rejects(client("__proto__", "GetFunction", {}), /not allowed/u);
  const valid = {
    FunctionName: "operations-dashboard-api",
    Namespace: envId,
    Handler: "index.main",
    InstallDependency: "TRUE",
    Publish: "FALSE",
    Code: { ZipFile: Buffer.from("synthetic zip").toString("base64") },
  };
  for (const payload of [
    { ...valid, FunctionName: "another-function" },
    { ...valid, Namespace: "../another-env" },
    { ...valid, Environment: { Variables: [] } },
    { ...valid, Handler: "other.handler" },
    { ...valid, Publish: "TRUE" },
    { ...valid, InstallDependency: "bad" },
    { ...valid, Code: { CosBucketName: "other-bucket" } },
    { ...valid, Code: { ...valid.Code, ImageConfig: {} } },
    { ...valid, Code: { ZipFile: "bad-base64" } },
    { ...valid, Code: { ZipFile: "" } },
  ]) {
    await assert.rejects(
      client("scf", "UpdateFunctionCode", payload),
      /payload is not allowed/u,
    );
  }
  assert.equal(calls, 0);
  assert.deepEqual(await client("scf", "UpdateFunctionCode", valid), {
    Success: true,
  });
  await client("scf", "UpdateFunctionCode", {
    ...valid,
    Code: { ZipFile: Buffer.alloc(200_000).toString("base64") },
  });
  assert.equal(calls, 2);
});

test("network, timeout, parse and API errors never reflect credentials or raw messages", async () => {
  const rawMessage = Object.values(credentials).join(" ");
  const cases = [
    async () => {
      throw new Error(rawMessage);
    },
    async () => {
      throw new DOMException(rawMessage, "TimeoutError");
    },
    async () => new Response(rawMessage),
    async () =>
      Response.json({
        Response: {
          Error: { Code: "AuthFailure.SecretIdNotFound", Message: rawMessage },
        },
      }),
    async () =>
      Response.json({
        Response: {
          Error: { Code: credentials.secretId, Message: rawMessage },
        },
      }),
    async () => Response.json({ Response: {} }, { status: 500 }),
    async () => Response.json({ unexpected: rawMessage }),
  ];
  for (const fetchImplementation of cases) {
    const client = createTencentCloudClient({
      credentials,
      region: "ap-shanghai",
      fetchImplementation,
    });
    await assert.rejects(
      client("tcb", "DescribeEnvs", { EnvId: envId }),
      (e) => {
        for (const value of Object.values(credentials)) {
          assert.equal(e.message.includes(value), false);
          assert.equal(e.stack.includes(value), false);
        }
        assert.equal(e.cause, undefined);
        return true;
      },
    );
  }
});

test("API errors retain validated request IDs without exposing messages or credential-shaped IDs", async () => {
  const requestId = "3bab891c-99c4-4794-a558-c0d261cfe5b3";
  for (const id of [requestId, credentials.secretId, "unsafe\nrequest", null]) {
    const client = createTencentCloudClient({
      credentials,
      region: "ap-shanghai",
      fetchImplementation: async () =>
        Response.json({
          Response: {
            Error: {
              Code: "UnsupportedOperation",
              Message: credentials.secretKey,
            },
            RequestId: id,
          },
        }),
    });
    await assert.rejects(
      client("tcb", "DescribeEnvs", { EnvId: envId }),
      (e) => {
        assert.equal(
          e.message,
          "Tencent Cloud API error: UnsupportedOperation",
        );
        assert.equal(e.apiRequestId, id === requestId ? requestId : undefined);
        assert.ok(!JSON.stringify(e).includes(credentials.secretKey));
        return true;
      },
    );
  }
  const client = createTencentCloudClient({
    credentials: { ...credentials, secretKey: requestId },
    region: "ap-shanghai",
    fetchImplementation: async () =>
      Response.json({
        Response: {
          Error: { Code: "UnsupportedOperation", Message: requestId },
          RequestId: requestId,
        },
      }),
  });
  await assert.rejects(client("tcb", "DescribeEnvs", { EnvId: envId }), (e) => {
    assert.equal(e.apiRequestId, undefined);
    assert.ok(!JSON.stringify(e).includes(requestId));
    return true;
  });
});

test("API responses exceeding the declared or streamed size limit are rejected", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-length": "5000001" } }),
    new Response("x".repeat(5_000_001)),
  ]) {
    const client = createTencentCloudClient({
      credentials,
      region: "ap-shanghai",
      fetchImplementation: async () => response,
    });
    await assert.rejects(
      client("tcb", "DescribeEnvs", { EnvId: envId }),
      /^Error: Tencent Cloud API request or response failed$/u,
    );
  }
});
