import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillRoot = new URL(
  "../skills/bifang-public-services-onboarding/",
  import.meta.url,
);
const schemaUrl = new URL(
  "references/public-services-profile.schema.json",
  skillRoot,
);
const validateScript = fileURLToPath(
  new URL("scripts/validate_profile.py", skillRoot),
);
const deriveScript = fileURLToPath(
  new URL("scripts/derive_resources.py", skillRoot),
);
const scanScript = fileURLToPath(new URL("scripts/scan_project.py", skillRoot));
const verifySdkScript = fileURLToPath(
  new URL("scripts/verify_sdk_distribution.py", skillRoot),
);
const pythonCommand = process.env.PYTHON || "python";

const infrastructureCommit = "a".repeat(40);

function runPython(script, args) {
  return spawnSync(pythonCommand, ["-B", script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "*",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    timeout: 10_000,
    windowsHide: true,
  });
}

function completeProfile(overrides = {}) {
  return {
    profile_schema_version: 2,
    display_name: "毕方录屏助手",
    product_purpose: "Record a selected screen area",
    product_key: "screen-recorder",
    app_id: "bifang-screen-recorder",
    owner: "Bifang team",
    platforms: ["windows", "macos", "linux"],
    architectures: ["x64", "arm64"],
    framework: "Node/Electron/TypeScript",
    current_version: "1.4.0",
    version_source: "package.json#version",
    app_config_strategy: "Electron app.getPath('userData')",
    startup_entry: "src/main.ts#createWindow",
    main_window_ready_hook: "BrowserWindow ready-to-show",
    external_link_handler: "shell.openExternal",
    exit_handler: "app before-quit",
    cloudbase_env_id: "bifang-free-test-123",
    cloudbase_origin: "https://bifang-free-test.ap-shanghai.app.tcloudbase.com",
    telemetry_endpoint:
      "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/apps/bifang-screen-recorder/v1/track",
    update_transport: "application-version-api-v1",
    application_version_contract_version: "1.0.0",
    application_version_base_url:
      "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/tools/version-control/v1",
    release_streams: [
      {
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-screen-recorder-windows-x64",
      },
      {
        platform: "macos",
        architecture: "arm64",
        channel: "stable",
        code: "bifang-screen-recorder-macos-arm64",
      },
      {
        platform: "linux",
        architecture: "x64",
        channel: "stable",
        code: "bifang-screen-recorder-linux-x64",
      },
    ],
    version_api_auth_binding_id: "runtime-bifang-screen-recorder",
    version_api_auth_status: "verified",
    legacy_update_status: "detected",
    infrastructure_version: "3.0.0",
    infrastructure_source_commit: infrastructureCommit,
    registration_status: "not_registered",
    legacy_track_status: "found",
    deployment_gates: {
      profile_complete: true,
      app_id_confirmed: true,
      uses_existing_free_environment: true,
      free_environment_confirmed: true,
    },
    privacy_notice: "docs/privacy.md",
    current_stage: 2,
    ...overrides,
  };
}

function completeV2Profile(overrides = {}) {
  return completeProfile({
    platforms: ["windows", "macos"],
    architectures: ["x64", "arm64"],
    release_streams: [
      {
        platform: "windows",
        architecture: "x64",
        channel: "stable",
        code: "bifang-screen-recorder-windows-x64",
      },
      {
        platform: "macos",
        architecture: "arm64",
        channel: "stable",
        code: "bifang-screen-recorder-macos-arm64",
      },
    ],
    ...overrides,
  });
}

function legacyV1Profile(overrides = {}) {
  return {
    profile_schema_version: 1,
    display_name: "毕方录屏助手",
    app_id: "bifang-screen-recorder",
    update_base_url:
      "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/updates",
    deployment_gates: {
      update_manifests_deployed: true,
    },
    current_stage: 5,
    ...overrides,
  };
}

function deployedV2Gates(overrides = {}) {
  return {
    ...completeProfile().deployment_gates,
    app_registered: true,
    platform_code_mapping_confirmed: true,
    cloudbase_config_reviewed: true,
    version_api_config_reviewed: true,
    function_deployed: true,
    collection_created: true,
    collection_admin_only: true,
    route_deployed: true,
    online_e2e_passed: true,
    runtime_auth_ready: true,
    version_api_service_verified: true,
    client_integration_complete: true,
    version_api_client_integrated: true,
    legacy_client_update_removed: true,
    ...overrides,
  };
}

async function withTempProfile(profile, run) {
  const root = await mkdtemp(join(tmpdir(), "bifang-profile-test-"));
  const path = join(root, "public-services-profile.json");
  try {
    await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
    await run(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const sdkRuntimeEntry = `export {
  ApplicationVersionChecker,
  buildApplicationVersionCheckUrl,
  decideApplicationVersion,
  isCanonicalApplicationVersionBaseUrl,
  parseApplicationVersionData,
  runApplicationVersionHostHooks
} from "./application-version.js";\n`;
const sdkDeclarationEntry = `export declare class ApplicationVersionChecker {}
export declare function buildApplicationVersionCheckUrl(): string | null;
export declare function decideApplicationVersion(): ApplicationVersionDecision;
export declare function isCanonicalApplicationVersionBaseUrl(): boolean;
export declare function parseApplicationVersionData(): ApplicationVersionData | null;
export declare function runApplicationVersionHostHooks(): Promise<void>;
export interface ApplicationVersionCheckerConfig { baseUrl: string; }
export interface ApplicationVersionData { update: boolean; }
export type ApplicationVersionDecision = { kind: "none" };
export interface ApplicationVersionHostHooks {}\n`;

async function createSdkTarball(projectRoot, version = "3.0.0") {
  const relative = `vendor/bifang-telemetry-update-sdk-${version}.tgz`;
  const artifact = join(projectRoot, ...relative.split("/"));
  await mkdir(join(projectRoot, "vendor"), { recursive: true });
  const script = [
    "import io, json, sys, tarfile",
    'package = json.dumps({"name":"@bifang/telemetry-update-sdk","version":sys.argv[2],"type":"module","main":"./dist/index.js","types":"./dist/index.d.ts","exports":{".":{"types":"./dist/index.d.ts","import":"./dist/index.js"}}}, separators=(",", ":")).encode("utf-8")',
    'members = {"package/package.json": package, "package/dist/index.js": sys.argv[3].encode("utf-8"), "package/dist/index.d.ts": sys.argv[4].encode("utf-8")}',
    'with tarfile.open(sys.argv[1], "w:gz") as archive:',
    "    for name, payload in members.items():",
    "        info = tarfile.TarInfo(name)",
    "        info.size = len(payload)",
    "        info.mtime = 0",
    "        archive.addfile(info, io.BytesIO(payload))",
  ].join("\n");
  const created = spawnSync(
    pythonCommand,
    [
      "-B",
      "-c",
      script,
      artifact,
      version,
      sdkRuntimeEntry,
      sdkDeclarationEntry,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(created.status, 0, created.stderr);
  const digest = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  return { digest, relative };
}

function calculateSdkTreeHash(directory) {
  const script = [
    "import sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "from verify_sdk_distribution import stable_tree_sha256",
    "print(stable_tree_sha256(Path(sys.argv[2])))",
  ].join("\n");
  const result = spawnSync(
    pythonCommand,
    ["-B", "-c", script, dirname(verifySdkScript), directory],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("profile schema is resumable, strict, and enumerates only non-sensitive fields", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["profile_schema_version"]);
  assert.equal(schema.properties.profile_schema_version.const, 2);
  assert.equal(schema.properties.deployment_gates.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, "update_base_url"), false);
  assert.equal(
    Object.hasOwn(
      schema.properties.deployment_gates.properties,
      "update_manifests_deployed",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      schema.properties.deployment_gates.properties,
      "legacy_update_removed",
    ),
    false,
  );
  assert.equal(
    schema.properties.deployment_gates.properties.legacy_client_update_removed
      .type,
    "boolean",
  );
  assert.equal(
    schema.properties.deployment_gates.properties.legacy_cloud_resources_removed
      .type,
    "boolean",
  );
  assert.equal(
    schema.properties.update_transport.const,
    "application-version-api-v1",
  );
  assert.equal(
    schema.properties.application_version_contract_version.const,
    "1.0.0",
  );
  assert.equal(schema.$defs.releaseStream.properties.code.maxLength, 50);
  assert.deepEqual(schema.properties.version_api_auth_status.enum, [
    "unknown",
    "planned",
    "ready",
    "verified",
  ]);
  assert.deepEqual(schema.properties.legacy_update_status.enum, [
    "detected",
    "not_found",
    "removed",
  ]);
  assert.equal(
    schema.properties.infrastructure_source_commit.pattern,
    "^[0-9a-f]{40}$",
  );
  for (const forbidden of [
    "SecretId",
    "SecretKey",
    "Token",
    "Cookie",
    "Authorization",
    "hardware_id",
    "user_account",
  ]) {
    assert.equal(Object.hasOwn(schema.properties, forbidden), false);
  }
});

test("a minimal stage-one profile validates so an interrupted interview can resume", async () => {
  await withTempProfile(
    { profile_schema_version: 2, current_stage: 1 },
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /profile is valid/i);
    },
  );
});

test("a complete profile cannot omit detected platform architecture or progress state", async () => {
  for (const missingField of [
    "architectures",
    "registration_status",
    "legacy_track_status",
    "deployment_gates",
    "current_stage",
  ]) {
    const profile = completeProfile();
    delete profile[missingField];
    await withTempProfile(profile, async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1, `${missingField}: ${result.stderr}`);
      assert.match(
        result.stderr,
        new RegExp(`\\$\\.${missingField}: required`),
      );
    });
  }
});

test("an existing v1 profile is read-only migration input and is never rewritten", async () => {
  await withTempProfile(legacyV1Profile(), async (path) => {
    const before = await readFile(path, "utf8");

    const firstValidation = runPython(validateScript, [path]);
    assert.equal(firstValidation.status, 1, firstValidation.stdout);
    assert.match(
      firstValidation.stderr,
      /legacy profile schema v1 is obsolete.*migrate.*schema_version 2/i,
    );
    assert.equal(
      firstValidation.stderr.match(/^- /gm)?.length,
      1,
      firstValidation.stderr,
    );
    const derivation = runPython(deriveScript, ["--profile", path]);
    assert.equal(derivation.status, 1, derivation.stderr);
    assert.match(derivation.stderr, /schema v1 is obsolete.*migrate/i);
    const secondValidation = runPython(validateScript, [path]);
    assert.equal(secondValidation.status, 1, secondValidation.stdout);

    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("a v2 profile derives telemetry and application-version resources without static updates", async () => {
  await withTempProfile(completeV2Profile(), async (path) => {
    const validation = runPython(validateScript, [path]);
    assert.equal(validation.status, 0, validation.stderr);
    assert.equal(validation.stdout.trim(), "profile is valid");

    const derivation = runPython(deriveScript, ["--profile", path]);
    assert.equal(derivation.status, 0, derivation.stderr);
    const resources = JSON.parse(derivation.stdout);
    assert.equal(resources.function_name, "telemetry-bifang-screen-recorder");
    assert.equal(resources.collection_name, "telemetry_bifang_screen_recorder");
    assert.equal(
      resources.application_version_function_name,
      "application-version-api",
    );
    assert.equal(
      resources.version_collection_name,
      "versions_bifang_screen_recorder",
    );
    assert.equal(resources.ad_collection_name, "ads_bifang_screen_recorder");
    assert.equal(
      resources.audit_collection_name,
      "audit_bifang_screen_recorder",
    );
    assert.equal(
      resources.application_version_base_url,
      "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/tools/version-control/v1",
    );
    assert.equal(resources.release_streams.length, 2);
    assert.match(
      resources.release_streams[1].version_check_url_template,
      /\/tools\/version-control\/v1\/versions\/bifang-screen-recorder-windows-x64\/\{version\}$/,
    );
    assert.equal(Object.hasOwn(resources, "update_base_url"), false);
    assert.equal(Object.hasOwn(resources, "update_manifests"), false);
    assert.equal(Object.hasOwn(resources, "update_directory"), false);
  });
});

test("app ids use the exact 1-50 character deployment alphabet", () => {
  for (const appId of ["a", "bifang-tools", "a".repeat(50)]) {
    const result = runPython(deriveScript, ["--", appId]);
    assert.equal(result.status, 0, `${appId}: ${result.stderr}`);
  }
  for (const appId of [
    "Bad-App",
    "has_underscore",
    "-leading",
    "trailing-",
    "a".repeat(51),
  ]) {
    const result = runPython(deriveScript, ["--", appId]);
    assert.notEqual(result.status, 0, appId);
    assert.match(result.stderr, /app_id must be 1-50/);
  }
});

test("resource derivation is deterministic across desktop and native platforms", () => {
  const args = [
    "bifang-capture",
    "--platform",
    "windows",
    "--platform",
    "linux",
    "--platform",
    "macos",
    "--platform",
    "windows",
  ];
  const first = runPython(deriveScript, args);
  const second = runPython(deriveScript, args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.deepEqual(JSON.parse(first.stdout), {
    ad_collection_name: "ads_bifang_capture",
    app_id: "bifang-capture",
    application_version_contract_version: "1.0.0",
    application_version_function_name: "application-version-api",
    application_version_route: "/tools/version-control/v1",
    audit_collection_name: "audit_bifang_capture",
    collection_name: "telemetry_bifang_capture",
    function_name: "telemetry-bifang-capture",
    platform_gates: {
      linux: {
        reason:
          "application-version API release stream code is not yet declared",
        status: "pending",
      },
      macos: {
        reason:
          "application-version API release stream code is not yet declared",
        status: "pending",
      },
      windows: {
        reason:
          "application-version API release stream code is not yet declared",
        status: "pending",
      },
    },
    release_streams: [],
    telemetry_route: "/apps/bifang-capture/v1/track",
    version_collection_name: "versions_bifang_capture",
  });
});

test("profiles reject unsupported platforms and non-canonical architectures", async () => {
  for (const profile of [
    completeProfile({ platforms: ["android"] }),
    completeProfile({ architectures: ["x86_64"] }),
    completeProfile({ architectures: ["aarch64"] }),
  ]) {
    await withTempProfile(profile, async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must be one of/);
    });
  }

  const derivation = runPython(deriveScript, [
    "bifang-mobile",
    "--platform",
    "android",
  ]);
  assert.equal(derivation.status, 1);
  assert.match(derivation.stderr, /windows, macos, linux/);
});

test("unknown and sensitive fields or values are rejected", async () => {
  const cases = [
    {
      profile_schema_version: 2,
      SecretId: "AKIDEXAMPLE",
    },
    {
      profile_schema_version: 2,
      hardware_id: "machine-1234",
    },
    {
      profile_schema_version: 2,
      privacy_notice: "Authorization: Bearer abcdefghijklmnop",
    },
    {
      profile_schema_version: 2,
      x_app_secret: "must-never-be-stored",
    },
    {
      profile_schema_version: 2,
      privacy_notice: "x-app-secret: must-never-be-stored",
    },
  ];

  for (const profile of cases) {
    await withTempProfile(profile, async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        /sensitive (?:field|value)|appears to contain/,
      );
    });
  }
});

test("v2 rejects duplicate-v1 URLs, static update fields, and ambiguous release streams", async () => {
  const duplicateCode = completeV2Profile();
  duplicateCode.release_streams[1].code = duplicateCode.release_streams[0].code;

  const duplicateTarget = completeV2Profile();
  duplicateTarget.release_streams[1] = {
    ...duplicateTarget.release_streams[0],
    code: "another-release-code",
  };

  const obsoleteStaticField = completeV2Profile();
  obsoleteStaticField.update_base_url =
    "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/updates";

  const obsoleteStaticGate = completeV2Profile();
  obsoleteStaticGate.deployment_gates.update_manifests_deployed = true;

  const cases = [
    completeV2Profile({
      application_version_base_url:
        "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/tools/version-control/v1/v1",
    }),
    duplicateCode,
    duplicateTarget,
    completeV2Profile({
      release_streams: [
        {
          platform: "windows",
          architecture: "x64",
          channel: "stable",
          code: "a".repeat(51),
        },
      ],
    }),
    obsoleteStaticField,
    obsoleteStaticGate,
  ];

  for (const profile of cases) {
    await withTempProfile(profile, async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /one v1 segment|duplicate release|duplicate platform|50 character|unknown field/,
      );
    });
  }
});

test("v2 completion records obsolete static updates as removed without retaining their fields", async () => {
  const deploymentGates = {
    profile_complete: true,
    app_id_confirmed: true,
    uses_existing_free_environment: true,
    free_environment_confirmed: true,
    app_registered: true,
    platform_code_mapping_confirmed: true,
    cloudbase_config_reviewed: true,
    version_api_config_reviewed: true,
    function_deployed: true,
    collection_created: true,
    collection_admin_only: true,
    route_deployed: true,
    online_e2e_passed: true,
    runtime_auth_ready: true,
    version_api_service_verified: true,
    client_integration_complete: true,
    version_api_client_integrated: true,
    client_e2e_passed: true,
    version_api_client_e2e_passed: true,
    privacy_notice_ready: true,
    migration_observation_complete: true,
    legacy_usage_assessed: true,
    owner_approved: true,
    legacy_client_update_removed: true,
    legacy_cloud_resources_removed: true,
  };
  await withTempProfile(
    completeV2Profile({
      framework: "Tauri/Rust",
      current_stage: 8,
      registration_status: "verified",
      legacy_update_status: "not_found",
      deployment_gates: {
        ...deploymentGates,
        legacy_client_update_removed: false,
      },
    }),
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        /legacy_(?:update_status|client_update_removed)/,
      );
    },
  );

  const profile = completeV2Profile({
    framework: "Tauri/Rust",
    current_stage: 8,
    registration_status: "verified",
    version_api_auth_binding_id: "runtime-bifang-screen-recorder",
    version_api_auth_status: "verified",
    legacy_update_status: "removed",
    deployment_gates: deploymentGates,
  });

  await withTempProfile(profile, async (path) => {
    const result = runPython(validateScript, [path]);
    assert.equal(result.status, 0, result.stderr);
    const derivation = runPython(deriveScript, ["--profile", path]);
    assert.equal(derivation.status, 0, derivation.stderr);
    const resources = JSON.parse(derivation.stdout);
    assert.equal(resources.legacy_update_status, "removed");
    assert.equal(Object.hasOwn(resources, "update_base_url"), false);
    assert.equal(Object.hasOwn(resources, "update_manifests"), false);
  });
});

test("SemVer, URL identity, and stage gates are validated semantically", async () => {
  const cases = [
    completeProfile({ current_version: "v1.4.0" }),
    completeProfile({
      telemetry_endpoint:
        "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/apps/other-tool/v1/track",
    }),
    completeProfile({
      update_base_url: "https://another.example.com/updates",
    }),
    completeProfile({
      registration_status: "not_registered",
      deployment_gates: {
        ...completeProfile().deployment_gates,
        app_registered: true,
      },
    }),
    completeProfile({
      current_stage: 3,
      registration_status: "registered",
    }),
    completeProfile({
      cloudbase_origin: "https://custom.example.com",
      telemetry_endpoint:
        "https://custom.example.com/apps/bifang-screen-recorder/v1/track",
      application_version_base_url:
        "https://custom.example.com/tools/version-control/v1",
    }),
    completeProfile({
      cloudbase_origin: "https://gateway.example.invalid",
      telemetry_endpoint:
        "https://gateway.example.invalid/apps/bifang-screen-recorder/v1/track",
      application_version_base_url:
        "https://gateway.example.invalid/tools/version-control/v1",
    }),
  ];

  for (const profile of cases) {
    await withTempProfile(profile, async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, /profile validation failed/);
    });
  }
});

test("stage seven requires a ready privacy notice", async () => {
  const deploymentGates = deployedV2Gates({
    client_integration_complete: true,
    version_api_client_integrated: true,
    client_e2e_passed: true,
    version_api_client_e2e_passed: true,
    privacy_notice_ready: false,
    sdk_distribution_ready: true,
  });
  await withTempProfile(
    completeProfile({
      current_stage: 7,
      registration_status: "verified",
      legacy_update_status: "removed",
      deployment_gates: deploymentGates,
      sdk_distribution: {
        kind: "versioned_tarball",
        source: "vendor/bifang-telemetry-update-sdk-3.0.0.tgz",
        version: "3.0.0",
      },
      sdk_artifact_sha256: "b".repeat(64),
    }),
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /privacy_notice_ready: must be true/);
    },
  );
});

test("stage five is a local migration and does not require CloudBase or runtime credentials", async () => {
  const profile = completeV2Profile({
    framework: "Tauri/Rust",
    current_stage: 5,
    registration_status: "not_registered",
    version_api_auth_binding_id: "planned-runtime-binding",
    version_api_auth_status: "planned",
    legacy_update_status: "removed",
    deployment_gates: {
      ...completeProfile().deployment_gates,
      client_integration_complete: true,
      version_api_client_integrated: true,
      legacy_client_update_removed: true,
    },
  });

  await withTempProfile(profile, async (path) => {
    const result = runPython(validateScript, [path]);
    assert.equal(result.status, 0, result.stderr);
  });
});

test("Node and Electron stage five requires a fixed relative SDK artifact", async () => {
  const stageFiveGates = deployedV2Gates();
  const stageFive = completeProfile({
    current_stage: 5,
    registration_status: "verified",
    legacy_update_status: "removed",
    deployment_gates: stageFiveGates,
  });

  await withTempProfile(stageFive, async (path) => {
    const result = runPython(validateScript, [path]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sdk_distribution_ready/);
    assert.match(result.stderr, /sdk_distribution: required/);
    assert.match(result.stderr, /sdk_artifact_sha256: required/);
  });

  await withTempProfile(
    {
      ...stageFive,
      deployment_gates: {
        ...stageFiveGates,
        sdk_distribution_ready: true,
      },
      sdk_distribution: {
        kind: "versioned_tarball",
        source: "C:\\temp\\bifang-sdk-3.0.0.tgz",
        version: "3.0.0",
      },
      sdk_artifact_sha256: "b".repeat(64),
    },
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /not an absolute or escaping path/);
    },
  );

  for (const framework of ["ElectronJS", "NW.js"]) {
    await withTempProfile({ ...stageFive, framework }, async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /sdk_distribution_ready/);
    });
  }

  await withTempProfile(
    {
      ...stageFive,
      deployment_gates: {
        ...stageFiveGates,
        sdk_distribution_ready: true,
      },
      sdk_distribution: {
        kind: "versioned_tarball",
        source: "%USERPROFILE%\\bifang-sdk-3.0.0.tgz",
        version: "3.0.0",
      },
      sdk_artifact_sha256: "b".repeat(64),
    },
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /environment|project-relative/);
    },
  );

  await withTempProfile(
    {
      ...stageFive,
      deployment_gates: {
        ...stageFiveGates,
        sdk_distribution_ready: true,
      },
      sdk_distribution: {
        kind: "versioned_tarball",
        source: "vendor/bifang-telemetry-update-sdk-3.0.0.tgz",
        version: "3.0.0",
      },
      sdk_artifact_sha256: "b".repeat(64),
    },
    async (path) => {
      const projectRoot = dirname(path);
      await createSdkTarball(projectRoot);
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /SHA-256 mismatch/);
    },
  );

  await withTempProfile(
    {
      ...stageFive,
      deployment_gates: {
        ...stageFiveGates,
        sdk_distribution_ready: true,
      },
      sdk_distribution: {
        kind: "versioned_tarball",
        source: "vendor/bifang-telemetry-update-sdk-3.0.0.tgz",
        version: "3.0.0",
      },
      sdk_artifact_sha256: "b".repeat(64),
    },
    async (path) => {
      const profile = JSON.parse(await readFile(path, "utf8"));
      const { digest } = await createSdkTarball(dirname(path));
      profile.sdk_artifact_sha256 = digest;
      await writeFile(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 0, result.stderr);
      const verification = runPython(verifySdkScript, [path]);
      assert.equal(verification.status, 0, verification.stderr);
      const evidence = JSON.parse(verification.stdout);
      assert.equal(evidence.artifact_bytes_verified, true);
      assert.equal(evidence.verification_status, "artifact_verified");
    },
  );

  await withTempProfile(
    completeProfile({
      framework: "Tauri/Rust",
      current_stage: 5,
      registration_status: "verified",
      legacy_update_status: "removed",
      deployment_gates: stageFiveGates,
    }),
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

test("a private SDK package needs explicit immutable human evidence", async () => {
  const deploymentGates = deployedV2Gates({
    sdk_distribution_ready: true,
  });
  const artifactHash = "c".repeat(64);
  const profile = completeProfile({
    current_stage: 5,
    registration_status: "verified",
    legacy_update_status: "removed",
    deployment_gates: deploymentGates,
    sdk_distribution: {
      kind: "private_package",
      source: "@bifang/telemetry-update-sdk@3.0.0",
      version: "3.0.0",
      verification_evidence: "evidence/sdk-private-package.json",
      immutable_reference: `sha256:${artifactHash}`,
    },
    sdk_artifact_sha256: artifactHash,
  });

  await withTempProfile(profile, async (path) => {
    const evidenceDirectory = join(dirname(path), "evidence");
    await mkdir(evidenceDirectory, { recursive: true });
    const evidence = {
      package: "@bifang/telemetry-update-sdk",
      version: "3.0.0",
      artifact_sha256: artifactHash,
      immutable_reference: `sha256:${artifactHash}`,
      verified_by: "Bifang team",
      verified_at: "2026-09-05T17:00:00+08:00",
    };
    await writeFile(
      join(evidenceDirectory, "sdk-private-package.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );

    const validation = runPython(validateScript, [path]);
    assert.equal(validation.status, 0, validation.stderr);
    const verification = runPython(verifySdkScript, [path]);
    assert.equal(verification.status, 0, verification.stderr);
    const result = JSON.parse(verification.stdout);
    assert.equal(result.verification_mode, "manual_evidence");
    assert.equal(result.artifact_bytes_verified, false);
    assert.equal(result.verification_status, "manual_evidence_verified");

    delete evidence.verified_at;
    await writeFile(
      join(evidenceDirectory, "sdk-private-package.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    const missingReview = runPython(validateScript, [path]);
    assert.equal(missingReview.status, 1);
    assert.match(missingReview.stderr, /verified_at/);
  });
});

test("a workspace SDK uses a stable content hash and detects later mutation", async () => {
  const deploymentGates = deployedV2Gates({
    sdk_distribution_ready: true,
  });
  const profile = completeProfile({
    current_stage: 5,
    registration_status: "verified",
    legacy_update_status: "removed",
    deployment_gates: deploymentGates,
    sdk_distribution: {
      kind: "workspace",
      source: "vendor/sdk-workspace",
      version: "3.0.0",
    },
    sdk_artifact_sha256: "d".repeat(64),
  });

  await withTempProfile(profile, async (path) => {
    const sdkRoot = join(dirname(path), "vendor", "sdk-workspace");
    await mkdir(join(sdkRoot, "src"), { recursive: true });
    await writeFile(
      join(sdkRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "@bifang/telemetry-update-sdk",
          version: "3.0.0",
          type: "module",
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.js",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await mkdir(join(sdkRoot, "dist"), { recursive: true });
    await writeFile(join(sdkRoot, "dist", "index.js"), sdkRuntimeEntry, "utf8");
    await writeFile(
      join(sdkRoot, "dist", "index.d.ts"),
      sdkDeclarationEntry,
      "utf8",
    );
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.sdk_artifact_sha256 = calculateSdkTreeHash(sdkRoot);
    await writeFile(path, `${JSON.stringify(saved, null, 2)}\n`, "utf8");

    const first = runPython(verifySdkScript, [path]);
    const second = runPython(verifySdkScript, [path]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(
      JSON.parse(first.stdout).hash_algorithm,
      "bifang-relative-content-v1",
    );

    await writeFile(
      join(sdkRoot, "src", "extra.js"),
      "export const x = 1;\n",
      "utf8",
    );
    const changed = runPython(validateScript, [path]);
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /SHA-256 mismatch/);
  });
});

test("legacy scan distinguishes runtime references from docs and fixtures without side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "bifang-legacy-scan-test-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(
      join(root, "src", "config.ts"),
      'const endpoint = "https://old.example.test/v1/track";\n' +
        'const arches = ["x86_64", "aarch64", "i686"];\n',
      "utf8",
    );
    await writeFile(
      join(root, "electron-builder.yml"),
      "arch: [x86_64, aarch64, i686]\n",
      "utf8",
    );
    await writeFile(
      join(root, "src", "new.ts"),
      'const endpoint = "/apps/bifang-recorder/v1/track";\n' +
        'const APP_ID = "bifang-recorder";\n' +
        'const manifest = "/updates/bifang-recorder/windows.json";\n' +
        'const warning = "不要使用历史共享 /v1/track";\n',
      "utf8",
    );
    await writeFile(
      join(root, "docs", "migration.md"),
      "The historical route was `/v1/track`.\n",
      "utf8",
    );
    await writeFile(
      join(root, "tests", "config.test.ts"),
      'const fixture = "/v1/track";\n',
      "utf8",
    );
    await writeFile(
      join(root, "tcb.cmd"),
      "@echo deployment-must-not-run>deploy-called.txt\r\n",
      "utf8",
    );
    const beforeFiles = (await readdir(root, { recursive: true })).sort();
    const beforeRuntime = await readFile(
      join(root, "src", "config.ts"),
      "utf8",
    );

    const result = runPython(scanScript, [root]);
    assert.equal(result.status, 0, result.stderr);
    const scan = JSON.parse(result.stdout);
    assert.equal(scan.classification, "runtime_reference");
    assert.equal(scan.legacy_track_status, "migration_required");
    assert.equal(scan.migration_gate, "blocked");
    assert.deepEqual(scan.detected_architectures, ["x64", "arm64", "ia32"]);
    assert.deepEqual(scan.detected_app_ids, ["bifang-recorder"]);
    assert.equal(scan.modern_track_hits.length, 1);
    assert.equal(scan.update_manifest_hits.length, 1);
    assert.deepEqual(
      scan.runtime_hits.map((hit) => [hit.path, hit.marker]),
      [["src/config.ts", "legacy_track_path"]],
    );
    assert.deepEqual(scan.non_runtime_hits.map((hit) => hit.kind).sort(), [
      "documentation",
      "runtime_text",
      "test_fixture",
    ]);
    assert.equal(
      await readFile(join(root, "src", "config.ts"), "utf8"),
      beforeRuntime,
    );
    assert.deepEqual(
      (await readdir(root, { recursive: true })).sort(),
      beforeFiles,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy scan treats docs-only evidence separately and ignores modern routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "bifang-modern-scan-test-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "src", "config.ts"),
      'const endpoint = "/apps/bifang-recorder/v1/track";\n',
      "utf8",
    );
    await writeFile(
      join(root, "docs", "history.md"),
      "Old clients used `/v1/track`.\n",
      "utf8",
    );
    const docsOnly = runPython(scanScript, [root]);
    assert.equal(docsOnly.status, 0, docsOnly.stderr);
    assert.equal(
      JSON.parse(docsOnly.stdout).classification,
      "non_runtime_only",
    );
    assert.deepEqual(JSON.parse(docsOnly.stdout).detected_app_ids, [
      "bifang-recorder",
    ]);

    await rm(join(root, "docs"), { recursive: true, force: true });
    const modernOnly = runPython(scanScript, [root]);
    assert.equal(modernOnly.status, 0, modernOnly.stderr);
    assert.equal(JSON.parse(modernOnly.stdout).classification, "not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy scan treats common runtime script extensions as migration evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "bifang-script-scan-test-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "modern.ts"),
      'const endpoint = "/apps/bifang-recorder/v1/track";\n',
      "utf8",
    );
    await writeFile(
      join(root, "legacy.ps1"),
      '$endpoint = "https://old.example.test/v1/track"\r\n',
      "utf8",
    );

    const result = runPython(scanScript, [root]);
    assert.equal(result.status, 0, result.stderr);
    const scan = JSON.parse(result.stdout);
    assert.equal(scan.classification, "runtime_reference");
    assert.equal(scan.legacy_track_status, "migration_required");
    assert.equal(scan.migration_gate, "blocked");
    assert.deepEqual(
      scan.runtime_hits.map((hit) => [hit.path, hit.marker]),
      [["legacy.ps1", "legacy_track_path"]],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project scan separates obsolete static updates from the application-version v1 client", async () => {
  const root = await mkdtemp(join(tmpdir(), "bifang-version-api-scan-test-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(
      join(root, "src", "version-client.rs"),
      'const CHECK: &str = "/tools/version-control/v1/versions/bifang-recorder-windows-x64/{version}";\n' +
        'const ADS: &str = "/tools/version-control/v1/app/bifang-recorder-windows-x64/ads/show";\n' +
        'const KEY_HEADER: &str = "x-app-key";\n' +
        'const SECRET_HEADER: &str = "x-app-secret";\n' +
        'const LOCAL_TEST_VALUE: &str = "runtime-secret-value-must-not-leak";\n',
      "utf8",
    );
    await writeFile(
      join(root, "src", "legacy-update.ts"),
      'const manifest = "/updates/bifang-recorder/windows.json";\n',
      "utf8",
    );
    await writeFile(
      join(root, "docs", "bad-example.md"),
      "Never use `/tools/version-control/v1/v1/versions/code/1.0.0`.\n",
      "utf8",
    );

    const detected = runPython(scanScript, [root]);
    assert.equal(detected.status, 0, detected.stderr);
    assert.doesNotMatch(detected.stdout, /runtime-secret-value-must-not-leak/);
    const firstScan = JSON.parse(detected.stdout);
    assert.equal(firstScan.scan_version, 3);
    assert.equal(firstScan.application_version_api_status, "marker-only");
    assert.equal(firstScan.legacy_update_status, "detected");
    assert.equal(firstScan.legacy_update_removal_gate, "blocked");
    assert.deepEqual(
      new Set(firstScan.application_version_api_hits.map((hit) => hit.marker)),
      new Set([
        "version_check_path",
        "ads_show_path",
        "x_app_key_header",
        "x_app_secret_header",
      ]),
    );
    assert.equal(firstScan.invalid_application_version_api_hits.length, 1);

    await rm(join(root, "src", "legacy-update.ts"));
    const migrated = runPython(scanScript, [root]);
    assert.equal(migrated.status, 0, migrated.stderr);
    const migratedScan = JSON.parse(migrated.stdout);
    assert.equal(migratedScan.application_version_api_status, "marker-only");
    assert.equal(migratedScan.legacy_update_status, "not_found");
    assert.equal(migratedScan.legacy_update_removal_gate, "clear");

    await writeFile(
      join(root, "src", "bad-runtime.ts"),
      'const base = "/tools/version-control/v1/v1";\n',
      "utf8",
    );
    const invalid = runPython(scanScript, [root]);
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(
      JSON.parse(invalid.stdout).application_version_api_status,
      "invalid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project scan reports unresolved APP_ID values and incomplete env scans without guessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "bifang-conservative-scan-test-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "src", "config.ts"),
      "appId = releaseConfig.APP_ID;\n" +
        "app_id = None;\n" +
        'APP_ID = "Bad-App";\n',
      "utf8",
    );
    await writeFile(
      join(root, ".env.local"),
      "APP_ID=bifang-env-tool\n",
      "utf8",
    );
    await writeFile(join(root, ".env.secrets"), Buffer.from([0xff, 0xfe]));
    await writeFile(
      join(root, ".env.production"),
      Buffer.alloc(2_097_153, 0x61),
    );

    const result = runPython(scanScript, [root]);
    assert.equal(result.status, 0, result.stderr);
    const scan = JSON.parse(result.stdout);
    assert.deepEqual(scan.detected_app_ids, ["bifang-env-tool"]);
    assert.deepEqual(
      scan.invalid_app_id_evidence.map((item) => item.app_id),
      ["Bad-App"],
    );
    assert.equal(scan.unresolved_app_id_evidence.length, 2);
    assert.equal(scan.scan_incomplete, true);
    assert.equal(scan.classification, "incomplete");
    assert.equal(scan.legacy_track_status, "unknown");
    assert.equal(scan.migration_gate, "blocked");
    assert.equal(scan.legacy_update_removal_gate, "blocked");
    assert.equal(Object.hasOwn(scan, "legacy_update_status"), false);
    assert.deepEqual(scan.skipped_files.map((item) => item.reason).sort(), [
      "non_utf8",
      "too_large",
    ]);
    assert.equal(
      scan.app_id_candidates.some((item) =>
        ["releaseconfig", "none", "config"].includes(item.app_id),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate JSON fields are rejected before validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bifang-duplicate-profile-test-"));
  const path = join(root, "public-services-profile.json");
  try {
    await writeFile(
      path,
      '{"profile_schema_version":1,"profile_schema_version":1}\n',
      "utf8",
    );
    const result = runPython(validateScript, [path]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /duplicate JSON field/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
