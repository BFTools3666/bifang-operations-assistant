import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
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

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "bifang-onboarding-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function runInstaller(codexHome, source, extraEnvironment = {}) {
  return spawnSync(python, ["-B", installer, "--source", source], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      PYTHONDONTWRITEBYTECODE: "1",
      ...extraEnvironment,
    },
  });
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

test("checked-in source installs with its recorded real provenance", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");

  const result = runInstaller(codexHome, sourceSkill);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const installed = await readFile(
    join(codexHome, "skills", skillName, "SKILL.md"),
    "utf8",
  );
  assert.match(
    installed,
    /^  infrastructure-source-commit: "704da8d702c9991c80ba079910936c275349fabb"\r?$/m,
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
  const unknown = `---\nname: ${skillName}\ndescription: unrelated local skill\nmetadata:\n  version: "1.0.0"\n  infrastructure-version: "2.1.0"\n  infrastructure-source-commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n  protocol-baseline-commit: "01f42449bf0f80a2660e7ee0899eef1176aca934"\n  source-repository: "someone-elses-repository"\n---\n\nDo not overwrite.\n`;
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

test("an older same-source installation is updated through staging", async (t) => {
  const root = await temporaryDirectory(t);
  const codexHome = join(root, "codex-home");
  const oldSource = await createInstallableSource(root, "old-source");
  const newSource = await createInstallableSource(root, "new-source");
  await setMetadata(oldSource, "version", "0.9.0");
  await setMetadata(oldSource, "infrastructure-version", "2.0.0");
  const sentinel = await createOtherSkill(codexHome);

  const first = runInstaller(codexHome, oldSource);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const result = runInstaller(codexHome, newSource);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /\[OK\] updated:/);
  const installed = await readFile(
    join(codexHome, "skills", skillName, "SKILL.md"),
    "utf8",
  );
  assert.match(installed, /^  version: "1\.0\.0"\r?$/m);
  assert.match(installed, /^  infrastructure-version: "2\.1\.0"\r?$/m);
  assert.equal(await readFile(sentinel, "utf8"), "must remain unchanged\n");
  const entries = await readdir(join(codexHome, "skills"));
  assert.deepEqual(entries.sort(), [skillName, "unrelated-skill"].sort());
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
