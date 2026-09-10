import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readText = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

const readJson = async (relativePath) =>
  JSON.parse(await readText(relativePath));

const CONTRACT_ROOT = "contracts/application-version-api-v1";
const EXPECTED_SOURCE_SHA256 =
  "6721cd6fe03db65847b7d64d8bd65c102c67b0a3563ef8803475a3ce5ebda8c7";
const EXPECTED_OPERATIONS = new Map([
  ["/versions", ["get", "post"]],
  ["/versions/{id}", ["put"]],
  ["/versions/{code}/{version}", ["get"]],
  ["/app/{code}/ads", ["get", "post"]],
  ["/app/{code}/ads/{id}", ["delete", "put"]],
  ["/app/ads/{id}", ["get"]],
  ["/app/{code}/ads/show", ["get"]],
]);

test("the target contract is valid JSON with exactly the documented endpoint set", async () => {
  const [openapi, schema, fixtures] = await Promise.all([
    readJson(`${CONTRACT_ROOT}/openapi.json`),
    readJson(`${CONTRACT_ROOT}/schema.json`),
    readJson(`${CONTRACT_ROOT}/fixtures/runtime-decision-cases.json`),
  ]);

  assert.equal(openapi.openapi, "3.1.0");
  assert.equal(
    openapi.jsonSchemaDialect,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(fixtures.contract_version, openapi.info.version);
  assert.equal(
    openapi["x-bifang-target-state"],
    "implemented-local-not-deployed",
  );
  assert.equal(
    openapi["x-bifang-source-document"].sha256,
    EXPECTED_SOURCE_SHA256,
  );

  assert.deepEqual(
    [...Object.keys(openapi.paths)].sort(),
    [...EXPECTED_OPERATIONS.keys()].sort(),
  );
  for (const [path, methods] of EXPECTED_OPERATIONS) {
    assert.deepEqual(Object.keys(openapi.paths[path]).sort(), methods);
    for (const method of methods) {
      assert.equal(openapi.paths[path][method]["x-bifang-qps"], 10);
    }
  }

  assert.equal("delete" in openapi.paths["/versions"], false);
  assert.equal("/versions/{code}" in openapi.paths, false);
});

test("the canonical URL and exact two-header AND authentication stay frozen", async () => {
  const openapi = await readJson(`${CONTRACT_ROOT}/openapi.json`);

  assert.deepEqual(
    openapi.servers.map(({ url }) => url),
    ["https://{host}/tools/version-control/v1"],
  );
  assert.doesNotMatch(openapi.servers[0].url, /\/v1\/v1(?:\/|$)/);
  assert.deepEqual(openapi.security, [{ XAppKey: [], XAppSecret: [] }]);
  assert.deepEqual(
    {
      type: openapi.components.securitySchemes.XAppKey.type,
      in: openapi.components.securitySchemes.XAppKey.in,
      name: openapi.components.securitySchemes.XAppKey.name,
    },
    { type: "apiKey", in: "header", name: "x-app-key" },
  );
  assert.deepEqual(
    {
      type: openapi.components.securitySchemes.XAppSecret.type,
      in: openapi.components.securitySchemes.XAppSecret.in,
      name: openapi.components.securitySchemes.XAppSecret.name,
    },
    { type: "apiKey", in: "header", name: "x-app-secret" },
  );

  for (const scheme of Object.values(openapi.components.securitySchemes)) {
    assert.equal("value" in scheme, false);
    assert.equal("default" in scheme, false);
    assert.equal("example" in scheme, false);
  }
});

test("runtime operations use bare exact response shapes and management remains labelled provisional", async () => {
  const [openapi, schema] = await Promise.all([
    readJson(`${CONTRACT_ROOT}/openapi.json`),
    readJson(`${CONTRACT_ROOT}/schema.json`),
  ]);
  const versionOperation = openapi.paths["/versions/{code}/{version}"].get;
  const adsOperation = openapi.paths["/app/{code}/ads/show"].get;

  for (const operation of [versionOperation, adsOperation]) {
    assert.deepEqual(operation.tags, ["runtime"]);
    assert.equal(
      operation["x-bifang-contract-status"],
      "implemented-local-pending-original-client-e2e",
    );
  }
  assert.equal(
    versionOperation.responses["200"].content["application/json"].schema.$ref,
    "./schema.json#/$defs/VersionCheckResponse",
  );
  assert.equal(
    adsOperation.responses["200"].content["application/json"].schema.$ref,
    "./schema.json#/$defs/AdShowResponse",
  );

  const versionResponse = schema.$defs.VersionCheckResponse;
  assert.equal(versionResponse.type, "object");
  assert.equal(versionResponse.additionalProperties, false);
  assert.deepEqual([...versionResponse.required].sort(), [
    "downloadUrl",
    "forcedUpdate",
    "promptContent",
    "promptUpdate",
    "stopUpdate",
    "update",
    "updateContent",
  ]);
  assert.deepEqual(
    Object.keys(versionResponse.properties).sort(),
    [...versionResponse.required].sort(),
  );

  const adsResponse = schema.$defs.AdShowResponse;
  assert.equal(adsResponse.type, "array");
  assert.equal(adsResponse.items.$ref, "#/$defs/AdShowItem");
  assert.deepEqual([...schema.$defs.AdShowItem.required].sort(), [
    "content",
    "id",
    "image",
    "url",
  ]);
  assert.equal(schema.$defs.AdShowItem.additionalProperties, false);

  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    for (const operation of Object.values(pathItem)) {
      if (operation.tags.includes("management")) {
        assert.equal(
          operation["x-bifang-contract-status"],
          "implemented-local-provisional-management",
          path,
        );
      }
    }
  }
});

test("every OpenAPI and schema reference resolves inside the checked-in package", async () => {
  const [openapi, schema] = await Promise.all([
    readJson(`${CONTRACT_ROOT}/openapi.json`),
    readJson(`${CONTRACT_ROOT}/schema.json`),
  ]);

  for (const ref of collectRefs(openapi)) {
    if (ref.startsWith("./schema.json#/$defs/")) {
      const name = ref.slice("./schema.json#/$defs/".length);
      assert.ok(Object.hasOwn(schema.$defs, name), ref);
    } else if (ref.startsWith("#/components/")) {
      assert.ok(resolveJsonPointer(openapi, ref), ref);
    } else {
      assert.fail(`unexpected OpenAPI reference: ${ref}`);
    }
  }

  for (const ref of collectRefs(schema)) {
    assert.match(ref, /^#\/\$defs\/[A-Za-z][A-Za-z0-9]*$/);
    assert.ok(resolveJsonPointer(schema, ref), ref);
  }
});

test("version format, criteria pairing, and mutually exclusive write states are machine-frozen", async () => {
  const [schema, fixtures] = await Promise.all([
    readJson(`${CONTRACT_ROOT}/schema.json`),
    readJson(`${CONTRACT_ROOT}/fixtures/runtime-decision-cases.json`),
  ]);
  const versionPattern = new RegExp(schema.$defs.VersionNumber.pattern);
  const pathCodePattern = new RegExp(
    schema.$defs.ApplicationCodePath.pattern,
    "u",
  );
  const writeCodePattern = new RegExp(
    schema.$defs.ApplicationCodeWrite.pattern,
    "u",
  );
  for (const pattern of [pathCodePattern, writeCodePattern]) {
    assert.equal(pattern.test("example-tool"), true);
    assert.equal(pattern.test("."), false);
    assert.equal(pattern.test(".."), false);
    assert.equal(pattern.test("safe\\evil"), false);
  }

  for (const accepted of ["1", "1.2", "1.2.3.4", "01.002"]) {
    assert.match(accepted, versionPattern, accepted);
  }
  for (const rejected of ["", "v1.2.0", "1.2-beta", "1..2", ".1"]) {
    assert.doesNotMatch(rejected, versionPattern, rejected);
  }

  assert.deepEqual(schema.$defs.VersionWriteRequest.dependentRequired, {
    updateCriteria: ["versionCriteria"],
    versionCriteria: ["updateCriteria"],
  });
  const schemaFlagStates = schema.$defs.VersionWriteRequest.oneOf.map(
    ({ properties }) => ({
      forcedUpdate: properties.forcedUpdate.const,
      promptUpdate: properties.promptUpdate.const,
      stopUpdate: properties.stopUpdate.const,
    }),
  );
  assert.deepEqual(schemaFlagStates, fixtures.valid_flag_states);
  assert.ok(fixtures.valid_flag_states.every(isValidFlagState));
  assert.ok(
    fixtures.invalid_flag_states.every((flags) => !isValidFlagState(flags)),
  );
  for (const plainTextDefinition of [
    schema.$defs.Text50,
    schema.$defs.Text100,
    schema.$defs.AdTitle,
  ]) {
    const pattern = new RegExp(plainTextDefinition.pattern, "u");
    assert.equal(pattern.test("普通文本"), true);
    assert.equal(pattern.test("<img src=x onerror=run()>"), false);
  }
});

test("URL schemes and the provisional advertisement search grammar stay narrow", async () => {
  const [openapi, schema] = await Promise.all([
    readJson(`${CONTRACT_ROOT}/openapi.json`),
    readJson(`${CONTRACT_ROOT}/schema.json`),
  ]);
  const downloadPattern = new RegExp(schema.$defs.HttpsUrl500.pattern);
  assert.equal(
    downloadPattern.test("https://downloads.example.com/app.exe"),
    true,
  );
  assert.equal(
    downloadPattern.test("HTTPS://downloads.example.com/app.exe"),
    true,
  );
  assert.equal(
    downloadPattern.test("http://downloads.example.com/app.exe"),
    false,
  );
  assert.equal(downloadPattern.test("javascript:alert(1)"), false);
  assert.equal(
    downloadPattern.test("https://user:pass@downloads.example.com/app.exe"),
    false,
  );

  for (const name of ["AdUrl", "AdImage"]) {
    assert.deepEqual(schema.$defs[name].oneOf[0], { const: "" });
    const pattern = new RegExp(schema.$defs[name].oneOf[1].pattern);
    assert.equal(pattern.test("https://www.example.com/value"), true);
    assert.equal(pattern.test("http://www.example.com/value"), false);
  }
  assert.deepEqual(openapi.components.parameters.AdSearch.schema.enum, [
    "createdTime=sort=asc",
    "createdTime=sort=desc",
  ]);
});

test("numeric dotted comparison and update decisions match every frozen vector", async () => {
  const fixtures = await readJson(
    `${CONTRACT_ROOT}/fixtures/runtime-decision-cases.json`,
  );

  for (const { left, right, expected } of fixtures.version_comparison_cases) {
    assert.equal(
      compareDottedVersions(left, right),
      expected,
      `${left} vs ${right}`,
    );
    assert.equal(
      compareDottedVersions(right, left),
      expected === 0 ? 0 : -expected,
      `${right} vs ${left}`,
    );
  }

  for (const value of fixtures.criteria_cases) {
    assert.equal(
      criteriaMatches(
        value.current_version,
        value.operator,
        value.version_criteria,
      ),
      value.matches,
      JSON.stringify(value),
    );
  }

  for (const value of fixtures.decision_cases) {
    assert.deepEqual(decideRuntimeUpdate(value), value.expected, value.name);
  }
});

test("management writes keep source-compatible HTTP 200 with no invented body", async () => {
  const openapi = await readJson(`${CONTRACT_ROOT}/openapi.json`);
  const writeOperations = [
    openapi.paths["/versions"].post,
    openapi.paths["/versions/{id}"].put,
    openapi.paths["/app/{code}/ads"].post,
    openapi.paths["/app/{code}/ads/{id}"].put,
    openapi.paths["/app/{code}/ads/{id}"].delete,
  ];

  for (const operation of writeOperations) {
    assert.ok(operation.responses["200"]);
    assert.equal("content" in operation.responses["200"], false);
    assert.equal("201" in operation.responses, false);
    assert.equal("204" in operation.responses, false);
  }
});

test("the source error wrapper and target-only repository boundary remain explicit", async () => {
  const [schema, rootReadme, contractReadme, report, sdkPackage] =
    await Promise.all([
      readJson(`${CONTRACT_ROOT}/schema.json`),
      readText("README.md"),
      readText(`${CONTRACT_ROOT}/README.md`),
      readText("docs/application-version-api-zero-code-contract.md"),
      readJson("packages/telemetry-update-sdk/package.json"),
    ]);

  const error = schema.$defs.ErrorEnvelope;
  assert.equal(error.properties.model.const, "errors");
  assert.equal(error.properties.errors.properties.model.const, "data.set");
  assert.equal(
    error.properties.errors.properties.datas.items.$ref,
    "#/$defs/ErrorItem",
  );

  assert.match(rootReadme, /Application-version API v1/);
  assert.match(rootReadme, /contracts\/application-version-api-v1/);
  assert.match(contractReadme, /尚未部署或经两个毕方真实客户端验证/);
  assert.match(report, /旧静态更新协议、清单、fallback 和双轨设计全部删除/);
  assert.match(report, /两个实际客户端的测试域名 E2E 门禁/);
  assert.match(report, /鼠标精灵、录屏助手或第三方程序修改/);
  assert.equal(sdkPackage.version, "3.0.0");
});

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  if (value === null || typeof value !== "object") return refs;
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref") refs.push(item);
    else collectRefs(item, refs);
  }
  return refs;
}

function resolveJsonPointer(document, pointer) {
  return pointer
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], document);
}

function compareDottedVersions(left, right) {
  const pattern = /^[0-9]+(?:\.[0-9]+)*$/;
  if (!pattern.test(left) || !pattern.test(right)) {
    throw new TypeError("numeric dotted versions are required");
  }
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function criteriaMatches(currentVersion, operator, versionCriteria) {
  const comparison = compareDottedVersions(currentVersion, versionCriteria);
  switch (operator) {
    case "lt":
      return comparison < 0;
    case "le":
      return comparison <= 0;
    case "gt":
      return comparison > 0;
    case "ge":
      return comparison >= 0;
    default:
      throw new TypeError("unsupported update operator");
  }
}

function isValidFlagState(flags) {
  return (
    [flags.forcedUpdate, flags.promptUpdate, flags.stopUpdate].filter(Boolean)
      .length <= 1
  );
}

function decideRuntimeUpdate(value) {
  if (!isValidFlagState(value.flags)) {
    throw new TypeError("conflicting update flags");
  }
  const newer =
    compareDottedVersions(value.current_version, value.code_version) < 0;
  const eligible =
    value.criteria === null ||
    criteriaMatches(
      value.current_version,
      value.criteria.operator,
      value.criteria.version_criteria,
    );
  const update = newer && eligible && !value.flags.stopUpdate;
  return {
    update,
    forcedUpdate: update && value.flags.forcedUpdate,
    promptUpdate: update && value.flags.promptUpdate,
    stopUpdate: value.flags.stopUpdate,
  };
}
