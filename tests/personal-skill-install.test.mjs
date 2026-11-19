import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  inspectSource,
  installSkill,
  resolveSource,
  NAME,
  SKILL_PATH,
} from "../skills/bifang-public-services-onboarding/scripts/local-source.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const required = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "bifang-onboarding.json",
  "docs/毕方小工具公共服务分步接入指南.md",
  "cloudbase/personal/cli.mjs",
  "cloudbase/personal/client-confirmation.mjs",
  "cloudbase/personal/release-management.mjs",
  "cloudbase/personal/private-files.mjs",
  "cloudbase/personal/spec.mjs",
  "cloudbase/personal/cloud.mjs",
  "cloudbase/personal/shared.mjs",
  "cloudbase/personal/postgresql.mjs",
  "cloudbase/functions/telemetry/src/cleanup.js",
  "cloudbase/functions/telemetry/src/writer.js",
  "cloudbase/tencent-cloud-api.mjs",
  "cloudbase/generate-cloudbaserc.mjs",
  "cloudbase/app-labels.mjs",
  "cloudbase/deploy-operations-dashboard-code.mjs",
  "cloudbase/functions/application-version-api/src/auth.js",
  "cloudbase/functions/application-version-api/src/validation.js",
  "cloudbase/functions/application-version-api/src/version.js",
  ...["telemetry", "application-version-api", "operations-dashboard"].flatMap(
    (name) =>
      ["index.js", "package.json", "src/handler.js"].map(
        (file) => `cloudbase/functions/${name}/${file}`,
      ),
  ),
];
async function fixture(t) {
  const temporaryRoot = await realpath(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, "bifang-skill-test-"));
  t.after(async () => {
    // Recursive cleanup is confined to this test's verified, generated directory.
    assert.equal(path.dirname(root), temporaryRoot);
    assert.ok(path.basename(root).startsWith("bifang-skill-test-"));
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "下载目录", "任意 项目名称");
  for (const file of required) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await cp(path.join(repository, file), path.join(source, file));
  }
  await cp(path.join(repository, SKILL_PATH), path.join(source, SKILL_PATH), {
    recursive: true,
  });
  const codexHome = path.join(root, "codex home");
  const skillDirectory = path.join(codexHome, "skills", NAME);
  const cwd = path.join(root, "目标项目", "客户项目");
  await mkdir(cwd, { recursive: true });
  const downloads = path.join(root, "unused-downloads");
  return { root, source, codexHome, skillDirectory, cwd, downloads };
}
const resolveInstalled = ({ skillDirectory, cwd, downloads }) =>
  resolveSource({ skillDirectory, cwd, downloads });
const json = async (file) => JSON.parse(await readFile(file, "utf8"));

test("local installer binds a renamed ZIP checkout without network or npm dependencies", async (t) => {
  const f = await fixture(t);
  const source = await inspectSource(f.source);
  assert.equal(source.sourceKind, "archive");
  const script = path.join(f.source, SKILL_PATH, "scripts/local-source.mjs");
  // Execute from an unrelated customer cwd: source comes from the script location.
  const receipt = JSON.parse(
    execFileSync(process.execPath, [script, "install"], {
      cwd: f.cwd,
      env: { ...process.env, CODEX_HOME: f.codexHome },
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  assert.equal(receipt.source, f.source);
  assert.equal(receipt.installed, f.skillDirectory);
  assert.equal(receipt.cloudRequests, 0);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.backup, null);
  for (const file of source.files) {
    assert.deepEqual(
      await readFile(path.join(f.skillDirectory, file)),
      await readFile(path.join(f.source, SKILL_PATH, file)),
    );
  }
  const bound = await json(
    path.join(f.skillDirectory, ".source-location.json"),
  );
  assert.equal(bound.source, f.source);
  assert.equal(bound.skillSha256, source.skillSha256);
  const installed = await resolveInstalled(f);
  assert.equal(installed.via, "installation-binding");
  assert.equal(installed.installedCopyMatchesSource, true);
  assert.equal(installed.bareInvocation.action, "show-menu-and-wait");
  assert.deepEqual(
    installed.bareInvocation.options.map(({ choice, route }) => [
      choice,
      route,
    ]),
    [
      ["1", "firstIntegration"],
      ["2", "manageExistingRelease"],
    ],
  );
  assert.equal((await readdir(f.cwd)).length, 0);
});

test("update preserves the previous skill outside the loader and detects current local changes", async (t) => {
  const f = await fixture(t);
  await mkdir(f.skillDirectory, { recursive: true });
  await writeFile(path.join(f.skillDirectory, "SKILL.md"), "old company skill");
  const first = await installSkill(f);
  assert.ok(
    first.backup.startsWith(path.join(f.codexHome, "skill-backups") + path.sep),
  );
  assert.equal(
    await readFile(path.join(first.backup, "SKILL.md"), "utf8"),
    "old company skill",
  );
  const sourceFile = path.join(f.source, SKILL_PATH, "SKILL.md");
  await writeFile(
    sourceFile,
    (await readFile(sourceFile, "utf8")) + "\n本地规范修订。\n",
  );
  const current = await resolveInstalled(f);
  assert.equal(current.source, f.source);
  assert.equal(current.installedCopyMatchesSource, false);
  const updated = await installSkill(f);
  assert.notEqual(updated.backup, first.backup);
  assert.equal((await resolveInstalled(f)).installedCopyMatchesSource, true);
  assert.deepEqual(await readdir(path.join(f.codexHome, "skills")), [NAME]);
});

test("a moved source is found by bounded sibling discovery; multiple copies require selection", async (t) => {
  const f = await fixture(t);
  await installSkill(f);
  const moved = path.join(path.dirname(f.source), "新目录名称");
  await rename(f.source, moved);
  const found = await resolveInstalled(f);
  assert.equal(found.source, moved);
  assert.equal(found.via, "bounded-discovery");
  const other = path.join(path.dirname(f.source), "第二份");
  await cp(moved, other, { recursive: true });
  const ambiguous = await resolveInstalled(f);
  assert.equal(ambiguous.status, "source-ambiguous");
  assert.deepEqual(new Set(ambiguous.candidates), new Set([moved, other]));
  assert.equal((await resolveSource({ ...f, source: other })).source, other);
  // Resolve remains read-only; reinstallation is what changes the binding.
  assert.equal(
    (await json(path.join(f.skillDirectory, ".source-location.json"))).source,
    f.source,
  );
});

test("unbound installations find a unique Downloads archive but do not recurse into arbitrary folders", async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.skillDirectory), { recursive: true });
  await cp(path.join(f.source, SKILL_PATH), f.skillDirectory, {
    recursive: true,
  });
  const moved = path.join(f.downloads, "客户下载的项目");
  await mkdir(f.downloads);
  await rename(f.source, moved);
  assert.equal((await resolveInstalled(f)).source, moved);
  await mkdir(path.join(f.downloads, "深层", "内部"), { recursive: true });
  await rename(moved, path.join(f.downloads, "深层", "内部", "项目"));
  assert.equal((await resolveInstalled(f)).status, "source-not-found");
});

test("a directory exceeding the discovery bound cannot cause an arbitrary automatic selection", async (t) => {
  const f = await fixture(t);
  await installSkill(f);
  const moved = path.join(path.dirname(f.source), "移后名称");
  await rename(f.source, moved);
  await mkdir(f.downloads);
  await Promise.all(
    Array.from({ length: 201 }, (_, n) =>
      writeFile(path.join(f.downloads, `${n}.txt`), ""),
    ),
  );
  const found = await resolveInstalled(f);
  assert.equal(found.status, "source-not-found");
  assert.deepEqual(found.candidates, [moved]);
  assert.deepEqual(found.truncated, [f.downloads]);
});

test("company metadata and missing tools cannot replace a valid local installation", async (t) => {
  const f = await fixture(t);
  await installSkill(f);
  const installed = await readFile(
    path.join(f.skillDirectory, "SKILL.md"),
    "utf8",
  );
  const manifestFile = path.join(f.source, "bifang-onboarding.json");
  const manifest = await json(manifestFile);
  await writeFile(
    manifestFile,
    JSON.stringify({ ...manifest, mode: "company-managed" }),
  );
  await assert.rejects(installSkill(f), /NOT_PERSONAL_SOURCE/);
  await assert.rejects(resolveInstalled(f), /NOT_PERSONAL_SOURCE/);
  await writeFile(manifestFile, JSON.stringify(manifest));
  const cli = path.join(f.source, "cloudbase/personal/cli.mjs");
  await rename(cli, cli + ".missing");
  await assert.rejects(installSkill(f), /INCOMPLETE_SOURCE/);
  assert.equal(
    await readFile(path.join(f.skillDirectory, "SKILL.md"), "utf8"),
    installed,
  );
});

test("actual Git branch is checked and cannot silently fall back to a different source", async (t) => {
  const f = await fixture(t);
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: f.source,
      windowsHide: true,
      stdio: "pipe",
    });
  git("init", "--initial-branch=codex/personal-cloudbase");
  await installSkill(f);
  assert.equal((await resolveInstalled(f)).sourceKind, "git");
  git("symbolic-ref", "HEAD", "refs/heads/main");
  await assert.rejects(resolveInstalled(f), /WRONG_SOURCE_BRANCH/);
});

test("linked install targets and installs inside the source are rejected before mutation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    installSkill({ ...f, codexHome: path.join(f.source, ".codex") }),
    /INSTALL_SOURCE_OVERLAP/,
  );
  const external = path.join(f.root, "other-directory");
  await mkdir(external);
  await writeFile(path.join(external, "keep.txt"), "preserve");
  await mkdir(path.dirname(f.skillDirectory), { recursive: true });
  await symlink(
    external,
    f.skillDirectory,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(installSkill(f), /LINKED_PATH_NOT_SUPPORTED/);
  assert.equal(
    await readFile(path.join(external, "keep.txt"), "utf8"),
    "preserve",
  );
});

test("running directly from the personal repository needs no installation binding", async () => {
  const result = await resolveSource({
    skillDirectory: path.join(repository, SKILL_PATH),
  });
  assert.equal(result.via, "in-repository");
  assert.equal(result.installedCopyMatchesSource, true);
  assert.equal(result.cloudRequests, 0);
});
