import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import * as sdk from "../dist/index.js";
import {
  ClientUpdateService,
  isSameInstallTarget,
  parseClientUpdateSnapshot,
} from "../dist/index.js";

test("built SDK exposes only the current update protocol and removes retired output", async () => {
  assert.equal(typeof sdk.TelemetryClient, "function");
  assert.equal(typeof sdk.ClientUpdateService, "function");
  assert.equal("ApplicationVersionChecker" in sdk, false);
  assert.equal("DEFAULT_APPLICATION_VERSION_TIMEOUT_MS" in sdk, false);
  const output = await readdir(new URL("../dist/", import.meta.url));
  assert.equal(
    output.some((name) => name.startsWith("update-checker.")),
    false,
  );
});

const request = {
  current_version: "1.0.0",
  channel: "stable",
  os: "windows",
  os_version: "10.0.19045",
  architecture: "x86_64",
  installation_type: "installed",
  installation_id: "9e3c721a-2ed1-4f55-8a21-134db938d631",
  trigger: "manual",
  capabilities: ["download"],
};
const base = {
  id: "chk_1",
  app_id: "my-app",
  server_time: "2026-10-27T02:38:06Z",
  expires_at: "2026-10-27T02:48:06Z",
  decision: "update_available",
  reason: "required_by_policy",
  required: true,
  enforcement: "block_new_operations",
  action: "download_and_install",
  force_after: null,
  next_check_after_seconds: 3600,
  mandatory_cache_expires_at: "2026-10-28T02:38:06Z",
  release: {
    id: "rel_1",
    version: "1.1.0",
    notes: {
      locale: "zh-CN",
      title: "更新",
      items: [{ category: "fix", text: "修复" }],
    },
  },
  artifact: {
    id: "art_1",
    size_bytes: 123,
    sha256: "a".repeat(64),
    download_url:
      "https://update.meetelf.com/api/v1/apps/my-app/artifacts/art_1/download?check_id=chk_1",
    manual_download_page_url: null,
  },
};
const token = "a".repeat(32);

test("sends the new POST request and preserves the service decision", async () => {
  let seen;
  const checker = new ClientUpdateService({
    appId: "my-app",
    token,
    fetch: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(base), { status: 201 });
    },
  });
  const result = await checker.check(request);
  assert.equal(result.kind, "snapshot");
  assert.equal(result.snapshot.enforcement, "block_new_operations");
  assert.equal(
    seen.url,
    "https://update.meetelf.com/api/v1/apps/my-app/update-checks",
  );
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(seen.init.body), request);
  assert.equal(seen.init.redirect, "error");
});

test("allows only the explicit local origin and validates local download URLs", async () => {
  let seen;
  const local = {
    ...base,
    artifact: {
      ...base.artifact,
      download_url:
        "http://127.0.0.1:8080/api/v1/apps/my-app/artifacts/art_1/download?check_id=chk_1",
    },
  };
  const checker = new ClientUpdateService({
    appId: "my-app",
    token,
    baseUrl: "http://127.0.0.1:8080/",
    fetch: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(local), { status: 201 });
    },
  });
  assert.equal((await checker.check(request)).kind, "snapshot");
  assert.equal(
    seen.url,
    "http://127.0.0.1:8080/api/v1/apps/my-app/update-checks",
  );
  assert.equal(seen.init.redirect, "error");
  assert.equal(parseClientUpdateSnapshot(local, "my-app"), null);
  for (const url of [
    "http://localhost:8080",
    "http://127.0.0.1:8081",
    "http://127.0.0.1:8080/path",
    "http://user@127.0.0.1:8080",
    "http://127.0.0.1:8080.evil.test",
  ]) {
    let called = false;
    const invalid = new ClientUpdateService({
      appId: "my-app",
      token,
      baseUrl: url,
      fetch: async () => {
        called = true;
        throw new Error("must not send");
      },
    });
    assert.equal((await invalid.check(request)).reason, "invalid_config");
    assert.equal(called, false);
  }
  for (const url of [
    "http://127.0.0.1:8081/file",
    "http://127.1:8080/file",
    "http://user@127.0.0.1:8080/file",
    "http://127.0.0.1:8080/file#fragment",
    "https://update.meetelf.com/file",
  ]) {
    assert.equal(
      parseClientUpdateSnapshot(
        { ...local, artifact: { ...local.artifact, download_url: url } },
        "my-app",
        "http://127.0.0.1:8080",
      ),
      null,
    );
  }
});

test("invalid, unavailable and unknown outcomes never invent an update decision", async () => {
  const checker = new ClientUpdateService({
    appId: "my-app",
    token,
    fetch: async () =>
      new Response("", { status: 503, headers: { "Retry-After": "60" } }),
  });
  assert.deepEqual(await checker.check(request), {
    kind: "error",
    reason: "unavailable",
    status: 503,
    retryAfter: "60",
  });
  for (const change of [
    { decision: "unknown" },
    { action: "unknown" },
    { enforcement: "unknown" },
    { app_id: "other" },
    {
      artifact: {
        ...base.artifact,
        download_url: "https://evil.example.org/file",
      },
    },
    { mandatory_cache_expires_at: null },
  ]) {
    assert.equal(
      parseClientUpdateSnapshot({ ...base, ...change }, "my-app"),
      null,
    );
  }
  const unavailable = {
    ...base,
    decision: "update_unavailable",
    action: "none",
    enforcement: "none",
  };
  assert.equal(
    parseClientUpdateSnapshot(unavailable, "my-app").enforcement,
    "none",
  );
  assert.equal(
    parseClientUpdateSnapshot(
      { ...unavailable, enforcement: "block_new_operations" },
      "my-app",
    ),
    null,
  );
});

test("pre-install target comparison rejects changes and manual page actions", () => {
  const first = parseClientUpdateSnapshot(base, "my-app");
  assert.equal(isSameInstallTarget(first, first), false);
  const fresh = { ...first, id: "chk_2" };
  assert.equal(isSameInstallTarget(first, fresh), true);
  assert.equal(
    isSameInstallTarget(first, {
      ...fresh,
      artifact: { ...first.artifact, sha256: "b".repeat(64) },
    }),
    false,
  );
  assert.equal(
    isSameInstallTarget(first, { ...fresh, action: "auto_install" }),
    false,
  );
  assert.equal(
    isSameInstallTarget(
      { ...fresh, action: "open_download_page" },
      { ...first, action: "open_download_page" },
    ),
    false,
  );
});

test("rejects invalid capabilities and times out even when a fetcher ignores abort", async () => {
  const checker = new ClientUpdateService({
    appId: "my-app",
    token,
    timeoutMs: 10,
    fetch: () => new Promise(() => {}),
  });
  assert.equal(
    (await checker.check({ ...request, capabilities: ["auto_install"] }))
      .reason,
    "invalid_config",
  );
  assert.equal((await checker.check(request)).reason, "unavailable");
});
