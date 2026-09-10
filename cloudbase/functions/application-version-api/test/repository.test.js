"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createCloudBaseRepository,
  createDefaultCloudBaseApp,
  adDocumentId,
  extractRuntimeSdkContext,
  fromAdDocument,
  fromVersionDocument,
  toAdDocument,
  toVersionDocument,
  versionDocumentId,
} = require("../src/repository");

const APP_A = "bifang-mouse-clicker";
const APP_B = "bifang-screen-recorder";
const RESOURCES = [
  {
    appId: APP_A,
    versionCollection: "versions_bifang_mouse_clicker",
    adCollection: "ads_bifang_mouse_clicker",
    auditCollection: "audit_bifang_mouse_clicker",
  },
  {
    appId: APP_B,
    versionCollection: "versions_bifang_screen_recorder",
    adCollection: "ads_bifang_screen_recorder",
    auditCollection: "audit_bifang_screen_recorder",
  },
];

test("the production adapter loads the CloudBase Node SDK with transaction support", () => {
  const app = createDefaultCloudBaseApp({ envOverride: "test-environment" });
  const database = app.database();
  const document = database
    .collection("test_collection")
    .doc("0123456789abcdef01234567");

  assert.equal(typeof database.runTransaction, "function");
  assert.equal(typeof document.create, "function");
  assert.equal(typeof document.get, "function");
  assert.equal(typeof document.set, "function");
  assert.equal(typeof document.delete, "function");
});

test("the CloudBase adapter writes transactional records, uniqueness keys and audits per app", async () => {
  const database = createFakeDatabase();
  const factoryCalls = [];
  const runtimeContext = { requestId: "test-request" };
  const repository = createCloudBaseRepository({
    resources: RESOURCES,
    runtimeContext,
    appFactory: (options) => {
      factoryCalls.push(options);
      return { database: () => database };
    },
  });

  await repository.createVersion(
    APP_A,
    versionRecord(),
    audit("audit-version", "create", "version", "2001178408904765440"),
  );
  await repository.createAd(
    APP_A,
    adRecord(),
    audit("audit-ad", "create", "ad", "8001178408904765440"),
  );

  assert.equal(factoryCalls.length, 1);
  assert.equal(factoryCalls[0].runtimeContext, runtimeContext);
  assert.equal(database.documents("versions_bifang_mouse_clicker").length, 2);
  assert.equal(database.documents("ads_bifang_mouse_clicker").length, 1);
  assert.equal(database.documents("audit_bifang_mouse_clicker").length, 2);
  assert.equal(database.documents("versions_bifang_screen_recorder").length, 0);
  assert.ok(
    database
      .allDocumentIds()
      .every((documentId) => /^[0-9a-f]{24}$/.test(documentId)),
  );

  const versions = await repository.listVersions(APP_A, new Set(["tool-a"]), {
    page: 1,
    size: 10,
    direction: "desc",
  });
  assert.equal(versions.totalRecords, 1);
  assert.deepEqual(versions.records[0], versionRecord());
  assert.deepEqual(await repository.listVersionsForCode(APP_A, "tool-a"), [
    versionRecord(),
  ]);

  const ads = await repository.listAds(APP_A, "tool-a", {
    page: 1,
    size: 10,
    direction: "desc",
  });
  assert.equal(ads.totalRecords, 1);
  assert.deepEqual(ads.records[0], adRecord());
  assert.deepEqual(await repository.getAd(APP_A, adRecord().id), adRecord());
  assert.deepEqual(await repository.showAds(APP_A, "tool-a"), [adRecord()]);
});

test("canonical version uniqueness is atomic per code and independent between codes", async () => {
  const database = createFakeDatabase();
  const repository = createRepository(database);
  await repository.createVersion(
    APP_A,
    versionRecord(),
    audit("audit-1", "create", "version", versionRecord().id),
  );

  await assert.rejects(
    repository.createVersion(
      APP_A,
      versionRecord({
        id: "2001178408904765441",
        codeVersion: "1.0",
        versionKey: "1",
      }),
      audit("audit-2", "create", "version", "2001178408904765441"),
    ),
    (error) => error.statusCode === 409 && error.code === "resource.conflict",
  );
  await repository.createVersion(
    APP_A,
    versionRecord({
      id: "2001178408904765442",
      code: "tool-b",
      codeVersion: "1.0",
      versionKey: "1",
    }),
    audit("audit-3", "create", "version", "2001178408904765442", "tool-b"),
  );
  assert.equal(
    database
      .documents("versions_bifang_mouse_clicker")
      .filter(({ doc_type: type }) => type === "version_record").length,
    2,
  );
  assert.equal(database.documents("audit_bifang_mouse_clicker").length, 2);
});

test("an exhausted CloudBase transaction conflict stays a retryable 409", async () => {
  const database = createFakeDatabase();
  database.runTransaction = async () => {
    const error = new Error("transaction retry exhausted");
    error.code = "DATABASE_TRANSACTION_CONFLICT";
    throw error;
  };
  const repository = createRepository(database);
  await assert.rejects(
    repository.createVersion(
      APP_A,
      versionRecord(),
      audit("audit-conflict", "create", "version", versionRecord().id),
    ),
    (error) => error.statusCode === 409 && error.code === "resource.conflict",
  );
});

test("the runtime lookup uses the internal numeric sort key and returns one highest version", async () => {
  const database = createFakeDatabase();
  const repository = createRepository(database);
  for (const [index, codeVersion] of ["1.9", "1.10", "1.2.999"].entries()) {
    const id = (2_001_178_408_904_765_440n + BigInt(index)).toString();
    await repository.createVersion(
      APP_A,
      versionRecord({
        id,
        codeVersion,
        versionKey: codeVersion,
      }),
      audit(`audit-sort-${index}`, "create", "version", id),
    );
  }

  const selected = await repository.listVersionsForCode(APP_A, "tool-a");
  assert.equal(selected.length, 1);
  assert.equal(selected[0].codeVersion, "1.10");
  assert.ok(
    database
      .documents("versions_bifang_mouse_clicker")
      .filter(({ doc_type: type }) => type === "version_record")
      .every(({ version_sort_key: key }) => /^[0-9]+$/.test(key)),
  );
});

test("version-key reservations move with updates and deleted ads stay app/code scoped", async () => {
  const database = createFakeDatabase();
  const repository = createRepository(database);
  const original = versionRecord();
  await repository.createVersion(
    APP_A,
    original,
    audit("audit-1", "create", "version", original.id),
  );
  const changed = versionRecord({
    code: "tool-b",
    codeVersion: "2.0.0",
    versionKey: "2",
    updatedAt: "2026-09-11T00:00:00.000Z",
  });
  assert.deepEqual(
    await repository.updateVersion(
      APP_A,
      original.id,
      changed,
      audit("audit-2", "update", "version", original.id, changed.code),
      new Set([original.code, changed.code]),
    ),
    { ...changed, createdAt: original.createdAt },
  );
  await repository.createVersion(
    APP_A,
    versionRecord({ id: "2001178408904765443" }),
    audit("audit-3", "create", "version", "2001178408904765443"),
  );

  const ad = adRecord();
  await repository.createAd(APP_A, ad, audit("audit-4", "create", "ad", ad.id));
  assert.equal(
    await repository.deleteAd(
      APP_A,
      "wrong-code",
      ad.id,
      audit("audit-5", "delete", "ad", ad.id, "wrong-code"),
    ),
    null,
  );
  assert.deepEqual(
    await repository.deleteAd(
      APP_A,
      ad.appCode,
      ad.id,
      audit("audit-6", "delete", "ad", ad.id),
    ),
    ad,
  );
  assert.equal(await repository.getAd(APP_A, ad.id), null);
  assert.equal(database.documents("audit_bifang_mouse_clicker").length, 5);
});

test("runtime database credentials forward only a complete temporary session", () => {
  const secret = {
    secretId: "temporary-id",
    secretKey: "temporary-key",
    token: "temporary-token",
  };
  assert.deepEqual(
    extractRuntimeSdkContext({
      extendedContext: { tmpSecret: { ...secret, arbitrary: "drop-me" } },
    }),
    { extendedContext: { tmpSecret: secret } },
  );
  assert.deepEqual(
    extractRuntimeSdkContext({
      environ:
        "TENCENTCLOUD_SECRETID=temporary-id;TENCENTCLOUD_SECRETKEY=temporary-key;TENCENTCLOUD_SESSIONTOKEN=temporary-token",
    }),
    { extendedContext: { tmpSecret: secret } },
  );
  assert.equal(
    extractRuntimeSdkContext({
      extendedContext: {
        tmpSecret: { secretId: secret.secretId, secretKey: secret.secretKey },
      },
    }),
    null,
  );
});

test("persisted records are fully revalidated before they can reach a response", () => {
  const validVersion = toVersionDocument(versionRecord());
  assert.deepEqual(fromVersionDocument(validVersion), versionRecord());
  assert.deepEqual(
    fromVersionDocument({
      ...validVersion,
      _id: versionDocumentId(validVersion.id),
    }),
    versionRecord(),
  );
  for (const corruptVersion of [
    { ...validVersion, download_url: "http://downloads.example.com/tool.exe" },
    { ...validVersion, update_content: "<script>run()</script>" },
    { ...validVersion, forced_update: "false" },
    { ...validVersion, version_sort_key: "999" },
    { ...validVersion, updated_at: "2026-09-09T00:00:00.000Z" },
    { ...validVersion, _id: "0".repeat(24) },
  ]) {
    assert.throws(
      () => fromVersionDocument(corruptVersion),
      /application_version_invalid_document/,
    );
  }

  const validAd = toAdDocument(adRecord());
  assert.deepEqual(fromAdDocument(validAd), adRecord());
  assert.deepEqual(
    fromAdDocument({ ...validAd, _id: adDocumentId(validAd.id) }),
    adRecord(),
  );
  for (const corruptAd of [
    { ...validAd, url: "javascript:run()" },
    { ...validAd, image: "http://cdn.example.com/image.png" },
    { ...validAd, content: "<img src=x onerror=run()>" },
    { ...validAd, title: undefined },
    { ...validAd, updated_at: "not-a-time" },
    { ...validAd, _id: "f".repeat(24) },
  ]) {
    assert.throws(
      () => fromAdDocument(corruptAd),
      /application_version_invalid_document/,
    );
  }
});

function createRepository(database) {
  return createCloudBaseRepository({
    resources: RESOURCES,
    appFactory: () => ({ database: () => database }),
  });
}

function versionRecord(overrides = {}) {
  return {
    id: "2001178408904765440",
    name: "Tool A",
    code: "tool-a",
    codeVersion: "1.0.0",
    versionKey: "1",
    downloadUrl: "https://downloads.example.com/tool-a.exe",
    promptContent: "Update available",
    forcedUpdate: false,
    promptUpdate: true,
    stopUpdate: false,
    updateContent: "<p>Changes</p>",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function adRecord(overrides = {}) {
  return {
    id: "8001178408904765440",
    appCode: "tool-a",
    title: "Campaign",
    url: "https://www.example.com/campaign",
    image: "https://cdn.example.com/campaign.png",
    content: "<p>Campaign</p>",
    createdAt: "2026-09-10T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function audit(id, action, entity, recordId, code = "tool-a") {
  return {
    id,
    action,
    entity,
    recordId,
    code,
    credentialFingerprint: "test-credential",
    occurredAt: "2026-09-10T00:00:00.000Z",
    sourceIp: "203.0.113.10",
  };
}

function createFakeDatabase() {
  const stores = new Map();
  const getStore = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };

  const database = {
    command: {
      in(values) {
        return { $in: [...values] };
      },
    },
    collection(name) {
      return createCollection(getStore(name));
    },
    async runTransaction(work) {
      const backup = cloneStores(stores);
      const transaction = {
        collection(name) {
          return {
            doc(id) {
              return createDocumentReference(getStore(name), id);
            },
          };
        },
      };
      try {
        return await work(transaction);
      } catch (error) {
        stores.clear();
        for (const [name, values] of backup) stores.set(name, values);
        throw error;
      }
    },
    documents(name) {
      return [...getStore(name).values()].map((value) =>
        structuredClone(value),
      );
    },
    allDocumentIds() {
      return [...stores.values()].flatMap((store) => [...store.keys()]);
    },
  };
  return database;
}

function createCollection(store) {
  return {
    doc(id) {
      return createDocumentReference(store, id);
    },
    where(condition) {
      return createQuery(store, condition);
    },
  };
}

function createDocumentReference(store, id) {
  return {
    async get() {
      return { data: store.has(id) ? [structuredClone(store.get(id))] : [] };
    },
    async create(value) {
      if (store.has(id)) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      store.set(id, { ...structuredClone(value), _id: id });
      return { inserted: 1 };
    },
    async set(value) {
      store.set(id, { ...structuredClone(value), _id: id });
      return { updated: 1 };
    },
    async delete() {
      store.delete(id);
      return { deleted: 1 };
    },
  };
}

function createQuery(store, condition) {
  const state = { direction: "asc", limit: 100, orders: [], skip: 0 };
  const query = {
    orderBy(field, direction) {
      state.orders.push([field, direction]);
      return query;
    },
    skip(value) {
      state.skip = value;
      return query;
    },
    limit(value) {
      state.limit = value;
      return query;
    },
    async get() {
      const values = matchingValues(store, condition, state.orders);
      return {
        data: values.slice(state.skip, state.skip + state.limit),
      };
    },
    async count() {
      return { total: matchingValues(store, condition, []).length };
    },
  };
  return query;
}

function matchingValues(store, condition, orders) {
  const values = [...store.values()].filter((document) =>
    Object.entries(condition).every(([key, expected]) => {
      if (expected && Array.isArray(expected.$in)) {
        return expected.$in.includes(document[key]);
      }
      return document[key] === expected;
    }),
  );
  values.sort((left, right) => {
    for (const [field, direction] of orders) {
      if (left[field] === right[field]) continue;
      const comparison = left[field] < right[field] ? -1 : 1;
      return direction === "asc" ? comparison : -comparison;
    }
    return 0;
  });
  return values.map((value) => structuredClone(value));
}

function cloneStores(stores) {
  return new Map(
    [...stores].map(([name, store]) => [
      name,
      new Map([...store].map(([id, value]) => [id, structuredClone(value)])),
    ]),
  );
}
