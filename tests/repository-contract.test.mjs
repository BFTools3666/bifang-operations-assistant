import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  decideUpdate,
  isValidSemVer,
  parseUpdateConfig,
} from "@bifang/telemetry-update-sdk";

const readJson = async (relativePath) =>
  JSON.parse(
    await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  );

const UPDATE_MANIFEST_KEYS = [
  "schema_version",
  "app_id",
  "platform",
  "enabled",
  "latest_version",
  "min_supported_version",
  "force_update",
  "rollout",
  "title",
  "message",
  "download_url",
  "release_notes_url",
  "sha256",
  "published_at",
].sort();

test("the checked-in update template matches the v1 schema contract", async () => {
  const schema = await readJson("cloudbase/updates/update.schema.json");
  const manifest = await readJson(
    "cloudbase/updates/bifang-tools/windows.json",
  );

  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), UPDATE_MANIFEST_KEYS);
  assert.deepEqual(Object.keys(schema.properties).sort(), UPDATE_MANIFEST_KEYS);
  assert.ok(
    Object.values(schema.properties).every(
      (property) =>
        typeof property.description === "string" &&
        /[\u3400-\u9fff]/u.test(property.description),
    ),
  );
  assert.deepEqual(Object.keys(manifest).sort(), UPDATE_MANIFEST_KEYS);
  const schemaSemVer = new RegExp(schema.$defs.semver.pattern);
  for (const version of ["0.1.0", "1.10.0", "1.0.0-beta.11+build.7"]) {
    assert.equal(schemaSemVer.test(version), isValidSemVer(version), version);
  }
  for (const version of ["01.0.0", "1.0", "1.0.0-01", "v1.0.0"]) {
    assert.equal(schemaSemVer.test(version), isValidSemVer(version), version);
  }
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.app_id, "bifang-tools");
  assert.equal(manifest.platform, "windows");
  assert.equal(manifest.latest_version, "0.1.0");
  assert.equal(manifest.min_supported_version, "0.1.0");
  assert.equal(manifest.enabled, false);
  assert.equal(manifest.force_update, false);
  assert.equal(manifest.rollout, 0);
  assert.equal(schema.properties.title.type, "string");
  assert.equal(schema.properties.title.minLength, 1);
  assert.equal(schema.properties.title.maxLength, 120);
  assert.equal(schema.properties.message.type, "string");
  assert.equal(schema.properties.message.minLength, 1);
  assert.equal(schema.properties.message.maxLength, 1_000);
  assert.equal(schema.properties.sha256.type, "string");
  assert.equal(schema.properties.published_at.type, "string");
  assert.equal(schema.properties.published_at.format, "date-time");
  assert.equal(schema.properties.published_at.maxLength, 35);
  assert.match(
    manifest.title,
    new RegExp(schema.properties.title.pattern, "u"),
  );
  assert.match(
    manifest.message,
    new RegExp(schema.properties.message.pattern, "u"),
  );
  assert.doesNotMatch(
    "safe\u202etxt.exe",
    new RegExp(schema.properties.title.pattern, "u"),
  );
  assert.doesNotMatch(
    "\u200b",
    new RegExp(schema.properties.message.pattern, "u"),
  );
  assert.match(manifest.sha256, new RegExp(schema.properties.sha256.pattern));
  assert.match(
    manifest.published_at,
    new RegExp(schema.properties.published_at.pattern),
  );
  assert.equal(schema.properties.download_url.maxLength, 2_048);
  assert.equal(schema.properties.release_notes_url.maxLength, 2_048);

  const parsed = parseUpdateConfig(manifest, "bifang-tools", "windows");
  assert.deepEqual(parsed, manifest);
  assert.deepEqual(
    decideUpdate("0.1.0", "33333333-3333-4333-8333-333333333333", parsed),
    { kind: "none", reason: "disabled" },
  );

  for (const key of ["download_url", "release_notes_url"]) {
    const url = new URL(manifest[key]);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname.endsWith(".example.invalid"), true);
  }
});

test("every registered platform has one strict manifest accepted by the SDK", async () => {
  const registry = await readJson("cloudbase/apps.json");
  const schema = await readJson("cloudbase/updates/update.schema.json");

  assert.equal(registry.schema_version, 2);
  for (const application of registry.apps) {
    assert.ok(application.platforms.length > 0);
    assert.equal(
      new Set(application.platforms).size,
      application.platforms.length,
    );
    for (const platform of application.platforms) {
      assert.equal(schema.properties.platform.enum.includes(platform), true);
      const manifest = await readJson(
        `cloudbase/updates/${application.app_id}/${platform}.json`,
      );
      assert.deepEqual(Object.keys(manifest).sort(), UPDATE_MANIFEST_KEYS);
      assert.equal(manifest.app_id, application.app_id);
      assert.equal(manifest.platform, platform);
      assert.deepEqual(
        parseUpdateConfig(manifest, application.app_id, platform),
        manifest,
      );
    }
  }
});

test("the curl example is the minimal daily-active ingestion envelope", async () => {
  const source = await readFile(
    new URL("../examples/telemetry-event.json", import.meta.url),
    "utf8",
  );
  const event = JSON.parse(source);

  assert.ok(Buffer.byteLength(source, "utf8") <= 4_096);
  assert.equal(event.schema_version, 2);
  assert.equal(event.sdk_version, "2.0.0");
  assert.equal(event.event, "daily_active");
  assert.deepEqual(Object.keys(event).sort(), [
    "app_id",
    "app_version",
    "arch",
    "event",
    "event_id",
    "install_id",
    "occurred_at",
    "platform",
    "schema_version",
    "sdk_version",
  ]);
  assert.equal("channel" in event, false);
  assert.equal("session_id" in event, false);
  assert.equal("properties" in event, false);
  assert.equal("source_ip" in event, false);
  assert.equal("active_date" in event, false);
  assert.equal("received_at" in event, false);

  const serialized = JSON.stringify(event).toLowerCase();
  for (const forbidden of [
    "password",
    "token",
    "cookie",
    "email",
    "phone",
    "clipboard",
    "file_content",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("the host example keeps update network and UI work out of startup", async () => {
  const source = await readFile(
    new URL("../examples/host-integration.ts", import.meta.url),
    "utf8",
  );
  const initializeStart = source.indexOf(
    "export async function initializePublicServices",
  );
  const backgroundWorkStart = source.indexOf("async function checkForUpdates");
  assert.ok(initializeStart >= 0);
  assert.ok(backgroundWorkStart > initializeStart);

  const initializeSource = source.slice(initializeStart, backgroundWorkStart);
  assert.match(source, /checkForUpdatesInBackground\(\): void/);
  assert.match(initializeSource, /checkForUpdatesInBackground\(\) \{/);
  assert.match(initializeSource, /setTimeout\(\(\) => \{/);
  assert.match(initializeSource, /void checkForUpdates\(options, telemetry\)/);
  assert.match(initializeSource, /\.catch\(\(\) => undefined\)/);
  assert.match(
    initializeSource,
    /new NodeFileIdentityStorage\(options\.appConfigDirectory, \{\s*appId: release\.APP_ID,\s*\}\)/,
  );
  assert.doesNotMatch(initializeSource, /new UpdateChecker/);
  assert.doesNotMatch(initializeSource, /runUpdateHostHooks/);
  assert.doesNotMatch(source, /CHANNEL\??:/);
  assert.doesNotMatch(source, /\btrack(?:Update\w+)?\s*\(/);

  const optionalHook = source.slice(
    source.indexOf("onOptionalUpdate:"),
    source.indexOf("onRequiredUpdate:"),
  );
  const requiredHook = source.slice(source.indexOf("onRequiredUpdate:"));
  assert.match(optionalHook, /await options\.ui\.showOptionalUpdate/);
  assert.match(requiredHook, /await options\.ui\.showRequiredUpdate/);
});

test("the CloudBase template keeps the Event-function deployment boundary", async () => {
  const config = await readJson("cloudbaserc.json.example");
  const functionPackage = await readJson(
    "cloudbase/functions/telemetry/package.json",
  );
  const telemetryFunction = config.functions.find(
    (candidate) => candidate.name === "telemetry-bifang-tools",
  );
  const telemetryRoute = config.gateway.routes.find(
    (candidate) => candidate.path === "/apps/bifang-tools/v1/track",
  );

  assert.equal(config.version, "2.1");
  assert.equal(telemetryFunction.type, "Event");
  assert.equal(telemetryFunction.runtime, "Nodejs20.19");
  assert.equal(telemetryFunction.handler, "index.main");
  assert.equal(telemetryFunction.timeout, 3);
  assert.equal(
    telemetryFunction.envVariables.TELEMETRY_COLLECTION,
    "telemetry_bifang_tools",
  );
  assert.equal(telemetryRoute.target, "function:telemetry-bifang-tools");
  assert.equal(telemetryRoute.protocol, "HTTP_TO_HTTPS");
  assert.equal(telemetryRoute.enablePathTransmission, true);
  assert.equal(telemetryRoute.enableAuth, false);
  assert.equal(functionPackage.dependencies["@cloudbase/js-sdk"], "3.8.2");
  assert.equal("@cloudbase/node-sdk" in functionPackage.dependencies, false);
});
