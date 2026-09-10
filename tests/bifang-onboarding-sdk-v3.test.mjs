import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(
  new URL(
    "../skills/bifang-public-services-onboarding/scripts/verify_sdk_distribution.py",
    import.meta.url,
  ),
);
const python = process.env.PYTHON || "python";
const packageName = "@bifang/telemetry-update-sdk";
const compatibleVersion = "3.0.0";
const runtimeExports = [
  "ApplicationVersionChecker",
  "buildApplicationVersionCheckUrl",
  "decideApplicationVersion",
  "isCanonicalApplicationVersionBaseUrl",
  "parseApplicationVersionData",
  "runApplicationVersionHostHooks",
];

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "bifang-sdk-v3-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runPython(args) {
  return spawnSync(python, ["-B", ...args], {
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

function runtimeSource(exports = runtimeExports, suffix = "") {
  return `export { ${exports.join(", ")} } from "./application-version.js";\n${suffix}`;
}

const declarationExports = [
  ...runtimeExports,
  "ApplicationVersionCheckerConfig",
  "ApplicationVersionData",
  "ApplicationVersionDecision",
  "ApplicationVersionHostHooks",
];

function fakeExportText(names) {
  return names.map((name) => `export class ${name} {}`).join("\n");
}

function lexicalExportDecoy(kind, names) {
  const source = fakeExportText(names);
  if (kind === "comment") return `/*\n${source}\n*/\n`;
  if (kind === "string") return `const decoy = ${JSON.stringify(source)};\n`;
  if (kind === "template") return `const decoy = \`${source}\`;\n`;
  if (kind === "regex")
    return `const decoy = /${source.replaceAll("\n", "|")}/;\n`;
  throw new Error(`unknown decoy kind: ${kind}`);
}

function declarationSource({ omit = "", suffix = "" } = {}) {
  const declarations = [
    "export declare class ApplicationVersionChecker {}",
    "export declare function buildApplicationVersionCheckUrl(): string | null;",
    "export declare function decideApplicationVersion(): ApplicationVersionDecision;",
    "export declare function isCanonicalApplicationVersionBaseUrl(): boolean;",
    "export declare function parseApplicationVersionData(): ApplicationVersionData | null;",
    "export declare function runApplicationVersionHostHooks(): Promise<void>;",
    "export interface ApplicationVersionCheckerConfig { baseUrl: string; }",
    "export interface ApplicationVersionData { update: boolean; }",
    'export type ApplicationVersionDecision = { kind: "none" };',
    "export interface ApplicationVersionHostHooks {}",
  ].filter((line) => omit === "" || !line.includes(omit));
  return `${declarations.join("\n")}\n${suffix}`;
}

async function createSdkDirectory(
  projectRoot,
  relative,
  {
    version = compatibleVersion,
    runtime = runtimeSource(),
    declarations = declarationSource(),
  } = {},
) {
  const sdkRoot = join(projectRoot, ...relative.split("/"));
  await mkdir(join(sdkRoot, "dist"), { recursive: true });
  await writeFile(
    join(sdkRoot, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version,
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
  await writeFile(join(sdkRoot, "dist", "index.js"), runtime, "utf8");
  await writeFile(join(sdkRoot, "dist", "index.d.ts"), declarations, "utf8");
  return sdkRoot;
}

function stableTreeHash(directory) {
  const helperDirectory = dirname(verifier);
  const result = runPython([
    "-c",
    [
      "import sys",
      "from pathlib import Path",
      "sys.path.insert(0, sys.argv[1])",
      "from verify_sdk_distribution import stable_tree_sha256",
      "print(stable_tree_sha256(Path(sys.argv[2])))",
    ].join("\n"),
    helperDirectory,
    directory,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function writeProfile(
  projectRoot,
  { kind, source, version = compatibleVersion, digest, extra = {} },
) {
  const profilePath = join(projectRoot, "public-services-profile.json");
  await writeFile(
    profilePath,
    `${JSON.stringify(
      {
        owner: "Bifang team",
        sdk_distribution: {
          kind,
          source,
          version,
          ...extra,
        },
        sdk_artifact_sha256: digest,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return profilePath;
}

function verify(profilePath, projectRoot) {
  return runPython([verifier, profilePath, "--project-root", projectRoot]);
}

async function createTarball(sourceDirectory, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const result = runPython([
    "-c",
    [
      "import pathlib, sys, tarfile",
      "source = pathlib.Path(sys.argv[1])",
      'with tarfile.open(sys.argv[2], "w:gz") as archive:',
      '    for path in sorted(item for item in source.rglob("*") if item.is_file()):',
      '        archive.add(path, arcname=(pathlib.PurePosixPath("package") / path.relative_to(source).as_posix()).as_posix(), recursive=False)',
    ].join("\n"),
    sourceDirectory,
    outputPath,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return createHash("sha256")
    .update(await readFile(outputPath))
    .digest("hex");
}

test("repository-copy and workspace distributions require the SDK 3 application-version surface", async (t) => {
  const root = await temporaryDirectory(t);

  for (const kind of ["repository_copy", "workspace"]) {
    const relative = `vendor/${kind}`;
    const sdkRoot = await createSdkDirectory(root, relative);
    const profile = await writeProfile(root, {
      kind,
      source: relative,
      digest: stableTreeHash(sdkRoot),
    });

    const result = verify(profile, root);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.version, compatibleVersion);
    assert.equal(evidence.artifact_bytes_verified, true);
    assert.equal(evidence.artifact_contract_verified, true);
  }
});

test("a matching hash cannot make a self-reported 2.x SDK compatible", async (t) => {
  const root = await temporaryDirectory(t);
  const relative = "vendor/sdk-v2";
  const sdkRoot = await createSdkDirectory(root, relative, {
    version: "2.0.0",
  });
  const profile = await writeProfile(root, {
    kind: "workspace",
    source: relative,
    version: "2.0.0",
    digest: stableTreeHash(sdkRoot),
  });

  const result = verify(profile, root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /version must be exactly 3\.0\.0/);
});

test("directory distributions reject missing checker exports, missing declarations, and static-manifest API", async (t) => {
  const root = await temporaryDirectory(t);
  const cases = [
    {
      label: "missing-runtime",
      options: {
        runtime: runtimeSource(
          runtimeExports.filter(
            (name) => name !== "parseApplicationVersionData",
          ),
        ),
      },
      error: /missing application-version exports: parseApplicationVersionData/,
    },
    {
      label: "missing-declaration",
      options: {
        declarations: declarationSource({
          omit: "ApplicationVersionCheckerConfig",
        }),
      },
      error:
        /missing application-version declarations: ApplicationVersionCheckerConfig/,
    },
    {
      label: "legacy-api",
      options: {
        runtime: runtimeSource(
          runtimeExports,
          "export class UpdateChecker {}\n",
        ),
      },
      error: /obsolete static-manifest API: UpdateChecker/,
    },
    {
      label: "legacy-declaration-field",
      options: {
        declarations: declarationSource({
          suffix: 'export interface UnsafeAddon { "rollout": number; }\n',
        }),
      },
      error: /obsolete static-manifest API: rollout/,
    },
  ];

  for (const fixture of cases) {
    const relative = `vendor/${fixture.label}`;
    const sdkRoot = await createSdkDirectory(root, relative, fixture.options);
    const profile = await writeProfile(root, {
      kind: "workspace",
      source: relative,
      digest: stableTreeHash(sdkRoot),
    });
    const result = verify(profile, root);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, fixture.error);
  }
});

test("comments, strings, templates and regex literals cannot fake public exports", async (t) => {
  const root = await temporaryDirectory(t);

  for (const kind of ["comment", "string", "template", "regex"]) {
    const runtimeRelative = `vendor/runtime-${kind}`;
    const runtimeSdk = await createSdkDirectory(root, runtimeRelative, {
      runtime: lexicalExportDecoy(kind, runtimeExports),
    });
    const runtimeProfile = await writeProfile(root, {
      kind: "workspace",
      source: runtimeRelative,
      digest: stableTreeHash(runtimeSdk),
    });
    const runtimeResult = verify(runtimeProfile, root);
    assert.equal(runtimeResult.status, 1, runtimeResult.stdout);
    assert.match(runtimeResult.stderr, /missing application-version exports/);

    const declarationRelative = `vendor/declaration-${kind}`;
    const declarationSdk = await createSdkDirectory(root, declarationRelative, {
      declarations: lexicalExportDecoy(kind, declarationExports),
    });
    const declarationProfile = await writeProfile(root, {
      kind: "workspace",
      source: declarationRelative,
      digest: stableTreeHash(declarationSdk),
    });
    const declarationResult = verify(declarationProfile, root);
    assert.equal(declarationResult.status, 1, declarationResult.stdout);
    assert.match(
      declarationResult.stderr,
      /missing application-version declarations/,
    );
  }
});

test("lexical decoys do not invent obsolete public APIs", async (t) => {
  const root = await temporaryDirectory(t);

  for (const kind of ["comment", "string", "template", "regex"]) {
    const relative = `vendor/legacy-decoy-${kind}`;
    const sdkRoot = await createSdkDirectory(root, relative, {
      runtime: runtimeSource(
        runtimeExports,
        lexicalExportDecoy(kind, ["UpdateChecker", "rolloutBucket"]),
      ),
    });
    const profile = await writeProfile(root, {
      kind: "workspace",
      source: relative,
      digest: stableTreeHash(sdkRoot),
    });
    const result = verify(profile, root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).artifact_contract_verified, true);
  }
});

test("unresolved export-star surfaces fail closed", async (t) => {
  const root = await temporaryDirectory(t);
  const relative = "vendor/export-star";
  const sdkRoot = await createSdkDirectory(root, relative, {
    runtime: runtimeSource(
      runtimeExports,
      'export * from "./uninspected-module.js";\n',
    ),
  });
  const profile = await writeProfile(root, {
    kind: "workspace",
    source: relative,
    digest: stableTreeHash(sdkRoot),
  });
  const result = verify(profile, root);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /export-star or namespace export/);
});

test("versioned tarballs receive the same application-version public-contract checks", async (t) => {
  const root = await temporaryDirectory(t);

  for (const [label, suffix, expectedStatus] of [
    ["valid", "", 0],
    ["legacy", "export function rolloutBucket() {}\n", 1],
  ]) {
    const source = await createSdkDirectory(root, `source-${label}`, {
      runtime: runtimeSource(runtimeExports, suffix),
    });
    const relative = `vendor/sdk-${label}.tgz`;
    const tarball = join(root, ...relative.split("/"));
    const digest = await createTarball(source, tarball);
    const profile = await writeProfile(root, {
      kind: "versioned_tarball",
      source: relative,
      digest,
    });
    const result = verify(profile, root);
    assert.equal(result.status, expectedStatus, result.stderr || result.stdout);
    if (expectedStatus === 0) {
      assert.equal(JSON.parse(result.stdout).artifact_contract_verified, true);
    } else {
      assert.match(
        result.stderr,
        /obsolete static-manifest API: rolloutBucket/,
      );
    }
  }
});

test("private-package evidence remains explicit about the unverified artifact contract", async (t) => {
  const root = await temporaryDirectory(t);
  const digest = "c".repeat(64);
  const evidenceRelative = "evidence/sdk-private-package.json";
  await mkdir(join(root, "evidence"), { recursive: true });
  await writeFile(
    join(root, ...evidenceRelative.split("/")),
    `${JSON.stringify(
      {
        package: packageName,
        version: compatibleVersion,
        artifact_sha256: digest,
        immutable_reference: `sha256:${digest}`,
        verified_by: "Bifang team",
        verified_at: "2026-09-10T14:00:00+08:00",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const profile = await writeProfile(root, {
    kind: "private_package",
    source: `${packageName}@${compatibleVersion}`,
    digest,
    extra: {
      verification_evidence: evidenceRelative,
      immutable_reference: `sha256:${digest}`,
    },
  });

  const result = verify(profile, root);
  assert.equal(result.status, 0, result.stderr);
  const verification = JSON.parse(result.stdout);
  assert.equal(verification.artifact_bytes_verified, false);
  assert.equal(verification.artifact_contract_verified, false);
  assert.equal(verification.verification_status, "manual_evidence_verified");
});
