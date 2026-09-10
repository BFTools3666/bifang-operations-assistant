import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scanScript = join(
  repositoryRoot,
  "skills",
  "bifang-public-services-onboarding",
  "scripts",
  "scan_project.py",
);
const python = process.env.PYTHON || "python";

function scan(root) {
  const result = spawnSync(python, ["-X", "utf8", "-B", scanScript, root], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function project(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

const legacyManifestFields = `
  const {
    schema_version, app_id, platform, latest_version,
    min_supported_version, enabled, force_update, rollout,
    title, message, download_url, release_notes_url, sha256, published_at
  } = input;
`;

const strictModernClient = `
const RESPONSE_KEYS = [
  "update", "downloadUrl", "promptContent", "forcedUpdate",
  "promptUpdate", "stopUpdate", "updateContent"
];
export async function checkVersion(baseUrl, code, currentVersion, appKey, appSecret) {
  const url = \`\${baseUrl}/versions/\${encodeURIComponent(code)}/\${encodeURIComponent(currentVersion)}\`;
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-app-key": appKey, "x-app-secret": appSecret }
  });
  const value = await response.json();
  if (Object.keys(value).length !== RESPONSE_KEYS.length ||
      !RESPONSE_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  if (typeof value.update !== "boolean" ||
      typeof value.forcedUpdate !== "boolean" ||
      typeof value.promptUpdate !== "boolean" ||
      typeof value.stopUpdate !== "boolean") return null;
  if (value.stopUpdate) return { kind: "stopped", data: value };
  if (!value.update) return { kind: "up_to_date" };
  return { kind: value.forcedUpdate ? "required" : "optional", data: value };
}
`;

test("dynamic static-update paths, manifest parsing, rollout and compatibility switches block runtime migration", async (t) => {
  const root = await project(t, "bifang-dynamic-legacy-scan-");
  await writeFile(
    join(root, "src", "legacy-update.ts"),
    `
const UPDATE_BASE_URL = serviceOrigin;
const ENABLE_LEGACY_UPDATE_FALLBACK = true;
function buildManifestUrl(origin, appId, platform) {
  return new URL(["updates", appId, \`\${platform}.json\`].join("/"), origin);
}
function parseUpdateManifest(input) {
  ${legacyManifestFields}
  return { latest_version, min_supported_version, force_update, rollout, download_url };
}
function rolloutBucket(installId, rollout) {
  return hash(installId) % 100 < rollout;
}
`,
    "utf8",
  );

  const result = scan(root);
  const markers = new Set(
    result.legacy_static_update_hits.map((hit) => hit.marker),
  );
  assert.equal(result.legacy_update_status, "detected");
  assert.equal(result.legacy_update_removal_gate, "blocked");
  for (const expected of [
    "legacy_update_base_url",
    "dynamic_static_update_path",
    "legacy_manifest_parser",
    "legacy_manifest_field_contract",
    "legacy_rollout_algorithm",
    "legacy_update_compatibility",
  ]) {
    assert.ok(markers.has(expected), expected);
  }
  assert.ok(
    result.legacy_static_update_hits.every((hit) => hit.kind === "runtime"),
  );
});

test("a high-confidence legacy manifest type and field set is detected without a URL literal", async (t) => {
  const root = await project(t, "bifang-fields-legacy-scan-");
  await writeFile(
    join(root, "src", "update-types.ts"),
    `interface StaticUpdateManifest {
  schema_version: number;
  app_id: string;
  platform: string;
  latest_version: string;
  min_supported_version: string;
  enabled: boolean;
  force_update: boolean;
  rollout: number;
  title: string;
  message: string;
  download_url: string;
  release_notes_url: string;
  sha256: string;
  published_at: string;
}
`,
    "utf8",
  );

  const result = scan(root);
  const markers = result.legacy_static_update_hits.map((hit) => hit.marker);
  assert.equal(result.legacy_update_removal_gate, "blocked");
  assert.ok(markers.includes("legacy_manifest_type"));
  assert.ok(markers.includes("legacy_manifest_field_contract"));
});

test("generic manifest, rollout, fallback and update words do not create a legacy hit", async (t) => {
  const root = await project(t, "bifang-generic-update-scan-");
  await writeFile(
    join(root, "src", "ordinary.ts"),
    `
interface WebManifest { title: string; enabled: boolean; downloadUrl: string }
const rollout = 50;
const fallback = "system-default";
function parseManifest(value) { return JSON.parse(value); }
function updateProgress(value) { return Math.max(0, value); }
`,
    "utf8",
  );

  const result = scan(root);
  assert.equal(result.legacy_update_status, "not_found");
  assert.equal(result.legacy_update_removal_gate, "clear");
  assert.deepEqual(result.legacy_static_update_hits, []);
});

test("legacy combinations in documentation and tests remain non-runtime review evidence", async (t) => {
  const root = await project(t, "bifang-non-runtime-legacy-scan-");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  const historical = `function parseUpdateManifest(input) {
  ${legacyManifestFields}
  return ["updates", app_id, platform + ".json"].join("/");
}`;
  await writeFile(join(root, "docs", "history.md"), historical, "utf8");
  await writeFile(join(root, "tests", "legacy.test.ts"), historical, "utf8");

  const result = scan(root);
  assert.equal(result.legacy_update_status, "detected");
  assert.equal(result.legacy_update_removal_gate, "review");
  assert.equal(
    result.legacy_static_update_hits.some((hit) => hit.kind === "runtime"),
    false,
  );
  assert.deepEqual(
    new Set(result.legacy_static_update_hits.map((hit) => hit.kind)),
    new Set(["documentation", "test_fixture"]),
  );
});

test("only an authenticated request plus strict seven-field parser and decision is detected as the new client", async (t) => {
  const root = await project(t, "bifang-strict-version-client-scan-");
  await writeFile(
    join(root, "src", "version-client.ts"),
    strictModernClient,
    "utf8",
  );

  const complete = scan(root);
  assert.equal(complete.application_version_api_status, "detected");
  const completeMarkers = new Set(
    complete.application_version_api_hits.map((hit) => hit.marker),
  );
  for (const expected of [
    "application_version_request_construction",
    "strict_seven_field_response_parser",
    "application_version_decision",
  ]) {
    assert.ok(completeMarkers.has(expected), expected);
  }

  await writeFile(join(root, ".env.unreadable"), Buffer.from([0xff, 0xfe]));
  const incomplete = scan(root);
  assert.equal(incomplete.scan_incomplete, true);
  assert.equal(incomplete.application_version_api_status, "unknown");
  assert.equal(incomplete.legacy_update_removal_gate, "blocked");
});

test(
  "Windows target junctions are skipped and make the scan incomplete",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await project(t, "bifang-target-junction-scan-");
    const outside = await mkdtemp(join(tmpdir(), "bifang-outside-junction-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(
      join(outside, "outside.rs"),
      'const UPDATE = "https://outside.invalid/updates/escaped/windows.json";\n',
      "utf8",
    );
    const linked = join(root, "src", "linked");
    try {
      await symlink(outside, linked, "junction");
    } catch (error) {
      if (["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const result = scan(root);

    assert.equal(result.scan_incomplete, true);
    assert.equal(result.scanned_files, 0);
    assert.deepEqual(result.detected_app_ids, []);
    assert.deepEqual(result.legacy_static_update_hits, []);
    assert.equal(result.legacy_update_removal_gate, "blocked");
    assert.equal(Object.hasOwn(result, "legacy_update_status"), false);
    assert.ok(
      result.skipped_files.some(
        (entry) =>
          entry.path === "src/linked" &&
          /^(?:junction|reparse)_directory$/.test(entry.reason),
      ),
      JSON.stringify(result.skipped_files),
    );
  },
);

test("endpoint, headers, parser fields and decisions scattered across unrelated files do not certify a client", async (t) => {
  const root = await project(t, "bifang-scattered-version-markers-");
  await writeFile(
    join(root, "src", "endpoint.ts"),
    'export const endpoint = "/tools/version-control/v1/versions/tool/{version}";\n',
    "utf8",
  );
  await writeFile(
    join(root, "src", "key.ts"),
    'export const keyHeader = "x-app-key";\n',
    "utf8",
  );
  await writeFile(
    join(root, "src", "secret.ts"),
    'export const secretHeader = "x-app-secret";\n',
    "utf8",
  );
  await writeFile(
    join(root, "src", "shape.ts"),
    `const expectedKeys = ["update", "downloadUrl", "promptContent", "forcedUpdate", "promptUpdate", "stopUpdate", "updateContent"];
export const exact = (value) => Object.keys(value).length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
`,
    "utf8",
  );
  await writeFile(
    join(root, "src", "decision.ts"),
    `export function decide(value) {
  if (value.stopUpdate) return "stopped";
  if (!value.update) return "up_to_date";
  return value.forcedUpdate || value.promptUpdate ? "optional" : "required";
}
`,
    "utf8",
  );

  const result = scan(root);
  assert.notEqual(result.application_version_api_status, "detected");
  assert.equal(result.application_version_api_status, "partial");
});

test("a path and both header names alone are marker-only, not a detected client", async (t) => {
  const root = await project(t, "bifang-marker-only-version-scan-");
  await writeFile(
    join(root, "src", "constants.rs"),
    `const CHECK: &str = "/tools/version-control/v1/versions/tool/{version}";
const KEY: &str = "x-app-key";
const SECRET: &str = "x-app-secret";
`,
    "utf8",
  );

  const result = scan(root);
  assert.equal(result.application_version_api_status, "marker-only");
});
