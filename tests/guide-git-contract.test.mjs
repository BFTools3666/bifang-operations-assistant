import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const listFiles = async (relativeDirectory) => {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
};

const requiredGuideFiles = [
  "AGENTS.md",
  "README.md",
  "docs/毕方小工具公共服务分步接入指南.md",
  "docs/cloudbase-quickstart.md",
  "docs/CloudBase免费额度内部署新手图文版.docx",
  "docs/multi-tool-isolation.md",
  "docs/telemetry-and-update.md",
  "docs/application-version-api-zero-code-contract.md",
  "examples/host-integration.ts",
  "cloudbase/apps.json",
  "cloudbase/generate-cloudbaserc.mjs",
  "skills/bifang-public-services-onboarding/SKILL.md",
  "skills/bifang-public-services-onboarding/agents/openai.yaml",
  "tools/build_cloudbase_guide_docx.py",
  "tools/docx-requirements.txt",
  "tests/guide-git-contract.test.mjs",
];

const requiredApplicationVersionFiles = [
  "cloudbase/plan-application-version-api-deployment.mjs",
  "cloudbase/functions/application-version-api/package.json",
  "cloudbase/functions/application-version-api/index.js",
  "cloudbase/functions/application-version-api/src/auth.js",
  "cloudbase/functions/application-version-api/src/errors.js",
  "cloudbase/functions/application-version-api/src/handler.js",
  "cloudbase/functions/application-version-api/src/memory-repository.js",
  "cloudbase/functions/application-version-api/src/rate-limit.js",
  "cloudbase/functions/application-version-api/src/repository.js",
  "cloudbase/functions/application-version-api/src/validation.js",
  "cloudbase/functions/application-version-api/src/version.js",
  "contracts/application-version-api-v1/README.md",
  "contracts/application-version-api-v1/openapi.json",
  "contracts/application-version-api-v1/schema.json",
  "contracts/application-version-api-v1/fixtures/runtime-decision-cases.json",
];

test("the complete onboarding guide has tracked human and AI entrypoints", async () => {
  const screenshotFiles = await listFiles("docs/images/cloudbase");
  const skillFiles = await listFiles(
    "skills/bifang-public-services-onboarding",
  );
  const trackedGuideFiles = [
    ...requiredGuideFiles,
    ...requiredApplicationVersionFiles,
    ...screenshotFiles,
    ...skillFiles,
  ];

  assert.ok(screenshotFiles.length > 0, "the beginner guide needs screenshots");

  await execFileAsync(
    "git",
    ["ls-files", "--error-unmatch", "--", ...trackedGuideFiles],
    { cwd: repositoryRoot, windowsHide: true },
  );

  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");
  const agentGuide = await readFile(
    path.join(repositoryRoot, "AGENTS.md"),
    "utf8",
  );
  const beginnerGuide = await readFile(
    path.join(repositoryRoot, "docs/cloudbase-quickstart.md"),
    "utf8",
  );
  const onboardingGuide = await readFile(
    path.join(repositoryRoot, "docs/毕方小工具公共服务分步接入指南.md"),
    "utf8",
  );

  assert.ok(readme.includes("[`AGENTS.md`](AGENTS.md)"));
  assert.match(readme, /docs\/毕方小工具公共服务分步接入指南\.md/);
  for (const relativePath of requiredGuideFiles.slice(2)) {
    assert.ok(
      agentGuide.includes(`\`${relativePath}\``) ||
        agentGuide.includes(relativePath),
      `AGENTS.md must route AI readers to ${relativePath}`,
    );
  }

  assert.match(readme, /cloudbase\/apps\.json[^\n]+唯一权威/);
  assert.doesNotMatch(
    beginnerGuide,
    /cloudbase\/updates\/bifang-tools(?:\/|`)/,
  );
  assert.match(onboardingGuide, /历史首次检查示例：毕方录屏助手/);
  assert.match(
    onboardingGuide,
    /cloudbase-bifang-screen-recorder-20260905\.md/,
  );
});
