import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("onboarding skill release versions stay aligned without changing the SDK API version", async () => {
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

  assert.equal(rootPackage.version, "2.1.0");
  assert.equal(lock.version, rootPackage.version);
  assert.equal(lock.packages[""].version, rootPackage.version);
  assert.equal(sdkPackage.version, "2.0.0");
  assert.match(skill, /version:\s*["']1\.0\.0["']/);
  assert.match(skill, /infrastructure-version:\s*["']2\.1\.0["']/);
  assert.match(
    skill,
    /protocol-baseline-commit:\s*["']01f42449bf0f80a2660e7ee0899eef1176aca934["']/,
  );
  assert.doesNotMatch(
    skill,
    /infrastructure-source-commit:\s*["']01f42449bf0f80a2660e7ee0899eef1176aca934["']/,
  );
});
