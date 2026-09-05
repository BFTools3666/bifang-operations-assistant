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
    profile_schema_version: 1,
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
    update_base_url:
      "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/updates",
    infrastructure_version: "2.1.0",
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

async function createSdkTarball(projectRoot, version = "2.0.0") {
  const relative = `vendor/bifang-telemetry-update-sdk-${version}.tgz`;
  const artifact = join(projectRoot, ...relative.split("/"));
  await mkdir(join(projectRoot, "vendor"), { recursive: true });
  const script = [
    "import io, json, sys, tarfile",
    'payload = json.dumps({"name":"@bifang/telemetry-update-sdk","version":sys.argv[2]}, separators=(",", ":")).encode("utf-8")',
    'with tarfile.open(sys.argv[1], "w:gz") as archive:',
    '    info = tarfile.TarInfo("package/package.json")',
    "    info.size = len(payload)",
    "    info.mtime = 0",
    "    archive.addfile(info, io.BytesIO(payload))",
  ].join("\n");
  const created = spawnSync(
    pythonCommand,
    ["-B", "-c", script, artifact, version],
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
  assert.equal(schema.properties.deployment_gates.additionalProperties, false);
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
    { profile_schema_version: 1, current_stage: 1 },
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "profile is valid");
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

test("an existing confirmed profile restores exact progress without being rewritten", async () => {
  await withTempProfile(completeProfile(), async (path) => {
    const before = await readFile(path, "utf8");

    const firstValidation = runPython(validateScript, [path]);
    assert.equal(firstValidation.status, 0, firstValidation.stderr);
    const derivation = runPython(deriveScript, ["--profile", path]);
    assert.equal(derivation.status, 0, derivation.stderr);
    const secondValidation = runPython(validateScript, [path]);
    assert.equal(secondValidation.status, 0, secondValidation.stderr);

    assert.equal(await readFile(path, "utf8"), before);
    const resources = JSON.parse(derivation.stdout);
    assert.equal(resources.app_id, "bifang-screen-recorder");
    assert.equal(resources.function_name, "telemetry-bifang-screen-recorder");
    assert.equal(
      resources.telemetry_endpoint,
      "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/apps/bifang-screen-recorder/v1/track",
    );
    assert.equal(
      resources.update_manifest_urls.windows,
      "https://bifang-free-test.ap-shanghai.app.tcloudbase.com/updates/bifang-screen-recorder/windows.json",
    );
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
    app_id: "bifang-capture",
    collection_name: "telemetry_bifang_capture",
    function_name: "telemetry-bifang-capture",
    platform_gates: {
      linux: {
        reason:
          "authoritative infrastructure does not generate or validate linux.json",
        status: "pending",
      },
      macos: {
        reason:
          "authoritative infrastructure generates and validates macos.json",
        status: "ready",
      },
      windows: {
        reason:
          "authoritative infrastructure generates and validates windows.json",
        status: "ready",
      },
    },
    telemetry_route: "/apps/bifang-capture/v1/track",
    update_directory: "/updates/bifang-capture",
    update_manifests: {
      linux: "/updates/bifang-capture/linux.json",
      macos: "/updates/bifang-capture/macos.json",
      windows: "/updates/bifang-capture/windows.json",
    },
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
      profile_schema_version: 1,
      SecretId: "AKIDEXAMPLE",
    },
    {
      profile_schema_version: 1,
      hardware_id: "machine-1234",
    },
    {
      profile_schema_version: 1,
      privacy_notice: "Authorization: Bearer abcdefghijklmnop",
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
      update_base_url: "https://custom.example.com/updates",
    }),
    completeProfile({
      cloudbase_origin: "https://gateway.example.invalid",
      telemetry_endpoint:
        "https://gateway.example.invalid/apps/bifang-screen-recorder/v1/track",
      update_base_url: "https://gateway.example.invalid/updates",
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
  const deploymentGates = {
    ...completeProfile().deployment_gates,
    app_registered: true,
    cloudbase_config_reviewed: true,
    function_deployed: true,
    collection_created: true,
    collection_admin_only: true,
    route_deployed: true,
    update_manifests_deployed: true,
    online_e2e_passed: true,
    client_integration_complete: true,
    client_e2e_passed: true,
    privacy_notice_ready: false,
    sdk_distribution_ready: true,
  };
  await withTempProfile(
    completeProfile({
      current_stage: 7,
      registration_status: "verified",
      deployment_gates: deploymentGates,
      sdk_distribution: {
        kind: "versioned_tarball",
        source: "vendor/bifang-telemetry-update-sdk-2.0.0.tgz",
        version: "2.0.0",
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

test("Node and Electron stage five requires a fixed relative SDK artifact", async () => {
  const stageFiveGates = {
    ...completeProfile().deployment_gates,
    app_registered: true,
    cloudbase_config_reviewed: true,
    function_deployed: true,
    collection_created: true,
    collection_admin_only: true,
    route_deployed: true,
    update_manifests_deployed: true,
    online_e2e_passed: true,
  };
  const stageFive = completeProfile({
    current_stage: 5,
    registration_status: "verified",
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
        source: "C:\\temp\\bifang-sdk-2.0.0.tgz",
        version: "2.0.0",
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
        source: "%USERPROFILE%\\bifang-sdk-2.0.0.tgz",
        version: "2.0.0",
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
        source: "vendor/bifang-telemetry-update-sdk-2.0.0.tgz",
        version: "2.0.0",
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
        source: "vendor/bifang-telemetry-update-sdk-2.0.0.tgz",
        version: "2.0.0",
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
      deployment_gates: stageFiveGates,
    }),
    async (path) => {
      const result = runPython(validateScript, [path]);
      assert.equal(result.status, 0, result.stderr);
    },
  );
});

test("a private SDK package needs explicit immutable human evidence", async () => {
  const deploymentGates = {
    ...completeProfile().deployment_gates,
    app_registered: true,
    cloudbase_config_reviewed: true,
    function_deployed: true,
    collection_created: true,
    collection_admin_only: true,
    route_deployed: true,
    update_manifests_deployed: true,
    online_e2e_passed: true,
    sdk_distribution_ready: true,
  };
  const artifactHash = "c".repeat(64);
  const profile = completeProfile({
    current_stage: 5,
    registration_status: "verified",
    deployment_gates: deploymentGates,
    sdk_distribution: {
      kind: "private_package",
      source: "@bifang/telemetry-update-sdk@2.0.0",
      version: "2.0.0",
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
      version: "2.0.0",
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
  const deploymentGates = {
    ...completeProfile().deployment_gates,
    app_registered: true,
    cloudbase_config_reviewed: true,
    function_deployed: true,
    collection_created: true,
    collection_admin_only: true,
    route_deployed: true,
    update_manifests_deployed: true,
    online_e2e_passed: true,
    sdk_distribution_ready: true,
  };
  const profile = completeProfile({
    current_stage: 5,
    registration_status: "verified",
    deployment_gates: deploymentGates,
    sdk_distribution: {
      kind: "workspace",
      source: "vendor/sdk-workspace",
      version: "2.0.0",
    },
    sdk_artifact_sha256: "d".repeat(64),
  });

  await withTempProfile(profile, async (path) => {
    const sdkRoot = join(dirname(path), "vendor", "sdk-workspace");
    await mkdir(join(sdkRoot, "src"), { recursive: true });
    await writeFile(
      join(sdkRoot, "package.json"),
      `${JSON.stringify(
        { name: "@bifang/telemetry-update-sdk", version: "2.0.0" },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(sdkRoot, "src", "index.js"), "export {};\n", "utf8");
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
