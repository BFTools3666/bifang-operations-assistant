import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceBootstrap = join(
  repositoryRoot,
  "tools",
  "bootstrap_bifang_onboarding.py",
);
const sourceManifest = join(repositoryRoot, "bifang-onboarding.json");
const skillName = "bifang-public-services-onboarding";
const sourceSkill = join(repositoryRoot, "skills", skillName);
const canonicalRepositoryUrl =
  "https://github.com/BFTools366/bifang-operations-assistant.git";
const python = process.env.PYTHON || "python";

function run(command, arguments_, options = {}) {
  return spawnSync(command, arguments_, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

function git(cwd, arguments_) {
  const result = run("git", arguments_, { cwd });
  assert.equal(
    result.status,
    0,
    `git ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "bifang-bootstrap-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function createAuthorityFixture(t, options = {}) {
  const root = await temporaryRoot(t);
  const authority = join(root, "authority");
  const clone = run(
    "git",
    ["clone", "--no-hardlinks", repositoryRoot, authority],
    { cwd: root },
  );
  assert.equal(clone.status, 0, clone.stderr || clone.stdout);
  git(authority, ["switch", "-C", "main"]);
  git(authority, ["config", "user.name", "Bifang Bootstrap Tests"]);
  git(authority, ["config", "user.email", "bootstrap-tests@example.invalid"]);

  await copyFile(
    join(repositoryRoot, "package.json"),
    join(authority, "package.json"),
  );
  git(authority, ["add", "package.json"]);
  git(authority, [
    "commit",
    "--allow-empty",
    "-m",
    "test: infrastructure 3.0 fixture",
  ]);
  const infrastructureSourceCommit = git(authority, ["rev-parse", "HEAD"]);

  const installedSkillSource = join(authority, "skills", skillName);
  await rm(installedSkillSource, { recursive: true, force: true });
  await mkdir(dirname(installedSkillSource), { recursive: true });
  await cp(sourceSkill, installedSkillSource, { recursive: true });
  await mkdir(join(authority, "tools"), { recursive: true });
  await copyFile(
    sourceBootstrap,
    join(authority, "tools", "bootstrap_bifang_onboarding.py"),
  );
  await copyFile(sourceManifest, join(authority, "bifang-onboarding.json"));
  const fixtureSkillMd = join(installedSkillSource, "SKILL.md");
  await writeFile(
    fixtureSkillMd,
    (await readFile(fixtureSkillMd, "utf8")).replace(
      /^  infrastructure-source-commit:.*$/m,
      `  infrastructure-source-commit: "${infrastructureSourceCommit}"`,
    ),
    "utf8",
  );
  if (options.scannerSource !== undefined) {
    await writeFile(
      join(installedSkillSource, "scripts", "scan_project.py"),
      options.scannerSource,
      "utf8",
    );
  }

  git(authority, [
    "add",
    "--all",
    "--",
    "bifang-onboarding.json",
    "tools/bootstrap_bifang_onboarding.py",
    `skills/${skillName}`,
  ]);
  git(authority, ["commit", "-m", "test: published onboarding fixture"]);
  git(authority, ["remote", "set-url", "origin", canonicalRepositoryUrl]);
  const head = git(authority, ["rev-parse", "HEAD"]);
  assert.match(head, /^[0-9a-f]{40}$/);
  assert.equal(git(authority, ["status", "--porcelain=v1"]), "");
  return {
    authority,
    bootstrap: join(authority, "tools", "bootstrap_bifang_onboarding.py"),
    head,
    infrastructureSourceCommit,
    root,
  };
}

async function createClient(root, name = "客户端 项目") {
  const client = join(root, name);
  await mkdir(join(client, "src"), { recursive: true });
  git(client, ["init", "-b", "main"]);
  git(client, ["config", "user.name", "Bifang Bootstrap Tests"]);
  git(client, ["config", "user.email", "bootstrap-tests@example.invalid"]);
  await writeFile(
    join(client, "src", "config.rs"),
    'const UPDATE: &str = "https://old.example.invalid/updates/bifang-tool/windows.json";\n',
    "utf8",
  );
  git(client, ["add", "src/config.rs"]);
  git(client, ["commit", "-m", "test: initial client"]);
  await appendFile(
    join(client, "src", "config.rs"),
    "// inherited user edit\n",
    "utf8",
  );
  await writeFile(join(client, "用户未跟踪.txt"), "preserve me\n", "utf8");
  return client;
}

function runBootstrap(
  fixture,
  client,
  codexHome,
  { cwd = join(client, "src"), environment = {}, arguments_: extra = [] } = {},
) {
  return run(
    python,
    [
      "-X",
      "utf8",
      "-B",
      fixture.bootstrap,
      "--target-project",
      client,
      "--codex-home",
      codexHome,
      "--test-only-fixed-source-head",
      fixture.head,
      "--test-only-fixed-source-ref",
      "refs/heads/main",
      ...extra,
    ],
    {
      cwd,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        ...environment,
      },
    },
  );
}

async function assertSkillMissing(codexHome) {
  await assert.rejects(
    access(join(codexHome, "skills", skillName, "SKILL.md")),
    { code: "ENOENT" },
  );
}

test("verified bootstrap preserves the current dirty Git client and then installs", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "isolated codex-home");
  const beforeStatus = git(client, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(
    output.authorization,
    "one-line-client-integration; bootstrap-output-is-stage-0-only",
  );
  assert.equal(output.source_head, fixture.head);
  assert.equal(output.source_remote_ref, "refs/heads/main");
  assert.equal(output.source_is_clean_checkout, true);
  assert.equal(output.source_matches_advertised_remote, false);
  assert.equal(output.source_verification_mode, "test-only-fixed-ref");
  assert.equal(output.infrastructure_version, "3.0.0");
  assert.equal(output.application_version_contract_version, "1.0.0");
  assert.equal(output.skill.version, "2.1.1");
  assert.equal(output.writes_to_target_project, false);
  assert.equal(output.target_git_unchanged, true);
  assert.ok(
    output.target_git_before.status_porcelain.some((line) =>
      line.startsWith(" M "),
    ),
  );
  assert.equal(output.target_git_before.head, output.target_git_after.head);
  assert.equal(
    output.target_git_before.status_sha256,
    output.target_git_after.status_sha256,
  );
  assert.equal(
    output.target_git_before.index_sha256,
    output.target_git_after.index_sha256,
  );
  assert.equal(
    output.target_git_before.content_sha256,
    output.target_git_after.content_sha256,
  );
  assert.equal(output.stage_0_scan.scan_version, 3);
  assert.equal(output.stage_0_scan.legacy_update_status, "detected");
  assert.equal(
    git(client, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    beforeStatus,
  );

  const installed = await readFile(
    join(codexHome, "skills", skillName, "SKILL.md"),
    "utf8",
  );
  assert.match(installed, /^  version: "2\.1\.1"$/m);
});

test("bootstrap manifest freezes the exact request and authorization boundary", async () => {
  const manifest = JSON.parse(await readFile(sourceManifest, "utf8"));
  assert.equal(manifest.oneLineRequest, `${canonicalRepositoryUrl} 帮我接入`);
  assert.equal(manifest.updateTransport, "client-update-center-v1");
  assert.equal(
    manifest.applicationVersionBaselineCommit,
    "92b0c599a42c3a094c99787e6928c30c2d2ea3af",
  );
  assert.deepEqual(manifest.initialAuthorization.allows, [
    "fetch-authoritative-repository",
    "install-or-update-onboarding-skill",
    "read-only-stage-0-project-scan",
    "write-or-migrate-non-sensitive-profile",
    "replace-legacy-update-protocol-in-target-client",
    "remove-legacy-update-protocol-from-target-client",
    "run-local-static-and-unit-verification",
  ]);
  assert.ok(
    manifest.initialAuthorization.requiresSeparateExplicitAuthorization.includes(
      "deploy-cloudbase",
    ),
  );
});

test("dirty, staged, or untracked Skill source is rejected before scan or install", async (t) => {
  for (const mutation of ["dirty", "staged", "untracked"]) {
    const fixture = await createAuthorityFixture(t);
    const client = await createClient(fixture.root, `client-${mutation}`);
    const codexHome = join(fixture.root, `codex-${mutation}`);
    if (mutation === "dirty" || mutation === "staged") {
      await appendFile(
        join(
          fixture.authority,
          "skills",
          skillName,
          "scripts",
          "scan_project.py",
        ),
        "\n# dirty source\n",
        "utf8",
      );
      if (mutation === "staged") {
        git(fixture.authority, [
          "add",
          `skills/${skillName}/scripts/scan_project.py`,
        ]);
      }
    } else {
      await writeFile(
        join(fixture.authority, "skills", skillName, "untracked.py"),
        "raise SystemExit('must never execute')\n",
        "utf8",
      );
    }

    const result = runBootstrap(fixture, client, codexHome);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /differs from HEAD|differ from HEAD|ls-files.*failed/is,
    );
    await assertSkillMissing(codexHome);
  }
});

test("source HEAD must equal the selected published ref commit", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-head-mismatch");

  const result = runBootstrap(
    { ...fixture, head: "a".repeat(40) },
    client,
    codexHome,
  );

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /source HEAD is not the published refs\/heads\/main/i,
  );
  await assertSkillMissing(codexHome);
});

test("bootstrap source must itself be the canonical Git top-level", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-nested-source");
  const nestedBootstrap = join(
    fixture.authority,
    "nested",
    "tools",
    "bootstrap_bifang_onboarding.py",
  );
  await mkdir(dirname(nestedBootstrap), { recursive: true });
  await copyFile(fixture.bootstrap, nestedBootstrap);

  const result = runBootstrap(
    { ...fixture, bootstrap: nestedBootstrap },
    client,
    codexHome,
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bootstrap source must be the Git top-level/i);
  await assertSkillMissing(codexHome);
});

test("target must be the Git root that owns the invocation cwd", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const intended = await createClient(fixture.root, "intended-client");
  const other = await createClient(fixture.root, "other-client");
  const codexHome = join(fixture.root, "codex-target-boundary");

  const result = runBootstrap(fixture, intended, codexHome, {
    cwd: join(other, "src"),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target project must equal.*invocation cwd/is);
  await assertSkillMissing(codexHome);
});

test("an unrelated dirty source file fails the full-repository clean gate", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-full-clean");
  await appendFile(join(fixture.authority, "README.md"), "\nuncommitted\n");

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /repository differs from HEAD.*fully clean/is);
  await assertSkillMissing(codexHome);
});

test("ignored Python bytecode in the Skill source is rejected", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-bytecode");
  const cache = join(
    fixture.authority,
    "skills",
    skillName,
    "scripts",
    "__pycache__",
  );
  await mkdir(cache, { recursive: true });
  await writeFile(
    join(cache, "scan_project.cpython-312.pyc"),
    "not bytecode\n",
  );
  assert.equal(git(fixture.authority, ["status", "--porcelain=v1"]), "");

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Python bytecode\/cache/i);
  await assertSkillMissing(codexHome);
});

test("Git is resolved outside the untrusted invocation cwd", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const cwd = join(client, "src");
  const codexHome = join(fixture.root, "codex-safe-git");
  const fakeGit = join(cwd, process.platform === "win32" ? "git.exe" : "git");
  await writeFile(fakeGit, "#!/bin/sh\nexit 93\n", "utf8");
  if (process.platform !== "win32") {
    await chmod(fakeGit, 0o755);
  }

  const result = runBootstrap(fixture, client, codexHome, {
    cwd,
    environment: { PATH: `${cwd}${delimiter}${process.env.PATH ?? ""}` },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).target_git_unchanged, true);
});

test("target may be a Codex worktree but cannot overlap the Skill installation", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const codexHome = join(fixture.root, "codex-home");
  const client = await createClient(
    join(codexHome, "worktrees"),
    "client-worktree",
  );

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).target_git_unchanged, true);

  const installationTarget = join(codexHome, "skills", skillName);
  await mkdir(join(installationTarget, "src"), { recursive: true });
  git(installationTarget, ["init", "-b", "main"]);
  git(installationTarget, ["config", "user.name", "Bifang Bootstrap Tests"]);
  git(installationTarget, [
    "config",
    "user.email",
    "bootstrap-tests@example.invalid",
  ]);
  await writeFile(join(installationTarget, "src", "main.rs"), "fn main() {}\n");
  git(installationTarget, ["add", "src/main.rs"]);
  git(installationTarget, ["commit", "-m", "test: overlapping target"]);

  const overlap = runBootstrap(fixture, installationTarget, codexHome, {
    cwd: join(installationTarget, "src"),
  });
  assert.notEqual(overlap.status, 0);
  assert.match(overlap.stderr, /target must not overlap.*installation/is);
});

test("a scanner failure leaves no new Skill installation", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: 'raise SystemExit("intentional scanner failure")\n',
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-scan-failure");
  const before = git(client, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /scan_project\.py failed.*intentional scanner failure/is,
  );
  assert.equal(
    git(client, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    before,
  );
  await assertSkillMissing(codexHome);
});

test("content hashing detects a scanner rewrite that leaves porcelain unchanged", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: [
      "import json, sys",
      "from pathlib import Path",
      'target = Path(sys.argv[1]) / "src" / "config.rs"',
      'target.write_text(target.read_text(encoding="utf-8") + "// scanner mutation\\n", encoding="utf-8")',
      'print(json.dumps({"scan_version": 3, "scan_incomplete": False, "skipped_files": []}))',
      "",
    ].join("\n"),
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-content-digest");
  const beforeStatus = git(client, [
    "-c",
    "core.quotepath=false",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /status, or content changed during.*scan/is);
  assert.equal(
    git(client, [
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    beforeStatus,
  );
  await assertSkillMissing(codexHome);
});

test("bootstrap never executes an external quick_validate hook", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-no-hook");
  const validator = join(
    codexHome,
    "skills",
    ".system",
    "skill-creator",
    "scripts",
    "quick_validate.py",
  );
  const marker = join(fixture.root, "external-validator-ran.txt");
  await mkdir(dirname(validator), { recursive: true });
  await writeFile(
    validator,
    `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("ran")\nraise SystemExit(91)\n`,
    "utf8",
  );

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  await assert.rejects(access(marker), { code: "ENOENT" });
});

test("infrastructure provenance must include the minimum commit", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-provenance-minimum");
  const beforeMinimum = git(fixture.authority, [
    "rev-parse",
    "92b0c599a42c3a094c99787e6928c30c2d2ea3af^",
  ]);
  const skillMd = join(fixture.authority, "skills", skillName, "SKILL.md");
  await writeFile(
    skillMd,
    (await readFile(skillMd, "utf8")).replace(
      /^  infrastructure-source-commit:.*$/m,
      `  infrastructure-source-commit: "${beforeMinimum}"`,
    ),
    "utf8",
  );
  git(fixture.authority, ["add", `skills/${skillName}/SKILL.md`]);
  git(fixture.authority, ["commit", "-m", "test: invalid early provenance"]);
  fixture.head = git(fixture.authority, ["rev-parse", "HEAD"]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source-commit does not contain the minimum/i);
  await assertSkillMissing(codexHome);
});

test("infrastructure provenance commit must carry the declared package version", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-provenance-version");
  const packagePath = join(fixture.authority, "package.json");
  const validPackage = await readFile(packagePath, "utf8");
  const wrongPackage = JSON.parse(validPackage);
  wrongPackage.version = "2.9.0";
  await writeFile(
    packagePath,
    `${JSON.stringify(wrongPackage, null, 2)}\n`,
    "utf8",
  );
  git(fixture.authority, ["add", "package.json"]);
  git(fixture.authority, ["commit", "-m", "test: wrong provenance version"]);
  const wrongVersionCommit = git(fixture.authority, ["rev-parse", "HEAD"]);

  await writeFile(packagePath, validPackage, "utf8");
  const skillMd = join(fixture.authority, "skills", skillName, "SKILL.md");
  await writeFile(
    skillMd,
    (await readFile(skillMd, "utf8")).replace(
      /^  infrastructure-source-commit:.*$/m,
      `  infrastructure-source-commit: "${wrongVersionCommit}"`,
    ),
    "utf8",
  );
  git(fixture.authority, [
    "add",
    "package.json",
    `skills/${skillName}/SKILL.md`,
  ]);
  git(fixture.authority, ["commit", "-m", "test: invalid version provenance"]);
  fixture.head = git(fixture.authority, ["rev-parse", "HEAD"]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /does not contain the declared infrastructure version/i,
  );
  await assertSkillMissing(codexHome);
});

test("application-version provenance stays pinned to the frozen v1 baseline", async (t) => {
  const fixture = await createAuthorityFixture(t);
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-contract-baseline");
  const manifestPath = join(fixture.authority, "bifang-onboarding.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.applicationVersionBaselineCommit =
    "728fc58c276ef3725d49759b3fdf70c20fcd5e9b";
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  git(fixture.authority, ["add", "bifang-onboarding.json"]);
  git(fixture.authority, ["commit", "-m", "test: invalid contract baseline"]);
  fixture.head = git(fixture.authority, ["rev-parse", "HEAD"]);

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not the frozen v1 baseline/i);
  await assertSkillMissing(codexHome);
});

test("scanner receives a minimal environment without unrelated host secrets", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: [
      "import json, os",
      "print(json.dumps({",
      '    "scan_version": 3,',
      '    "scan_incomplete": False,',
      '    "skipped_files": [],',
      '    "saw_unrelated_secret": "BIFANG_BOOTSTRAP_TEST_SECRET" in os.environ,',
      "}))",
      "",
    ].join("\n"),
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-minimal-env");

  const result = runBootstrap(fixture, client, codexHome, {
    environment: { BIFANG_BOOTSTRAP_TEST_SECRET: "must-not-reach-children" },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(
    JSON.parse(result.stdout).stage_0_scan.saw_unrelated_secret,
    false,
  );
});

test("trusted Python children always run in isolated mode", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: [
      "import json, sys",
      "print(json.dumps({",
      '    "scan_version": 3,',
      '    "scan_incomplete": False,',
      '    "skipped_files": [],',
      '    "python_isolated": sys.flags.isolated,',
      "}))",
      "",
    ].join("\n"),
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-isolated-python");

  const result = runBootstrap(fixture, client, codexHome);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).stage_0_scan.python_isolated, 1);
});

test("malformed scan output is rejected before Skill installation", async (t) => {
  const fixture = await createAuthorityFixture(t, {
    scannerSource: 'print("{}")\n',
  });
  const client = await createClient(fixture.root);
  const codexHome = join(fixture.root, "codex-invalid-scan");

  const result = runBootstrap(fixture, client, codexHome);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported scan_version/i);
  await assertSkillMissing(codexHome);
});
