import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  validateInput,
  validateAccessInput,
  createServiceSecrets,
  buildSpec,
  sourceBundle,
  ROOT,
} from "../cloudbase/personal/spec.mjs";
import {
  createPersonalApi,
  costPreflight,
  planResources,
  applyResources,
} from "../cloudbase/personal/cloud.mjs";
import {
  createIntake,
  readPrivate,
  writePrivate,
  privateRoot,
} from "../cloudbase/personal/private-files.mjs";
import { run, safeFailure } from "../cloudbase/personal/cli.mjs";
import { saveInputValues } from "../cloudbase/personal/input-values.mjs";
import { PGDOC_PROBE_SQL } from "../cloudbase/personal/postgresql.mjs";
import { captureShared, variables } from "../cloudbase/personal/shared.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  authenticate,
  authorize,
  parseCredentials,
} = require("../cloudbase/functions/application-version-api/src/auth.js");

const now = Date.parse("2026-11-18T00:00:00Z");
const clone = (v) => structuredClone(v);

test("conversation values merge into the original intake, preserve local CAM keys and only report field names", async (t) => {
  const original = input();
  const file = await privateFixture(t, original);
  const patch = {
    "cloudbase.env_id": "new-env",
    "credentials.Token": "mock-sts",
    "applications[0].display_name": "新版便签",
  };
  const result = await saveInputValues(file, patch);
  assert.deepEqual(result, {
    status: "saved-and-read-back",
    fields: Object.keys(patch),
  });
  const updated = await readPrivate(file);
  assert.deepEqual(updated.credentials, {
    ...original.credentials,
    Token: "mock-sts",
  });
  assert.equal(updated.applications[0].display_name, "新版便签");
  for (const key of [
    "credentials.SecretKey",
    "credentials.secretId",
    "credentials",
    "credentials.__proto__",
  ]) {
    await assert.rejects(
      saveInputValues(file, {
        "cloudbase.region": "invalid",
        [key]: "forbidden",
      }),
      /FIELD_NOT_EDITABLE/,
    );
  }
  assert.deepEqual(await saveInputValues(file, patch), result);
  assert.deepEqual(await readPrivate(file), updated);
});

test("integration and release forms accept scoped typed fields, with immutable plan files", async (t) => {
  const folder = dirname(await privateFixture(t));
  const file = join(folder, "integration-input.json");
  await writePrivate(file, {
    services: { update: false },
    targets: [],
    update: { credentials: [] },
  });
  await saveInputValues(file, {
    "services.update": true,
    "targets[0].channel": "stable",
    "update.credentials[0].codes[0]": "demo",
    "update.credentials[0].app_secret": "mock-only",
  });
  const result = await readPrivate(file);
  assert.deepEqual(result.update.credentials, [
    { codes: ["demo"], app_secret: "mock-only" },
  ]);
  assert.deepEqual(result.targets, [{ channel: "stable" }]);
  for (const name of [
    "windows-release-handoff.json",
    "release-settings-abcd.json",
  ]) {
    const form = join(folder, name);
    await writePrivate(form, {
      release: { code: "demo", updateCriteria: "lt", versionCriteria: "2" },
    });
    await saveInputValues(form, {
      "release.codeVersion": "2.0",
      "release.updateContent": "一行\n二行",
      "release.forcedUpdate": false,
      "release.updateCriteria": null,
      "release.versionCriteria": null,
    });
    assert.deepEqual((await readPrivate(form)).release, {
      code: "demo",
      codeVersion: "2.0",
      updateContent: "一行\n二行",
      forcedUpdate: false,
    });
    await assert.rejects(
      saveInputValues(form, { "release.forcedUpdate": "false" }),
      /INVALID_FIELD_TYPE/,
    );
  }
  await assert.rejects(
    saveInputValues(join(folder, "release-plan-abcd.json"), {
      "release.codeVersion": "3",
    }),
    /EDITABLE_INPUT_REQUIRED/,
  );
});

test("PostgreSQL default is verified from environment metadata and a fixed read-only catalog query", async () => {
  const { data, spec } = await fixture();
  data.cloudbase.database_type = "";
  assert.doesNotThrow(() => validateAccessInput(data, now));
  const cloud = fakeCloud(spec);
  cloud.setPlugin("missing");
  const result = await costPreflight(cloud.api, spec, now);
  assert.deepEqual(result.database, {
    type: "postgresql",
    document_api: "pgdoc",
    plugin: "missing",
    sql_connectivity: "verified",
  });
  assert.equal(cloud.writes.length, 0);
  cloud.environment.PostgreSQL = [];
  cloud.environment.Databases = [{ InstanceId: "tnt-legacy" }];
  await assert.rejects(
    costPreflight(cloud.api, spec, now),
    /POSTGRESQL_NOT_CONFIRMED/,
  );
});

test("pgdoc enablement is planned, authorized, read back and never repeated", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  cloud.setPlugin("missing");
  const plan = await planResources(cloud.api, spec, now);
  assert.equal(plan.operations[0].action, "EnablePGDocumentExt");
  assert.deepEqual(plan.operations[0].payload, { EnvId: spec.envId });
  assert.equal(cloud.writes.length, 0);
  await applyResources(cloud.api, spec, plan.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.equal(cloud.writes[0].action, "EnablePGDocumentExt");
  assert.equal(
    cloud.writes.filter((op) => op.action === "EnablePGDocumentExt").length,
    1,
  );
  assert.equal(
    (await planResources(cloud.api, spec, now)).operations.length,
    0,
  );
});

test("legacy document coexistence, partial installation and malformed PG responses fail closed", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  cloud.setPlugin("missing");
  cloud.environment.Databases = [{ InstanceId: "tnt-legacy" }];
  await assert.rejects(
    planResources(cloud.api, spec, now),
    /PGDOC_LEGACY_DATABASE_CONFLICT/,
  );
  cloud.environment.Databases = [];
  cloud.setPlugin("partial");
  await assert.rejects(
    planResources(cloud.api, spec, now),
    /PGDOC_PARTIAL_INSTALLATION/,
  );
  const api = (s, a, p) =>
    a === "ExecutePGSql"
      ? { Columns: ["wrong"], Rows: ['["ready"]'] }
      : cloud.api(s, a, p);
  await assert.rejects(
    planResources(api, spec, now),
    /INVALID_POSTGRESQL_RESULT/,
  );
  assert.equal(cloud.writes.length, 0);
});

test("failed enablement and resources discovered after enablement stop before downstream writes", async () => {
  const { spec } = await fixture();
  for (const conflict of [false, true]) {
    const cloud = fakeCloud(spec);
    cloud.setPlugin("missing");
    const plan = await planResources(cloud.api, spec, now);
    const api = async (s, a, p) => {
      if (a === "EnablePGDocumentExt" && !conflict) return { Enabled: false };
      const result = await cloud.api(s, a, p);
      if (a === "EnablePGDocumentExt")
        cloud.tables.set(spec.collections[0].name, {
          acl: "ADMINONLY",
          indexes: [],
        });
      return result;
    };
    await assert.rejects(
      applyResources(api, spec, plan.digest, {
        now: () => now,
        sleep: async () => {},
      }),
      conflict
        ? /POST_ENABLE_PLAN_CHANGED_REVIEW_REQUIRED/
        : /PGDOC_ENABLE_NOT_CONFIRMED/,
    );
    assert.ok(cloud.writes.every((op) => op.action === "EnablePGDocumentExt"));
  }
});

test("inspection credentials cannot run arbitrary SQL or enable pgdoc", async () => {
  let fetched = 0;
  const data = input();
  const api = createPersonalApi(data, [], async () => {
    fetched++;
    throw new Error("unexpected network");
  });
  for (const Sql of [
    "SELECT 1",
    PGDOC_PROBE_SQL + "; DROP SCHEMA public CASCADE",
  ]) {
    await assert.rejects(
      api("tcb", "ExecutePGSql", { EnvId: data.cloudbase.env_id, Sql }),
      /API_ACTION_NOT_AUTHORIZED/,
    );
  }
  await assert.rejects(
    api("tcb", "ExecutePGSql", {
      EnvId: data.cloudbase.env_id,
      Sql: PGDOC_PROBE_SQL,
      Role: "postgres",
    }),
    /API_ACTION_NOT_AUTHORIZED/,
  );
  await assert.rejects(
    api("tcb", "EnablePGDocumentExt", { EnvId: data.cloudbase.env_id }),
    /API_ACTION_NOT_AUTHORIZED/,
  );
  assert.equal(fetched, 0);
});
function input() {
  return {
    schema_version: 1,
    purpose: "personal-cloudbase-resource-creation",
    cloudbase: {
      env_id: "personal-test-env",
      region: "ap-shanghai",
      database_type: "postgresql",
      http_origin: "",
    },
    credentials: {
      mode: "api-key",
      SecretId: "fake-cam-id",
      SecretKey: "fake-cam-secret",
      Token: "",
      expires_at: "",
    },
    resources: {
      telemetry: "missing",
      update: "missing",
      dashboard: "missing",
    },
    applications: [
      {
        app_id: "personal-test",
        display_name: "个人测试",
        release_streams: [
          {
            platform: "windows",
            architecture: "x64",
            channel: "stable",
            code: "personal-test-windows-x64",
          },
        ],
      },
    ],
    existing_resource_overrides: [],
    existing_service_credentials_file: "",
    acknowledge_zero_cost_only: true,
  };
}
async function fixture() {
  const data = input(),
    v = validateInput(data, now),
    secrets = createServiceSecrets(v),
    spec = await buildSpec(v, secrets);
  return { data, v, secrets, spec };
}
function fakeCloud(spec) {
  const tables = new Map(),
    functions = new Map(),
    routes = [];
  const writes = [];
  let billed = false,
    failAction = null;
  let plugin = "ready";
  const environment = {
    EnvId: spec.envId,
    Region: spec.region,
    Status: "NORMAL",
    PackageId: "baas_trial",
    Databases: [],
    PostgreSQL: [
      {
        Name: "postgres",
        InstanceName: "postgres-test",
        Region: spec.region,
        Status: 1,
      },
    ],
  };
  const domain = {
    Domain: "personal-test-env-1.ap-shanghai.app.tcloudbase.com",
    DomainType: "HTTPSERVICE",
    IsDefault: true,
    Enable: true,
    Status: "SUCCESS",
    DNSStatus: "OK",
    Routes: routes,
  };
  const api = async (service, action, p) => {
    switch (action) {
      case "DescribeEnvs":
        return {
          EnvList: [clone(environment)],
        };
      case "ExecutePGSql":
        assert.equal(p.Sql, PGDOC_PROBE_SQL);
        return { Columns: ["pgdoc_state"], Rows: [JSON.stringify([plugin])] };
      case "EnablePGDocumentExt":
        assert.equal(plugin, "missing");
        assert.equal(environment.Databases.length, 0);
        writes.push({ action, p: clone(p) });
        plugin = "ready";
        return { Enabled: true };
      case "DescribeBillingInfo":
        return {
          EnvBillingInfoList: [
            {
              EnvId: spec.envId,
              PackageId: billed ? "paid" : "baas_trial",
              Status: "NORMAL",
              PayMode: "PREPAYMENT",
              IsAutoRenew: false,
              EnableOverrun: false,
              ExtPackageCode: [],
              ExpireTime: "2099-01-01T00:00:00Z",
            },
          ],
        };
      case "DescribeEnvAccountCircle":
        return { StartTime: "2026-11-01", EndTime: "2026-12-01" };
      case "DescribeBaasPackageList":
        return {
          PackageList: [
            {
              PackageName: "baas_trial",
              ResourceLimit: JSON.stringify({
                Credits: { MaxSize: 3000 },
                Scf: { FunctionNum: { MaxSize: 50 } },
              }),
            },
          ],
        };
      case "DescribeCreditsUsage":
        return { DeductValue: 1, PackageDeductValue: 0, ReportValue: 0 };
      case "DescribeHTTPServiceRoute":
        return { TotalCount: 1, Domains: [clone(domain)] };
      case "ListFunctions":
        return {
          TotalCount: functions.size,
          Functions: [...functions.values()]
            .slice(p.Offset, p.Offset + p.Limit)
            .map(clone),
        };
      case "GetFunction":
        return clone(functions.get(p.FunctionName));
      case "DescribeTable":
        assert.equal(plugin, "ready");
        if (!tables.has(p.TableName))
          throw new Error("Tencent Cloud API error: ResourceNotFound.Table");
        return {};
      case "DescribeDatabaseACL":
        return { AclTag: tables.get(p.CollectionName).acl };
      case "RunCommands": {
        const cmd = JSON.parse(p.MgoCommands[0].Command),
          table = tables.get(p.MgoCommands[0].TableName);
        if (cmd.listIndexes)
          return {
            Data: [
              JSON.stringify({
                ok: 1,
                cursor: { id: 0, firstBatch: table.indexes },
              }),
            ],
          };
        assert.equal(p.MgoCommands[0].CommandType, "COMMAND");
        assert.ok(cmd.createIndexes);
        writes.push({ action, p: clone(p) });
        table.indexes.push(...clone(cmd.indexes));
        return { Data: [JSON.stringify({ ok: 1 })] };
      }
      case "CreateTable":
        assert.equal(p.PermissionInfo.AclTag, "ADMINONLY");
        assert.ok(!tables.has(p.TableName));
        writes.push({ action, p: clone(p) });
        tables.set(p.TableName, {
          acl: "ADMINONLY",
          indexes: [{ name: "_id_", key: { _id: 1 }, unique: true }],
        });
        return {};
      case "UpdateTable":
        assert.equal(p.DropIndexes, undefined);
        writes.push({ action, p: clone(p) });
        tables.get(p.TableName).indexes.push(
          ...p.CreateIndexes.map((i) => ({
            name: i.IndexName,
            key: Object.fromEntries(
              i.MgoKeySchema.MgoIndexKeys.map((k) => [
                k.Name,
                Number(k.Direction),
              ]),
            ),
            unique: i.MgoKeySchema.MgoIsUnique,
            sparse: i.MgoKeySchema.MgoIsSparse,
          })),
        );
        return {};
      case "CreateFunction":
        if (failAction === action) {
          failAction = null;
          throw new Error("simulated failure");
        }
        assert.equal(service, "tcb");
        assert.ok(!functions.has(p.FunctionName));
        writes.push({ action, p: clone(p) });
        functions.set(p.FunctionName, {
          ...clone(p),
          Namespace: p.EnvId,
          Status: "Active",
        });
        return {};
      case "UpdateFunctionConfiguration": {
        assert.equal(service, "scf");
        assert.deepEqual(Object.keys(p).sort(), [
          "Environment",
          "FunctionName",
          "Namespace",
        ]);
        writes.push({ action, p: clone(p) });
        const fn = functions.get(p.FunctionName);
        fn.Environment = clone(p.Environment);
        fn.ModTime = "2026-11-18 00:01:00";
        return {};
      }
      case "CreateHTTPServiceRoute":
        writes.push({ action, p: clone(p) });
        routes.push(...clone(p.Domain.Routes));
        return {};
      default:
        throw new Error("Unexpected fake API action " + action);
    }
  };
  return {
    api,
    tables,
    functions,
    routes,
    writes,
    environment,
    setPlugin: (value) => {
      plugin = value;
    },
    setPaid: () => {
      billed = true;
    },
    failOnce: (a) => {
      failAction = a;
    },
  };
}

test("HTTP inventory separates default domain types and confirms omitted empty routes", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const reads = [];
  const api = async (service, action, payload) => {
    const response = await cloud.api(service, action, payload);
    if (action !== "DescribeHTTPServiceRoute") return response;
    reads.push(payload);
    const http = response.Domains[0];
    delete http.Routes;
    if (payload.Filters) return response;
    return {
      TotalCount: 3,
      Domains: [
        {
          ...http,
          Domain: "test.tcloudbaseapp.com",
          DomainType: "STATIC_STORE",
          Routes: [{ Path: "/" }],
        },
        http,
        {
          ...http,
          Domain: "test.storage.tcloudbase.com",
          DomainType: "STORAGE",
          Routes: [{ Path: "/" }],
        },
      ],
    };
  };
  const plan = await planResources(api, spec, now);
  assert.equal(
    plan.summary.origin,
    "https://personal-test-env-1.ap-shanghai.app.tcloudbase.com",
  );
  assert.equal(plan.operations.filter((op) => op.kind === "route").length, 4);
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1].Filters, [
    { Name: "Domain", Values: [new URL(plan.summary.origin).hostname] },
  ]);
  assert.equal(cloud.writes.length, 0);
});

test("HTTP inventory rejects ambiguity, malformed routes and changes during empty-route confirmation", async () => {
  const { spec } = await fixture();
  for (const scenario of [
    "ambiguous",
    "missing-type",
    "null",
    "object",
    "duplicate",
    "drift",
  ]) {
    const cloud = fakeCloud(spec);
    const api = async (service, action, payload) => {
      const response = await cloud.api(service, action, payload);
      if (action !== "DescribeHTTPServiceRoute") return response;
      const http = response.Domains[0];
      if (scenario === "ambiguous") {
        response.TotalCount = 2;
        response.Domains.push({ ...http, Domain: "other.app.tcloudbase.com" });
      }
      if (scenario === "missing-type") delete http.DomainType;
      if (scenario === "null") http.Routes = null;
      if (scenario === "object") http.Routes = {};
      if (scenario === "duplicate")
        http.Routes = [{ Path: "/same" }, { Path: "/same" }];
      if (scenario === "drift" && !payload.Filters) delete http.Routes;
      return response;
    };
    await assert.rejects(
      planResources(api, spec, now),
      /DEFAULT_DOMAIN_NOT_READY|INVALID_ROUTE_INVENTORY|DOMAIN_INVENTORY_DRIFT/,
    );
    assert.equal(cloud.writes.length, 0);
  }
});

test("DescribeTable accepts documented generic absence but rejects connector and permission failures", async () => {
  const { spec } = await fixture();
  for (const code of [
    "ResourceNotFound",
    "ResourceNotFound.Connector",
    "UnauthorizedOperation",
  ]) {
    const cloud = fakeCloud(spec);
    const api = (s, a, p) => {
      if (a === "DescribeTable")
        throw new Error("Tencent Cloud API error: " + code);
      return cloud.api(s, a, p);
    };
    if (code === "ResourceNotFound") {
      const plan = await planResources(api, spec, now);
      assert.equal(
        plan.operations.filter((op) => op.kind === "collection").length,
        4,
      );
    } else {
      await assert.rejects(planResources(api, spec, now), new RegExp(code));
    }
    assert.equal(cloud.writes.length, 0);
  }
  assert.equal(
    safeFailure(
      Object.assign(new Error("Tencent Cloud API error: ResourceNotFound"), {
        apiService: "tcb",
        apiAction: "DescribeTable",
      }),
    ).code,
    "CLOUD_RESOURCE_NOT_FOUND",
  );
});

test("index readback accepts pgdoc JSON rows with EJSON numbers and rejects incomplete/error rows", async () => {
  const { spec } = await fixture();
  for (const scenario of [
    "valid",
    "truncated",
    "error",
    "malformed",
    "unsafe-number",
  ]) {
    const cloud = fakeCloud(spec);
    for (const c of spec.collections)
      cloud.tables.set(c.name, { acl: "ADMINONLY", indexes: clone(c.indexes) });
    const api = async (s, a, p) => {
      if (a === "DescribeTable")
        return { IndexNum: cloud.tables.get(p.TableName).indexes.length };
      if (a === "RunCommands") {
        const rows = cloud.tables
          .get(p.MgoCommands[0].TableName)
          .indexes.map((i) =>
            JSON.stringify(i, (_k, v) =>
              typeof v === "number" ? { $numberInt: String(v) } : v,
            ),
          );
        if (scenario === "truncated") rows.pop();
        if (scenario === "error")
          return {
            Data: [JSON.stringify([JSON.stringify({ ok: 0, code: 13 })])],
          };
        if (scenario === "malformed")
          return { Data: [JSON.stringify(["not-json"])] };
        if (scenario === "unsafe-number")
          return {
            Data: [
              JSON.stringify([
                JSON.stringify({
                  name: "test",
                  key: { a: { $numberLong: "9007199254740993" } },
                }),
              ]),
            ],
          };
        return { Data: [JSON.stringify(rows)] };
      }
      return cloud.api(s, a, p);
    };
    if (scenario === "valid") {
      const plan = await planResources(api, spec, now);
      assert.equal(
        plan.operations.filter(
          (op) => op.kind === "indexes" || op.kind === "collection",
        ).length,
        0,
      );
    } else
      await assert.rejects(
        planResources(api, spec, now),
        /INCOMPLETE_INDEX_INVENTORY|DATABASE_COMMAND_FAILED|INVALID_DATABASE_RESULT/,
      );
    assert.equal(cloud.writes.length, 0);
  }
});

test("packages only customer resources, isolated credentials and dashboard labels", async () => {
  const { data, secrets, spec } = await fixture();
  assert.equal(spec.functions.length, 3);
  assert.equal(spec.collections.length, 4);
  assert.equal(spec.routes.length, 4);
  const wire = JSON.stringify(spec);
  for (const secret of [
    data.credentials.SecretId,
    data.credentials.SecretKey,
    ...secrets.version_credentials.flatMap((c) => [c.app_key, c.app_secret]),
    ...Object.values(secrets.dashboard),
  ])
    assert.equal(wire.includes(secret), false);
  const dashboard = spec.functions.find(
    (f) => f.name === "operations-dashboard-api",
  );
  const zip = Buffer.from(dashboard.payload.Code.ZipFile, "base64");
  assert.ok(zip.includes(Buffer.from("个人测试")));
  assert.ok(!zip.includes(Buffer.from("bifang-screen-recorder")));
  assert.ok(
    spec.routes.every((r) => !("QPSPolicy" in r) && !("EnableSafeDomain" in r)),
  );
});

test("telemetry ships only its HTTP handler and provisions no scheduled deletion", async () => {
  const { spec } = await fixture();
  assert.ok(spec.functions.every((fn) => !fn.name.startsWith("cleanup-")));
  assert.ok(!("triggers" in spec));
  const telemetry = spec.functions.find((fn) =>
    fn.name.startsWith("telemetry-"),
  );
  const zip = Buffer.from(telemetry.payload.Code.ZipFile, "base64");
  assert.ok(!zip.includes(Buffer.from("src/cleanup.js")));
  assert.ok(
    zip.includes(
      await readFile(join(ROOT, "cloudbase/functions/telemetry/index.js")),
    ),
  );
  assert.deepEqual(
    spec.collections.find((c) => c.name.startsWith("telemetry_")).indexes,
    [],
  );
});

test("an upgrade over an older source directory excludes the orphaned module from the HTTP ZIP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "bifang-telemetry-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = "cloudbase/functions/telemetry";
  const target = join(root, dir);
  await mkdir(target, { recursive: true });
  await cp(join(ROOT, dir), target, {
    recursive: true,
    filter: (path) => !/(?:node_modules|[\\/]test)$/.test(path),
  });
  await writeFile(join(target, "src/cleanup.js"), "orphaned module");
  assert.deepEqual(
    await sourceBundle(dir, {}, root),
    await sourceBundle(dir, {}, ROOT),
  );
});

test("full create then repeat is idempotent and never writes business records", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const plan = await planResources(cloud.api, spec, now);
  assert.equal(cloud.writes.length, 0);
  assert.equal(plan.operations.length, 14);
  const result = await applyResources(cloud.api, spec, plan.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.equal(result.status, "resources-created-control-plane-verified");
  assert.equal(result.live_http_gui_exe_tested, false);
  const count = cloud.writes.length;
  const again = await planResources(cloud.api, spec, now);
  assert.equal(again.operations.length, 0);
  await applyResources(cloud.api, spec, again.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.equal(cloud.writes.length, count);
  assert.ok(
    cloud.writes.every((w) =>
      [
        "CreateTable",
        "UpdateTable",
        "CreateFunction",
        "CreateHTTPServiceRoute",
      ].includes(w.action),
    ),
  );
});

test("paid environment blocks before any mutation", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  cloud.setPaid();
  await assert.rejects(
    planResources(cloud.api, spec, now),
    /FREE_BILLING_GATE_FAILED/,
  );
  assert.equal(cloud.writes.length, 0);
});

test("ordinary indexes reject a concurrent change before writing", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const plan = await planResources(cloud.api, spec, now);
  assert.ok(
    plan.operations
      .filter((o) => o.kind === "indexes")
      .every((o) => o.action === "UpdateTable" && !o.payload.DropIndexes),
  );
  const target = spec.collections.find((c) => c.indexes.length > 0);
  await assert.rejects(
    applyResources(cloud.api, spec, plan.digest, {
      now: () => now,
      sleep: async () => {},
      onProgress: (e) => {
        if (
          e.kind === "collection" &&
          e.target === target.name &&
          e.status === "readback-passed"
        )
          cloud.tables.get(e.target).indexes.push({ ...target.indexes[0] });
      },
    }),
    /INDEX_CHANGED_REPLAN_REQUIRED/,
  );
  assert.ok(!cloud.writes.some((w) => w.action === "UpdateTable"));
  const next = await planResources(cloud.api, spec, now);
  await applyResources(cloud.api, spec, next.digest, {
    now: () => now,
    sleep: async () => {},
  });
});

test("existing or manually removed legacy cleanup resources never become provisioning targets", async () => {
  const { spec } = await fixture();
  const cloud = fakeCloud(spec);
  const legacy =
    "cleanup-" +
    spec.functions
      .find((f) => f.name.startsWith("telemetry-"))
      .name.slice("telemetry-".length);
  cloud.functions.set(legacy, { FunctionName: legacy });
  const table = spec.collections.find((c) => c.name.startsWith("telemetry_"));
  const index = { name: "expires_at_cleanup", key: { expires_at: 1, _id: 1 } };
  cloud.tables.set(table.name, { acl: "ADMINONLY", indexes: [index] });
  const api = async (service, action, payload) => {
    assert.doesNotMatch(action, /Trigger/);
    assert.notEqual(payload.FunctionName, legacy);
    return cloud.api(service, action, payload);
  };
  const plan = await planResources(api, spec, now);
  await applyResources(api, spec, plan.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.ok(cloud.functions.has(legacy));
  assert.deepEqual(cloud.tables.get(table.name).indexes, [index]);
  cloud.functions.delete(legacy);
  cloud.tables.get(table.name).indexes = [];
  const again = await planResources(api, spec, now);
  assert.deepEqual(again.operations, []);
});

test("stale cleanup plans are rejected before any cloud request", async () => {
  const { spec } = await fixture();
  for (const stale of [
    { ...spec, triggers: [{ FunctionName: "cleanup-old" }] },
    {
      ...spec,
      functions: [
        { name: "cleanup-old", payload: { FunctionName: "cleanup-old" } },
      ],
    },
  ]) {
    await assert.rejects(
      planResources(() => assert.fail("unexpected API request"), stale, now),
      /PLAN_CHANGED_REVIEW_REQUIRED/,
    );
  }
});

test("a verified previous telemetry package can be reused only with the original configuration", async () => {
  const { spec } = await fixture();
  const cloud = fakeCloud(spec);
  const telemetry = spec.functions.find((fn) =>
    fn.name.startsWith("telemetry-"),
  );
  const marker = "personal-onboarding:" + "a".repeat(40);
  const deployed = {
    ...clone(telemetry.payload),
    Namespace: spec.envId,
    Status: "Active",
    Description: marker,
  };
  cloud.functions.set(telemetry.name, deployed);
  const known = (fn, description) =>
    fn.name === telemetry.name && description === marker;
  await assert.rejects(
    planResources(cloud.api, spec, now),
    /FUNCTION_CONFLICT/,
  );
  const plan = await planResources(cloud.api, spec, now, known);
  assert.ok(plan.summary.preserved.some((r) => r.target === telemetry.name));
  deployed.Timeout = 5;
  await assert.rejects(
    planResources(cloud.api, spec, now, known),
    /FUNCTION_CONFLICT/,
  );
});

test("new write APIs require exact approved payloads and reject scope changes", async () => {
  const { data, spec } = await fixture(),
    cloud = fakeCloud(spec);
  const plan = await planResources(cloud.api, spec, now);
  for (const kind of ["indexes", "function"]) {
    const op = plan.operations.find((o) => o.kind === kind);
    let calls = 0;
    const transport = async () => {
      calls++;
      return Response.json({ Response: {} });
    };
    const reader = createPersonalApi(data, [], transport);
    await assert.rejects(
      reader(op.service, op.action, op.payload),
      /API_ACTION_NOT_AUTHORIZED/,
    );
    const writer = createPersonalApi(data, [op], transport);
    const changed = clone(op.payload);
    if (kind === "indexes") changed.DropIndexes = [{ IndexName: "unrelated" }];
    else changed.FunctionName = "unrelated";
    await assert.rejects(
      writer(op.service, op.action, changed),
      /API_ACTION_NOT_AUTHORIZED/,
    );
    assert.equal(calls, 0);
    await writer(op.service, op.action, op.payload);
    assert.equal(calls, 1);
  }
});

test("preview includes reviewable configuration while failures expose only fixed API context", async () => {
  const { data, spec, secrets } = await fixture(),
    cloud = fakeCloud(spec);
  const plan = await planResources(cloud.api, spec, now);
  assert.equal(plan.summary.resource_details.collections[0].acl, "ADMINONLY");
  assert.equal(
    plan.summary.resource_details.functions[0].runtime,
    "Nodejs20.19",
  );
  const preview = JSON.stringify(plan.summary);
  for (const secret of [
    data.credentials.SecretId,
    data.credentials.SecretKey,
    ...Object.values(secrets.dashboard),
  ]) {
    assert.ok(!preview.includes(secret));
  }
  const api = createPersonalApi(
    data,
    [],
    async () =>
      new Response(
        JSON.stringify({
          Response: {
            Error: {
              Code: "UnauthorizedOperation",
              Message: "never-echo-secret-material",
            },
          },
        }),
      ),
  );
  await assert.rejects(
    api("tcb", "DescribeEnvs", { EnvId: spec.envId }),
    (e) => {
      const failure = safeFailure(e);
      assert.equal(failure.code, "CLOUD_PERMISSION_DENIED");
      assert.equal(failure.api_action, "DescribeEnvs");
      assert.ok(!JSON.stringify(failure).includes("never-echo"));
      return true;
    },
  );
});

test("function creation tolerates bounded eventual visibility", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const plan = await planResources(cloud.api, spec, now);
  const pending = new Set();
  let delayed = 0;
  const api = async (s, a, p) => {
    if (a === "CreateFunction") pending.add(p.FunctionName);
    if (a === "GetFunction" && pending.delete(p.FunctionName)) {
      delayed++;
      throw new Error("Tencent Cloud API error: ResourceNotFound.FunctionName");
    }
    return cloud.api(s, a, p);
  };
  await applyResources(api, spec, plan.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.equal(delayed, 3);
});

test("route appearing during execution is never overwritten", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const plan = await planResources(cloud.api, spec, now);
  let inserted = false;
  await assert.rejects(
    applyResources(cloud.api, spec, plan.digest, {
      now: () => now,
      sleep: async () => {},
      onProgress: (e) => {
        if (
          !inserted &&
          e.kind === "function" &&
          e.status === "readback-passed"
        ) {
          cloud.routes.push({
            ...spec.routes[0],
            UpstreamResourceName: "another-owner",
          });
          inserted = true;
        }
      },
    }),
    /ROUTE_CHANGED_REPLAN_REQUIRED/,
  );
  assert.ok(!cloud.writes.some((w) => w.action === "CreateHTTPServiceRoute"));
  assert.equal(cloud.routes[0].UpstreamResourceName, "another-owner");
});

test("source or target drift invalidates approved plan", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const p = await planResources(cloud.api, spec, now);
  spec.functions[0].payload.Code.ZipFile =
    Buffer.from("different").toString("base64");
  await assert.rejects(
    applyResources(cloud.api, spec, p.digest, { now: () => now }),
    /PLAN_CHANGED/,
  );
  assert.equal(cloud.writes.length, 0);
});

test("conflicting function, ACL, index and route all fail closed", async () => {
  for (const kind of ["function", "acl", "index", "route"]) {
    const { spec } = await fixture(),
      cloud = fakeCloud(spec);
    if (kind === "function")
      cloud.functions.set(spec.functions[0].name, {
        FunctionName: spec.functions[0].name,
        Status: "Active",
      });
    if (kind === "acl")
      cloud.tables.set(spec.collections[0].name, {
        acl: "READONLY",
        indexes: [],
      });
    if (kind === "index") {
      const target = spec.collections.find((c) => c.indexes.length > 0);
      cloud.tables.set(target.name, {
        acl: "ADMINONLY",
        indexes: [
          {
            name: target.indexes[0].name,
            key: { different: 1 },
            expireAfterSeconds: 0,
          },
        ],
      });
    }
    if (kind === "route")
      cloud.routes.push({ ...spec.routes[0], UpstreamResourceName: "other" });
    await assert.rejects(planResources(cloud.api, spec, now), /CONFLICT/);
    assert.equal(cloud.writes.length, 0);
  }
});

test("unsupported index creation stops writes and preserves cloud correlation in the private receipt", async (t) => {
  const { data, spec, secrets } = await fixture();
  const cloud = fakeCloud(spec);
  const file = await privateFixture(t, data);
  await writePrivate(join(dirname(file), "service-credentials.json"), secrets);
  const plan = await planResources(cloud.api, spec, now);
  const requestId = "3bab891c-99c4-4794-a558-c0d261cfe5b3";
  const output = [];
  let attempts = 0;
  const apiFactory = (_input, writes = []) => {
    const rejectedApi = createPersonalApi(data, writes, async () =>
      Response.json({
        Response: {
          Error: {
            Code: "UnsupportedOperation",
            Message: data.credentials.SecretKey,
          },
          RequestId: requestId,
        },
      }),
    );
    return async (service, action, payload) => {
      if (action === "UpdateTable") {
        attempts++;
        return rejectedApi(service, action, payload);
      }
      return cloud.api(service, action, payload);
    };
  };
  await assert.rejects(
    run(["apply", "--file", file, "--expected-plan", plan.digest], {
      apiFactory,
      now: () => now,
      print: (line) => output.push(JSON.parse(line)),
    }),
    /UnsupportedOperation/,
  );
  assert.equal(attempts, 1);
  assert.equal(cloud.tables.size, 2);
  assert.equal(cloud.functions.size, 0);
  assert.equal(cloud.routes.length, 0);
  const receipt = await readPrivate(output.at(-1).receipt);
  assert.equal(receipt.failure.code, "CLOUD_OPERATION_UNSUPPORTED");
  assert.equal(receipt.failure.api_error_code, "UnsupportedOperation");
  assert.equal(receipt.failure.api_request_id, requestId);
  assert.equal(receipt.failure.api_action, "UpdateTable");
  assert.ok(!JSON.stringify(receipt).includes(data.credentials.SecretKey));
  assert.ok(!JSON.stringify(output).includes(data.credentials.SecretKey));
});

test("partial failure keeps created resources and can resume after a new plan", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const p = await planResources(cloud.api, spec, now);
  cloud.failOnce("CreateFunction");
  await assert.rejects(
    applyResources(cloud.api, spec, p.digest, { now: () => now }),
    /simulated failure/,
  );
  assert.equal(cloud.tables.size, 4);
  const next = await planResources(cloud.api, spec, now);
  assert.ok(
    next.operations.every(
      (op) => op.kind !== "collection" && op.kind !== "indexes",
    ),
  );
  await applyResources(cloud.api, spec, next.digest, {
    now: () => now,
    sleep: async () => {},
  });
});

test("unselected existing services and unrelated cloud resources are never rewritten", async () => {
  const data = input();
  data.resources.update = "created";
  data.resources.dashboard = "created";
  const v = validateInput(data, now),
    spec = await buildSpec(v, createServiceSecrets(v));
  assert.equal(spec.functions.length, 1);
  assert.equal(spec.collections.length, 1);
  assert.equal(spec.routes.length, 1);
  const cloud = fakeCloud(spec);
  cloud.functions.set("unrelated", {
    FunctionName: "unrelated",
    Status: "Active",
  });
  const p = await planResources(cloud.api, spec, now);
  await applyResources(cloud.api, spec, p.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.deepEqual(cloud.functions.get("unrelated"), {
    FunctionName: "unrelated",
    Status: "Active",
  });
});

test("incomplete inventory and failed database command cannot certify success", async () => {
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  await assert.rejects(
    planResources(
      async (s, a, p) =>
        a === "ListFunctions"
          ? { TotalCount: 2, Functions: [] }
          : cloud.api(s, a, p),
      spec,
      now,
    ),
    /INCOMPLETE_FUNCTION_INVENTORY/,
  );
  const p = await planResources(cloud.api, spec, now);
  await assert.rejects(
    applyResources(
      async (s, a, x) => {
        if (a === "UpdateTable") return {}; // Acknowledgement without the index must fail readback.
        return cloud.api(s, a, x);
      },
      spec,
      p.digest,
      { now: () => now, sleep: async () => {} },
    ),
    /READBACK_TIMEOUT_REVIEW_REQUIRED/,
  );
});

test("unknown, unsupported or expired credential inputs stop without echoing data", () => {
  for (const change of [
    (d) => (d.resources.update = "unknown"),
    (d) => (d.credentials.Token = "temporary"),
    (d) => (d.cloudbase.database_type = "mysql"),
    (d) => (d.cloudbase.http_origin = "https://attacker.invalid"),
    (d) => (d.existing_resource_overrides = [{ function_name: "foreign" }]),
    (d) => (d.credentials.mode = "existing-session"),
  ]) {
    const data = input();
    change(data);
    assert.throws(() => validateInput(data, now));
  }
  const data = input();
  data.resources = {
    telemetry: "created",
    update: "created",
    dashboard: "created",
  };
  data.credentials = {};
  assert.deepEqual(validateInput(data, now), { skipped: true });
  assert.equal(
    JSON.stringify(safeFailure(new Error("secret-id raw secret"))).includes(
      "secret-id",
    ),
    false,
  );
});

test("API transport refuses writes without exact approved payload and refuses wrong environment", async () => {
  const { data, spec } = await fixture(),
    cloud = fakeCloud(spec);
  const p = await planResources(cloud.api, spec, now);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(JSON.stringify({ Response: { RequestId: "fake" } }));
  };
  const readonly = createPersonalApi(data, [], fetcher);
  const op = p.operations[0];
  await assert.rejects(
    readonly(op.service, op.action, op.payload),
    /NOT_AUTHORIZED/,
  );
  const writable = createPersonalApi(data, p.operations, fetcher);
  await assert.rejects(
    writable("tcb", "DeleteTable", { EnvId: spec.envId, TableName: "x" }),
    /NOT_AUTHORIZED/,
  );
  await assert.rejects(
    writable(op.service, op.action, { ...op.payload, TableName: "different" }),
    /NOT_AUTHORIZED/,
  );
  await assert.rejects(
    readonly("tcb", "DescribeEnvs", { EnvId: "wrong" }),
    /TARGET_MISMATCH/,
  );
  assert.equal(calls, 0);
  await writable(op.service, op.action, op.payload);
  assert.equal(calls, 1);
});

test("private intake cannot be overwritten or read from a repository and CLI never echoes secrets", async (t) => {
  const template = JSON.parse(
    await readFile(
      join(
        ROOT,
        "skills/bifang-public-services-onboarding/assets/resource-input.template.json",
      ),
      "utf8",
    ),
  );
  const file = await createIntake(template);
  t.after(async () => {
    const dir = resolve(dirname(file));
    assert.ok(dir.startsWith(privateRoot() + sep));
    await rm(dir, { recursive: true, force: true });
  });
  await assert.rejects(writePrivate(file, { overwrite: true }));
  await assert.rejects(
    readPrivate(join(ROOT, "package.json")),
    /PRIVATE_INTAKE_PATH_REQUIRED/,
  );
  await writeFile(file, JSON.stringify(input()), "utf8");
  const output = [];
  await run(["validate", "--file", file], { print: (s) => output.push(s) });
  assert.equal(output.length, 1);
  assert.equal(output.join("").includes("fake-cam"), false);
  await writeFile(file, '{"SecretKey":"test-secret", broken}', "utf8");
  await assert.rejects(
    readPrivate(file),
    (e) =>
      e.message === "INVALID_PRIVATE_JSON" &&
      !e.message.includes("test-secret"),
  );
});

async function privateFixture(t, data = input()) {
  const file = await createIntake(data);
  t.after(async () => {
    const dir = resolve(dirname(file));
    assert.ok(dir.startsWith(privateRoot() + sep));
    await rm(dir, { recursive: true, force: true });
  });
  return file;
}

test("gate-one access checks credentials and free environment without application or resource inputs", async (t) => {
  const data = input();
  data.resources = {
    telemetry: "unknown",
    update: "unknown",
    dashboard: "unknown",
  };
  data.applications = [];
  const target = validateAccessInput(data, now);
  const cloud = fakeCloud(target),
    calls = [],
    output = [];
  const file = await privateFixture(t, data);
  await run(["access", "--file", file], {
    print: (s) => output.push(JSON.parse(s)),
    now: () => now,
    apiFactory:
      () =>
      async (...args) => {
        calls.push(args[1]);
        return cloud.api(...args);
      },
  });
  assert.deepEqual(
    new Set(calls),
    new Set([
      "DescribeEnvs",
      "DescribeBillingInfo",
      "DescribeEnvAccountCircle",
      "DescribeBaasPackageList",
      "DescribeCreditsUsage",
      "ExecutePGSql",
    ]),
  );
  assert.equal(cloud.writes.length, 0);
  assert.equal(output[0].status, "access-verified");
  assert.equal(output[0].resource_permissions_verified, false);
  assert.equal(
    (await readPrivate(output[0].receipt)).status,
    "access-verified",
  );
  assert.ok(!JSON.stringify(output).includes("fake-cam"));
});

test("gate-one missing or expired credentials never reach transport and paid environments cannot pass", async (t) => {
  const data = input(),
    file = await privateFixture(t, data);
  let calls = 0;
  const dependencies = {
    print: () => assert.fail("must not print success"),
    apiFactory: () => {
      calls++;
      throw new Error("unexpected transport");
    },
    now: () => now,
  };
  data.credentials.SecretKey = "";
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(
    run(["access", "--file", file], dependencies),
    /MISSING_DEPLOYMENT_CREDENTIALS/,
  );
  data.credentials = {
    ...input().credentials,
    Token: "fake-token",
    expires_at: "2026-11-17T00:00:00Z",
  };
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(
    run(["access", "--file", file], dependencies),
    /TEMPORARY_CREDENTIAL_EXPIRED/,
  );
  assert.equal(calls, 0);
  await writeFile(file, JSON.stringify(input()));
  const cloud = fakeCloud({
    envId: input().cloudbase.env_id,
    region: input().cloudbase.region,
  });
  cloud.setPaid();
  await assert.rejects(
    run(["access", "--file", file], {
      ...dependencies,
      apiFactory: () => cloud.api,
    }),
    /FREE_BILLING_GATE_FAILED/,
  );
  assert.equal(cloud.writes.length, 0);
});

test("manual preparation produces private deployable ZIPs and exact settings without any cloud request", async (t) => {
  const data = input(),
    file = await privateFixture(t, data),
    output = [];
  await run(["prepare", "--file", file], {
    print: (s) => output.push(JSON.parse(s)),
    apiFactory: () => assert.fail("manual prepare must remain offline"),
  });
  const result = output[0];
  assert.equal(result.cloud_requests, 0);
  assert.equal(result.function_zip_files.length, 3);
  const material = await readPrivate(result.materials_file);
  const secrets = await readPrivate(result.service_credentials_file);
  const spec = await buildSpec(validateInput(data, now), secrets);
  assert.equal(material.collections.length, 4);
  assert.deepEqual(material.console_guides, result.console_guides);
  for (const item of [
    "Document 编辑器",
    "索引管理",
    "ZIP",
    "环境变量",
    "路由管理",
  ]) {
    assert.ok(
      result.console_guides.some((guide) => guide.where.includes(item)),
      item,
    );
  }
  assert.equal(material.routes.length, 4);
  assert.ok(!("triggers" in material));
  assert.ok(!JSON.stringify(material.console_guides).includes("定时触发器"));
  for (const fn of material.functions) {
    const planned = spec.functions.find(
      (f) => f.name === fn.settings.FunctionName,
    );
    const { Code, ...settings } = planned.payload;
    assert.deepEqual(fn.settings, settings);
    assert.deepEqual(
      await readFile(fn.zip_file),
      Buffer.from(Code.ZipFile, "base64"),
    );
  }
  for (const raw of [
    data.credentials.SecretId,
    data.credentials.SecretKey,
    ...secrets.version_credentials.flatMap((c) => [c.app_key, c.app_secret]),
    ...Object.values(secrets.dashboard),
  ]) {
    assert.ok(!JSON.stringify(output).includes(raw));
    assert.ok(!JSON.stringify(material).includes(raw));
  }
});

test("manual completion is verified read-only and cannot hide missing or mismatched resources", async (t) => {
  const data = input(),
    file = await privateFixture(t, data),
    prepared = [];
  await run(["prepare", "--file", file], {
    print: (s) => prepared.push(JSON.parse(s)),
  });
  const spec = await buildSpec(
    validateInput(data, now),
    await readPrivate(prepared[0].service_credentials_file),
  );
  const cloud = fakeCloud(spec),
    output = [];
  const deps = {
    print: (s) => output.push(JSON.parse(s)),
    apiFactory: () => cloud.api,
    now: () => now,
  };
  await assert.rejects(
    run(["verify", "--file", file], deps),
    /FINAL_READBACK_INCOMPLETE/,
  );
  assert.equal(cloud.writes.length, 0);
  assert.equal(output.length, 0);
  const plan = await planResources(cloud.api, spec, now);
  await applyResources(cloud.api, spec, plan.digest, {
    now: () => now,
    sleep: async () => {},
  });
  const count = cloud.writes.length;
  await run(["verify", "--file", file], deps);
  assert.equal(output[0].status, "resources-control-plane-verified");
  assert.equal(output[0].live_http_gui_exe_tested, false);
  assert.equal(cloud.writes.length, count);
  cloud.routes[0].EnablePathTransmission = false;
  await assert.rejects(run(["verify", "--file", file], deps), /ROUTE_CONFLICT/);
  assert.equal(cloud.writes.length, count);
});

test("all-created customer declarations cannot pass the verification command", async (t) => {
  const data = input();
  data.resources = {
    telemetry: "created",
    update: "created",
    dashboard: "created",
  };
  const file = await privateFixture(t, data);
  await assert.rejects(
    run(["verify", "--file", file], {
      print: () =>
        assert.fail("declaration must not print verification success"),
      apiFactory: () =>
        assert.fail("existing foreign configuration needs its own evidence"),
    }),
    /EXISTING_RESOURCES_VERIFICATION_REQUIRED/,
  );
  await writeFile(file, JSON.stringify(input()));
  await assert.rejects(
    run(["verify", "--file", file], {
      print: () => assert.fail("must require original verification materials"),
      apiFactory: () =>
        assert.fail("must not probe with freshly generated credentials"),
    }),
    /VERIFICATION_MATERIALS_REQUIRED/,
  );
  await assert.rejects(
    readPrivate(join(dirname(file), "service-credentials.json")),
    (e) => e.code === "ENOENT",
  );
});

test("shipped CAM policies cover actual read/create calls without administrator, deletion or purchase actions", async () => {
  const folder = join(ROOT, "skills/bifang-public-services-onboarding/assets");
  const inspect = JSON.parse(
    await readFile(join(folder, "cam-inspect-policy.json"), "utf8"),
  );
  const create = JSON.parse(
    await readFile(join(folder, "cam-create-policy.json"), "utf8"),
  );
  const readActions = new Set(inspect.statement.flatMap((s) => s.action));
  const writeActions = new Set(create.statement.flatMap((s) => s.action));
  const { spec } = await fixture(),
    cloud = fakeCloud(spec);
  const recorded = [];
  cloud.setPlugin("missing");
  const api = async (...args) => {
    recorded.push(args[0] + ":" + args[1]);
    return cloud.api(...args);
  };
  const plan = await planResources(api, spec, now);
  for (const action of recorded) assert.ok(readActions.has(action), action);
  await applyResources(api, spec, plan.digest, {
    now: () => now,
    sleep: async () => {},
  });
  const shared = await sharedFixture();
  const extension = await planResources(shared.cloud.api, shared.spec, now);
  assert.deepEqual(extension.summary.required_additional_actions, []);
  assert.deepEqual(extension.summary.shared_actions_from_create_policy, [
    "scf:UpdateFunctionConfiguration",
  ]);
  for (const op of extension.operations) {
    const action = op.service + ":" + op.action;
    assert.ok(writeActions.has(action), action);
    recorded.push(action);
  }
  assert.ok(!readActions.has("scf:UpdateFunctionConfiguration"));
  assert.deepEqual(
    new Set(recorded),
    new Set([...readActions, ...writeActions]),
  );
  for (const policy of [inspect, create]) {
    assert.equal(policy.version, "2.0");
    for (const s of policy.statement) {
      assert.equal(s.effect, "allow");
      assert.deepEqual(s.resource, ["*"]);
      assert.ok(
        s.action.every((a) => !/\*|Delete|Destroy|Purchase|Deal|^cam:/.test(a)),
      );
    }
  }
});

async function sharedFixture() {
  const original = await fixture();
  const cloud = fakeCloud(original.spec);
  const initial = await planResources(cloud.api, original.spec, now);
  await applyResources(cloud.api, original.spec, initial.digest, {
    now: () => now,
    sleep: async () => {},
  });
  for (const fn of cloud.functions.values()) {
    fn.ModTime = "2026-11-18 00:00:00";
    fn.CodeSize = 1024;
    fn.Environment.Variables.push({
      Key: "KEEP_EXISTING_SETTING",
      Value: "fake-existing-value",
    });
  }
  cloud.writes.length = 0;
  const data = input();
  data.resources.update = "extend";
  data.resources.dashboard = "extend";
  data.applications = [
    {
      app_id: "new-app",
      display_name: "新增应用",
      release_streams: [
        {
          platform: "windows",
          architecture: "x64",
          channel: "stable",
          code: "new-windows-x64",
        },
        {
          platform: "macos",
          architecture: "arm64",
          channel: "stable",
          code: "new-macos-arm64",
        },
      ],
    },
  ];
  const v = validateInput(data, now),
    secrets = createServiceSecrets(v);
  const snapshot = await captureShared(cloud.api, v);
  const spec = await buildSpec(v, secrets, ROOT, snapshot);
  return { original, cloud, data, v, secrets, snapshot, spec };
}

test("shared extension preserves old credentials, scopes, settings, code and dashboard tokens end to end", async () => {
  const { original, cloud, secrets, spec, snapshot } = await sharedFixture();
  assert.deepEqual(secrets.dashboard, {});
  const plan = await planResources(cloud.api, spec, now);
  assert.equal(cloud.writes.length, 0);
  assert.equal(
    plan.operations.filter((o) => o.action === "UpdateFunctionConfiguration")
      .length,
    2,
  );
  assert.equal(
    plan.operations.filter((o) => o.action === "CreateFunction").length,
    1,
  );
  for (const fn of spec.shared) {
    assert.equal(
      variables(fn.after).KEEP_EXISTING_SETTING,
      "fake-existing-value",
    );
    assert.equal(fn.before.Description, fn.after.Description);
    assert.equal(fn.before.CodeSize, fn.after.CodeSize);
  }
  for (const key of ["DASHBOARD_TOKEN_SHA256", "DASHBOARD_ACCESS_TOKEN_SHA256"])
    assert.equal(
      variables(spec.shared[1].after)[key],
      variables(snapshot.functions[1])[key],
    );
  assert.deepEqual(
    JSON.parse(variables(spec.shared[1].after).DASHBOARD_APP_LABELS_JSON),
    {
      "personal-test": "个人测试",
      "new-app": "新增应用",
    },
  );
  assert.deepEqual(plan.summary.resource_details.expected_dashboard_labels, {
    "new-app": "新增应用",
  });
  assert.equal(spec.shared[1].summary.dashboard_label_source, "environment");
  const merged = parseCredentials(
    variables(spec.shared[0].after).APPLICATION_VERSION_CREDENTIALS_B64,
    ["personal-test", "new-app"],
  );
  for (const c of [
    ...original.secrets.version_credentials,
    ...secrets.version_credentials,
  ]) {
    const principal = authenticate(
      { "x-app-key": c.app_key, "x-app-secret": c.app_secret },
      merged,
    );
    assert.equal(principal.appId, c.app_id);
    assert.deepEqual([...principal.codes], c.codes);
    assert.throws(() =>
      authorize(
        principal,
        "versions:check",
        c.app_id === "personal-test"
          ? "new-windows-x64"
          : "personal-test-windows-x64",
      ),
    );
  }
  const oldTable = clone(cloud.tables.get("versions_personal_test"));
  await applyResources(cloud.api, spec, plan.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.deepEqual(cloud.tables.get("versions_personal_test"), oldTable);
  assert.equal(
    (await planResources(cloud.api, spec, now)).operations.length,
    0,
  );
  assert.equal(
    cloud.writes.filter((o) => o.action === "UpdateFunctionConfiguration")
      .length,
    2,
  );
  assert.ok(
    cloud.writes.every(
      (o) => !["UpdateFunctionCode", "DeleteFunction"].includes(o.action),
    ),
  );
});

test("legacy shared dashboards expose the outstanding label check and malformed configured catalogs stop planning", async () => {
  const { cloud, v, secrets } = await sharedFixture();
  const dashboard = cloud.functions.get("operations-dashboard-api");
  const entry = dashboard.Environment.Variables.find(
    ({ Key }) => Key === "DASHBOARD_APP_LABELS_JSON",
  );
  entry.Value = JSON.stringify({ "unknown-app": "其他应用" });
  await assert.rejects(
    buildSpec(v, secrets, ROOT, await captureShared(cloud.api, v)),
    /SHARED_DASHBOARD_LABELS_INVALID/,
  );
  dashboard.Description = "personal-onboarding:" + "a".repeat(40);
  await assert.rejects(
    buildSpec(v, secrets, ROOT, await captureShared(cloud.api, v)),
    /SHARED_CONTRACT_UNSUPPORTED/,
  );
  dashboard.Environment.Variables = dashboard.Environment.Variables.filter(
    (item) => item !== entry,
  );
  const spec = await buildSpec(
    v,
    secrets,
    ROOT,
    await captureShared(cloud.api, v),
  );
  const plan = await planResources(cloud.api, spec, now);
  const summary = plan.summary.resource_details.shared_functions[1];
  assert.equal(summary.dashboard_label_source, "legacy-package");
  assert.equal(
    summary.dashboard_label_status,
    "verify-deployed-catalog-or-plan-label-only-repair",
  );
  assert.deepEqual(summary.changed_variables, ["DASHBOARD_APPS_JSON"]);
  assert.deepEqual(summary.expected_dashboard_labels, {
    "new-app": "新增应用",
  });
  assert.equal(cloud.writes.length, 0);
});

test("shared extension rejects configuration drift before any write and immediately before update", async () => {
  for (const timing of ["before", "during"]) {
    const { cloud, spec } = await sharedFixture();
    const plan = await planResources(cloud.api, spec, now);
    const change = () => {
      cloud.functions
        .get("application-version-api")
        .Environment.Variables.push({
          Key: "NEW_OPERATOR_VALUE",
          Value: "preserve-me",
        });
    };
    if (timing === "before") change();
    let changed = false;
    const api = async (s, a, p) => {
      if (timing === "during" && a === "CreateFunction" && !changed) {
        change();
        changed = true;
      }
      return cloud.api(s, a, p);
    };
    await assert.rejects(
      applyResources(api, spec, plan.digest, {
        now: () => now,
        sleep: async () => {},
      }),
      /SHARED_FUNCTION_CHANGED_REPLAN_REQUIRED/,
    );
    assert.equal(
      cloud.writes.filter((o) => o.action === "UpdateFunctionConfiguration")
        .length,
      0,
    );
    if (timing === "before") assert.equal(cloud.writes.length, 0);
  }
});

test("shared extension rejects code modification time drift, app and code collisions, malformed secrets and size overflow", async () => {
  const { cloud, spec, snapshot, v, secrets } = await sharedFixture();
  cloud.functions.get("application-version-api").ModTime =
    "changed-code-same-size";
  await assert.rejects(
    planResources(cloud.api, spec, now),
    /SHARED_FUNCTION_CHANGED_REPLAN_REQUIRED/,
  );
  assert.equal(cloud.writes.length, 0);
  for (const [key, value, error] of [
    [
      "APPLICATION_VERSION_CREDENTIALS_B64",
      "malformed",
      /SHARED_CREDENTIALS_INVALID/,
    ],
    ["APPLICATION_VERSION_APPS_JSON", "[]", /SHARED_CONFIGURATION_INVALID/],
    [
      "UNRELATED_LARGE_VALUE",
      "x".repeat(3900),
      /FUNCTION_ENVIRONMENT_TOO_LARGE/,
    ],
  ]) {
    const changed = clone(snapshot);
    const vars = changed.functions[0].Environment.Variables;
    const entry = vars.find((e) => e.Key === key);
    if (entry) entry.Value = value;
    else vars.push({ Key: key, Value: value });
    await assert.rejects(buildSpec(v, secrets, ROOT, changed), error);
  }
  for (const collision of ["app", "code"]) {
    const data = clone(v.input);
    if (collision === "app") data.applications[0].app_id = "personal-test";
    else
      data.applications[0].release_streams[0].code =
        "personal-test-windows-x64";
    const cv = validateInput(data, now),
      cs = createServiceSecrets(cv),
      snap = await captureShared(cloud.api, cv);
    await assert.rejects(
      buildSpec(cv, cs, ROOT, snap),
      /SHARED_APPLICATION_CONFLICT/,
    );
  }
});

test("shared configuration write with uncertain outcome is not retried; remaining work can be replanned", async () => {
  const { cloud, spec } = await sharedFixture();
  const plan = await planResources(cloud.api, spec, now);
  let attempts = 0;
  const api = async (s, a, p) => {
    const result = await cloud.api(s, a, p);
    if (a === "UpdateFunctionConfiguration") {
      attempts++;
      throw new Error("simulated lost response");
    }
    return result;
  };
  await assert.rejects(
    applyResources(api, spec, plan.digest, {
      now: () => now,
      sleep: async () => {},
    }),
    /simulated lost response/,
  );
  assert.equal(attempts, 1);
  const remaining = await planResources(cloud.api, spec, now);
  assert.equal(
    remaining.operations.filter(
      (o) => o.action === "UpdateFunctionConfiguration",
    ).length,
    1,
  );
  await applyResources(cloud.api, spec, remaining.digest, {
    now: () => now,
    sleep: async () => {},
  });
  assert.equal(
    (await planResources(cloud.api, spec, now)).operations.length,
    0,
  );
});

test("shared updates require an exact authorized payload and the correct namespace", async () => {
  const { data, spec } = await sharedFixture();
  let calls = 0;
  const fetch = async () => {
    calls++;
    return {
      ok: true,
      text: async () => JSON.stringify({ Response: { RequestId: "fake" } }),
    };
  };
  const op = {
    service: "scf",
    action: "UpdateFunctionConfiguration",
    payload: spec.shared[0].payload,
  };
  const denied = createPersonalApi(data, [], fetch);
  await assert.rejects(
    denied(op.service, op.action, op.payload),
    /API_ACTION_NOT_AUTHORIZED/,
  );
  const allowed = createPersonalApi(data, [op], fetch);
  await assert.rejects(
    allowed(op.service, op.action, { ...op.payload, MemorySize: 512 }),
    /API_ACTION_NOT_AUTHORIZED/,
  );
  assert.equal(calls, 0);
  const wrong = {
    ...op,
    payload: { ...op.payload, Namespace: "different-env" },
  };
  await assert.rejects(
    createPersonalApi(data, [wrong], fetch)(
      wrong.service,
      wrong.action,
      wrong.payload,
    ),
    /API_TARGET_MISMATCH/,
  );
  assert.equal(calls, 0);
  await allowed(op.service, op.action, op.payload);
  assert.equal(calls, 1);
});

test("shared merge retains both old rotation secrets and accepts a zero control-plane code size", async () => {
  const { cloud, v, secrets, original } = await sharedFixture();
  const f = cloud.functions.get("application-version-api");
  f.CodeSize = 0;
  const variable = f.Environment.Variables.find(
    (e) => e.Key === "APPLICATION_VERSION_CREDENTIALS_B64",
  );
  const config = JSON.parse(
    Buffer.from(variable.Value, "base64").toString("utf8"),
  );
  const { createHash } = await import("node:crypto");
  const rotated = "fake-rotated-secret";
  config.credentials[0][4].push(
    createHash("sha256").update(rotated).digest("base64"),
  );
  variable.Value = Buffer.from(JSON.stringify(config)).toString("base64");
  const snapshot = await captureShared(cloud.api, v);
  const spec = await buildSpec(v, secrets, ROOT, snapshot);
  const credentials = parseCredentials(
    variables(spec.shared[0].after).APPLICATION_VERSION_CREDENTIALS_B64,
    ["personal-test", "new-app"],
  );
  const old = original.secrets.version_credentials[0];
  for (const secret of [old.app_secret, rotated]) {
    const p = authenticate(
      { "x-app-key": old.app_key, "x-app-secret": secret },
      credentials,
    );
    assert.equal(p.appId, old.app_id);
    assert.equal(p.secretHashes.length, 2);
  }
});

test("shared readback failure stops before the second shared update without rollback", async () => {
  const { cloud, spec } = await sharedFixture();
  const plan = await planResources(cloud.api, spec, now);
  const api = async (s, a, p) => {
    const result = await cloud.api(s, a, p);
    if (a === "UpdateFunctionConfiguration") {
      cloud.functions.get(p.FunctionName).Environment.Variables.push({
        Key: "UNEXPECTED_DRIFT",
        Value: "retained",
      });
    }
    return result;
  };
  await assert.rejects(
    applyResources(api, spec, plan.digest, {
      now: () => now,
      sleep: async () => {},
    }),
    /READBACK_TIMEOUT_REVIEW_REQUIRED/,
  );
  assert.equal(
    cloud.writes.filter((o) => o.action === "UpdateFunctionConfiguration")
      .length,
    1,
  );
  assert.ok(cloud.tables.has("telemetry_new_app"));
});
