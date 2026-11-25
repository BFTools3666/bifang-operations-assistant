import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);
const skillRoot = "skills/bifang-public-services-onboarding";
test("every customer console task has a usable official destination, location and completion instruction", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "bifang-onboarding.json"), "utf8"),
  );
  const { guides } = JSON.parse(
    await readFile(path.join(root, manifest.consoleGuidance.catalog), "utf8"),
  );
  for (const id of [
    "register",
    "identity",
    "serviceAccess",
    "createEnv",
    "environment",
    "quota",
    "user",
    "policy",
    "grant",
    "camKey",
    "sts",
    "postgres",
    "collections",
    "indexes",
    "functionCreate",
    "functionCode",
    "functionConfig",
    "domain",
    "routes",
    "logs",
  ]) {
    const guide = guides[id];
    assert.ok(guide, id);
    for (const field of ["entry", "source"]) {
      const url = new URL(guide[field]);
      assert.equal(url.protocol, "https:");
      assert.match(
        url.hostname,
        /^(?:[a-z]+\.)*cloud\.tencent\.com$|^docs\.cloudbase\.net$|^intl\.cloud\.tencent\.com$/,
      );
    }
    for (const field of ["title", "where", "result"])
      assert.ok(guide[field].trim(), id + "." + field);
  }
  assert.match(guides.environment.result, /cloudbase\.env_id/);
  assert.match(guides.environment.result, /cloudbase\.region/);
  assert.match(guides.camKey.result, /本机/);
});
const listFiles = async (dir) => {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relative = path.posix.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(relative) : [relative];
    }),
  );
  return nested.flat();
};

test("personal onboarding ships only its declared skill and valid local documentation links", async () => {
  const skillFiles = await listFiles(skillRoot);
  assert.deepEqual(
    skillFiles.sort(),
    [
      skillRoot + "/SKILL.md",
      skillRoot + "/agents/openai.yaml",
      skillRoot + "/assets/console-guides.json",
      skillRoot + "/references/personal-cloudbase.md",
      skillRoot + "/references/personal-resources.md",
      skillRoot + "/references/personal-client-confirmation.md",
      skillRoot + "/references/personal-client-implementation.md",
      skillRoot + "/references/personal-update-preflight.md",
      skillRoot + "/references/personal-release-management.md",
      skillRoot + "/references/dashboard-install.md",
      skillRoot + "/references/personal-artifact-testing.md",
      skillRoot + "/references/local-source.md",
      skillRoot + "/references/postgresql.md",
      skillRoot + "/references/retention-cleanup.md",
      skillRoot + "/references/shared-function-extension.md",
      skillRoot + "/scripts/local-source.mjs",
      skillRoot + "/assets/resource-input.template.json",
      skillRoot + "/assets/integration-input.template.json",
      skillRoot + "/assets/cam-inspect-policy.json",
      skillRoot + "/assets/cam-create-policy.json",
      skillRoot + "/assets/cam-shared-update-policy.json",
    ].sort(),
  );
  const entries = [
    "README.md",
    "AGENTS.md",
    "bifang-onboarding.json",
    "docs/毕方小工具公共服务分步接入指南.md",
    ...skillFiles,
  ];
  await execFileAsync(
    "git",
    ["ls-files", "--error-unmatch", "--", ...entries],
    {
      cwd: root,
      windowsHide: true,
    },
  );
  for (const entry of entries.filter((file) => file.endsWith(".md"))) {
    const content = await readFile(path.join(root, entry), "utf8");
    for (const match of content.matchAll(/\]\(([^\s)]+)\)/g)) {
      const link = match[1];
      if (/^[a-z]+:/i.test(link) || link.startsWith("#")) continue;
      const target = path.resolve(
        root,
        path.dirname(entry),
        decodeURIComponent(link.split("#")[0]),
      );
      assert.ok((await stat(target)).isFile(), entry + ": " + link);
    }
  }
});
