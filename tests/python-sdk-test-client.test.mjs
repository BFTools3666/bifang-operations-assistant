import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BridgeRequestError,
  createBridgeDispatcher,
} from "../tools/python-sdk-test-client/bridge.mjs";

const BASE_REQUEST = {
  app_id: "bifang-tools",
  app_version: "0.1.0",
  platform: "windows",
  arch: "x64",
};
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function updateManifest(overrides = {}) {
  return {
    schema_version: 1,
    app_id: "bifang-tools",
    platform: "windows",
    enabled: true,
    latest_version: "0.2.0",
    min_supported_version: "0.1.0",
    force_update: false,
    rollout: 100,
    title: "Bifang Tools 0.2.0",
    message: "A tested update is available.",
    download_url: "https://downloads.example.invalid/bifang-tools-0.2.0.exe",
    release_notes_url: "https://releases.example.invalid/bifang-tools/0.2.0",
    sha256: "",
    published_at: "2026-09-03T04:43:55.000Z",
    ...overrides,
  };
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "bifang-sdk-client-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("capture initialization creates only one daily-active record and never uses network", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("network must stay disabled");
    };
    try {
      const first = await createBridgeDispatcher()({
        action: "init_capture",
        state_dir: stateDirectory,
        ...BASE_REQUEST,
      });
      assert.equal(first.network_performed, false);
      assert.equal(first.client.enabled, true);
      assert.ok(UUID_V4_PATTERN.test(first.client.install_id));
      assert.equal(Object.hasOwn(first.client, "session_id"), false);
      assert.equal(first.events.length, 1);

      const event = first.events[0];
      assert.deepEqual(Object.keys(event).sort(), [
        "app_id",
        "app_version",
        "arch",
        "event",
        "event_id",
        "install_id",
        "occurred_at",
        "platform",
        "schema_version",
        "sdk_version",
      ]);
      assert.equal(event.event, "daily_active");
      assert.equal(event.schema_version, 2);
      assert.equal(event.sdk_version, "2.0.0");
      assert.equal(event.app_id, BASE_REQUEST.app_id);
      assert.equal(event.app_version, BASE_REQUEST.app_version);
      assert.equal(event.platform, "windows");
      assert.equal(event.arch, "x64");
      assert.equal(event.install_id, first.client.install_id);
      for (const removed of [
        "channel",
        "session_id",
        "properties",
        "active_date",
        "source_ip",
        "ip",
      ]) {
        assert.equal(Object.hasOwn(event, removed), false, removed);
      }

      const second = await createBridgeDispatcher()({
        action: "init_capture",
        state_dir: stateDirectory,
        ...BASE_REQUEST,
      });
      assert.equal(second.client.install_id, first.client.install_id);
      assert.deepEqual(second.events, []);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("bridge namespaces one supplied state directory by app id", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const firstAppRequest = {
      action: "init_capture",
      state_dir: stateDirectory,
      ...BASE_REQUEST,
    };
    const otherAppRequest = {
      ...firstAppRequest,
      app_id: "bifang-tools-image",
    };

    const first = await createBridgeDispatcher()(firstAppRequest);
    const other = await createBridgeDispatcher()(otherAppRequest);
    const restarted = await createBridgeDispatcher()(firstAppRequest);

    assert.notEqual(first.client.install_id, other.client.install_id);
    assert.equal(restarted.client.install_id, first.client.install_id);
    assert.equal(first.events.length, 1);
    assert.equal(other.events.length, 1);
    assert.deepEqual(restarted.events, []);
  });
});

test("one approved test performs exactly one daily-active POST", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ ok: true }),
      };
    };
    try {
      const endpoint =
        "https://telemetry.example.com/apps/bifang-tools/v1/track";
      const result = await createBridgeDispatcher()({
        action: "send_daily_active",
        state_dir: stateDirectory,
        endpoint,
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });

      assert.equal(requests.length, 1);
      assert.equal(result.deliveries.length, 1);
      assert.equal(result.acknowledged_count, 1);
      assert.equal(result.deliveries[0].event, "daily_active");
      assert.equal(result.deliveries[0].acknowledged, true);
      assert.equal(result.deliveries[0].status, 202);
      assert.deepEqual(result.deliveries[0].ack, { ok: true });
      assert.equal(requests[0].url, endpoint);
      assert.equal(requests[0].init.method, "POST");
      assert.equal(requests[0].body.event, "daily_active");
      assert.equal(requests[0].body.schema_version, 2);
      assert.equal(requests[0].body.sdk_version, "2.0.0");
      assert.equal(requests[0].body.install_id, result.install_id);
      for (const removed of [
        "channel",
        "session_id",
        "properties",
        "active_date",
        "source_ip",
        "ip",
      ]) {
        assert.equal(Object.hasOwn(requests[0].body, removed), false, removed);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("a rejected daily-active POST stays a single structured failure", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ ok: false, error: "unknown_app" }),
      };
    };
    try {
      const result = await createBridgeDispatcher()({
        action: "send_daily_active",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/apps/bifang-tools/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });
      assert.equal(calls, 1);
      assert.equal(result.acknowledged_count, 0);
      assert.deepEqual(result.deliveries[0].error, {
        code: "server_rejected",
        http_status: 403,
        server_error: "unknown_app",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("ten-device simulation performs at most one POST per device", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    const payloads = [];
    const startTimes = [];
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    globalThis.fetch = async (_url, init) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      startTimes.push(performance.now());
      payloads.push(JSON.parse(init.body));
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return {
          ok: true,
          status: 202,
          text: async () => JSON.stringify({ ok: true }),
        };
      } finally {
        activeRequests -= 1;
      }
    };
    try {
      const result = await createBridgeDispatcher({
        simulationPostIntervalMs: 10,
      })({
        action: "simulate_devices",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/apps/bifang-tools/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });

      assert.equal(result.device_count, 10);
      assert.equal(result.devices.length, 10);
      assert.equal(result.deliveries.length, 10);
      assert.equal(result.acknowledged_count, 10);
      assert.equal(payloads.length, 10);
      assert.equal(maximumActiveRequests, 1);
      assert.ok(
        startTimes
          .slice(1)
          .every((startedAt, index) => startedAt - startTimes[index] >= 7),
      );
      assert.equal(
        new Set(result.devices.map((device) => device.install_id)).size,
        10,
      );
      assert.ok(
        result.devices.every((device) => device.deliveries.length === 1),
      );
      assert.ok(
        result.deliveries.every((item) => item.event === "daily_active"),
      );
      assert.deepEqual(
        new Set(result.devices.map((device) => device.platform)),
        new Set(["windows", "macos", "linux"]),
      );
      assert.deepEqual(
        new Set(result.devices.map((device) => device.arch)),
        new Set(["x64", "arm64", "ia32"]),
      );
      assert.ok(payloads.every((payload) => payload.event === "daily_active"));
      assert.ok(
        payloads.every((payload) => !Object.hasOwn(payload, "source_ip")),
      );
      assert.doesNotMatch(
        JSON.stringify(payloads),
        /channel|feature_|task_|account/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("simulation timeout is shared and releases the serialized action queue", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let hangingCalls = 0;
    globalThis.fetch = async () => {
      hangingCalls += 1;
      return new Promise(() => {});
    };
    try {
      const dispatch = createBridgeDispatcher({
        simulationTimeoutMs: 40,
        simulationPostIntervalMs: 10,
      });
      const startedAt = performance.now();
      const result = await dispatch({
        action: "simulate_devices",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/apps/bifang-tools/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });
      assert.ok(performance.now() - startedAt < 2_000);
      assert.ok(hangingCalls <= 10);
      assert.equal(result.deliveries.length, 10);
      assert.equal(result.acknowledged_count, 0);
      assert.ok(
        result.deliveries.every(
          (delivery) =>
            delivery.acknowledged === false &&
            delivery.error?.code === "timeout",
        ),
      );

      globalThis.fetch = async () => ({
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ ok: true }),
      });
      const next = await dispatch({
        action: "send_daily_active",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/apps/bifang-tools/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });
      assert.equal(next.acknowledged_count, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("network actions fail closed without consent or canonical public HTTPS URLs", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("must remain offline");
    };
    try {
      const dispatch = createBridgeDispatcher();
      await assert.rejects(
        dispatch({
          action: "send_daily_active",
          state_dir: stateDirectory,
          endpoint: "https://telemetry.example.com/apps/bifang-tools/v1/track",
          ...BASE_REQUEST,
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "network_consent_required",
      );
      await assert.rejects(
        dispatch({
          action: "send_daily_active",
          state_dir: stateDirectory,
          endpoint: "http://127.0.0.1/v1/track",
          allow_network: true,
          confirmation: "POST",
          ...BASE_REQUEST,
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "unsafe_endpoint",
      );
      await assert.rejects(
        dispatch({
          action: "check_update_url",
          state_dir: stateDirectory,
          update_url: "https://updates.example.com/a/../windows.json",
          allow_network: true,
          confirmation: "GET",
          ...BASE_REQUEST,
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "unsafe_update_url",
      );
      await assert.rejects(
        dispatch({
          action: "track_live",
          allow_network: true,
          confirmation: "POST",
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "unknown_action",
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("full update URL is fetched freshly while identities stay stable per app", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const updateUrl =
      "https://updates.example.com/releases/bifang-tools/windows.json";
    const otherUpdateUrl =
      "https://updates.example.com/releases/bifang-tools-image/windows.json";
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      const body =
        url === otherUpdateUrl
          ? updateManifest({ app_id: "bifang-tools-image" })
          : calls.length === 1
            ? updateManifest({
                latest_version: "0.1.0",
                min_supported_version: "0.1.0",
              })
            : updateManifest();
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
      };
    };
    try {
      const request = {
        action: "check_update_url",
        state_dir: join(stateDirectory, "stable-update-identity"),
        update_url: updateUrl,
        allow_network: true,
        confirmation: "GET",
        ...BASE_REQUEST,
      };
      const dispatch = createBridgeDispatcher();
      const first = await dispatch(request);
      const second = await dispatch(request);
      const otherApp = await dispatch({
        ...request,
        app_id: "bifang-tools-image",
        update_url: otherUpdateUrl,
      });
      assert.deepEqual(first.decision, { kind: "none", reason: "up_to_date" });
      assert.equal(second.decision.kind, "optional");
      assert.equal(first.install_id, second.install_id);
      assert.notEqual(first.install_id, otherApp.install_id);
      assert.equal(calls.length, 3);
      assert.deepEqual(
        calls.map((call) => call.url),
        [updateUrl, updateUrl, otherUpdateUrl],
      );
      assert.ok(calls.every((call) => call.init.method === "GET"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("local update preview remains network-free", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("network must stay disabled");
    };
    try {
      const dispatch = createBridgeDispatcher();
      await dispatch({
        action: "init_capture",
        state_dir: stateDirectory,
        ...BASE_REQUEST,
      });
      const result = await dispatch({
        action: "preview_update",
        manifest: updateManifest(),
        ...BASE_REQUEST,
      });
      assert.equal(result.decision.kind, "optional");
      assert.equal(result.network_performed, false);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("JSON Lines bridge returns structured errors and reports SDK 2", async () => {
  const bridgePath = new URL(
    "../tools/python-sdk-test-client/bridge.mjs",
    import.meta.url,
  );
  const child = spawn(process.execPath, [fileURLToPath(bridgePath)], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.stdin.write("{not json}\r\n");
  child.stdin.write(
    `${JSON.stringify({ request_id: "unicode-毕方", action: "ping" })}\n`,
  );
  child.stdin.end();
  const exitCode = await new Promise((resolveExit) => {
    child.on("close", resolveExit);
  });

  assert.equal(exitCode, 0, stderr);
  assert.equal(stderr, "");
  const responses = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.ok(
    responses.some(
      (response) =>
        response.ok === false && response.error.code === "invalid_json",
    ),
  );
  assert.ok(
    responses.some(
      (response) =>
        response.ok === true &&
        response.request_id === "unicode-毕方" &&
        response.result.sdk_version === "2.0.0",
    ),
  );
});
