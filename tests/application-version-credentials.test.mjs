import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createApplicationVersionDeploymentPlan } from "../cloudbase/plan-application-version-api-deployment.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolPath = join(
  repositoryRoot,
  "tools",
  "application-version-credentials.ps1",
);
const registryPath = join(repositoryRoot, "cloudbase", "apps.json");
const powershellPath = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const pwshProbe = spawnSync("where.exe", ["pwsh.exe"], {
  encoding: "utf8",
  windowsHide: true,
});
const pwshPath =
  pwshProbe.status === 0
    ? pwshProbe.stdout.split(/\r?\n/u).find((line) => line.trim().length > 0)
    : null;

function minimalWindowsEnvironment(additions = {}) {
  const allowed = [
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "ProgramData",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramW6432",
    "PSModulePath",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
  ];
  return Object.fromEntries([
    ...allowed.flatMap((name) =>
      typeof process.env[name] === "string" && process.env[name].length > 0
        ? [[name, process.env[name]]]
        : [],
    ),
    ...Object.entries(additions),
  ]);
}

function runTool(args, additions = {}, executable = powershellPath) {
  const invocation = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    toolPath,
    ...args,
  ];
  return {
    invocation,
    result: spawnSync(executable, invocation, {
      encoding: "utf8",
      env: minimalWindowsEnvironment(additions),
      timeout: 30_000,
      windowsHide: true,
    }),
  };
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expandCompactDigest(configuration) {
  assert.equal(configuration.schema_version, 2);
  assert.deepEqual(Object.keys(configuration).sort(), [
    "app_ids",
    "codes",
    "credentials",
    "schema_version",
  ]);
  const scopeBundles = new Map([
    [1, ["versions:check"]],
    [9, ["versions:check", "ads:show"]],
    [18, ["versions:read", "ads:read"]],
    [36, ["versions:write", "ads:write"]],
  ]);
  return configuration.credentials.map(
    ([
      credentialId,
      appIndex,
      codeIndexes,
      keyHash,
      secretHashes,
      scopeMask,
    ]) => ({
      credential_id: credentialId,
      app_id: configuration.app_ids[appIndex],
      codes: codeIndexes.map((index) => configuration.codes[index]),
      key_sha256: Buffer.from(keyHash, "base64").toString("hex"),
      secret_sha256: secretHashes.map((hash) =>
        Buffer.from(hash, "base64").toString("hex"),
      ),
      scopes: scopeBundles.get(scopeMask),
    }),
  );
}

function decodeBase64Url(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  return Buffer.from(
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
    "base64",
  );
}

function decryptVault(path) {
  const command = [
    "Add-Type -AssemblyName System.Security -ErrorAction Stop",
    "$utf8 = New-Object System.Text.UTF8Encoding($false, $true)",
    "$envelope = $utf8.GetString([IO.File]::ReadAllBytes($env:BIFANG_TEST_VAULT)) | ConvertFrom-Json",
    "$entropy = $utf8.GetBytes('Bifang/OperationsAssistant/application-version-credentials/v1')",
    "$ciphertext = [Convert]::FromBase64String($envelope.ciphertext_base64)",
    "$plaintext = [Security.Cryptography.ProtectedData]::Unprotect($ciphertext, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "try { [Console]::Out.Write($utf8.GetString($plaintext)) } finally { [Array]::Clear($plaintext, 0, $plaintext.Length) }",
  ].join("; ");
  const result = spawnSync(
    powershellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      env: minimalWindowsEnvironment({ BIFANG_TEST_VAULT: path }),
      timeout: 15_000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, "test-only DPAPI decryption must succeed");
  return JSON.parse(result.stdout);
}

function readAcl(path, directory) {
  const command = [
    "$isDirectory = $env:BIFANG_TEST_ACL_DIRECTORY -eq 'true'",
    "$acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($env:BIFANG_TEST_ACL_PATH) } else { [IO.File]::GetAccessControl($env:BIFANG_TEST_ACL_PATH) }",
    "$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.NTAccount]) | ForEach-Object { [pscustomobject]@{ identity = $_.IdentityReference.Value; inherited = $_.IsInherited; type = $_.AccessControlType.ToString(); rights = $_.FileSystemRights.ToString() } })",
    "[pscustomobject]@{ protected = $acl.AreAccessRulesProtected; directory = $env:BIFANG_TEST_ACL_DIRECTORY -eq 'true'; rules = $rules } | ConvertTo-Json -Compress -Depth 5",
  ].join("; ");
  const result = spawnSync(
    powershellPath,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      encoding: "utf8",
      env: minimalWindowsEnvironment({
        BIFANG_TEST_ACL_PATH: path,
        BIFANG_TEST_ACL_DIRECTORY: String(directory),
      }),
      timeout: 15_000,
      windowsHide: true,
    },
  );
  assert.equal(result.status, 0, "ACL inspection must succeed");
  assert.equal(result.stderr, "", "ACL inspection must not report an error");
  return JSON.parse(result.stdout);
}

function assertExclusiveCurrentUserAcl(acl) {
  assert.equal(acl.protected, true, JSON.stringify(acl));
  assert.equal(Array.isArray(acl.rules), true);
  assert.equal(acl.rules.length, 1);
  assert.equal(acl.rules[0].inherited, false);
  assert.equal(acl.rules[0].type, "Allow");
  assert.match(acl.rules[0].rights, /FullControl/);
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args[0]} must succeed`);
}

test(
  "Windows credential tool generates, protects and exports only runtime credentials",
  { skip: process.platform !== "win32", timeout: 120_000 },
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "bifang-application-version-credentials-"),
    );
    try {
      const digestPath = join(directory, "deployment", "credentials.b64");
      const vaultPath = join(directory, "private", "credentials.dpapi.json");
      const generateArgs = [
        "-Mode",
        "generate",
        "-RegistryPath",
        registryPath,
        "-DigestOutputPath",
        digestPath,
        "-VaultPath",
        vaultPath,
      ];
      const generated = runTool(generateArgs);
      assert.equal(generated.result.status, 0, generated.result.stderr);
      assert.equal(generated.result.stderr, "");
      const summary = JSON.parse(generated.result.stdout);
      assert.equal(summary.status, "generated");
      assert.equal(
        summary.digest_configuration_path.toLowerCase(),
        (await realpath(digestPath)).toLowerCase(),
      );
      assert.equal(
        summary.vault_path.toLowerCase(),
        (await realpath(vaultPath)).toLowerCase(),
      );
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      const expectedCredentialCount = registry.apps.reduce(
        (count, app) => count + app.release_streams.length + 2,
        1,
      );
      assert.equal(summary.credentials.length, expectedCredentialCount);
      assert.doesNotMatch(
        generated.result.stdout,
        /key_sha256|secret_sha256|app_key|app_secret/,
      );

      const digestBase64 = await readFile(digestPath, "utf8");
      assert.equal(summary.configuration_sha256, sha256(digestBase64));
      const canonicalBase64 = Buffer.from(digestBase64, "base64").toString(
        "base64",
      );
      assert.equal(canonicalBase64, digestBase64);
      const digestConfiguration = JSON.parse(
        Buffer.from(digestBase64, "base64").toString("utf8"),
      );
      const digestCredentials = expandCompactDigest(digestConfiguration);
      assert.equal(Buffer.byteLength(digestBase64, "utf8") > 4_096, true);
      // Eight registered apps no longer fit the runtime credential parser. A
      // reserved release stream must not silently bypass that deployment gate.
      assert.throws(
        () =>
          createApplicationVersionDeploymentPlan(registry, digestBase64, {
            envId: "bftoos-sh-d3ga7hahz59229f0a",
            origin:
              "https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com",
          }),
        /credential configuration must be base64 text/,
      );
      const vaultEnvelopeText = await readFile(vaultPath, "utf8");
      const vaultEnvelope = JSON.parse(vaultEnvelopeText);
      assert.deepEqual(Object.keys(vaultEnvelope).sort(), [
        "ciphertext_base64",
        "protection",
        "schema_version",
      ]);
      assert.equal(vaultEnvelope.protection, "Windows-DPAPI-CurrentUser");
      const rawVault = decryptVault(vaultPath);
      const rawCredentials = rawVault.credentials;
      assert.equal(rawCredentials.length, digestCredentials.length);

      const rawIds = new Set();
      const rawKeys = new Set();
      const rawSecrets = new Set();
      const allSecretValues = [];
      const allIndividualDigests = [];
      for (const raw of rawCredentials) {
        assert.equal(rawIds.has(raw.credential_id), false);
        rawIds.add(raw.credential_id);
        assert.equal(rawKeys.has(raw.app_key), false);
        rawKeys.add(raw.app_key);
        assert.equal(rawSecrets.has(raw.app_secret), false);
        rawSecrets.add(raw.app_secret);
        assert.equal(decodeBase64Url(raw.app_key).length >= 32, true);
        assert.equal(decodeBase64Url(raw.app_secret).length >= 32, true);
        const digest = digestCredentials.find(
          (item) => item.credential_id === raw.credential_id,
        );
        assert.equal(Boolean(digest), true);
        assert.equal(digest.key_sha256 === sha256(raw.app_key), true);
        assert.equal(digest.secret_sha256.length, 1);
        assert.equal(digest.secret_sha256[0] === sha256(raw.app_secret), true);
        assert.deepEqual(digest.codes, raw.codes);
        assert.deepEqual(digest.scopes, raw.scopes);
        assert.equal(digest.app_id, raw.app_id);
        allSecretValues.push(raw.app_key, raw.app_secret);
        allIndividualDigests.push(digest.key_sha256, ...digest.secret_sha256);
      }

      for (const app of registry.apps) {
        const codes = app.release_streams.map((stream) => stream.code).sort();
        const runtime = rawCredentials.filter(
          (item) => item.role === "runtime" && item.app_id === app.app_id,
        );
        assert.deepEqual(runtime.flatMap((item) => item.codes).sort(), codes);
        assert.equal(runtime.length, codes.length);
        assert.equal(
          runtime.every((item) => item.codes.length === 1),
          true,
        );
        assert.equal(
          runtime.every(
            (item) => JSON.stringify(item.scopes) === '["versions:check"]',
          ),
          true,
        );
        const managementRead = rawCredentials.filter(
          (item) =>
            item.role === "management-read" && item.app_id === app.app_id,
        );
        const managementWrite = rawCredentials.filter(
          (item) =>
            item.role === "management-write" && item.app_id === app.app_id,
        );
        assert.equal(managementRead.length, 1);
        assert.equal(managementWrite.length, 1);
        assert.deepEqual([...managementRead[0].codes].sort(), codes);
        assert.deepEqual([...managementWrite[0].codes].sort(), codes);
        assert.deepEqual(managementRead[0].scopes, [
          "versions:read",
          "ads:read",
        ]);
        assert.deepEqual(managementWrite[0].scopes, [
          "versions:write",
          "ads:write",
        ]);
      }
      const advertisementContractTests = rawCredentials.filter(
        (item) => item.role === "contract-test",
      );
      assert.equal(advertisementContractTests.length, 1);
      assert.equal(
        advertisementContractTests[0].credential_id,
        "contract-ads-bifang-screen-recorder-macos-arm64",
      );
      assert.deepEqual(advertisementContractTests[0].scopes, [
        "versions:check",
        "ads:show",
      ]);

      for (const sensitiveValue of [
        ...allSecretValues,
        ...allIndividualDigests,
      ]) {
        assert.equal(vaultEnvelopeText.includes(sensitiveValue), false);
        assert.equal(generated.result.stdout.includes(sensitiveValue), false);
        assert.equal(generated.result.stderr.includes(sensitiveValue), false);
        assert.equal(
          generated.invocation.some((argument) =>
            argument.includes(sensitiveValue),
          ),
          false,
        );
      }
      assertExclusiveCurrentUserAcl(readAcl(dirname(vaultPath), true));
      assertExclusiveCurrentUserAcl(readAcl(vaultPath, false));

      const digestBefore = await readFile(digestPath);
      const vaultBefore = await readFile(vaultPath);
      const refusedGenerate = runTool(generateArgs);
      assert.notEqual(refusedGenerate.result.status, 0);
      assert.match(refusedGenerate.result.stderr, /refusing to overwrite/);
      assert.deepEqual(await readFile(digestPath), digestBefore);
      assert.deepEqual(await readFile(vaultPath), vaultBefore);

      const runtimeCredential = rawCredentials.find(
        (item) => item.role === "runtime",
      );
      const runtimeOutputPath = join(directory, "exports", "runtime.json");
      const runtimeArgs = [
        "-Mode",
        "export-runtime",
        "-VaultPath",
        vaultPath,
        "-CredentialId",
        runtimeCredential.credential_id,
        "-OutputPath",
        runtimeOutputPath,
      ];
      const exported = runTool(runtimeArgs);
      assert.equal(exported.result.status, 0, exported.result.stderr);
      assert.equal(exported.result.stderr, "");
      const exportSummary = JSON.parse(exported.result.stdout);
      assert.equal(exportSummary.status, "runtime-exported");
      assert.equal(
        exportSummary.output_path.toLowerCase(),
        (await realpath(runtimeOutputPath)).toLowerCase(),
      );
      const runtimeFile = JSON.parse(await readFile(runtimeOutputPath, "utf8"));
      assert.equal(runtimeFile.credential_id, runtimeCredential.credential_id);
      assert.equal(runtimeFile.app_key === runtimeCredential.app_key, true);
      assert.equal(
        runtimeFile.app_secret === runtimeCredential.app_secret,
        true,
      );
      assert.equal(runtimeFile.code, runtimeCredential.codes[0]);
      assertExclusiveCurrentUserAcl(readAcl(runtimeOutputPath, false));

      if (pwshPath) {
        const pwshRuntimeOutputPath = join(
          directory,
          "exports",
          "runtime-pwsh.json",
        );
        const pwshRuntimeArgs = [
          "-Mode",
          "export-runtime",
          "-VaultPath",
          vaultPath,
          "-CredentialId",
          runtimeCredential.credential_id,
          "-OutputPath",
          pwshRuntimeOutputPath,
        ];
        const pwshExported = runTool(pwshRuntimeArgs, {}, pwshPath);
        assert.equal(pwshExported.result.status, 0, pwshExported.result.stderr);
        assert.equal(pwshExported.result.stderr, "");
        const pwshRuntimeFile = JSON.parse(
          await readFile(pwshRuntimeOutputPath, "utf8"),
        );
        assert.equal(
          pwshRuntimeFile.credential_id,
          runtimeCredential.credential_id,
        );
        assert.equal(pwshRuntimeFile.app_key, runtimeCredential.app_key);
        assert.equal(pwshRuntimeFile.app_secret, runtimeCredential.app_secret);
      }

      for (const sensitiveValue of [
        ...allSecretValues,
        ...allIndividualDigests,
      ]) {
        assert.equal(exported.result.stdout.includes(sensitiveValue), false);
        assert.equal(exported.result.stderr.includes(sensitiveValue), false);
        assert.equal(
          runtimeArgs.some((argument) => argument.includes(sensitiveValue)),
          false,
        );
      }
      const runtimeBefore = await readFile(runtimeOutputPath);
      const refusedExport = runTool(runtimeArgs);
      assert.notEqual(refusedExport.result.status, 0);
      assert.match(refusedExport.result.stderr, /refusing to overwrite/);
      assert.deepEqual(await readFile(runtimeOutputPath), runtimeBefore);

      const managementCredential = rawCredentials.find(
        (item) => item.role === "management-read",
      );
      const managementOutputPath = join(
        directory,
        "exports",
        "management.json",
      );
      const refusedManagement = runTool([
        "-Mode",
        "export-runtime",
        "-VaultPath",
        vaultPath,
        "-CredentialId",
        managementCredential.credential_id,
        "-OutputPath",
        managementOutputPath,
      ]);
      assert.notEqual(refusedManagement.result.status, 0);
      assert.match(
        refusedManagement.result.stderr,
        /only client runtime credentials can be exported/,
      );
      await assert.rejects(access(managementOutputPath), { code: "ENOENT" });

      const contractTestCredential = rawCredentials.find(
        (item) => item.role === "contract-test",
      );
      const contractTestOutputPath = join(
        directory,
        "exports",
        "contract-test.json",
      );
      const refusedContractTest = runTool([
        "-Mode",
        "export-runtime",
        "-VaultPath",
        vaultPath,
        "-CredentialId",
        contractTestCredential.credential_id,
        "-OutputPath",
        contractTestOutputPath,
      ]);
      assert.notEqual(refusedContractTest.result.status, 0);
      assert.match(
        refusedContractTest.result.stderr,
        /only client runtime credentials can be exported/,
      );
      await assert.rejects(access(contractTestOutputPath), { code: "ENOENT" });

      const gitDirectory = join(directory, "client-worktree");
      await writeFile(join(directory, "placeholder"), "", "utf8");
      runGit(directory, ["init", gitDirectory]);
      await writeFile(
        join(gitDirectory, ".gitignore"),
        "ignored-runtime.json\n",
        "utf8",
      );
      const trackedPath = join(gitDirectory, "tracked-runtime.json");
      await writeFile(trackedPath, "tracked placeholder\n", "utf8");
      runGit(gitDirectory, ["add", ".gitignore", "tracked-runtime.json"]);
      await unlink(trackedPath);

      const unignoredPath = join(gitDirectory, "unignored-runtime.json");
      const refusedUnignored = runTool([
        "-Mode",
        "export-runtime",
        "-VaultPath",
        vaultPath,
        "-CredentialId",
        runtimeCredential.credential_id,
        "-OutputPath",
        unignoredPath,
      ]);
      assert.notEqual(refusedUnignored.result.status, 0);
      assert.match(refusedUnignored.result.stderr, /must be ignored/);
      await assert.rejects(access(unignoredPath), { code: "ENOENT" });

      const refusedTracked = runTool([
        "-Mode",
        "export-runtime",
        "-VaultPath",
        vaultPath,
        "-CredentialId",
        runtimeCredential.credential_id,
        "-OutputPath",
        trackedPath,
      ]);
      assert.notEqual(refusedTracked.result.status, 0);
      assert.match(refusedTracked.result.stderr, /tracked by Git/);
      await assert.rejects(access(trackedPath), { code: "ENOENT" });

      const ignoredPath = join(gitDirectory, "ignored-runtime.json");
      const allowedIgnored = runTool([
        "-Mode",
        "export-runtime",
        "-VaultPath",
        vaultPath,
        "-CredentialId",
        runtimeCredential.credential_id,
        "-OutputPath",
        ignoredPath,
      ]);
      assert.equal(
        allowedIgnored.result.status,
        0,
        allowedIgnored.result.stderr,
      );
      const ignoredRuntime = JSON.parse(await readFile(ignoredPath, "utf8"));
      assert.equal(ignoredRuntime.app_key === runtimeCredential.app_key, true);
      assertExclusiveCurrentUserAcl(readAcl(ignoredPath, false));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
