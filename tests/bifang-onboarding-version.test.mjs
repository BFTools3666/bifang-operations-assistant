import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

test("personal skill version is independent of the retained infrastructure release", async () => {
  const manifest = await readJson("../bifang-onboarding.json");
  const root = await readJson("../package.json");
  const lock = await readJson("../package-lock.json");
  const sdk = await readJson("../packages/telemetry-update-sdk/package.json");
  const skill = await readFile(
    new URL("../" + manifest.skill.path + "/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.equal(lock.version, root.version);
  assert.equal(lock.packages[""].version, root.version);
  assert.equal(sdk.version, root.version);
  assert.equal(manifest.mode, "personal-free-cloudbase");
  assert.equal(manifest.skill.name, "bifang-public-services-onboarding");
  assert.ok(skill.includes('version: "' + manifest.skill.version + '"'));
  assert.ok(skill.includes('source-branch: "' + manifest.sourceBranch + '"'));
  assert.equal(manifest.automaticBootstrap.enabled, false);
  assert.equal(manifest.nextGate.status, "basic-artifact-testing-defined");
  assert.equal(manifest.secondGate.dependsOn, manifest.firstGate.id);
  assert.equal(manifest.thirdGate.dependsOn, manifest.secondGate.id);
  assert.equal(manifest.fourthGate.dependsOn, manifest.thirdGate.id);
  assert.equal(manifest.fifthGate.dependsOn, manifest.fourthGate.id);
  assert.equal(manifest.nextGate.dependsOn, manifest.fifthGate.id);
  let predecessor = manifest.thirdGate.id;
  for (const checkpoint of manifest.fourthGate.checkpoints) {
    assert.equal(checkpoint.dependsOn, predecessor);
    predecessor = checkpoint.id;
  }
  predecessor = manifest.fourthGate.id;
  for (const checkpoint of manifest.fifthGate.checkpoints) {
    assert.equal(checkpoint.dependsOn, predecessor);
    predecessor = checkpoint.id;
  }
  assert.equal(manifest.thirdGate.requiresExplicitConfirmation, true);
  assert.equal(manifest.thirdGate.jointScopeMustPassTogether, true);
  assert.equal(manifest.thirdGate.previewSendsRequests, false);
  assert.equal(manifest.firstGate.requiresCredentials, true);
  assert.equal(manifest.firstGate.requiresCamUser, true);
  assert.equal(manifest.firstGate.requiresAccessVerification, true);
  assert.equal(manifest.firstGate.requiresSecretChatInput, false);
  assert.equal(manifest.secondGate.requiresCreationModeChoice, true);
  assert.equal(manifest.secondGate.requiresResourceVerification, true);
  assert.equal(manifest.firstGate.requiresExplicitAnswer, true);
  assert.doesNotMatch(
    skill,
    /updater:config:read|cloudbase:config:read|update\.meetelf\.com|woskill/,
  );
});
