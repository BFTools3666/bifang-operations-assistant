import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const NAME = "bifang-public-services-onboarding";
export const SKILL_PATH = "skills/" + NAME;
const BRANCH = "codex/personal-cloudbase";
const BINDING = ".source-location.json";
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "docs/毕方小工具公共服务分步接入指南.md",
  "cloudbase/personal/cli.mjs",
  "cloudbase/personal/client-confirmation.mjs",
  "cloudbase/personal/release-management.mjs",
  "cloudbase/personal/dashboard-upgrade.mjs",
  "cloudbase/personal/deployed-source.mjs",
  "cloudbase/functions/application-version-api/src/dashboard-releases.js",
  "cloudbase/functions/application-version-api/src/release-form.js",
  "cloudbase/functions/operations-dashboard/src/release-service.js",
  "cloudbase/functions/operations-dashboard/public/releases.html",
  "cloudbase/functions/operations-dashboard/public/releases.js",
  "cloudbase/personal/private-files.mjs",
  "cloudbase/personal/input-values.mjs",
  "cloudbase/personal/spec.mjs",
  "cloudbase/personal/cloud.mjs",
  "cloudbase/personal/shared.mjs",
  "cloudbase/personal/postgresql.mjs",
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

function check(condition, code) {
  if (!condition) throw new Error(code);
}
async function info(file) {
  try {
    return await lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
function inside(parent, target) {
  const relative = path.relative(parent, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}
async function noLinks(target) {
  let current = path.resolve(target);
  while (true) {
    check(
      !(await info(current))?.isSymbolicLink(),
      "LINKED_PATH_NOT_SUPPORTED",
    );
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function filesIn(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.posix.join(prefix, entry.name);
    check(!entry.isSymbolicLink(), "LINKED_SOURCE_NOT_SUPPORTED");
    if (entry.isDirectory())
      files.push(...(await filesIn(directory, relative)));
    else {
      check(entry.isFile(), "INVALID_SOURCE_FILE");
      files.push(relative);
    }
  }
  return files.sort();
}
async function digest(directory, files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file + "\0");
    hash.update(
      createHash("sha256")
        .update(await readFile(path.join(directory, file)))
        .digest(),
    );
  }
  return hash.digest("hex");
}

// Inspect files only; never import or execute code from a discovered repository.
export async function inspectSource(candidate) {
  check(path.isAbsolute(candidate), "SOURCE_PATH_MUST_BE_ABSOLUTE");
  await noLinks(candidate);
  const root = await realpath(candidate);
  await noLinks(path.join(root, "bifang-onboarding.json"));
  const manifest = JSON.parse(
    await readFile(path.join(root, "bifang-onboarding.json"), "utf8"),
  );
  check(
    manifest.schemaVersion === 2 &&
      manifest.mode === "personal-free-cloudbase" &&
      manifest.sourceBranch === BRANCH &&
      manifest.skill?.name === NAME &&
      manifest.skill.path === SKILL_PATH &&
      /^\d+\.\d+\.\d+-personal\.\d+$/.test(manifest.skill.version),
    "NOT_PERSONAL_SOURCE",
  );
  const skillDirectory = path.join(root, SKILL_PATH);
  await noLinks(skillDirectory);
  const skillText = await readFile(
    path.join(skillDirectory, "SKILL.md"),
    "utf8",
  );
  check(
    skillText.includes(`version: "${manifest.skill.version}"`) &&
      skillText.includes(`source-branch: "${BRANCH}"`) &&
      skillText.includes(`name: ${NAME}`),
    "SOURCE_METADATA_MISMATCH",
  );
  for (const file of requiredFiles) {
    const target = path.join(root, file);
    await noLinks(target);
    check((await info(target))?.isFile(), "INCOMPLETE_SOURCE");
  }
  const files = await filesIn(skillDirectory);
  check(
    [
      "agents/openai.yaml",
      "assets/console-guides.json",
      "assets/resource-input.template.json",
      "assets/integration-input.template.json",
      "assets/cam-inspect-policy.json",
      "assets/cam-create-policy.json",
      "references/personal-cloudbase.md",
      "references/personal-resources.md",
      "references/personal-client-confirmation.md",
      "references/personal-client-implementation.md",
      "references/personal-update-preflight.md",
      "references/personal-release-management.md",
      "references/local-source.md",
    ].every((file) => files.includes(file)),
    "INCOMPLETE_SKILL",
  );
  check(!files.includes(BINDING), "LOCAL_BINDING_IN_SOURCE");
  check(files.includes("scripts/local-source.mjs"), "SOURCE_INSTALLER_MISSING");
  let sourceKind = "archive";
  if (await info(path.join(root, ".git"))) {
    const branch = execFileSync(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    check(branch === BRANCH, "WRONG_SOURCE_BRANCH");
    sourceKind = "git";
  }
  return {
    root,
    skillDirectory,
    version: manifest.skill.version,
    bareInvocation: manifest.intentRouting?.bareInvocation,
    numberedConfirmation: manifest.numberedConfirmation,
    choiceMenus: manifest.choiceMenus,
    fileInput: manifest.fileInput,
    consoleGuidance: manifest.consoleGuidance,
    branch: BRANCH,
    sourceKind,
    files,
    skillSha256: await digest(skillDirectory, files),
  };
}

export async function resolveSource({
  skillDirectory = HERE,
  cwd = process.cwd(),
  downloads = path.join(os.homedir(), "Downloads"),
  source,
} = {}) {
  const finish = async (candidate, via) => {
    const result = await inspectSource(candidate);
    const installedFiles = (await filesIn(skillDirectory)).filter(
      (file) => file !== BINDING,
    );
    return {
      status: "source-resolved",
      source: result.root,
      via,
      version: result.version,
      ...(result.bareInvocation && { bareInvocation: result.bareInvocation }),
      ...(result.numberedConfirmation && {
        numberedConfirmation: result.numberedConfirmation,
      }),
      ...(result.choiceMenus && { choiceMenus: result.choiceMenus }),
      ...(result.fileInput && { fileInput: result.fileInput }),
      ...(result.consoleGuidance && {
        consoleGuidance: result.consoleGuidance,
      }),
      branch: result.branch,
      sourceKind: result.sourceKind,
      skill: path.join(result.skillDirectory, "SKILL.md"),
      installedCopyMatchesSource:
        result.skillSha256 === (await digest(skillDirectory, installedFiles)),
      cloudRequests: 0,
    };
  };
  if (source) return finish(path.resolve(source), "explicit");
  const enclosing = path.resolve(skillDirectory, "../..");
  if (
    path.resolve(enclosing, SKILL_PATH) === path.resolve(skillDirectory) &&
    (await info(path.join(enclosing, "bifang-onboarding.json")))
  ) {
    return finish(enclosing, "in-repository");
  }
  let binding;
  if (await info(path.join(skillDirectory, BINDING))) {
    await noLinks(path.join(skillDirectory, BINDING));
    binding = JSON.parse(
      await readFile(path.join(skillDirectory, BINDING), "utf8"),
    );
    check(
      binding.schemaVersion === 1 &&
        binding.skill === NAME &&
        typeof binding.source === "string" &&
        path.isAbsolute(binding.source),
      "INVALID_SOURCE_BINDING",
    );
    // An existing but incompatible bound copy must not silently switch to another copy.
    if (await info(binding.source))
      return finish(binding.source, "installation-binding");
  }
  const containers = new Set([path.resolve(downloads)]);
  if (binding) containers.add(path.dirname(binding.source));
  let ancestor = path.resolve(cwd);
  for (
    let level = 0;
    level < 3 && path.dirname(ancestor) !== ancestor;
    level++
  ) {
    containers.add(ancestor);
    ancestor = path.dirname(ancestor);
  }
  const candidates = new Set();
  const truncated = [];
  for (const container of containers) {
    candidates.add(container);
    if (!(await info(container))?.isDirectory()) continue;
    await noLinks(container);
    const entries = await readdir(container, { withFileTypes: true });
    // Never silently choose one candidate from a partially inspected directory.
    if (entries.length > 200) {
      truncated.push(container);
      continue;
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !entry.name.startsWith(".") &&
        entry.name !== "node_modules"
      )
        candidates.add(path.join(container, entry.name));
    }
  }
  const valid = new Map();
  for (const candidate of candidates) {
    if (!(await info(path.join(candidate, "bifang-onboarding.json")))) continue;
    try {
      const result = await inspectSource(candidate);
      valid.set(result.root, result);
    } catch {
      /* A similarly named or company checkout is not a personal source. */
    }
  }
  if (valid.size === 1 && truncated.length === 0)
    return finish([...valid.keys()][0], "bounded-discovery");
  return {
    status: valid.size > 1 ? "source-ambiguous" : "source-not-found",
    candidates: [...valid.keys()],
    searched: [...containers],
    truncated,
    nextAction:
      "ask-for-one-repository-root-or-run-skill-install-from-the-chosen-copy",
    cloudRequests: 0,
  };
}

export async function installSkill({
  source = path.resolve(HERE, "../.."),
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
} = {}) {
  const checked = await inspectSource(path.resolve(source));
  const home = path.resolve(codexHome);
  // Only the named skill is replaced. Stage and backup remain outside the skills loader.
  check(
    home !== checked.root &&
      !inside(checked.root, home) &&
      !inside(home, checked.root),
    "INSTALL_SOURCE_OVERLAP",
  );
  const destination = path.join(home, "skills", NAME);
  const backupRoot = path.join(home, "skill-backups", NAME);
  await noLinks(destination);
  await noLinks(backupRoot);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(backupRoot, { recursive: true });
  const transaction = await mkdtemp(path.join(backupRoot, "local-"));
  const stage = path.join(transaction, "staged");
  const backup = path.join(transaction, "previous");
  check(
    inside(home, destination) && inside(backupRoot, transaction),
    "INVALID_INSTALL_TARGET",
  );
  for (const file of checked.files) {
    await mkdir(path.dirname(path.join(stage, file)), { recursive: true });
    await copyFile(
      path.join(checked.skillDirectory, file),
      path.join(stage, file),
    );
  }
  check(
    (await digest(stage, checked.files)) === checked.skillSha256,
    "SOURCE_CHANGED_DURING_INSTALL",
  );
  const binding = {
    schemaVersion: 1,
    skill: NAME,
    source: checked.root,
    versionAtInstall: checked.version,
    branch: checked.branch,
    installedAt: new Date().toISOString(),
    skillSha256: checked.skillSha256,
  };
  await writeFile(
    path.join(stage, BINDING),
    JSON.stringify(binding, null, 2) + "\n",
    { flag: "wx" },
  );
  const previous = await info(destination);
  check(!previous || previous.isDirectory(), "INVALID_EXISTING_INSTALLATION");
  if (previous) await rename(destination, backup);
  try {
    await rename(stage, destination);
  } catch (error) {
    if (previous) await rename(backup, destination);
    throw error;
  }
  check(
    (await digest(destination, checked.files)) === checked.skillSha256,
    "INSTALLED_HASH_MISMATCH",
  );
  const receipt = {
    status: "skill-installed",
    source: checked.root,
    installed: destination,
    version: checked.version,
    files: checked.files.length,
    verified: true,
    binding: path.join(destination, BINDING),
    backup: previous ? backup : null,
    cloudRequests: 0,
  };
  await writeFile(
    path.join(transaction, "install-receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  return receipt;
}

export async function run(args) {
  const [command, flag, value, ...extra] = args;
  check(
    ["install", "resolve"].includes(command) &&
      extra.length === 0 &&
      ((!flag && !value) ||
        (typeof value === "string" &&
          flag === (command === "install" ? "--codex-home" : "--source"))),
    "INVALID_ARGUMENTS",
  );
  const result =
    command === "install"
      ? await installSkill(value ? { codexHome: value } : {})
      : await resolveSource(value ? { source: value } : {});
  console.log(JSON.stringify(result, null, 2));
  if (!["source-resolved", "skill-installed"].includes(result.status))
    process.exitCode = 2;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  run(process.argv.slice(2)).catch((error) => {
    // Do not print command buffers or arbitrary file contents on errors.
    console.error(
      JSON.stringify({
        status: "local-source-error",
        code: /^[A-Z_]+$/.test(error.message)
          ? error.message
          : error.code || "SOURCE_VALIDATION_FAILED",
      }),
    );
    process.exitCode = 1;
  });
}
