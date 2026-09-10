"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { hashCredential, parseCredentials } = require("../src/auth");
const { createHandler, MAX_BODY_BYTES } = require("../src/handler");
const { createMemoryRepository } = require("../src/memory-repository");
const { createRateLimiter } = require("../src/rate-limit");
const { parseApplicationResources } = require("../src/repository");
const {
  canonicalizeDottedVersion,
  compareDottedVersions,
  createVersionSortKey,
  criteriaMatches,
} = require("../src/version");

const BASE_PATH = "/tools/version-control/v1";
const APP_ID = "bifang-mouse-clicker";
const OTHER_APP_ID = "bifang-screen-recorder";
const CODE = "original-tool";
const OTHER_CODE = "another-tool";
const MANAGEMENT_READ_KEY = "management-read-key-with-high-entropy";
const MANAGEMENT_READ_SECRET = "management-read-secret-with-high-entropy";
const MANAGEMENT_READ_NEXT_SECRET =
  "management-read-next-secret-with-high-entropy";
const MANAGEMENT_WRITE_KEY = "management-write-key-with-high-entropy";
const MANAGEMENT_WRITE_SECRET = "management-write-secret-with-high-entropy";
const RUNTIME_KEY = "runtime-key-with-high-entropy";
const RUNTIME_SECRET = "runtime-secret-with-high-entropy";
const OTHER_KEY = "other-app-key-with-high-entropy";
const OTHER_SECRET = "other-app-secret-with-high-entropy";
const OTHER_MANAGEMENT_READ_KEY =
  "other-app-management-read-key-with-high-entropy";
const OTHER_MANAGEMENT_READ_SECRET =
  "other-app-management-read-secret-with-high-entropy";
const LIMITED_MANAGEMENT_WRITE_KEY =
  "limited-management-write-key-with-high-entropy";
const LIMITED_MANAGEMENT_WRITE_SECRET =
  "limited-management-write-secret-with-high-entropy";

const APPLICATIONS = [
  {
    appId: APP_ID,
    versionCollection: "versions_bifang_mouse_clicker",
    adCollection: "ads_bifang_mouse_clicker",
    auditCollection: "audit_bifang_mouse_clicker",
  },
  {
    appId: OTHER_APP_ID,
    versionCollection: "versions_bifang_screen_recorder",
    adCollection: "ads_bifang_screen_recorder",
    auditCollection: "audit_bifang_screen_recorder",
  },
];

const CREDENTIAL_CONFIG = {
  schema_version: 1,
  credentials: [
    credential({
      credentialId: "manage-read-mouse-2026-09",
      key: MANAGEMENT_READ_KEY,
      secrets: [MANAGEMENT_READ_SECRET, MANAGEMENT_READ_NEXT_SECRET],
      appId: APP_ID,
      codes: [CODE, OTHER_CODE],
      scopes: ["versions:read", "ads:read"],
    }),
    credential({
      credentialId: "manage-write-mouse-2026-09",
      key: MANAGEMENT_WRITE_KEY,
      secrets: [MANAGEMENT_WRITE_SECRET],
      appId: APP_ID,
      codes: [CODE, OTHER_CODE],
      scopes: ["versions:write", "ads:write"],
    }),
    credential({
      credentialId: "runtime-mouse-2026-09",
      key: RUNTIME_KEY,
      secrets: [RUNTIME_SECRET],
      appId: APP_ID,
      codes: [CODE],
      scopes: ["versions:check", "ads:show"],
    }),
    credential({
      credentialId: "runtime-recorder-2026-09",
      key: OTHER_KEY,
      secrets: [OTHER_SECRET],
      appId: OTHER_APP_ID,
      codes: [CODE],
      scopes: ["versions:check", "ads:show"],
    }),
    credential({
      credentialId: "manage-read-recorder-2026-09",
      key: OTHER_MANAGEMENT_READ_KEY,
      secrets: [OTHER_MANAGEMENT_READ_SECRET],
      appId: OTHER_APP_ID,
      codes: [CODE],
      scopes: ["versions:read", "ads:read"],
    }),
    credential({
      credentialId: "limited-manage-write-mouse-2026-09",
      key: LIMITED_MANAGEMENT_WRITE_KEY,
      secrets: [LIMITED_MANAGEMENT_WRITE_SECRET],
      appId: APP_ID,
      codes: [CODE],
      scopes: ["versions:write", "ads:write"],
    }),
  ],
};

function credential({ credentialId, key, secrets, appId, codes, scopes }) {
  return {
    credential_id: credentialId,
    key_sha256: hashCredential(key),
    secret_sha256: secrets.map(hashCredential),
    app_id: appId,
    codes,
    scopes,
  };
}

function createFixture(options = {}) {
  const repository = options.repository || createMemoryRepository();
  let versionId = 2_001_178_408_904_765_440n;
  let adId = 8_001_178_408_904_765_440n;
  let auditId = 0;
  const handler = createHandler({
    applications: APPLICATIONS,
    credentials: CREDENTIAL_CONFIG,
    repository,
    rateLimiter:
      options.rateLimiter || (() => ({ allowed: true, retryAfterSeconds: 1 })),
    now: options.now || (() => new Date("2026-09-10T12:34:56.000Z")),
    idGenerator:
      options.idGenerator ||
      ((kind) => String(kind === "version" ? versionId++ : adId++)),
    auditIdGenerator: () => `audit-${++auditId}`,
    logger: options.logger || { error() {} },
  });
  return { handler, repository };
}

async function invoke(handler, method, path, options = {}) {
  const isWrite = ["POST", "PUT", "DELETE"].includes(method);
  const defaultKey = isWrite ? MANAGEMENT_WRITE_KEY : MANAGEMENT_READ_KEY;
  const defaultSecret = isWrite
    ? MANAGEMENT_WRITE_SECRET
    : MANAGEMENT_READ_SECRET;
  const key = options.key === undefined ? defaultKey : options.key;
  const secret = options.secret === undefined ? defaultSecret : options.secret;
  const headers = {
    ...(key === null ? {} : { "x-app-key": key }),
    ...(secret === null ? {} : { "x-app-secret": secret }),
    ...(options.body === undefined
      ? {}
      : { "content-type": "application/json" }),
    ...options.headers,
  };
  const body =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body);
  return handler(
    {
      httpMethod: method,
      path,
      headers,
      body,
      isBase64Encoded: options.isBase64Encoded === true,
      requestContext: {
        http: { sourceIp: options.sourceIp || "203.0.113.10" },
      },
    },
    {},
  );
}

function body(response) {
  return response.body === "" ? null : JSON.parse(response.body);
}

function versionWrite(overrides = {}) {
  return {
    name: "原程序",
    code: CODE,
    codeVersion: "2.0.0",
    downloadUrl: "https://downloads.example.com/original-tool/2.0.0.exe",
    promptContent: "发现新版本",
    forcedUpdate: false,
    promptUpdate: true,
    stopUpdate: false,
    updateContent: "<div>本次更新内容</div>",
    ...overrides,
  };
}

test("the router accepts one v1 segment only and freezes method behavior", async () => {
  const { handler } = createFixture();

  const doubled = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/v1/versions/${CODE}/1.0.0`,
  );
  assert.equal(doubled.statusCode, 404);

  const trailing = await invoke(handler, "GET", `${BASE_PATH}/versions/`);
  assert.equal(trailing.statusCode, 404);

  const wrongMethod = await invoke(handler, "PATCH", `${BASE_PATH}/versions`);
  assert.equal(wrongMethod.statusCode, 405);
  assert.equal(wrongMethod.headers.Allow, "GET, POST");
  assert.equal(
    body(wrongMethod).errors.datas[0].code,
    "request.method_not_allowed",
  );
});

test("both exact headers are required and rotated secret hashes are accepted", async () => {
  const { handler } = createFixture();
  for (const [key, secret] of [
    [null, null],
    [MANAGEMENT_READ_KEY, null],
    [null, MANAGEMENT_READ_SECRET],
    [MANAGEMENT_READ_KEY, "wrong-secret"],
  ]) {
    const response = await invoke(handler, "GET", `${BASE_PATH}/versions`, {
      key,
      secret,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(body(response).errors.datas[0].code, "auth.invalid");
    assert.doesNotMatch(response.body, /wrong-secret|management-key/);
  }

  const rotated = await invoke(handler, "GET", `${BASE_PATH}/versions`, {
    secret: MANAGEMENT_READ_NEXT_SECRET,
  });
  assert.equal(rotated.statusCode, 200);
});

test("credential config is versioned, base64 encoded, exact, and app bound", () => {
  const encoded = Buffer.from(
    JSON.stringify(CREDENTIAL_CONFIG),
    "utf8",
  ).toString("base64");
  const parsed = parseCredentials(encoded, [APP_ID, OTHER_APP_ID]);
  assert.equal(parsed.length, 6);
  assert.equal(parsed[0].appId, APP_ID);
  assert.equal(parsed[0].codes.size, 2);
  assert.equal(parsed[0].secretHashes.length, 2);

  assert.equal(parseCredentials("not-base64", [APP_ID]), null);
  assert.equal(parseCredentials("wyg=", [APP_ID]), null);
  assert.equal(parseCredentials("e31=", [APP_ID]), null);
  assert.equal(
    parseCredentials({ ...CREDENTIAL_CONFIG, schema_version: 2 }, [APP_ID]),
    null,
  );
  assert.equal(parseCredentials(CREDENTIAL_CONFIG, [APP_ID]), null);
});

test("credentials accept only exact role bundles and runtime binds one code", () => {
  const parseSingle = (scopes, codes = [CODE]) =>
    parseCredentials(
      {
        schema_version: 1,
        credentials: [
          credential({
            credentialId: "exact-role-bundle",
            key: MANAGEMENT_READ_KEY,
            secrets: [MANAGEMENT_READ_SECRET],
            appId: APP_ID,
            codes,
            scopes,
          }),
        ],
      },
      [APP_ID],
    );

  for (const scopes of [["versions:check"], ["versions:check", "ads:show"]]) {
    assert.equal(parseSingle(scopes)?.length, 1);
    assert.equal(parseSingle(scopes, [CODE, OTHER_CODE]), null);
  }

  for (const scopes of [
    ["versions:read", "ads:read"],
    ["versions:write", "ads:write"],
  ]) {
    const parsed = parseSingle(scopes, [CODE, OTHER_CODE]);
    assert.equal(parsed?.length, 1);
    assert.equal(parsed[0].codes.size, 2);
  }

  for (const scopes of [
    ["ads:show"],
    ["versions:check", "versions:read"],
    ["versions:read"],
    ["ads:read"],
    ["versions:read", "versions:write"],
    ["versions:read", "ads:read", "versions:check"],
    ["versions:read", "ads:read", "ads:read"],
    ["versions:write"],
    ["ads:write"],
    ["versions:write", "ads:write", "ads:show"],
    [
      "versions:check",
      "versions:read",
      "versions:write",
      "ads:show",
      "ads:read",
      "ads:write",
    ],
  ]) {
    assert.equal(parseSingle(scopes), null, scopes.join(","));
  }
});

test("management read and write credentials cannot cross roles", async () => {
  const { handler } = createFixture();
  const deniedWrite = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    key: MANAGEMENT_READ_KEY,
    secret: MANAGEMENT_READ_SECRET,
    body: versionWrite(),
  });
  assert.equal(deniedWrite.statusCode, 403);

  const deniedRead = await invoke(handler, "GET", `${BASE_PATH}/versions`, {
    key: MANAGEMENT_WRITE_KEY,
    secret: MANAGEMENT_WRITE_SECRET,
  });
  assert.equal(deniedRead.statusCode, 403);
});

test("runtime credentials cannot write or cross their code boundary", async () => {
  const { handler } = createFixture();
  const deniedWrite = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    key: RUNTIME_KEY,
    secret: RUNTIME_SECRET,
    body: versionWrite(),
  });
  assert.equal(deniedWrite.statusCode, 403);

  for (const managementReadPath of [
    `${BASE_PATH}/versions`,
    `${BASE_PATH}/app/${CODE}/ads`,
    `${BASE_PATH}/app/ads/1`,
  ]) {
    const deniedManagementRead = await invoke(
      handler,
      "GET",
      managementReadPath,
      { key: RUNTIME_KEY, secret: RUNTIME_SECRET },
    );
    assert.equal(deniedManagementRead.statusCode, 403);
  }

  const deniedCode = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/versions/${OTHER_CODE}/1.0.0`,
    { key: RUNTIME_KEY, secret: RUNTIME_SECRET },
  );
  assert.equal(deniedCode.statusCode, 403);
});

test("version creation rejects query strings instead of widening the endpoint grammar", async () => {
  const { handler } = createFixture();
  const response = await invoke(
    handler,
    "POST",
    `${BASE_PATH}/versions?unknown=1`,
    { body: versionWrite() },
  );
  assert.equal(response.statusCode, 400);
  assert.equal(body(response).errors.datas[0].code, "request.invalid");
});

test("version create, list, update and runtime decision use exact external shapes", async () => {
  const { handler, repository } = createFixture();
  const created = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: versionWrite({ codeVersion: "01.002.0" }),
  });
  assert.equal(created.statusCode, 200);
  assert.equal(created.body, "");

  const duplicate = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: versionWrite({ codeVersion: "1.2" }),
  });
  assert.equal(duplicate.statusCode, 409);

  const higher = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: versionWrite({ codeVersion: "2.0.0" }),
  });
  assert.equal(higher.statusCode, 200);

  const listed = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/versions?page=1&size=100`,
  );
  assert.equal(listed.statusCode, 200);
  const grid = body(listed);
  assert.deepEqual(Object.keys(grid).sort(), ["model", "page", "result"]);
  assert.equal(grid.model, "grid.result");
  assert.equal(grid.result.model, "data.set");
  assert.equal(grid.result.total, 2);
  assert.equal(grid.page.total, 1);
  assert.equal(grid.page.total_page, 1);
  assert.deepEqual(Object.keys(grid.result.datas[0]).sort(), [
    "code",
    "codeVersion",
    "downloadUrl",
    "forcedUpdate",
    "id",
    "name",
    "promptContent",
    "promptUpdate",
    "stopUpdate",
    "updateContent",
  ]);

  const updateAvailable = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/versions/${CODE}/1.5.0`,
    { key: RUNTIME_KEY, secret: RUNTIME_SECRET },
  );
  assert.equal(updateAvailable.statusCode, 200);
  assert.deepEqual(body(updateAvailable), {
    update: true,
    downloadUrl: "https://downloads.example.com/original-tool/2.0.0.exe",
    promptContent: "发现新版本",
    forcedUpdate: false,
    promptUpdate: true,
    stopUpdate: false,
    updateContent: "<div>本次更新内容</div>",
  });

  const sameVersion = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/versions/${CODE}/2`,
    { key: RUNTIME_KEY, secret: RUNTIME_SECRET },
  );
  assert.equal(sameVersion.statusCode, 200);
  assert.equal(body(sameVersion).update, false);
  assert.equal(body(sameVersion).promptUpdate, false);

  const id = grid.result.datas.find(
    ({ codeVersion }) => codeVersion === "2.0.0",
  ).id;
  const updated = await invoke(handler, "PUT", `${BASE_PATH}/versions/${id}`, {
    body: versionWrite({ forcedUpdate: true, promptUpdate: false }),
  });
  assert.equal(updated.statusCode, 200);
  const forced = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/versions/${CODE}/1.0`,
    { key: RUNTIME_KEY, secret: RUNTIME_SECRET },
  );
  assert.equal(body(forced).forcedUpdate, true);

  const snapshot = repository.snapshot(APP_ID);
  assert.equal(snapshot.audit.length, 3);
  assert.deepEqual(
    snapshot.audit.map(({ action, entity }) => [action, entity]),
    [
      ["create", "version"],
      ["create", "version"],
      ["update", "version"],
    ],
  );
  assert.ok(
    snapshot.audit.every((item) => !("body" in item || "secret" in item)),
  );
});

test("version update authorizes both the stored code and the replacement code", async () => {
  const { handler, repository } = createFixture();
  await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: versionWrite({ code: OTHER_CODE }),
  });
  const listed = await invoke(handler, "GET", `${BASE_PATH}/versions`);
  const id = body(listed).result.datas[0].id;

  const denied = await invoke(handler, "PUT", `${BASE_PATH}/versions/${id}`, {
    key: LIMITED_MANAGEMENT_WRITE_KEY,
    secret: LIMITED_MANAGEMENT_WRITE_SECRET,
    body: versionWrite({ code: CODE }),
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(repository.snapshot(APP_ID).versions[0].code, OTHER_CODE);
  assert.equal(repository.snapshot(APP_ID).audit.length, 1);
});

test("criteria and state validation reject ambiguous updates", async () => {
  const { handler } = createFixture();
  const invalidBodies = [
    versionWrite({ forcedUpdate: true, promptUpdate: true }),
    versionWrite({ updateCriteria: "le" }),
    versionWrite({ versionCriteria: "1.0" }),
    versionWrite({ updateCriteria: "eq", versionCriteria: "1.0" }),
    versionWrite({ codeVersion: "v2.0.0" }),
    versionWrite({ code: "safe\u202eevil" }),
    versionWrite({ code: "." }),
    versionWrite({ code: ".." }),
    versionWrite({ code: "safe\\evil" }),
    { ...versionWrite(), unknown: true },
  ];
  for (const value of invalidBodies) {
    const response = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
      body: value,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(value));
  }

  const accepted = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: versionWrite({
      updateCriteria: "le",
      versionCriteria: "1.5",
    }),
  });
  assert.equal(accepted.statusCode, 200);
  const miss = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/versions/${CODE}/1.6`,
    { key: RUNTIME_KEY, secret: RUNTIME_SECRET },
  );
  assert.equal(body(miss).update, false);
  assert.equal(body(miss).promptUpdate, false);
});

test("URLs are public HTTPS and rich text is parsed then rendered through an allowlist", async () => {
  const { handler, repository } = createFixture();
  for (const downloadUrl of [
    "http://downloads.example.com/setup.exe",
    "https://user:pass@downloads.example.com/setup.exe",
    "https://127.0.0.1/setup.exe",
    "https://10.0.0.1/setup.exe",
    "https://service.internal/setup.exe",
    "https://intranet/setup.exe",
    "https://downloads.example.invalid/setup.exe",
    "https://198.51.100.7/setup.exe",
    "https://203.0.113.9/setup.exe",
  ]) {
    const response = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
      body: versionWrite({ downloadUrl }),
    });
    assert.equal(response.statusCode, 400, downloadUrl);
  }

  const markupInPlainText = await invoke(
    handler,
    "POST",
    `${BASE_PATH}/versions`,
    {
      body: versionWrite({ promptContent: "<img src=x onerror=run()>" }),
    },
  );
  assert.equal(markupInPlainText.statusCode, 400);

  const sanitized = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: versionWrite({
      updateContent:
        '<DIV onclick="steal()">安全<strong class="x">文本</strong><script>alert(1)</script><img src=x onerror=steal()></DIV>',
    }),
  });
  assert.equal(sanitized.statusCode, 200);
  assert.equal(
    repository.snapshot(APP_ID).versions[0].updateContent,
    "<div>安全<strong>文本</strong></div>",
  );

  const encodedUnsafeCharacter = await invoke(
    handler,
    "POST",
    `${BASE_PATH}/versions`,
    {
      body: versionWrite({ updateContent: "safe&#x202e;evil" }),
    },
  );
  assert.equal(encodedUnsafeCharacter.statusCode, 400);
});

test("write bodies enforce JSON media type, encoding and byte bounds", async () => {
  const { handler } = createFixture();
  const missingType = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: versionWrite(),
    headers: { "content-type": "text/plain" },
  });
  assert.equal(missingType.statusCode, 400);

  const malformed = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: "{",
  });
  assert.equal(malformed.statusCode, 400);

  const oversized = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: `{"value":"${"x".repeat(MAX_BODY_BYTES)}"}`,
  });
  assert.equal(oversized.statusCode, 400);

  const encodedBody = Buffer.from(
    JSON.stringify(versionWrite()),
    "utf8",
  ).toString("base64");
  const encoded = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: encodedBody,
    isBase64Encoded: true,
  });
  assert.equal(encoded.statusCode, 200);

  const invalidUtf8 = await invoke(handler, "POST", `${BASE_PATH}/versions`, {
    body: Buffer.from([0xc3, 0x28]).toString("base64"),
    isBase64Encoded: true,
  });
  assert.equal(invalidUtf8.statusCode, 400);

  const nonCanonicalBase64 = await invoke(
    handler,
    "POST",
    `${BASE_PATH}/versions`,
    {
      body: "e31=",
      isBase64Encoded: true,
    },
  );
  assert.equal(nonCanonicalBase64.statusCode, 400);
});

test("advertisement CRUD, detail, list and show keep their documented distinct shapes", async () => {
  const { handler, repository } = createFixture();
  const empty = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/app/${CODE}/ads/show`,
    {
      key: RUNTIME_KEY,
      secret: RUNTIME_SECRET,
    },
  );
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(body(empty), []);

  const created = await invoke(
    handler,
    "POST",
    `${BASE_PATH}/app/${CODE}/ads`,
    {
      body: {
        title: "活动",
        url: "https://www.example.com/campaign",
        image: "https://cdn.example.com/campaign.png",
        content: "<p onclick=bad()>正文<script>bad()</script></p>",
      },
    },
  );
  assert.equal(created.statusCode, 200);

  const list = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/app/${CODE}/ads?page=1&size=10&search=createdTime%3Dsort%3Ddesc`,
  );
  const listBody = body(list);
  assert.equal(listBody.result.total, 1);
  assert.deepEqual(Object.keys(listBody.result.datas[0]).sort(), [
    "appCode",
    "id",
    "image",
    "title",
    "url",
  ]);
  const id = listBody.result.datas[0].id;

  const detail = await invoke(handler, "GET", `${BASE_PATH}/app/ads/${id}`);
  assert.deepEqual(body(detail), {
    id,
    appCode: CODE,
    title: "活动",
    url: "https://www.example.com/campaign",
    image: "https://cdn.example.com/campaign.png",
    content: "<p>正文</p>",
  });

  const shown = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/app/${CODE}/ads/show`,
    {
      key: RUNTIME_KEY,
      secret: RUNTIME_SECRET,
    },
  );
  assert.deepEqual(body(shown), [
    {
      id,
      url: "https://www.example.com/campaign",
      image: "https://cdn.example.com/campaign.png",
      content: "<p>正文</p>",
    },
  ]);

  const updated = await invoke(
    handler,
    "PUT",
    `${BASE_PATH}/app/${CODE}/ads/${id}`,
    { body: { title: "新活动", url: "", content: "纯文本" } },
  );
  assert.equal(updated.statusCode, 200);
  assert.equal(
    repository.snapshot(APP_ID).ads[0].image,
    "https://cdn.example.com/campaign.png",
  );

  const deleted = await invoke(
    handler,
    "DELETE",
    `${BASE_PATH}/app/${CODE}/ads/${id}`,
  );
  assert.equal(deleted.statusCode, 200);
  assert.equal(repository.snapshot(APP_ID).ads.length, 0);
  assert.equal(repository.snapshot(APP_ID).audit.length, 3);

  const missing = await invoke(handler, "GET", `${BASE_PATH}/app/ads/${id}`);
  assert.equal(missing.statusCode, 404);
});

test("ad detail authorizes the stored code and app before returning data", async () => {
  const { handler } = createFixture();
  await invoke(handler, "POST", `${BASE_PATH}/app/${OTHER_CODE}/ads`, {
    body: { title: "other", url: "" },
  });
  const list = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/app/${OTHER_CODE}/ads`,
  );
  const id = body(list).result.datas[0].id;
  const denied = await invoke(handler, "GET", `${BASE_PATH}/app/ads/${id}`, {
    key: RUNTIME_KEY,
    secret: RUNTIME_SECRET,
  });
  assert.equal(denied.statusCode, 403);

  const isolated = await invoke(handler, "GET", `${BASE_PATH}/app/ads/${id}`, {
    key: OTHER_MANAGEMENT_READ_KEY,
    secret: OTHER_MANAGEMENT_READ_SECRET,
  });
  assert.equal(isolated.statusCode, 404);
});

test("pagination and provisional search syntax fail closed", async () => {
  const { handler } = createFixture();
  for (const path of [
    `${BASE_PATH}/versions?page=0`,
    `${BASE_PATH}/versions?page=101`,
    `${BASE_PATH}/versions?page=1&page=2`,
    `${BASE_PATH}/versions?unknown=1`,
    `${BASE_PATH}/app/${CODE}/ads?search=title%3Dfoo`,
  ]) {
    const response = await invoke(handler, "GET", path);
    assert.equal(response.statusCode, 400, path);
  }
});

test("the warm-instance limiter returns the frozen error wrapper and Retry-After", async () => {
  let milliseconds = 1_000;
  const limiter = createRateLimiter({ now: () => milliseconds });
  const { handler } = createFixture({ rateLimiter: limiter });
  for (let index = 0; index < 10; index += 1) {
    const response = await invoke(handler, "GET", `${BASE_PATH}/versions`);
    assert.equal(response.statusCode, 200);
  }
  const limited = await invoke(handler, "GET", `${BASE_PATH}/versions`, {
    headers: { "x-forwarded-for": `198.51.100.${Math.random()}` },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers["Retry-After"], "1");
  assert.equal(body(limited).errors.datas[0].code, "rate.limit_exceeded");

  const independentEndpoint = await invoke(
    handler,
    "GET",
    `${BASE_PATH}/app/${CODE}/ads/show`,
    { key: RUNTIME_KEY, secret: RUNTIME_SECRET },
  );
  assert.equal(independentEndpoint.statusCode, 200);

  milliseconds += 1_000;
  const reset = await invoke(handler, "GET", `${BASE_PATH}/versions`);
  assert.equal(reset.statusCode, 200);
});

test("unexpected repository failures do not log bodies, headers, or secrets", async () => {
  const logs = [];
  const repository = createMemoryRepository();
  repository.listVersions = async () => {
    const error = new Error(`database failed ${MANAGEMENT_READ_SECRET}`);
    error.code = "DATABASE_TIMEOUT";
    throw error;
  };
  const { handler } = createFixture({
    repository,
    logger: { error: (...values) => logs.push(values) },
  });
  const response = await invoke(handler, "GET", `${BASE_PATH}/versions`);
  assert.equal(response.statusCode, 500);
  assert.equal(body(response).errors.datas[0].code, "server.error");
  const serialized = JSON.stringify(logs);
  assert.match(serialized, /DATABASE_TIMEOUT/);
  assert.doesNotMatch(serialized, new RegExp(MANAGEMENT_READ_SECRET));
  assert.doesNotMatch(serialized, /x-app-secret|downloads\.example/);
});

test("application resources are exact and keep every app in separate collections", () => {
  const encoded = JSON.stringify(JSON.stringify(APPLICATIONS));
  assert.deepEqual(parseApplicationResources(encoded), APPLICATIONS);
  assert.equal(
    parseApplicationResources([
      { ...APPLICATIONS[0], adCollection: APPLICATIONS[0].versionCollection },
    ]),
    null,
  );
  assert.equal(
    parseApplicationResources([{ ...APPLICATIONS[0], unknown: true }]),
    null,
  );
  assert.equal(
    parseApplicationResources([
      {
        ...APPLICATIONS[0],
        versionCollection: APPLICATIONS[1].versionCollection,
        adCollection: APPLICATIONS[1].adCollection,
        auditCollection: APPLICATIONS[1].auditCollection,
      },
      {
        ...APPLICATIONS[1],
        versionCollection: APPLICATIONS[0].versionCollection,
        adCollection: APPLICATIONS[0].adCollection,
        auditCollection: APPLICATIONS[0].auditCollection,
      },
    ]),
    null,
  );
});

test("numeric dotted comparison is arbitrary precision and canonical", () => {
  assert.equal(compareDottedVersions("1", "1.0.0"), 0);
  assert.equal(compareDottedVersions("1.9", "1.10"), -1);
  assert.equal(compareDottedVersions("01.002", "1.2.0"), 0);
  assert.equal(
    compareDottedVersions(
      "9007199254740993.0",
      "9007199254740992.999999999999999999",
    ),
    1,
  );
  assert.equal(canonicalizeDottedVersion("0001.002.000"), "1.2");
  assert.equal(createVersionSortKey("0001.002.000"), "011012");
  const ordered = [
    "0",
    "1",
    "1.0.1",
    "1.2.999",
    "1.9",
    "1.10",
    "9007199254740993.0",
  ];
  assert.deepEqual(
    [...ordered].sort((left, right) => {
      const leftKey = createVersionSortKey(left);
      const rightKey = createVersionSortKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    }),
    ordered,
  );
  assert.equal(criteriaMatches("2", "ge", "2.0"), true);
  assert.equal(criteriaMatches("2", "lt", "2.0"), false);
});
