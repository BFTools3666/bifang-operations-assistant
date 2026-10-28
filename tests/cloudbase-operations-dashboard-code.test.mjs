import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  createDashboardCodePlan,
  createSourceZip,
  deployDashboardCode,
  validateCloudState,
} from "../cloudbase/deploy-operations-dashboard-code.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const envId = "dashboard-code-test";
const region = "ap-shanghai";
const domain = `${envId}-123.${region}.app.tcloudbase.com`;
const functionName = "operations-dashboard-api";
const sourceRoot = "cloudbase/functions/operations-dashboard";

function cloudState() {
  const applications = [
    {
      appId: "bifang-tools",
      releaseStreams: [
        {
          platform: "windows",
          architecture: "x64",
          channel: "stable",
          code: "bifang-tools-windows-x64",
        },
      ],
    },
  ];
  const mapping = {
    schema_version: 2,
    apps: [
      [
        "bifang-tools",
        [["windows", "x64", "stable", "bifang-tools-windows-x64"]],
      ],
    ],
  };
  const routes = [
    ["/admin/v1/metrics", functionName, 2],
    ["/dashboard", functionName, 10],
    ["/tools/version-control/v1", "application-version-api", 10],
    ["/apps/bifang-tools/v1/track", "telemetry-bifang-tools", 10],
  ].map(([Path, UpstreamResourceName, LimitValue]) => ({
    Path,
    UpstreamResourceName,
    UpstreamResourceType: "SCF",
    Enable: true,
    EnableAuth: false,
    EnablePathTransmission: true,
    QPSPolicy: {
      QPSTotal: 100,
      QPSPerClient: { LimitBy: "ClientIP", LimitValue },
    },
    PathRewrite: {},
  }));
  return {
    envId,
    region,
    domain,
    applications,
    env: {
      EnvId: envId,
      Region: region,
      Status: "NORMAL",
      PackageId: "baas_trial",
    },
    fn: {
      FunctionName: functionName,
      FunctionId: "lam-test",
      Namespace: envId,
      Status: "Active",
      Type: "Event",
      Runtime: "Nodejs20.19",
      Handler: "index.main",
      Timeout: 3,
      MemorySize: 256,
      Environment: {
        Variables: Object.entries({
          CLOUDBASE_ENV_ID: envId,
          DASHBOARD_PATH: "/admin/v1/metrics",
          DASHBOARD_WEB_PATH: "/dashboard",
          DASHBOARD_TOKEN_SHA256: "a".repeat(64),
          DASHBOARD_ACCESS_TOKEN_SHA256: "b".repeat(64),
          DASHBOARD_APPS_JSON: JSON.stringify(JSON.stringify(mapping)),
        }).map(([Key, Value]) => ({ Key, Value })),
      },
    },
    billing: {
      EnvId: envId,
      PackageId: "baas_trial",
      Status: "NORMAL",
      PayMode: "PREPAYMENT",
      IsAutoRenew: false,
      EnableOverrun: false,
      ExtPackageCode: [],
      TipList: "",
      OrderInfo: { TranId: "", ReqBody: "", TranStatus: "" },
      ExpireTime: "2027-03-17 23:59:59",
    },
    route: {
      TotalCount: 1,
      Domains: [
        {
          Domain: domain,
          IsDefault: true,
          Enable: true,
          Status: "SUCCESS",
          DNSStatus: "OK",
          Routes: routes,
        },
      ],
    },
    functions: [
      functionName,
      "application-version-api",
      "telemetry-bifang-tools",
    ].map((FunctionName) => ({ FunctionName, Status: "Active" })),
    quota: 3000,
    usage: { DeductValue: 19.16, PackageDeductValue: 0, ReportValue: 0 },
  };
}

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "bifang-code-safety-test-"));
  try {
    const files = {
      [`${sourceRoot}/index.js`]: 'exports.main = () => "test";\n',
      [`${sourceRoot}/package.json`]: JSON.stringify({
        name: "test-dashboard",
        version: "1.0.0",
      }),
      [`${sourceRoot}/public/app.js`]: 'const label = "毕方小工具";\n',
      [`${sourceRoot}/src/app-labels.json`]: JSON.stringify({
        "bifang-tools": "毕方小工具",
      }),
      "cloudbase/apps.json": JSON.stringify({
        schema_version: 3,
        apps: [
          {
            app_id: "bifang-tools",
            release_streams: [
              {
                platform: "windows",
                architecture: "x64",
                channel: "stable",
                code: "bifang-tools-windows-x64",
              },
            ],
          },
        ],
      }),
      "cloudbase/deploy-operations-dashboard-code.mjs": "// fixture uploader\n",
      "cloudbase/tencent-cloud-api.mjs": "// fixture signer\n",
      "cloudbase/app-labels.mjs": "// fixture label validation\n",
      "cloudbase/generate-cloudbaserc.mjs": "// fixture config generator\n",
      "package.json": '{"name":"deployment-test-fixture"}\n',
      "package-lock.json": "{}\n",
    };
    for (const [name, body] of Object.entries(files)) {
      const path = resolve(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    }
    const state = cloudState();
    const calls = [];
    const oldZip = Buffer.from("previous verified package bytes");
    let baselineHash = hash(oldZip);
    const api = async (service, action, payload) => {
      calls.push({ service, action, payload: structuredClone(payload) });
      let response;
      switch (action) {
        case "DescribeEnvs":
          response = { EnvList: [state.env] };
          break;
        case "GetFunction":
          response = state.fn;
          break;
        case "DescribeBillingInfo":
          response = { EnvBillingInfoList: [state.billing] };
          break;
        case "DescribeHTTPServiceRoute":
          response = state.route;
          break;
        case "DescribeEnvAccountCircle":
          response = {
            StartTime: "2026-10-18 00:00:00",
            EndTime: "2026-11-17 23:59:59",
          };
          break;
        case "DescribeBaasPackageList":
          response = {
            PackageList: [
              {
                PackageName: "baas_trial",
                ResourceLimit: '{"Credits":{"MaxSize":"3000"}}',
              },
            ],
          };
          break;
        case "GetFunctionAddress":
          response = {
            Url: "https://rollback.cos.ap-shanghai.myqcloud.com/old.zip?signature=fixture",
            CodeSha256: baselineHash,
          };
          break;
        case "DescribeCreditsUsage":
          response = state.usage;
          break;
        case "ListFunctions":
          response = {
            TotalCount: state.functions.length,
            Functions: state.functions.slice(
              payload.Offset,
              payload.Offset + payload.Limit,
            ),
          };
          break;
        case "UpdateFunctionCode":
          baselineHash = hash(Buffer.from(payload.Code.ZipFile, "base64"));
          response = { RequestId: "fixture-update" };
          break;
        default:
          throw new Error(`unexpected fake API action: ${action}`);
      }
      return structuredClone(response);
    };
    const options = { envId, region, origin: `https://${domain}`, api, root };
    const deploymentOptions = {
      ...options,
      backupDirectory: join(root, "test-backups"),
      fetchImplementation: async () => new Response(oldZip),
      waitImplementation: async () => {},
    };
    await run({ root, state, calls, oldZip, options, deploymentOptions });
  } finally {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(
      target.split(/[\\/]/).at(-1).startsWith("bifang-code-safety-test-"),
    );
    await rm(target, { recursive: true, force: true });
  }
}

test("code-only ZIP uses standard CRC32 and rejects escaping entry names", () => {
  const zip = createSourceZip([
    { name: "index.js", body: Buffer.from("123456789") },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(14), 0xcbf43926);
  assert.equal(zip.subarray(30, 38).toString(), "index.js");
  assert.equal(zip.subarray(38, 47).toString(), "123456789");
  assert.equal(zip.readUInt32LE(47), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  for (const name of [
    "../secret",
    "/absolute.js",
    "src/../../secret.js",
    "C:\\secret.js",
  ]) {
    assert.throws(
      () => createSourceZip([{ name, body: Buffer.from("secret") }]),
      /unsafe ZIP entry/,
    );
  }
});

test("cloud-state safety gates reject paid operations, quota exhaustion and incomplete inventories", () => {
  const healthy = cloudState();
  const result = validateCloudState(healthy);
  assert.equal(result.routeCount, 4);
  assert.equal(result.functionCount, 3);
  assert.match(result.preservedStateSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("a".repeat(64)), false);
  const mutations = [
    [
      "auto-renew",
      (s) => {
        s.billing.IsAutoRenew = true;
      },
    ],
    [
      "overrun",
      (s) => {
        s.billing.EnableOverrun = true;
      },
    ],
    [
      "paid plan",
      (s) => {
        s.billing.PackageId = "baas_personal";
      },
    ],
    [
      "resource pack",
      (s) => {
        s.billing.ExtPackageCode = ["paid-pack"];
      },
    ],
    [
      "active order",
      (s) => {
        s.billing.OrderInfo.TranStatus = "pending";
      },
    ],
    [
      "upgrade prompt",
      (s) => {
        s.billing.TipList = "upgrade";
      },
    ],
    [
      "on-demand usage",
      (s) => {
        s.usage.ReportValue = 0.01;
      },
    ],
    [
      "resource-pack usage",
      (s) => {
        s.usage.PackageDeductValue = 1;
      },
    ],
    [
      "exhausted quota",
      (s) => {
        s.usage.DeductValue = s.quota;
      },
    ],
    [
      "unknown quota",
      (s) => {
        s.quota = NaN;
      },
    ],
    [
      "missing route",
      (s) => {
        s.route.Domains[0].Routes.pop();
      },
    ],
    [
      "route retarget",
      (s) => {
        s.route.Domains[0].Routes[0].UpstreamResourceName = "another-function";
      },
    ],
    [
      "route quota change",
      (s) => {
        s.route.Domains[0].Routes[0].QPSPolicy.QPSTotal = 200;
      },
    ],
    [
      "incomplete domains",
      (s) => {
        s.route.TotalCount = 2;
      },
    ],
    [
      "missing function",
      (s) => {
        s.functions.pop();
      },
    ],
    [
      "incomplete mapping",
      (s) => {
        s.fn.Environment.Variables.find(
          (v) => v.Key === "DASHBOARD_APPS_JSON",
        ).Value = '{"schema_version":2,"apps":[]}';
      },
    ],
    [
      "wrong namespace",
      (s) => {
        s.fn.Namespace = "other-environment";
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const state = structuredClone(healthy);
    mutate(state);
    assert.throws(() => validateCloudState(state), undefined, name);
  }
});

test("preview includes complete names without exposing authentication hashes and is strictly read-only", async () => {
  await withFixture(async ({ options, calls }) => {
    const plan = await createDashboardCodePlan(options);
    assert.equal(plan.application_count, 1);
    assert.equal(plan.release_stream_count, 1);
    assert.equal(plan.preserved_route_count, 4);
    assert.deepEqual(plan.desired_app_labels, { "bifang-tools": "毕方小工具" });
    assert.equal(plan.configuration_action, "preserve-all-existing-values");
    assert.deepEqual(plan.deletes, []);
    assert.match(plan.materials_sha256, /^[a-f0-9]{64}$/);
    assert.equal(
      calls.some((c) => c.action.startsWith("Update")),
      false,
    );
    assert.equal(JSON.stringify(plan).includes("a".repeat(64)), false);
    assert.equal(JSON.stringify(plan).includes("b".repeat(64)), false);
    assert.equal(JSON.stringify(plan).includes("signature=fixture"), false);
  });
});

test("preserved role and public-network changes invalidate the cloud-state digest", () => {
  const state = cloudState();
  state.fn.Role = "reviewed-function-role";
  state.fn.PublicNetConfig = { PublicNetStatus: "ENABLE" };
  const before = validateCloudState(state).preservedStateSha256;
  for (const mutate of [
    (s) => {
      s.fn.Role = "changed-function-role";
    },
    (s) => {
      s.fn.PublicNetConfig.PublicNetStatus = "DISABLE";
    },
  ]) {
    const changed = structuredClone(state);
    mutate(changed);
    assert.notEqual(validateCloudState(changed).preservedStateSha256, before);
  }
});

test("missing reviewed digest or missing Chinese name cannot reach a write", async () => {
  await withFixture(async ({ root, options, deploymentOptions, calls }) => {
    await assert.rejects(
      deployDashboardCode(deploymentOptions),
      /reviewed material digest/,
    );
    assert.equal(calls.length, 0);
    await writeFile(
      resolve(root, sourceRoot, "src/app-labels.json"),
      JSON.stringify({ "bifang-other": "其他工具" }),
    );
    await assert.rejects(
      createDashboardCodePlan(options),
      /missing display name/,
    );
    assert.equal(calls.length, 0);
  });
});

test("changed source bytes or preserved cloud configuration invalidate the reviewed preview", async () => {
  for (const kind of ["source", "cloud"]) {
    await withFixture(
      async ({ root, state, options, deploymentOptions, calls }) => {
        const plan = await createDashboardCodePlan(options);
        if (kind === "source")
          await appendFile(
            resolve(root, sourceRoot, "index.js"),
            "// changed after review\n",
          );
        else
          state.fn.Environment.Variables.find(
            (v) => v.Key === "DASHBOARD_TOKEN_SHA256",
          ).Value = "c".repeat(64);
        let downloads = 0;
        await assert.rejects(
          deployDashboardCode({
            ...deploymentOptions,
            expectedPlanSha256: plan.materials_sha256,
            fetchImplementation: async () => {
              downloads++;
              throw new Error("must not download");
            },
          }),
          /changed; refresh the preview/,
        );
        assert.equal(downloads, 0);
        assert.equal(
          calls.some((c) => c.action === "UpdateFunctionCode"),
          false,
        );
      },
    );
  }
});

test("unverified or failed rollback download prevents any code update", async () => {
  for (const kind of ["digest", "network"]) {
    await withFixture(async ({ options, deploymentOptions, calls }) => {
      const plan = await createDashboardCodePlan(options);
      await assert.rejects(
        deployDashboardCode({
          ...deploymentOptions,
          expectedPlanSha256: plan.materials_sha256,
          fetchImplementation: async () => {
            if (kind === "network")
              throw new Error("sensitive signed URL must be hidden");
            return new Response("tampered package");
          },
        }),
        /rollback ZIP|verified rollback ZIP/,
      );
      assert.equal(
        calls.some((c) => c.action === "UpdateFunctionCode"),
        false,
      );
    });
  }
});

test("cloud configuration drift while downloading backup prevents any code update", async () => {
  await withFixture(
    async ({ state, options, deploymentOptions, calls, oldZip }) => {
      const plan = await createDashboardCodePlan(options);
      let downloads = 0;
      await assert.rejects(
        deployDashboardCode({
          ...deploymentOptions,
          expectedPlanSha256: plan.materials_sha256,
          fetchImplementation: async () => {
            downloads++;
            state.fn.Role = "concurrently-changed-role";
            return new Response(oldZip);
          },
        }),
        /changed during backup; no write was made/,
      );
      assert.equal(downloads, 1);
      assert.equal(
        calls.some((c) => c.action === "UpdateFunctionCode"),
        false,
      );
    },
  );
});

test("successful deployment writes only the reviewed function code and preserves config and routes", async () => {
  await withFixture(async ({ options, deploymentOptions, calls, oldZip }) => {
    const plan = await createDashboardCodePlan(options);
    const result = await deployDashboardCode({
      ...deploymentOptions,
      expectedPlanSha256: plan.materials_sha256,
    });
    assert.equal(
      result.status,
      "code-updated-awaiting-functional-verification",
    );
    assert.equal(result.function, functionName);
    assert.deepEqual(await readFile(result.backup_file), oldZip);
    const writes = calls.filter(
      (c) =>
        !c.action.startsWith("Describe") &&
        !c.action.startsWith("Get") &&
        !c.action.startsWith("List"),
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].service, "scf");
    assert.equal(writes[0].action, "UpdateFunctionCode");
    const p = writes[0].payload;
    assert.deepEqual(
      Object.keys(p).sort(),
      [
        "Code",
        "FunctionName",
        "Handler",
        "InstallDependency",
        "Namespace",
        "Publish",
      ].sort(),
    );
    assert.equal(p.FunctionName, functionName);
    assert.equal(p.Namespace, envId);
    assert.equal(p.Handler, "index.main");
    assert.equal(p.InstallDependency, "TRUE");
    assert.equal(p.Publish, "FALSE");
    assert.equal(
      hash(Buffer.from(p.Code.ZipFile, "base64")),
      plan.source_zip_sha256,
    );
    assert.equal(
      result.plan.preserved_state_sha256,
      plan.preserved_state_sha256,
    );
  });
});
