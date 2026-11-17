import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const runGit = (args) =>
  spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

test("onboarding, infrastructure, and application-version SDK releases stay aligned", async () => {
  const rootPackage = await readJson("../package.json");
  const lock = await readJson("../package-lock.json");
  const sdkPackage = await readJson(
    "../packages/telemetry-update-sdk/package.json",
  );
  const skill = await readFile(
    new URL(
      "../skills/bifang-public-services-onboarding/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.equal(rootPackage.version, "3.0.0");
  assert.equal(lock.version, rootPackage.version);
  assert.equal(lock.packages[""].version, rootPackage.version);
  assert.equal(sdkPackage.version, "3.0.0");
  assert.match(skill, /version:\s*["']2\.1\.5["']/);
  assert.match(skill, /infrastructure-version:\s*["']3\.0\.0["']/);
  assert.match(
    skill,
    /application-version-contract-version:\s*["']1\.0\.0["']/,
  );
  assert.match(
    skill,
    /application-version-baseline-commit:\s*["']92b0c599a42c3a094c99787e6928c30c2d2ea3af["']/,
  );
  const sourceCommit = skill.match(
    /infrastructure-source-commit:\s*["']([0-9a-f]{40})["']/,
  );
  assert.ok(sourceCommit, "infrastructure source commit must be recorded");
  assert.notEqual(sourceCommit[1], "92b0c599a42c3a094c99787e6928c30c2d2ea3af");

  const commitExists = runGit([
    "cat-file",
    "-e",
    `${sourceCommit[1]}^{commit}`,
  ]);
  assert.equal(commitExists.status, 0, commitExists.stderr);
  const sourcePackage = runGit(["show", `${sourceCommit[1]}:package.json`]);
  assert.equal(sourcePackage.status, 0, sourcePackage.stderr);
  assert.equal(JSON.parse(sourcePackage.stdout).version, "3.0.0");
  const isAncestor = runGit([
    "merge-base",
    "--is-ancestor",
    sourceCommit[1],
    "HEAD",
  ]);
  assert.equal(isAncestor.status, 0, isAncestor.stderr);
});
