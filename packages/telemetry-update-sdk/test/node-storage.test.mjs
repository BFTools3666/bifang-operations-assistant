import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { InstallIdentity, isUuidV4 } from "../dist/index.js";
import { NodeFileIdentityStorage } from "../dist/node.js";

const execFileAsync = promisify(execFile);

test("Node file adapter requires an explicit safe AppConfig directory", () => {
  assert.throws(() => new NodeFileIdentityStorage("relative/path"), TypeError);
  assert.throws(
    () =>
      new NodeFileIdentityStorage(process.platform === "win32" ? "C:\\" : "/"),
    TypeError,
  );
  assert.throws(
    () =>
      new NodeFileIdentityStorage(join(tmpdir(), "bifang-invalid-app"), {
        appId: "Invalid App",
      }),
    TypeError,
  );
});

test("application namespaces isolate identities and daily gates", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-apps-"));
  try {
    const pdfStorage = new NodeFileIdentityStorage(temporaryRoot, {
      appId: "bifang-tools-pdf",
    });
    const imageStorage = new NodeFileIdentityStorage(temporaryRoot, {
      appId: "bifang-tools-image",
    });
    const pdfIdentity = await new InstallIdentity(pdfStorage).initialize();
    const imageIdentity = await new InstallIdentity(imageStorage).initialize();

    assert.notEqual(pdfStorage.filePath, imageStorage.filePath);
    assert.match(pdfStorage.filePath, /bifang-tools-pdf/);
    assert.match(imageStorage.filePath, /bifang-tools-image/);
    assert.notEqual(pdfIdentity.installId, imageIdentity.installId);
    assert.equal(await pdfStorage.claimActivityDay("2026-09-05"), true);
    assert.equal(await imageStorage.claimActivityDay("2026-09-05"), true);
    assert.equal(await pdfStorage.claimActivityDay("2026-09-05"), false);
    assert.equal(await imageStorage.claimActivityDay("2026-09-05"), false);

    const restartedPdf = await new InstallIdentity(
      new NodeFileIdentityStorage(temporaryRoot, {
        appId: "bifang-tools-pdf",
      }),
    ).initialize();
    assert.equal(restartedPdf.installId, pdfIdentity.installId);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Node daily marker persists across storage instances and advances by day", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-day-"));
  const appConfigDirectory = join(temporaryRoot, "bifang-tools");
  try {
    const first = new NodeFileIdentityStorage(appConfigDirectory);
    const restarted = new NodeFileIdentityStorage(appConfigDirectory);

    assert.equal(await first.claimActivityDay("2026-09-04"), true);
    assert.equal(await first.claimActivityDay("2026-09-04"), false);
    assert.equal(await restarted.claimActivityDay("2026-09-04"), false);
    assert.equal(await restarted.claimActivityDay("2026-09-05"), true);
    assert.equal(await first.claimActivityDay("2026-09-05"), false);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("separate Node storage instances atomically grant one daily claim", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-day-race-"));
  const appConfigDirectory = join(temporaryRoot, "bifang-tools");
  try {
    const claims = await Promise.all(
      Array.from({ length: 16 }, () =>
        new NodeFileIdentityStorage(appConfigDirectory).claimActivityDay(
          "2026-09-04",
        ),
      ),
    );

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.filter((claimed) => !claimed).length, 15);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("separate Node processes atomically grant one daily claim", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "bifang-sdk-day-process-"),
  );
  const appConfigDirectory = join(temporaryRoot, "bifang-tools");
  const nodeModule = new URL("../dist/node.js", import.meta.url).href;
  const startAt = Date.now() + 750;
  const script = `
    import { NodeFileIdentityStorage } from ${JSON.stringify(nodeModule)};
    const [directory, day, startAtText] = process.argv.slice(1);
    const waitMs = Math.max(0, Number(startAtText) - Date.now());
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    const claimed = await new NodeFileIdentityStorage(directory)
      .claimActivityDay(day);
    process.stdout.write(JSON.stringify(claimed));
  `;

  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        execFileAsync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            script,
            appConfigDirectory,
            "2026-09-04",
            String(startAt),
          ],
          { timeout: 5_000 },
        ),
      ),
    );
    const claims = results.map(({ stdout }) => JSON.parse(stdout));

    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.filter((claimed) => !claimed).length, 3);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Node daily marker rejects malformed and impossible calendar dates", async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), "bifang-sdk-day-invalid-"),
  );
  const appConfigDirectory = join(temporaryRoot, "bifang-tools");
  const storage = new NodeFileIdentityStorage(appConfigDirectory);
  try {
    for (const day of [
      "",
      "2026-9-04",
      "2026-09-4",
      "2026-02-29",
      "2026-02-30",
      "2026-13-01",
      "../2026-09-04",
      "2026-09-04.json",
    ]) {
      await assert.rejects(storage.claimActivityDay(day), TypeError, day);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Node file adapter persists a stable identity", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-identity-"));
  const appConfigDirectory = join(temporaryRoot, "bifang-tools");
  try {
    const storage = new NodeFileIdentityStorage(appConfigDirectory);
    const first = await new InstallIdentity(storage).initialize();
    const restarted = await new InstallIdentity(
      new NodeFileIdentityStorage(appConfigDirectory),
    ).initialize();
    const stored = JSON.parse(await readFile(storage.filePath, "utf8"));

    assert.ok(isUuidV4(first.installId));
    assert.equal(first.isFirstInstall, true);
    assert.equal(restarted.installId, first.installId);
    assert.equal(restarted.isFirstInstall, false);
    assert.equal(stored.install_id, first.installId);
    assert.equal(stored.installed, true);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Node file adapter recovers a stable identity without replacing corruption", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-corrupt-"));
  const appConfigDirectory = join(temporaryRoot, "bifang-tools");
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
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("separate Node processes converge on the same install identity", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "bifang-sdk-process-"));
  const appConfigDirectory = join(temporaryRoot, "bifang-tools");
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
      Array.from({ length: 4 }, () =>
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
