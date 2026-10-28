import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL(
  "../skills/bifang-public-services-onboarding/",
  import.meta.url,
);
const validate = fileURLToPath(new URL("scripts/validate_profile.py", root));
const derive = fileURLToPath(new URL("scripts/derive_resources.py", root));
const scan = fileURLToPath(new URL("scripts/scan_project.py", root));
const python = process.env.PYTHON || "python";
const fixture = {
  profile_schema_version: 2,
  display_name: "毕方测试工具",
  app_id: "bifang-test-tool",
  platforms: ["windows", "linux"],
  architectures: ["x64"],
  update_transport: "client-update-center-v1",
  update_center_base_url: "https://update.meetelf.com",
  update_center_auth_status: "unknown",
  offline_enforcement: "service-default",
  update_targets: [
    {
      os: "windows",
      architecture: "x86_64",
      installation_type: "installed",
      channel: "stable",
    },
    {
      os: "ubuntu",
      architecture: "x86_64",
      installation_type: "portable",
      channel: "beta",
    },
  ],
};
async function check(t, profile, args = []) {
  const directory = await mkdtemp(join(tmpdir(), "bifang-center-profile-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "profile.json");
  await writeFile(path, JSON.stringify(profile));
  const result = spawnSync(
    python,
    ["-B", validate, path, "--require-update-center", ...args],
    { encoding: "utf8", windowsHide: true },
  );
  return { result, path };
}
test("new onboarding validates center targets and derives the POST endpoint", async (t) => {
  const { result, path } = await check(t, fixture);
  assert.equal(result.status, 0, result.stderr);
  const derived = spawnSync(python, ["-B", derive, "--profile", path], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(derived.status, 0, derived.stderr);
  const value = JSON.parse(derived.stdout);
  assert.equal(
    value.update_check_url,
    "https://update.meetelf.com/api/v1/apps/bifang-test-tool/update-checks",
  );
  assert.equal(value.update_targets[0].architecture, "x86_64");
  assert.equal(value.application_version_route, undefined);
});
test("new onboarding rejects old transport, unsupported targets and sensitive data", async (t) => {
  for (const change of [
    { update_transport: "application-version-api-v1" },
    { update_center_base_url: "http://localhost:8080" },
    { update_center_base_url: "http://127.0.0.1:8081" },
    { update_center_base_url: "http://127.0.0.1:8080/path" },
    { update_center_base_url: "http://example.com:8080" },
    { update_targets: [{ ...fixture.update_targets[0], architecture: "x64" }] },
    { update_targets: [fixture.update_targets[0], fixture.update_targets[0]] },
    {
      application_version_base_url:
        "https://example.com/tools/version-control/v1",
    },
    { client_token: "secret" },
  ]) {
    const { result } = await check(t, { ...fixture, ...change });
    assert.notEqual(result.status, 0, JSON.stringify(change));
  }
});
test("loopback profile derives the actual local endpoint but cannot certify production", async (t) => {
  for (const url of ["http://127.0.0.1:8080", "http://127.0.0.1:8080/"]) {
    const { result, path } = await check(t, {
      ...fixture,
      update_center_base_url: url,
    });
    assert.equal(result.status, 0, result.stderr);
    const derived = spawnSync(python, ["-B", derive, "--profile", path], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(derived.status, 0, derived.stderr);
    assert.equal(
      JSON.parse(derived.stdout).update_check_url,
      "http://127.0.0.1:8080/api/v1/apps/bifang-test-tool/update-checks",
    );
    const online = await check(t, {
      ...fixture,
      update_center_base_url: url,
      deployment_gates: {
        update_center_service_verified: true,
        update_center_client_e2e_passed: true,
      },
    });
    assert.notEqual(online.result.status, 0);
    assert.match(
      online.result.stderr,
      /loopback tests cannot certify production/,
    );
  }
});
test("a completed profile requires a confirmed offline policy and real target configuration", async (t) => {
  const { result } = await check(t, {
    ...fixture,
    offline_enforcement: undefined,
    deployment_gates: { profile_complete: true },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /offline_enforcement/);
});
test("local stage five requires telemetry and update-center evidence without cloud deployment", async (t) => {
  const profile = {
    ...fixture,
    product_key: "test-tool",
    owner: "team",
    framework: "Tauri/Rust",
    current_version: "1.2.3",
    version_source: "Cargo.toml#version",
    app_config_strategy: "app config",
    startup_entry: "src/main.rs",
    main_window_ready_hook: "window ready",
    external_link_handler: "open url",
    exit_handler: "exit",
    cloudbase_env_id: "test-env",
    cloudbase_origin: "https://test.ap-shanghai.app.tcloudbase.com",
    telemetry_endpoint:
      "https://test.ap-shanghai.app.tcloudbase.com/apps/bifang-test-tool/v1/track",
    infrastructure_version: "3.0.0",
    infrastructure_source_commit: "a".repeat(40),
    registration_status: "unknown",
    legacy_track_status: "retained",
    legacy_update_status: "removed",
    privacy_notice: "docs/privacy.md",
    current_stage: 5,
    deployment_gates: {
      profile_complete: true,
      client_integration_complete: true,
      telemetry_app_version_verified: true,
      update_center_client_integrated: true,
      legacy_client_update_removed: true,
    },
  };
  const valid = await check(t, profile);
  assert.equal(valid.result.status, 0, valid.result.stderr);
  const missing = await check(t, {
    ...profile,
    deployment_gates: {
      ...profile.deployment_gates,
      update_center_client_integrated: false,
    },
  });
  assert.notEqual(missing.result.status, 0);
  assert.match(missing.result.stderr, /update_center_client_integrated/);
  const fakeOnline = await check(t, {
    ...profile,
    deployment_gates: {
      ...profile.deployment_gates,
      update_center_service_verified: true,
    },
  });
  assert.notEqual(fakeOnline.result.status, 0);
  assert.match(fakeOnline.result.stderr, /runtime_auth_ready/);
});
test("scanner exposes center markers without certifying integration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bifang-center-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "main.ts"),
    'const origin = "https://update.meetelf.com";\n',
  );
  const result = spawnSync(python, ["-B", scan, directory], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.client_update_center_status, "marker-only");
  assert.equal(
    value.client_update_center_hits[0].marker,
    "update_center_origin",
  );
  assert.equal(value.update_center_migration_gate, "clear");
  await writeFile(
    join(directory, "old.ts"),
    'const url = "https://example.com/tools/version-control/v1";\n',
  );
  const oldResult = spawnSync(python, ["-B", scan, directory], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(oldResult.status, 0, oldResult.stderr);
  assert.equal(
    JSON.parse(oldResult.stdout).update_center_migration_gate,
    "blocked",
  );
});

test("the one-line skill and host example use the new protocol", async () => {
  const skill = await readFile(new URL("SKILL.md", root), "utf8");
  const example = await readFile(
    new URL("../examples/host-integration.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    skill,
    /POST <update_center_base_url>\/api\/v1\/apps\/\{app_id\}\/update-checks/,
  );
  assert.match(skill, /--require-update-center/);
  assert.doesNotMatch(skill, /GET <base>\/versions/);
  assert.match(example, /ClientUpdateService/);
  assert.doesNotMatch(example, /ApplicationVersionChecker/);
});
