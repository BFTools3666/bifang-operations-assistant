import { createSignedTencentCloudClient } from "../tencent-cloud-api.mjs";
import { check } from "./private-files.mjs";
import { hash, same } from "./spec.mjs";
import { inspectPostgreSQL, PGDOC_PROBE_SQL } from "./postgresql.mjs";
import { sharedMatches } from "./shared.mjs";
const READS = {
  tcb: new Set([
    "DescribeEnvs",
    "DescribeBillingInfo",
    "DescribeEnvAccountCircle",
    "DescribeBaasPackageList",
    "DescribeCreditsUsage",
    "DescribeHTTPServiceRoute",
    "DescribeTable",
    "DescribeDatabaseACL",
    "RunCommands",
    "ExecutePGSql",
  ]),
  scf: new Set(["ListFunctions", "GetFunction", "ListTriggers"]),
};
export function createPersonalApi(
  input,
  writes = [],
  fetchImplementation = fetch,
) {
  const allowed = new Set(
    writes.map((op) => JSON.stringify([op.service, op.action, op.payload])),
  );
  const c = input.credentials;
  const request = createSignedTencentCloudClient({
    credentials: {
      secretId: c.SecretId,
      secretKey: c.SecretKey,
      token: c.Token,
    },
    region: input.cloudbase.region,
    fetchImplementation,
    authorize(service, action, payload) {
      const mutation =
        (action === "ExecutePGSql" &&
          !same(payload, {
            EnvId: input.cloudbase.env_id,
            Sql: PGDOC_PROBE_SQL,
          })) ||
        (action === "RunCommands" &&
          !payload.MgoCommands?.every((cmd) => {
            try {
              const data = JSON.parse(cmd.Command);
              return (
                cmd.CommandType === "COMMAND" &&
                same(Object.keys(data), ["listIndexes", "cursor"]) &&
                data.listIndexes === cmd.TableName &&
                same(data.cursor, {})
              );
            } catch {
              return false;
            }
          }));
      const read = READS[service]?.has(action) && !mutation;
      check(
        read || allowed.has(JSON.stringify([service, action, payload])),
        "API_ACTION_NOT_AUTHORIZED",
      );
      if (action !== "DescribeBaasPackageList")
        check(
          (service === "scf" ? payload.Namespace : payload.EnvId) ===
            input.cloudbase.env_id,
          "API_TARGET_MISMATCH",
        );
    },
  });
  return async (service, action, payload) => {
    try {
      return await request(service, action, payload);
    } catch (error) {
      if (
        READS[service]?.has(action) ||
        writes.some((op) => op.service === service && op.action === action)
      ) {
        error.apiAction = action;
        error.apiService = service;
      }
      throw error;
    }
  };
}
const query = (spec, name) => ({ EnvId: spec.envId, TableName: name });
const command = (spec, name, body) => ({
  EnvId: spec.envId,
  MgoCommands: [
    { TableName: name, CommandType: "COMMAND", Command: JSON.stringify(body) },
  ],
});
function parseDatabaseJson(source) {
  return JSON.parse(source, (_key, value) => {
    if (value && typeof value === "object" && Object.keys(value).length === 1) {
      const number = value.$numberInt ?? value.$numberLong;
      if (number !== undefined) {
        check(
          typeof number === "string" && /^-?\d+$/.test(number),
          "INVALID_DATABASE_RESULT",
        );
        check(Number.isSafeInteger(Number(number)), "INVALID_DATABASE_RESULT");
        return Number(number);
      }
    }
    return value;
  });
}
function decodeCommand(response, { indexes = false } = {}) {
  check(
    Array.isArray(response.Data) && response.Data.length === 1,
    "INVALID_DATABASE_RESULT",
  );
  let data;
  try {
    data = parseDatabaseJson(response.Data[0]);
    if (Array.isArray(data)) {
      data = data.map((item) =>
        typeof item === "string" ? parseDatabaseJson(item) : item,
      );
      if (
        indexes &&
        data.every(
          (item) =>
            item &&
            typeof item.name === "string" &&
            item.name.length > 0 &&
            item.key &&
            typeof item.key === "object" &&
            !Array.isArray(item.key) &&
            Object.keys(item.key).length > 0,
        )
      ) {
        return { ok: 1, cursor: { id: 0, firstBatch: data } };
      }
      if (data.length === 1) data = data[0];
    }
  } catch {
    throw new Error("INVALID_DATABASE_RESULT");
  }
  check(data && data.ok === 1, "DATABASE_COMMAND_FAILED");
  return data;
}
async function table(api, spec, name) {
  let description;
  try {
    description = await api("tcb", "DescribeTable", query(spec, name));
  } catch (e) {
    if (
      e.message === "Tencent Cloud API error: ResourceNotFound.Table" ||
      e.message === "Tencent Cloud API error: ResourceNotFound"
    )
      return null;
    throw e;
  }
  const acl = await api("tcb", "DescribeDatabaseACL", {
    EnvId: spec.envId,
    CollectionName: name,
  });
  const result = decodeCommand(
    await api(
      "tcb",
      "RunCommands",
      command(spec, name, { listIndexes: name, cursor: {} }),
    ),
    { indexes: true },
  );
  const cursor = result.cursor;
  check(
    cursor &&
      (cursor.id === 0 || cursor.id?.$numberLong === "0") &&
      Array.isArray(cursor.firstBatch),
    "INCOMPLETE_INDEX_INVENTORY",
  );
  check(
    new Set(cursor.firstBatch.map((i) => i.name)).size ===
      cursor.firstBatch.length,
    "INVALID_INDEX_INVENTORY",
  );
  if (description.IndexNum !== undefined)
    check(
      Number.isInteger(description.IndexNum) &&
        description.IndexNum === cursor.firstBatch.length,
      "INCOMPLETE_INDEX_INVENTORY",
    );
  return { acl: acl.AclTag, indexes: cursor.firstBatch };
}
export async function costPreflight(api, spec, now = Date.now()) {
  const [envs, bills, circle, packages] = await Promise.all([
    api("tcb", "DescribeEnvs", { EnvId: spec.envId }),
    api("tcb", "DescribeBillingInfo", { EnvId: spec.envId }),
    api("tcb", "DescribeEnvAccountCircle", { EnvId: spec.envId }),
    api("tcb", "DescribeBaasPackageList", {
      PaymentChannel: "qcloud",
      PackageTypeList: ["default", "vip", "basic", "trial"],
    }),
  ]);
  const env = envs.EnvList?.filter((e) => e.EnvId === spec.envId);
  const bill = bills.EnvBillingInfoList?.filter((e) => e.EnvId === spec.envId);
  check(env?.length === 1 && bill?.length === 1, "AMBIGUOUS_ENVIRONMENT");
  const e = env[0],
    b = bill[0];
  check(
    e.Region === spec.region &&
      e.Status === "NORMAL" &&
      e.PackageId === "baas_trial",
    "FREE_ENVIRONMENT_REQUIRED",
  );
  check(
    b.PackageId === "baas_trial" &&
      b.Status === "NORMAL" &&
      b.PayMode === "PREPAYMENT" &&
      b.IsAutoRenew === false &&
      b.EnableOverrun === false &&
      Array.isArray(b.ExtPackageCode) &&
      b.ExtPackageCode.length === 0 &&
      !b.TipList &&
      Object.values(b.OrderInfo || {}).every((v) => !v),
    "FREE_BILLING_GATE_FAILED",
  );
  check(
    typeof b.ExpireTime === "string" && Date.parse(b.ExpireTime) > now,
    "ENVIRONMENT_EXPIRED",
  );
  const ps = packages.PackageList?.filter(
    (p) => p.PackageName === "baas_trial",
  );
  check(ps?.length === 1, "QUOTA_NOT_CONFIRMED");
  let quota, functionLimit;
  try {
    const limits = JSON.parse(ps[0].ResourceLimit);
    quota = Number(limits.Credits?.MaxSize);
    functionLimit = Number(limits.Scf?.FunctionNum?.MaxSize);
  } catch {
    throw new Error("QUOTA_NOT_CONFIRMED");
  }
  const start = circle.StartTime?.slice(0, 10),
    end = circle.EndTime?.slice(0, 10);
  check(
    /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end),
    "BILLING_CYCLE_NOT_CONFIRMED",
  );
  const usage = await api("tcb", "DescribeCreditsUsage", {
    EnvId: spec.envId,
    StartDate: start,
    EndDate: end,
  });
  check(
    Number.isFinite(quota) &&
      quota > 0 &&
      Number.isFinite(usage.DeductValue) &&
      usage.DeductValue >= 0 &&
      usage.DeductValue < quota &&
      usage.PackageDeductValue === 0 &&
      usage.ReportValue === 0,
    "FREE_QUOTA_GATE_FAILED",
  );
  return {
    database: await inspectPostgreSQL(api, e, spec),
    package: "baas_trial",
    quota,
    used: usage.DeductValue,
    expires: b.ExpireTime,
    function_limit:
      Number.isInteger(functionLimit) && functionLimit > 0
        ? functionLimit
        : null,
  };
}
async function domainState(api, spec) {
  const domains = [];
  let total;
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await api("tcb", "DescribeHTTPServiceRoute", {
      EnvId: spec.envId,
      Limit: 100,
      Offset: offset,
    });
    check(
      Array.isArray(page.Domains) &&
        Number.isInteger(page.TotalCount) &&
        page.TotalCount >= 0,
      "INVALID_DOMAIN_INVENTORY",
    );
    if (total !== undefined)
      check(total === page.TotalCount, "DOMAIN_INVENTORY_DRIFT");
    total = page.TotalCount;
    domains.push(...page.Domains);
    if (domains.length === total) break;
    check(
      domains.length < total && page.Domains.length === 100,
      "INCOMPLETE_DOMAIN_INVENTORY",
    );
  }
  check(
    domains.length === total &&
      new Set(domains.map((d) => d.Domain)).size === total,
    "INCOMPLETE_DOMAIN_INVENTORY",
  );
  // Storage and static hosting also have default domains in this API.
  const defaults = domains.filter(
    (d) => d.IsDefault === true && d.DomainType === "HTTPSERVICE",
  );
  check(defaults.length === 1, "DEFAULT_DOMAIN_NOT_READY");
  let d = defaults[0];
  check(
    d.Enable === true &&
      d.Status === "SUCCESS" &&
      d.DNSStatus === "OK" &&
      typeof d.Domain === "string" &&
      d.Domain.endsWith(".app.tcloudbase.com"),
    "DEFAULT_DOMAIN_NOT_READY",
  );
  if (spec.origin)
    check(new URL(spec.origin).hostname === d.Domain, "ORIGIN_TARGET_MISMATCH");
  // The live API omits Routes for an empty HTTP service. Confirm that result
  // with an exact-domain query before normalizing absence; malformed/null
  // values and inconsistent inventories must still fail closed.
  if (!Object.hasOwn(d, "Routes")) {
    const detail = await api("tcb", "DescribeHTTPServiceRoute", {
      EnvId: spec.envId,
      Filters: [{ Name: "Domain", Values: [d.Domain] }],
      Limit: 100,
      Offset: 0,
    });
    check(
      detail.TotalCount === 1 &&
        Array.isArray(detail.Domains) &&
        detail.Domains.length === 1,
      "INCOMPLETE_DOMAIN_INVENTORY",
    );
    const exact = detail.Domains[0];
    check(
      [
        "Domain",
        "DomainType",
        "IsDefault",
        "Enable",
        "Status",
        "DNSStatus",
      ].every((key) => exact[key] === d[key]) &&
        !Object.hasOwn(exact, "Routes"),
      "DOMAIN_INVENTORY_DRIFT",
    );
    d = { ...d, Routes: [] };
  }
  check(
    Array.isArray(d.Routes) &&
      d.Routes.every((r) => r && typeof r.Path === "string") &&
      new Set(d.Routes.map((r) => r.Path)).size === d.Routes.length,
    "INVALID_ROUTE_INVENTORY",
  );
  return d;
}
async function functionNames(api, spec) {
  const items = [];
  let total;
  for (let offset = 0; offset < 1000; offset += 20) {
    const p = await api("scf", "ListFunctions", {
      Namespace: spec.envId,
      Limit: 20,
      Offset: offset,
    });
    check(
      Array.isArray(p.Functions) &&
        Number.isInteger(p.TotalCount) &&
        p.TotalCount >= 0,
      "INVALID_FUNCTION_INVENTORY",
    );
    if (total !== undefined)
      check(total === p.TotalCount, "FUNCTION_INVENTORY_DRIFT");
    total = p.TotalCount;
    items.push(...p.Functions);
    if (items.length === total) break;
    check(
      items.length < total && p.Functions.length === 20,
      "INCOMPLETE_FUNCTION_INVENTORY",
    );
  }
  check(
    items.length === total &&
      new Set(items.map((f) => f.FunctionName)).size === total,
    "INCOMPLETE_FUNCTION_INVENTORY",
  );
  return new Set(items.map((f) => f.FunctionName));
}
export function matchesFunction(actual, expected) {
  if (!actual) return false;
  const p = expected.payload;
  const variables = (actual.Environment?.Variables || [])
    .map((v) => ({ Key: v.Key, Value: v.Value }))
    .sort((a, b) => a.Key.localeCompare(b.Key));
  return (
    actual.FunctionName === p.FunctionName &&
    actual.Namespace === p.EnvId &&
    actual.Status === "Active" &&
    [
      "Type",
      "Runtime",
      "Handler",
      "Timeout",
      "MemorySize",
      "Description",
    ].every((k) => actual[k] === p[k]) &&
    same(variables, p.Environment.Variables)
  );
}
function matchesIndex(a, b) {
  return (
    same(a.key, b.key) &&
    (a.unique ?? false) === false &&
    (a.sparse ?? false) === false &&
    a.partialFilterExpression === undefined &&
    a.expireAfterSeconds === b.expireAfterSeconds
  );
}
function matchesRoute(a, b) {
  return Object.entries(b).every(([k, v]) => a[k] === v);
}
async function triggerInventory(api, trigger) {
  const items = [];
  let total;
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await api("scf", "ListTriggers", {
      Namespace: trigger.Namespace,
      FunctionName: trigger.FunctionName,
      Limit: 100,
      Offset: offset,
    });
    check(
      Array.isArray(page.Triggers) &&
        Number.isInteger(page.TotalCount) &&
        page.TotalCount >= 0,
      "INVALID_TRIGGER_INVENTORY",
    );
    check(
      total === undefined || total === page.TotalCount,
      "TRIGGER_INVENTORY_DRIFT",
    );
    total = page.TotalCount;
    items.push(...page.Triggers);
    if (items.length === total) break;
    check(
      items.length < total && page.Triggers.length === 100,
      "INCOMPLETE_TRIGGER_INVENTORY",
    );
  }
  check(
    items.length === total &&
      items.every((t) => typeof t?.TriggerName === "string") &&
      new Set(items.map((t) => JSON.stringify([t.TriggerName, t.Qualifier])))
        .size === total,
    "INCOMPLETE_TRIGGER_INVENTORY",
  );
  return items;
}
function matchesTrigger(actual, expected) {
  let cron = actual.TriggerDesc;
  if (typeof cron !== "string") return false;
  try {
    if (cron.startsWith("{")) cron = JSON.parse(cron).cron;
  } catch {
    return false;
  }
  return (
    actual.TriggerName === expected.TriggerName &&
    actual.Type === "timer" &&
    actual.Qualifier === expected.Qualifier &&
    actual.Enable === 1 &&
    actual.AvailableStatus === "Available" &&
    cron === expected.TriggerDesc &&
    actual.CustomArgument === expected.CustomArgument
  );
}
export async function planResources(api, spec, now = Date.now()) {
  const cost = await costPreflight(api, spec, now);
  const domain = await domainState(api, spec);
  const names = await functionNames(api, spec);
  const newFunctions = spec.functions.filter((f) => !names.has(f.name)).length;
  check(
    Number.isInteger(cost.function_limit) &&
      names.size + newFunctions <= cost.function_limit,
    "FREE_FUNCTION_QUOTA_NOT_CONFIRMED",
  );
  const operations = [],
    preserved = [],
    state = [];
  const push = (kind, target, action, payload, service = "tcb") =>
    operations.push({ kind, target, service, action, payload });
  const needsPlugin = cost.database.plugin === "missing";
  if (needsPlugin)
    push("pgdoc", spec.envId, "EnablePGDocumentExt", { EnvId: spec.envId });
  else preserved.push({ kind: "pgdoc", target: spec.envId });
  for (const c of spec.collections) {
    const current = needsPlugin ? null : await table(api, spec, c.name);
    state.push([c.name, current]);
    if (current) check(current.acl === "ADMINONLY", "COLLECTION_ACL_CONFLICT");
    else
      push("collection", c.name, "CreateTable", {
        ...query(spec, c.name),
        PermissionInfo: { EnvId: spec.envId, AclTag: "ADMINONLY" },
      });
    const missing = [];
    for (const idx of c.indexes) {
      const found = current?.indexes.find((i) => i.name === idx.name);
      if (found) check(matchesIndex(found, idx), "INDEX_CONFLICT");
      else {
        // Do not replace or rename equivalent/different pre-existing indexes.
        const equivalent = current?.indexes.find((i) => matchesIndex(i, idx));
        if (!equivalent) missing.push(idx);
      }
    }
    if (missing.length)
      push("indexes", c.name, "UpdateTable", {
        ...query(spec, c.name),
        CreateIndexes: missing.map((i) => ({
          IndexName: i.name,
          MgoKeySchema: {
            MgoIndexKeys: Object.entries(i.key).map(([Name, direction]) => ({
              Name,
              Direction: String(direction),
            })),
            MgoIsUnique: false,
            MgoIsSparse: false,
          },
        })),
      });
    if (current && missing.length === 0)
      preserved.push({ kind: "collection", target: c.name });
  }
  for (const fn of spec.functions) {
    if (names.has(fn.name)) {
      const current = await api("scf", "GetFunction", {
        Namespace: spec.envId,
        FunctionName: fn.name,
        ShowCode: "FALSE",
      });
      check(matchesFunction(current, fn), "FUNCTION_CONFLICT");
      state.push([fn.name, hash(current.Environment), current.Description]);
      preserved.push({ kind: "function", target: fn.name });
    } else push("function", fn.name, "CreateFunction", fn.payload);
  }
  for (const fn of spec.shared || []) {
    check(names.has(fn.name), "SHARED_FUNCTION_CHANGED_REPLAN_REQUIRED");
    const current = await api("scf", "GetFunction", {
      Namespace: spec.envId,
      FunctionName: fn.name,
      ShowCode: "FALSE",
    });
    if (sharedMatches(current, fn.after)) {
      preserved.push({ kind: "shared-function", target: fn.name });
    } else {
      check(
        sharedMatches(current, fn.before, { beforeWrite: true }),
        "SHARED_FUNCTION_CHANGED_REPLAN_REQUIRED",
      );
      push(
        "function-configuration",
        fn.name,
        "UpdateFunctionConfiguration",
        fn.payload,
        "scf",
      );
    }
    state.push([
      "shared-function",
      fn.name,
      hash(current.Environment),
      current.Description,
    ]);
  }
  for (const r of spec.routes) {
    const current = domain.Routes.find((x) => x.Path === r.Path);
    if (current) {
      check(matchesRoute(current, r), "ROUTE_CONFLICT");
      preserved.push({ kind: "route", target: r.Path });
    } else
      push("route", r.Path, "CreateHTTPServiceRoute", {
        EnvId: spec.envId,
        Domain: { Domain: domain.Domain, Routes: [r] },
      });
  }
  // Timer activation is last: approval includes future scoped expiry deletion.
  for (const trigger of spec.triggers || []) {
    const existing = names.has(trigger.FunctionName)
      ? await triggerInventory(api, trigger)
      : [];
    state.push(["triggers", trigger.FunctionName, existing]);
    const found = existing.filter((t) => t.TriggerName === trigger.TriggerName);
    check(found.length <= 1, "TRIGGER_CONFLICT");
    const target = trigger.FunctionName + "/" + trigger.TriggerName;
    if (found.length) {
      check(matchesTrigger(found[0], trigger), "TRIGGER_CONFLICT");
      preserved.push({ kind: "trigger", target });
    } else push("trigger", target, "CreateTrigger", trigger, "scf");
  }
  const digest = hash({
    spec,
    database: cost.database,
    operations,
    state,
    routes: domain.Routes,
  });
  return {
    digest,
    operations,
    summary: {
      status: "planned",
      env_id: spec.envId,
      region: spec.region,
      origin: "https://" + domain.Domain,
      cost,
      function_capacity: {
        existing: names.size,
        to_create: newFunctions,
        after_creation: names.size + newFunctions,
        limit: cost.function_limit,
      },
      materials_sha256: digest,
      actions: operations.map(({ kind, target, service, action }) => ({
        kind,
        target,
        service,
        action,
      })),
      resource_details: {
        expected_dashboard_labels: spec.dashboardLabels,
        database: cost.database,
        collections: spec.collections.map((c) => ({ ...c, acl: "ADMINONLY" })),
        functions: spec.functions.map(({ name, payload: p }) => ({
          name,
          type: p.Type,
          runtime: p.Runtime,
          handler: p.Handler,
          memory_mb: p.MemorySize,
          timeout_seconds: p.Timeout,
          install_dependency: p.InstallDependency,
          role: p.Role,
          environment_variable_names: p.Environment.Variables.map((v) => v.Key),
          environment_values: "omitted; credentials locally derived",
        })),
        shared_functions: (spec.shared || []).map((f) => f.summary),
        routes: spec.routes,
        triggers: spec.triggers || [],
        retention: spec.retention,
      },
      preserved,
      skipped_customer_confirmed: spec.skipped,
      ...(spec.shared?.length
        ? {
            required_additional_actions: [],
            shared_actions_from_create_policy: [
              ...new Set(
                operations
                  .filter((op) => op.kind === "function-configuration")
                  .map((op) => op.service + ":" + op.action),
              ),
            ],
            shared_update_limitations: [
              "environment-update-is-not-atomic-with-read; avoid-concurrent-administration",
              "existing-code-and-dashboard-login-preserved; verify-expected-dashboard-labels",
              "control-plane-configuration-evidence-only; live-http-tests-pending",
            ],
          }
        : {}),
    },
  };
}
export async function applyResources(
  api,
  spec,
  expected,
  {
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    onProgress = () => {},
  } = {},
) {
  check(/^[a-f0-9]{64}$/.test(expected), "EXPECTED_PLAN_REQUIRED");
  const plan = await planResources(api, spec, now());
  check(plan.digest === expected, "PLAN_CHANGED_REVIEW_REQUIRED");
  const completed = [];
  for (const op of plan.operations) {
    // Recheck the financial boundary immediately before each mutation.
    const cost = await costPreflight(api, spec, now());
    check(
      cost.database.plugin === (op.kind === "pgdoc" ? "missing" : "ready"),
      "DATABASE_STATE_CHANGED_REPLAN_REQUIRED",
    );
    // The route API can affect an existing binding. Reject a route that appeared
    // since planning rather than overwrite an operator's concurrent change.
    if (op.kind === "route") {
      const current = await domainState(api, spec);
      check(
        current.Domain === op.payload.Domain.Domain &&
          !current.Routes.some((r) => r.Path === op.target),
        "ROUTE_CHANGED_REPLAN_REQUIRED",
      );
    }
    if (op.kind === "indexes") {
      // UpdateTable can replace a same-name index. Re-inventory immediately
      // before the mutation and reject concurrent additions instead.
      const current = await table(api, spec, op.target);
      check(current?.acl === "ADMINONLY", "COLLECTION_ACL_CONFLICT");
      check(
        op.payload.CreateIndexes.every(
          (i) => !current.indexes.some((x) => x.name === i.IndexName),
        ),
        "INDEX_CHANGED_REPLAN_REQUIRED",
      );
    }
    if (op.kind === "function") {
      const names = await functionNames(api, spec);
      check(!names.has(op.target), "FUNCTION_CHANGED_REPLAN_REQUIRED");
      check(
        Number.isInteger(cost.function_limit) &&
          names.size < cost.function_limit,
        "FREE_FUNCTION_QUOTA_NOT_CONFIRMED",
      );
    }
    if (op.kind === "function-configuration") {
      const fn = spec.shared.find((f) => f.name === op.target);
      const current = await api("scf", "GetFunction", {
        Namespace: spec.envId,
        FunctionName: op.target,
        ShowCode: "FALSE",
      });
      check(
        sharedMatches(current, fn.before, { beforeWrite: true }),
        "SHARED_FUNCTION_CHANGED_REPLAN_REQUIRED",
      );
    }
    if (op.kind === "trigger") {
      const current = await triggerInventory(api, op.payload);
      check(
        !current.some((t) => t.TriggerName === op.payload.TriggerName),
        "TRIGGER_CHANGED_REPLAN_REQUIRED",
      );
    }
    onProgress({ status: "creating", kind: op.kind, target: op.target });
    const response = await api(op.service, op.action, op.payload);
    if (op.kind === "pgdoc")
      check(response.Enabled === true, "PGDOC_ENABLE_NOT_CONFIRMED");
    if (op.action === "RunCommands") decodeCommand(response);
    let verified = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        if (op.kind === "pgdoc") {
          const envs = await api("tcb", "DescribeEnvs", { EnvId: spec.envId });
          const env = envs.EnvList?.filter((e) => e.EnvId === spec.envId);
          check(env?.length === 1, "AMBIGUOUS_ENVIRONMENT");
          verified =
            (await inspectPostgreSQL(api, env[0], spec)).plugin === "ready";
        } else if (op.kind === "trigger") {
          const current = await triggerInventory(api, op.payload);
          const found = current.filter(
            (t) => t.TriggerName === op.payload.TriggerName,
          );
          check(found.length <= 1, "TRIGGER_CONFLICT");
          verified = found.length === 1 && matchesTrigger(found[0], op.payload);
        } else if (op.kind === "function-configuration") {
          const fn = spec.shared.find((f) => f.name === op.target);
          const current = await api("scf", "GetFunction", {
            Namespace: spec.envId,
            FunctionName: op.target,
            ShowCode: "FALSE",
          });
          verified = sharedMatches(current, fn.after);
        } else if (op.kind === "function") {
          const fn = spec.functions.find((f) => f.name === op.target);
          const current = await api("scf", "GetFunction", {
            Namespace: spec.envId,
            FunctionName: op.target,
            ShowCode: "FALSE",
          });
          check(
            ![
              "CreateFailed",
              "UpdateFailed",
              "Deleting",
              "DeleteFailed",
            ].includes(current.Status),
            "FUNCTION_CREATION_FAILED",
          );
          verified = matchesFunction(current, fn);
        } else if (op.kind === "route") {
          const d = await domainState(api, spec);
          const r = d.Routes.find((r) => r.Path === op.target);
          verified = r && matchesRoute(r, op.payload.Domain.Routes[0]);
        } else {
          const current = await table(api, spec, op.target);
          if (current) {
            check(current.acl === "ADMINONLY", "COLLECTION_ACL_CONFLICT");
            verified =
              op.kind === "collection" ||
              spec.collections
                .find((c) => c.name === op.target)
                .indexes.every((idx) =>
                  current.indexes.some((i) => matchesIndex(i, idx)),
                );
          }
        }
      } catch (error) {
        const transient = [
          "Tencent Cloud API error: ResourceNotFound.FunctionName",
          "Tencent Cloud API error: ResourceNotFound.Function",
          "DEFAULT_DOMAIN_NOT_READY",
        ];
        if (!transient.includes(error.message)) throw error;
      }
      if (verified) break;
      await sleep(2000);
    }
    check(verified, "READBACK_TIMEOUT_REVIEW_REQUIRED");
    completed.push({ kind: op.kind, target: op.target });
    onProgress({ status: "readback-passed", kind: op.kind, target: op.target });
    if (op.kind === "pgdoc") {
      // The disabled document endpoint could not be inventoried before enabling.
      // Re-read it now; any unexpected resource or drift stops before more writes.
      const afterEnable = await planResources(api, spec, now());
      check(
        same(afterEnable.operations, plan.operations.slice(1)),
        "POST_ENABLE_PLAN_CHANGED_REVIEW_REQUIRED",
      );
    }
  }
  const final = await planResources(api, spec, now());
  check(final.operations.length === 0, "FINAL_READBACK_INCOMPLETE");
  return {
    status: "resources-created-control-plane-verified",
    completed,
    origin: final.summary.origin,
    expected_dashboard_labels: spec.dashboardLabels,
    shared_functions: final.summary.resource_details.shared_functions,
    skipped_customer_confirmed: spec.skipped,
    live_http_gui_exe_tested: false,
  };
}
