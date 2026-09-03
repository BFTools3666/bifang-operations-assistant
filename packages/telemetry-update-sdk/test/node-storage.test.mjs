import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { InstallIdentity, isUuidV4, rolloutBucket } from "../dist/index.js";
import { NodeFileIdentityStorage } from "../dist/node.js";

const execFileAsync = promisify(execFile);

test("Node file adapter requires an explicit absolute AppConfig directory", () => {
  assert.throws(() => new NodeFileIdentityStorage("relative/path"), TypeError);
});

test("Node file adapter recovers a stable identity without replacing corruption", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-test-"));
  const appConfigDirectory = join(temporaryRoot, "example-tool");
  try {
    const storage = new NodeFileIdentityStorage(appConfigDirectory);
    const first = await new InstallIdentity(storage).initialize();
    const stored = JSON.parse(await readFile(storage.filePath, "utf8"));

    assert.ok(isUuidV4(first.installId));
    assert.equal(stored.install_id, first.installId);
    assert.equal(stored.installed, true);

    await writeFile(storage.filePath, "not-json", "utf8");
    const recovered = await new InstallIdentity(storage).initialize();
    assert.ok(isUuidV4(recovered.installId));
    assert.notEqual(recovered.installId, first.installId);
    assert.equal(recovered.isFirstInstall, false);
    assert.match(await readFile(storage.filePath, "utf8"), /not-json/);

    const restarted = await new InstallIdentity(storage).initialize();
    assert.equal(restarted.installId, recovered.installId);
    assert.equal(restarted.isFirstInstall, false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("separate Node storage instances atomically select one install identity", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-race-"));
  const appConfigDirectory = join(temporaryRoot, "example-tool");
  try {
    const identities = await Promise.all(
      Array.from({ length: 8 }, () =>
        new InstallIdentity(
          new NodeFileIdentityStorage(appConfigDirectory),
        ).initialize(),
      ),
    );

    assert.equal(new Set(identities.map(({ installId }) => installId)).size, 1);
    assert.equal(
      identities.filter(({ isFirstInstall }) => isFirstInstall).length,
      1,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("concurrent instances never replace a corrupt identity marker", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-corrupt-"));
  const appConfigDirectory = join(temporaryRoot, "example-tool");
  const storage = new NodeFileIdentityStorage(appConfigDirectory);
  try {
    await mkdir(appConfigDirectory, { recursive: true });
    await writeFile(storage.filePath, "not-json", "utf8");

    const identities = await Promise.all(
      Array.from({ length: 8 }, () =>
        new InstallIdentity(
          new NodeFileIdentityStorage(appConfigDirectory),
        ).initialize(),
      ),
    );

    assert.equal(
      identities.filter(({ isFirstInstall }) => isFirstInstall).length,
      0,
    );
    assert.equal(new Set(identities.map(({ installId }) => installId)).size, 1);
    assert.equal(await readFile(storage.filePath, "utf8"), "not-json");

    const restarted = await new InstallIdentity(
      new NodeFileIdentityStorage(appConfigDirectory),
    ).initialize();
    assert.equal(restarted.installId, identities[0].installId);
    assert.equal(
      rolloutBucket(restarted.installId, "1.2.3"),
      rolloutBucket(identities[0].installId, "1.2.3"),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("separate Node processes converge on the same install identity", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-process-"));
  const appConfigDirectory = join(temporaryRoot, "example-tool");
  const identityModule = new URL("../dist/index.js", import.meta.url).href;
  const nodeModule = new URL("../dist/node.js", import.meta.url).href;
  const startAt = Date.now() + 750;
  const script = `
    import { InstallIdentity } from ${JSON.stringify(identityModule)};
    import { NodeFileIdentityStorage } from ${JSON.stringify(nodeModule)};
    const [directory, startAtText] = process.argv.slice(1);
    const waitMs = Math.max(0, Number(startAtText) - Date.now());
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const result = await new InstallIdentity(
      new NodeFileIdentityStorage(directory),
    ).initialize();
    process.stdout.write(JSON.stringify(result));
  `;

  try {
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            script,
            appConfigDirectory,
            String(startAt),
          ],
          { timeout: 5_000 },
        ),
      ),
    );
    const identities = results.map(({ stdout }) => JSON.parse(stdout));

    assert.equal(new Set(identities.map(({ installId }) => installId)).size, 1);
    assert.equal(
      identities.filter(({ isFirstInstall }) => isFirstInstall).length,
      1,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
