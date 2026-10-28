import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillName = "bifang-public-services-onboarding";
const sourceSkill = join(repositoryRoot, "skills", skillName);
const installer = join(sourceSkill, "scripts", "install_skill.py");
const python = process.env.PYTHON || "python";

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "bifang-onboarding-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runInstaller(
  codexHome,
  source,
  extraEnvironment = {},
  extraArguments = [],
) {
  return spawnSync(
    python,
    ["-B", installer, "--source", source, ...extraArguments],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        PYTHONDONTWRITEBYTECODE: "1",
        ...extraEnvironment,
      },
    },
  );
}

async function copySkill(source, destination) {
  await cp(source, destination, { recursive: true });
}

async function createInstallableSource(root, label = "source") {
  const destination = join(root, label, skillName);
  await mkdir(dirname(destination), { recursive: true });
  await copySkill(sourceSkill, destination);
  const skillMd = join(destination, "SKILL.md");
  const content = await readFile(skillMd, "utf8");
  const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
  const sourceCommit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let updated;
  if (/^  infrastructure-source-commit:/m.test(content)) {
    updated = content.replace(
      /^  infrastructure-source-commit:.*$/m,
      `  infrastructure-source-commit: "${sourceCommit}"`,
    );
  } else {
    const lines = content.split(/\r?\n/);
    const infrastructureVersionIndex = lines.findIndex((line) =>
      line.startsWith("  infrastructure-version:"),
    );
    assert.notEqual(
      infrastructureVersionIndex,
      -1,
      "fixture infrastructure-version must exist",
    );
    lines.splice(
      infrastructureVersionIndex + 1,
      0,
      `  infrastructure-source-commit: "${sourceCommit}"`,
    );
    updated = lines.join(lineEnding);
  }
  await writeFile(skillMd, updated, "utf8");
  return destination;
}

async function setMetadata(skillDirectory, key, value) {
  const skillMd = join(skillDirectory, "SKILL.md");
  const current = await readFile(skillMd, "utf8");
  const pattern = new RegExp(
    `^(  ${key}:\\s*)(?:"[^"]*"|'[^']*'|\\S+)(\\r?)$`,
    "m",
  );
  assert.match(current, pattern, `fixture metadata ${key} must exist`);
  await writeFile(
    skillMd,
    current.replace(
      pattern,
      (_match, prefix, lineEnding) => `${prefix}"${value}"${lineEnding}`,
    ),
    "utf8",
  );
}

async function createOtherSkill(codexHome) {
  const sentinel = join(codexHome, "skills", "unrelated-skill", "sentinel.txt");
  await mkdir(dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "must remain unchanged\n", "utf8");
  return sentinel;
}

async function materializeCanonicalLegacySkill(
  codexHome,
  commit = "55f4a031df2756a4e37b1f2e6fe1d9cb91c9db37",
  crlf = false,
) {
  const prefix = `skills/${skillName}/`;
  const listed = run(
    "git",
    ["ls-tree", "-r", "--name-only", commit, "--", prefix],
    { cwd: repositoryRoot },
  );
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const destination = join(codexHome, "skills", skillName);
  for (const repositoryPath of listed.stdout.trim().split(/\r?\n/)) {
    const shown = run("git", ["show", `${commit}:${repositoryPath}`], {
      cwd: repositoryRoot,
    });
    assert.equal(shown.status, 0, shown.stderr || shown.stdout);
    const relative = repositoryPath.slice(prefix.length);
    const output = join(destination, ...relative.split("/"));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      crlf === true || (crlf === "mixed" && relative.endsWith(".py"))
        ? shown.stdout.replace(/\r?\n/g, "\r\n")
        : shown.stdout,
      "utf8",
    );
  }
  return destination;
}

test("checked-in source installs with its recorded real provenance", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");

  const result = runInstaller(codexHome, sourceSkill);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const installed = await readFile(
    join(codexHome, "skills", skillName, "SKILL.md"),
    "utf8",
  );
  const checkedIn = await readFile(join(sourceSkill, "SKILL.md"), "utf8");
  const sourceCommit = checkedIn.match(
    /^  infrastructure-source-commit: "([0-9a-f]{40})"\r?$/m,
  );
  assert.ok(sourceCommit);
  assert.match(
    installed,
    new RegExp(
      `^  infrastructure-source-commit: "${sourceCommit[1]}"\\r?$`,
      "m",
    ),
  );
});

test("first install targets an isolated temporary CODEX_HOME", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const sentinel = await createOtherSkill(codexHome);

  const result = runInstaller(codexHome, source);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] installed:/);
  const installedSkillMd = await readFile(
    join(codexHome, "skills", skillName, "SKILL.md"),
    "utf8",
  );
  assert.match(
    installedSkillMd,
    /^name: bifang-public-services-onboarding\r?$/m,
  );
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
  const entries = await readdir(join(codexHome, "skills"));
  assert.deepEqual(entries.sort(), [skillName, "unrelated-skill"].sort());
});

test("an unknown same-name skill is never overwritten", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const target = join(codexHome, "skills", skillName);
  const sentinel = await createOtherSkill(codexHome);
  await mkdir(target, { recursive: true });
  const unknown = `---\nname: ${skillName}\ndescription: unrelated local skill\nmetadata:\n  version: "2.0.0"\n  infrastructure-version: "3.0.0"\n  infrastructure-source-commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n  application-version-contract-version: "1.0.0"\n  application-version-baseline-commit: "92b0c599a42c3a094c99787e6928c30c2d2ea3af"\n  source-repository: "someone-elses-repository"\n  canonical-repository-url: "https://github.com/BFTools3666/bifang-operations-assistant.git"\n---\n\nDo not overwrite.\n`;
  await writeFile(join(target, "SKILL.md"), unknown, "utf8");

  const result = runInstaller(codexHome, source);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /refusing to overwrite an unknown same-name skill/i,
  );
  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), unknown);
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
});

test("an unrecognized older same-source installation is preserved", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const oldSource = await createInstallableSource(root, "old-source");
  const newSource = await createInstallableSource(root, "new-source");
  await setMetadata(oldSource, "version", "0.9.0");
  await setMetadata(oldSource, "infrastructure-version", "2.0.0");
  await writeFile(
    join(oldSource, "local-owner-note.txt"),
    "must not be overwritten\n",
    "utf8",
  );
  const sentinel = await createOtherSkill(codexHome);

  const first = runInstaller(codexHome, oldSource);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const target = join(codexHome, "skills", skillName);
  const before = await readFile(join(target, "SKILL.md"), "utf8");
  const result = runInstaller(codexHome, newSource);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unrecognized older same-name Skill.*exact canonical published v1/is,
  );
  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), before);
  assert.equal(
    await readFile(join(target, "local-owner-note.txt"), "utf8"),
    "must not be overwritten\n",
  );
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
  const entries = await readdir(join(codexHome, "skills"));
  assert.deepEqual(entries.sort(), [skillName, "unrelated-skill"].sort());
});

test("a canonical v1 infrastructure-2.1 installation upgrades atomically", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const target = await materializeCanonicalLegacySkill(codexHome);
  const sentinel = await createOtherSkill(codexHome);

  const result = runInstaller(codexHome, sourceSkill);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] updated:/);
  const installed = await readFile(join(target, "SKILL.md"), "utf8");
  assert.match(installed, /^  version: "2\.1\.4"\r?$/m);
  assert.match(installed, /^  infrastructure-version: "3\.0\.0"\r?$/m);
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
  const entries = await readdir(join(codexHome, "skills"));
  assert.deepEqual(entries.sort(), [skillName, "unrelated-skill"].sort());
});

test("canonical v1 with mixed checkout line endings upgrades safely", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  await materializeCanonicalLegacySkill(
    codexHome,
    "55f4a031df2756a4e37b1f2e6fe1d9cb91c9db37",
    "mixed",
  );
  const result = runInstaller(codexHome, sourceSkill);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] updated:/);
});

test("same version accepts line-ending differences but rejects content changes", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  assert.equal(runInstaller(codexHome, source).status, 0);
  const file = join(codexHome, "skills", skillName, "SKILL.md");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace(/\r?\n/g, "\r\n"), "utf8");
  const same = runInstaller(codexHome, source);
  assert.equal(same.status, 0, same.stderr || same.stdout);
  assert.match(same.stdout, /\[OK\] already-current:/);
  await writeFile(file, original + "\nUnapproved change\n", "utf8");
  const rejected = runInstaller(codexHome, source);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /same skill version has different content/i);
});

test("modified content cannot impersonate the canonical v1 installation", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const target = await materializeCanonicalLegacySkill(codexHome);
  const protectedFile = join(target, "local-owner-note.txt");
  await writeFile(protectedFile, "do not replace\n", "utf8");

  const result = runInstaller(codexHome, sourceSkill);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unknown same-name skill.*canonical published tree/is,
  );
  assert.equal(await readFile(protectedFile, "utf8"), "do not replace\n");
  const installed = await readFile(join(target, "SKILL.md"), "utf8");
  assert.match(installed, /^  version: "1\.0\.0"\r?$/m);
});

test("published v2.0.0 installations upgrade to the name-aware Skill on LF and CRLF checkouts", async (t) => {
  for (const crlf of [false, true]) {
    const root = await temporaryDirectory(t);
    const codexHome = join(root, "codex-home");
    const target = await materializeCanonicalLegacySkill(
      codexHome,
      "f41c0048a2ab7e73e70235829578bdcf1247aa48",
      crlf,
    );
    const sentinel = await createOtherSkill(codexHome);
    const result = runInstaller(codexHome, sourceSkill);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[OK\] updated:/);
    assert.match(
      await readFile(join(target, "SKILL.md"), "utf8"),
      /^  version: "2\.1\.4"\r?$/m,
    );
    const validator = await readFile(
      join(target, "scripts", "validate_profile.py"),
      "utf8",
    );
    assert.match(validator, /def validate_display_name/);
    assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
  }
});

test("a modified published v2 installation is not overwritten by a patch upgrade", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const target = await materializeCanonicalLegacySkill(
    codexHome,
    "f41c0048a2ab7e73e70235829578bdcf1247aa48",
  );
  const protectedFile = join(target, "scripts", "derive_resources.py");
  const content =
    (await readFile(protectedFile, "utf8")) + "\n# local owner change\n";
  await writeFile(protectedFile, content, "utf8");
  const result = runInstaller(codexHome, sourceSkill);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unrecognized older same-name Skill|unknown same-name skill/,
  );
  assert.equal(await readFile(protectedFile, "utf8"), content);
  assert.match(
    await readFile(join(target, "SKILL.md"), "utf8"),
    /^  version: "2\.0\.0"\r?$/m,
  );
});

test("a newer same-source installation is preserved and downgrade is refused", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const target = join(codexHome, "skills", skillName);
  await mkdir(dirname(target), { recursive: true });
  await copySkill(source, target);
  await setMetadata(target, "version", "9.0.0");
  await setMetadata(target, "infrastructure-version", "9.0.0");
  const sentinel = await createOtherSkill(codexHome);
  const before = await readFile(join(target, "SKILL.md"), "utf8");

  const result = runInstaller(codexHome, source);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /newer than this source; refusing a downgrade/i);
  assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), before);
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
});

test("same-source frontmatter cannot authorize an incomplete destination", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const target = join(codexHome, "skills", skillName);
  await mkdir(dirname(target), { recursive: true });
  await copySkill(source, target);
  await setMetadata(target, "version", "0.9.0");
  const protectedFile = join(target, "local-owner-note.txt");
  await writeFile(protectedFile, "unknown local content\n", "utf8");
  await rm(join(target, "references", "cloudbase-gates.md"));

  const result = runInstaller(codexHome, source);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /unknown same-name skill.*structure is incomplete/is,
  );
  assert.equal(
    await readFile(protectedFile, "utf8"),
    "unknown local content\n",
  );
  await assert.rejects(
    readFile(join(target, "references", "cloudbase-gates.md"), "utf8"),
    { code: "ENOENT" },
  );
});

test("quick_validate runs in UTF-8 mode for a Chinese SKILL.md on Windows", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const validator = join(root, "quick_validate_utf8_regression.py");
  await writeFile(
    validator,
    `import sys\nfrom pathlib import Path\nif sys.flags.utf8_mode != 1:\n    raise SystemExit("UTF-8 mode was not enabled")\ntext = (Path(sys.argv[1]) / "SKILL.md").read_text()\nif "毕方公共服务接入向导" not in text:\n    raise SystemExit("Chinese SKILL.md was not decoded")\nprint("Skill is valid!")\n`,
    "utf8",
  );

  const result = runInstaller(codexHome, source, {
    BIFANG_SKILL_QUICK_VALIDATE: validator,
    PYTHONUTF8: "0",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /quick_validate=/);
});

test("the bootstrap-only flag isolates external quick_validate hooks", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const validator = join(root, "must-not-run.py");
  const marker = join(root, "validator-ran.txt");
  await writeFile(
    validator,
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("ran")\nraise SystemExit(91)\n`,
    "utf8",
  );

  const result = runInstaller(
    codexHome,
    source,
    { BIFANG_SKILL_QUICK_VALIDATE: validator },
    ["--skip-external-quick-validate"],
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stdout, /quick_validate=/);
  await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" });
});

test("Python bytecode and cache directories are rejected, never ignored", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const cache = join(source, "scripts", "__pycache__");
  await mkdir(cache, { recursive: true });
  await writeFile(
    join(cache, "scan_project.cpython-312.pyc"),
    "not bytecode\n",
  );

  const result = runInstaller(codexHome, source);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Python bytecode\/cache entries are not allowed/i,
  );
  await assert.rejects(
    readFile(join(codexHome, "skills", skillName, "SKILL.md"), "utf8"),
    { code: "ENOENT" },
  );
});

test(
  "Windows junctions in a Skill source are rejected without copying outside content",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = await temporaryDirectory(t);
    const codexHome = join(root, "codex-home");
    const source = await createInstallableSource(root);
    const outside = join(root, "outside-source");
    const payload = join(outside, "outside-payload.txt");
    await mkdir(outside, { recursive: true });
    await writeFile(payload, "must stay outside the installed Skill\n", "utf8");

    try {
      await symlink(outside, join(source, "linked-extra"), "junction");
    } catch (error) {
      if (["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)) {
        t.skip(`junction creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const result = runInstaller(codexHome, source, {}, [
      "--skip-external-quick-validate",
    ]);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /junction|reparse point/i);
    assert.equal(
      await readFile(payload, "utf8"),
      "must stay outside the installed Skill\n",
    );
    await assert.rejects(
      readFile(join(codexHome, "skills", skillName, "SKILL.md"), "utf8"),
      { code: "ENOENT" },
    );
  },
);

test("source without infrastructure-source-commit is safely rejected", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const skillMd = join(source, "SKILL.md");
  const current = await readFile(skillMd, "utf8");
  await writeFile(
    skillMd,
    current.replace(/^  infrastructure-source-commit:.*(?:\r?\n|$)/m, ""),
    "utf8",
  );

  const result = runInstaller(codexHome, source);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /missing installation metadata:.*infrastructure-source-commit/i,
  );
  await assert.rejects(
    readFile(join(codexHome, "skills", skillName, "SKILL.md"), "utf8"),
    { code: "ENOENT" },
  );
});

test("invalid UTF-8 in a required reference blocks installation", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const sentinel = await createOtherSkill(codexHome);
  await writeFile(
    join(source, "references", "integration-contract.md"),
    Buffer.from([0xff, 0xfe]),
  );

  const result = runInstaller(codexHome, source);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /integration-contract\.md.*UTF-8 text/i);
  await assert.rejects(
    readFile(join(codexHome, "skills", skillName, "SKILL.md"), "utf8"),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
});

test("duplicate fields in the required JSON schema block installation", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const source = await createInstallableSource(root);
  const schema = join(
    source,
    "references",
    "public-services-profile.schema.json",
  );
  await writeFile(schema, '{"type":"object","type":"object"}\n', "utf8");

  const result = runInstaller(codexHome, source);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate JSON field: type/i);
  await assert.rejects(
    readFile(join(codexHome, "skills", skillName, "SKILL.md"), "utf8"),
    { code: "ENOENT" },
  );
});

test("published GitLab 2.1.0 upgrades to GitHub 2.1.4 without accepting modified trees", async (t) => {
  for (const crlf of [false, true, "mixed"]) {
    const root = await temporaryDirectory(t);
    const codexHome = join(root, "codex-home");
    const target = await materializeCanonicalLegacySkill(
      codexHome,
      "e6f8cf7b8539cdc910914d96fc5d521aa50bf244",
      crlf,
    );
    const result = runInstaller(codexHome, sourceSkill);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[OK\] updated:/);
    assert.match(
      await readFile(join(target, "SKILL.md"), "utf8"),
      /canonical-repository-url: "https:\/\/github\.com\/BFTools3666\/bifang-operations-assistant\.git"/,
    );
  }
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const target = await materializeCanonicalLegacySkill(
    codexHome,
    "e6f8cf7b8539cdc910914d96fc5d521aa50bf244",
  );
  const protectedFile = join(target, "SKILL.md");
  const content =
    (await readFile(protectedFile, "utf8")) + "\nLocal modification\n";
  await writeFile(protectedFile, content);
  const result = runInstaller(codexHome, sourceSkill);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(protectedFile, "utf8"), content);
});

test("incoming Skill cannot use the retired GitLab authority", async (t) => {
  const root = await temporaryDirectory(t);
  const source = await createInstallableSource(root);
  await setMetadata(
    source,
    "canonical-repository-url",
    "https://gitlab.kuajingvs.com/qiuyang/bifang-operations-assistant.git",
  );
  const result = runInstaller(join(root, "codex-home"), source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved credential-free GitHub URL/);
});

test("published 2.1.1 from the former GitHub location upgrades only as an exact tree", async (t) => {
  for (const crlf of [false, true, "mixed"]) {
    const root = await temporaryDirectory(t);
    const codexHome = join(root, "codex-home");
    const target = await materializeCanonicalLegacySkill(
      codexHome,
      "536d5ab3bbcaba7669b3453393eaf78fa6551b91",
      crlf,
    );
    const result = runInstaller(codexHome, sourceSkill);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /\[OK\] updated:/);
    assert.match(
      await readFile(join(target, "SKILL.md"), "utf8"),
      /BFTools3666\/bifang-operations-assistant/,
    );
  }
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const target = await materializeCanonicalLegacySkill(
    codexHome,
    "536d5ab3bbcaba7669b3453393eaf78fa6551b91",
  );
  const localFile = join(target, "local-note.txt");
  await writeFile(localFile, "preserve this modification\n");
  const result = runInstaller(codexHome, sourceSkill);
  assert.notEqual(result.status, 0);
  assert.equal(
    await readFile(localFile, "utf8"),
    "preserve this modification\n",
  );
});

test("published 2.1.2 upgrades for mixed Windows line endings but rejects altered content", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const target = await materializeCanonicalLegacySkill(
    codexHome,
    "b94cc813995ad54e9c127210e17a0cb4dbd5247b",
    "mixed",
  );
  const result = runInstaller(codexHome, sourceSkill);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] updated:/);
  assert.match(
    await readFile(join(target, "SKILL.md"), "utf8"),
    /version: "2\.1\.4"/,
  );

  const otherHome = join(root, "altered-home");
  const altered = await materializeCanonicalLegacySkill(
    otherHome,
    "b94cc813995ad54e9c127210e17a0cb4dbd5247b",
    "mixed",
  );
  const file = join(altered, "references", "integration-contract.md");
  const original = await readFile(file, "utf8");
  await writeFile(file, original + "\nUnapproved change\n", "utf8");
  const rejected = runInstaller(otherHome, sourceSkill);
  assert.notEqual(rejected.status, 0);
  assert.equal(
    await readFile(file, "utf8"),
    original + "\nUnapproved change\n",
  );
});

test("incoming Skill cannot use the former GitHub authority", async (t) => {
  const root = await temporaryDirectory(t);
  const source = await createInstallableSource(root);
  await setMetadata(
    source,
    "canonical-repository-url",
    "https://github.com/BFTools366/bifang-operations-assistant.git",
  );
  const result = runInstaller(join(root, "codex-home"), source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved credential-free GitHub URL/);
});

test("published 2.1.3 with mixed Windows line endings upgrades to the new Skill", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const target = await materializeCanonicalLegacySkill(
    codexHome,
    "b74a9728cd87d8c2ce40c86ef1f4ce9e37432783",
    "mixed",
  );
  const result = runInstaller(codexHome, sourceSkill);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] updated:/);
  assert.match(
    await readFile(join(target, "SKILL.md"), "utf8"),
    /version: "2\.1\.4"/,
  );
});
