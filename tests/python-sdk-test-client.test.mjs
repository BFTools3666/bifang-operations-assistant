import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BridgeRequestError,
  createBridgeDispatcher,
} from "../tools/python-sdk-test-client/bridge.mjs";

const BASE_REQUEST = {
  app_id: "example-tool",
  app_version: "0.1.0",
  platform: "windows",
  arch: "x64",
  channel: "official",
};

const EVENT_KEYS = [
  "app_id",
  "app_version",
  "arch",
  "channel",
  "event",
  "event_id",
  "install_id",
  "occurred_at",
  "platform",
  "properties",
  "schema_version",
  "sdk_version",
  "session_id",
];

function updateManifest(overrides = {}) {
  return {
    schema_version: 1,
    app_id: "example-tool",
    platform: "windows",
    enabled: true,
    latest_version: "0.2.0",
    min_supported_version: "0.1.0",
    force_update: false,
    rollout: 100,
    title: "Example Tool 0.2.0",
    message: "A tested update is available.",
    download_url: "https://downloads.example.invalid/example-tool-0.2.0.exe",
    release_notes_url: "https://releases.example.invalid/example-tool/0.2.0",
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

test("capture initialization and all event previews use the real SDK without network", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("network must stay disabled");
    };
    try {
      const dispatch = createBridgeDispatcher();
      const requestWithoutChannel = { ...BASE_REQUEST };
      delete requestWithoutChannel.channel;
      const initialized = await dispatch({
        action: "init_capture",
        state_dir: stateDirectory,
        ...requestWithoutChannel,
      });
      assert.equal(initialized.network_performed, false);
      assert.equal(initialized.client.enabled, true);
      assert.deepEqual(
        initialized.events.map((event) => event.event),
        ["app_install", "app_start"],
      );

      const cases = [
        ["feature_used", { feature_id: "export_csv" }],
        ["task_started", { task_type: "batch_export" }],
        ["task_succeeded", { task_type: "batch_export", duration_ms: 120 }],
        ["task_failed", { task_type: "batch_export", error_code: "E_TIMEOUT" }],
        ["update_prompt_shown", { target_version: "1.2.3" }],
        ["update_clicked", { target_version: "1.2.3" }],
      ];

      const allEvents = [...initialized.events];
      for (const [event, properties] of cases) {
        const result = await dispatch({
          action: "track_capture",
          event,
          properties,
        });
        assert.equal(result.accepted_by_sdk, true, event);
        assert.equal(result.network_performed, false, event);
        assert.equal(result.events.length, 1, event);
        assert.deepEqual(result.events[0].properties, properties, event);
        allEvents.push(result.events[0]);
      }

      for (const event of allEvents) {
        assert.deepEqual(Object.keys(event).sort(), EVENT_KEYS, event.event);
        assert.equal(event.schema_version, 1);
        assert.equal(event.sdk_version, "1.0.0");
        assert.equal(event.channel, "official");
        assert.equal(Object.hasOwn(event, "received_at"), false);
      }
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("capture identity persists across bridge restarts", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const first = await createBridgeDispatcher()({
      action: "init_capture",
      state_dir: stateDirectory,
      ...BASE_REQUEST,
    });
    const second = await createBridgeDispatcher()({
      action: "init_capture",
      state_dir: stateDirectory,
      ...BASE_REQUEST,
    });

    assert.equal(second.client.install_id, first.client.install_id);
    assert.notEqual(second.client.session_id, first.client.session_id);
    assert.deepEqual(
      second.events.map((event) => event.event),
      ["app_start"],
    );
  });
});

test("missing, old, and extra properties are dropped whole by the SDK", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const dispatch = createBridgeDispatcher();
    await dispatch({
      action: "init_capture",
      state_dir: stateDirectory,
      ...BASE_REQUEST,
    });
    const cases = [
      [
        "feature_used",
        { feature_id: "export_csv", private_text: "do not send" },
      ],
      ["task_succeeded", { task_type: "batch_export" }],
      ["update_clicked", { latest_version: "1.2.3", action: "update_now" }],
    ];
    for (const [event, properties] of cases) {
      const result = await dispatch({
        action: "track_capture",
        event,
        properties,
      });
      assert.equal(result.accepted_by_sdk, false, event);
      assert.deepEqual(result.events, [], event);
    }
  });
});

test("concurrent telemetry requests keep response event ownership exact", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const dispatch = createBridgeDispatcher();
    await dispatch({
      action: "init_capture",
      state_dir: stateDirectory,
      ...BASE_REQUEST,
    });

    const [first, second] = await Promise.all([
      dispatch({
        action: "track_capture",
        event: "feature_used",
        properties: { feature_id: "first" },
      }),
      dispatch({
        action: "track_capture",
        event: "feature_used",
        properties: { feature_id: "second" },
      }),
    ]);

    assert.deepEqual(
      first.events.map((event) => event.properties.feature_id),
      ["first"],
    );
    assert.deepEqual(
      second.events.map((event) => event.properties.feature_id),
      ["second"],
    );
  });
});

test("live actions fail closed without exact consent or an SDK-safe URL", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected network call");
    };
    try {
      const dispatch = createBridgeDispatcher();
      await assert.rejects(
        dispatch({
          action: "init_live",
          state_dir: stateDirectory,
          endpoint: "https://telemetry.example.com/track",
          ...BASE_REQUEST,
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "network_consent_required",
      );
      await assert.rejects(
        dispatch({
          action: "init_live",
          state_dir: stateDirectory,
          endpoint: "http://127.0.0.1/track",
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
          action: "check_update_live",
          base_url: "https://updates.example.com/base",
          ...BASE_REQUEST,
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "network_consent_required",
      );
      await assert.rejects(
        dispatch({
          action: "check_update_live",
          base_url: "http://localhost/updates",
          allow_network: true,
          confirmation: "GET",
          ...BASE_REQUEST,
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "unsafe_update_url",
      );
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("live event send requires the exact initialized endpoint", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return { ok: true };
    };
    try {
      const dispatch = createBridgeDispatcher();
      await dispatch({
        action: "init_live",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });
      const callsAfterInit = fetchCalls;
      await assert.rejects(
        dispatch({
          action: "track_live",
          endpoint: "https://other.example.com/track",
          event: "feature_used",
          properties: { feature_id: "export_csv" },
          allow_network: true,
          confirmation: "POST",
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "endpoint_mismatch",
      );
      assert.equal(fetchCalls, callsAfterInit);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("local update preview returns the SDK decision and canonical request", async () => {
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
      const optional = await dispatch({
        action: "preview_update",
        manifest: updateManifest(),
        ...BASE_REQUEST,
      });
      assert.equal(optional.decision.kind, "optional");
      assert.equal(optional.network_performed, false);
      assert.deepEqual(optional.sdk_requests, [
        {
          url: "https://updates.example.invalid/python-sdk-test-client/preview/example-tool/windows.json",
          method: "GET",
          headers: { accept: "application/json" },
        },
      ]);

      const current = await dispatch({
        action: "preview_update",
        manifest: updateManifest({
          latest_version: "0.1.0",
          min_supported_version: "0.1.0",
        }),
        ...BASE_REQUEST,
      });
      assert.deepEqual(current.decision, {
        kind: "none",
        reason: "up_to_date",
      });
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("JSON Lines bridge returns structured errors and remains usable", async () => {
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
        response.result.sdk_version === "1.0.0",
    ),
  );
});
