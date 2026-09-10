"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const http = require("node:http");
const test = require("node:test");

const { createHandler } = require("../src/handler");
const { createMemoryRepository } = require("../src/memory-repository");

const BASE_PATH = "/tools/version-control/v1";
const APP_ID = "bifang-mouse-clicker";
const CODE = "original-tool";
const MANAGEMENT_READ_KEY = "local-e2e-management-read-key";
const MANAGEMENT_READ_SECRET = "local-e2e-management-read-secret";
const MANAGEMENT_WRITE_KEY = "local-e2e-management-write-key";
const MANAGEMENT_WRITE_SECRET = "local-e2e-management-write-secret";
const RUNTIME_KEY = "local-e2e-runtime-key";
const RUNTIME_SECRET = "local-e2e-runtime-secret";

test("real local HTTP requests traverse the unchanged v1 URL/header/JSON boundary", async () => {
  const observed = [];
  const repository = createMemoryRepository();
  let id = 2_001_178_408_904_765_440n;
  const handler = createHandler({
    applications: [
      {
        appId: APP_ID,
        versionCollection: "versions_bifang_mouse_clicker",
        adCollection: "ads_bifang_mouse_clicker",
        auditCollection: "audit_bifang_mouse_clicker",
      },
    ],
    credentials: {
      schema_version: 1,
      credentials: [
        createCredential(
          "local-management-read",
          MANAGEMENT_READ_KEY,
          MANAGEMENT_READ_SECRET,
          ["versions:read", "ads:read"],
        ),
        createCredential(
          "local-management-write",
          MANAGEMENT_WRITE_KEY,
          MANAGEMENT_WRITE_SECRET,
          ["versions:write", "ads:write"],
        ),
        createCredential("local-runtime", RUNTIME_KEY, RUNTIME_SECRET, [
          "versions:check",
          "ads:show",
        ]),
      ],
    },
    repository,
    rateLimiter: () => ({ allowed: true, retryAfterSeconds: 1 }),
    now: () => new Date("2026-09-10T12:34:56.000Z"),
    idGenerator: () => String(id++),
    auditIdGenerator: () => `local-audit-${id++}`,
    logger: { error() {} },
  });

  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ method: request.method, url: request.url });
    const result = await handler(
      {
        httpMethod: request.method,
        path: request.url,
        headers: request.headers,
        body: chunks.length
          ? Buffer.concat(chunks).toString("utf8")
          : undefined,
      },
      { httpContext: { sourceIp: request.socket.remoteAddress } },
    );
    response.writeHead(result.statusCode, result.headers);
    response.end(result.body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const managementReadHeaders = {
      "x-app-key": MANAGEMENT_READ_KEY,
      "x-app-secret": MANAGEMENT_READ_SECRET,
    };
    const managementWriteHeaders = {
      "content-type": "application/json",
      "x-app-key": MANAGEMENT_WRITE_KEY,
      "x-app-secret": MANAGEMENT_WRITE_SECRET,
    };
    const runtimeHeaders = {
      "x-app-key": RUNTIME_KEY,
      "x-app-secret": RUNTIME_SECRET,
    };

    const versionPayload = {
      name: "原程序",
      code: CODE,
      codeVersion: "2.0.0",
      downloadUrl: "https://downloads.example.com/original-tool/2.0.0.exe",
      promptContent: "发现新版本",
      forcedUpdate: false,
      promptUpdate: true,
      stopUpdate: false,
      updateContent: "<div>本次更新内容</div>",
    };
    const createVersion = await fetch(`${origin}${BASE_PATH}/versions`, {
      method: "POST",
      headers: managementWriteHeaders,
      body: JSON.stringify(versionPayload),
    });
    assert.equal(createVersion.status, 200);
    assert.equal(await createVersion.text(), "");

    const listVersions = await fetch(`${origin}${BASE_PATH}/versions`, {
      headers: managementReadHeaders,
    });
    assert.equal(listVersions.status, 200);
    const versions = await listVersions.json();
    const versionId = versions.result.datas[0].id;

    const updateVersion = await fetch(
      `${origin}${BASE_PATH}/versions/${versionId}`,
      {
        method: "PUT",
        headers: managementWriteHeaders,
        body: JSON.stringify({ ...versionPayload, name: "原程序更新" }),
      },
    );
    assert.equal(updateVersion.status, 200);

    const createAd = await fetch(`${origin}${BASE_PATH}/app/${CODE}/ads`, {
      method: "POST",
      headers: managementWriteHeaders,
      body: JSON.stringify({
        title: "测试广告",
        url: "https://www.example.com/campaign",
        image: "https://cdn.example.com/campaign.png",
        content: "<p>测试</p>",
      }),
    });
    assert.equal(createAd.status, 200);

    const listAds = await fetch(`${origin}${BASE_PATH}/app/${CODE}/ads`, {
      headers: managementReadHeaders,
    });
    assert.equal(listAds.status, 200);
    const listedAds = await listAds.json();
    const adId = listedAds.result.datas[0].id;

    const adDetail = await fetch(`${origin}${BASE_PATH}/app/ads/${adId}`, {
      headers: managementReadHeaders,
    });
    assert.equal(adDetail.status, 200);

    const updateAd = await fetch(
      `${origin}${BASE_PATH}/app/${CODE}/ads/${adId}`,
      {
        method: "PUT",
        headers: managementWriteHeaders,
        body: JSON.stringify({
          title: "测试广告更新",
          url: "",
          content: "纯文本",
        }),
      },
    );
    assert.equal(updateAd.status, 200);

    const check = await fetch(`${origin}${BASE_PATH}/versions/${CODE}/1.0.0`, {
      headers: runtimeHeaders,
    });
    assert.equal(check.status, 200);
    assert.deepEqual(await check.json(), {
      update: true,
      downloadUrl: "https://downloads.example.com/original-tool/2.0.0.exe",
      promptContent: "发现新版本",
      forcedUpdate: false,
      promptUpdate: true,
      stopUpdate: false,
      updateContent: "<div>本次更新内容</div>",
    });

    const showAds = await fetch(`${origin}${BASE_PATH}/app/${CODE}/ads/show`, {
      headers: runtimeHeaders,
    });
    assert.equal(showAds.status, 200);
    const ads = await showAds.json();
    assert.equal(ads.length, 1);
    assert.deepEqual(Object.keys(ads[0]).sort(), [
      "content",
      "id",
      "image",
      "url",
    ]);

    const deleteAd = await fetch(
      `${origin}${BASE_PATH}/app/${CODE}/ads/${adId}`,
      { method: "DELETE", headers: managementWriteHeaders },
    );
    assert.equal(deleteAd.status, 200);

    const doubled = await fetch(
      `${origin}${BASE_PATH}/v1/versions/${CODE}/1.0.0`,
      { headers: runtimeHeaders },
    );
    assert.equal(doubled.status, 404);
    assert.deepEqual(
      observed.map(({ method, url }) => `${method} ${url}`),
      [
        `POST ${BASE_PATH}/versions`,
        `GET ${BASE_PATH}/versions`,
        `PUT ${BASE_PATH}/versions/${versionId}`,
        `POST ${BASE_PATH}/app/${CODE}/ads`,
        `GET ${BASE_PATH}/app/${CODE}/ads`,
        `GET ${BASE_PATH}/app/ads/${adId}`,
        `PUT ${BASE_PATH}/app/${CODE}/ads/${adId}`,
        `GET ${BASE_PATH}/versions/${CODE}/1.0.0`,
        `GET ${BASE_PATH}/app/${CODE}/ads/show`,
        `DELETE ${BASE_PATH}/app/${CODE}/ads/${adId}`,
        `GET ${BASE_PATH}/v1/versions/${CODE}/1.0.0`,
      ],
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function createCredential(credentialId, key, secret, scopes) {
  return {
    credential_id: credentialId,
    key_sha256: sha256(key),
    secret_sha256: [sha256(secret)],
    app_id: APP_ID,
    codes: [CODE],
    scopes,
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
