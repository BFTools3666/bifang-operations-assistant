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
  deriveSimulationVersions,
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
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXPECTED_BATCH_EVENTS = [
  "app_install",
  "app_start",
  "feature_used",
  "task_started",
  "task_succeeded",
  "task_failed",
  "update_prompt_shown",
  "update_clicked",
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

test("live update preflight builds the exact SDK URL without network", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("preflight must stay offline");
  };
  try {
    const dispatch = createBridgeDispatcher();
    const prepared = await dispatch({
      action: "build_update_url",
      base_url: "https://updates.example.com/base",
      ...BASE_REQUEST,
    });
    assert.deepEqual(prepared, {
      request_url: "https://updates.example.com/base/example-tool/windows.json",
      network_performed: false,
    });
    await assert.rejects(
      dispatch({
        action: "build_update_url",
        base_url: "http://localhost/updates",
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

test("live event send requires the exact initialized endpoint", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ ok: true }),
      };
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

test("send_test_batch uses SDK-generated events and requires a strict ack per item", async () => {
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
      const endpoint = "https://telemetry.example.com/v1/track";
      const result = await createBridgeDispatcher()({
        action: "send_test_batch",
        state_dir: stateDirectory,
        endpoint,
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });

      assert.equal(result.network_performed, true);
      assert.equal(result.acknowledged_count, 8);
      assert.equal(result.deliveries.length, 8);
      assert.deepEqual(
        result.deliveries.map((delivery) => delivery.event),
        EXPECTED_BATCH_EVENTS,
      );
      assert.ok(UUID_V4_PATTERN.test(result.session_id));
      assert.equal(
        new Set(result.deliveries.map((item) => item.event_id)).size,
        8,
      );
      for (const delivery of result.deliveries) {
        assert.equal(delivery.acknowledged, true);
        assert.equal(delivery.status, 202);
        assert.deepEqual(delivery.ack, { ok: true });
        assert.equal(delivery.error, null);
        assert.ok(UUID_V4_PATTERN.test(delivery.event_id));
      }

      assert.equal(requests.length, 8);
      assert.ok(requests.every((request) => request.url === endpoint));
      assert.ok(
        requests.every(
          (request) =>
            request.init.method === "POST" && request.init.cache === "no-store",
        ),
      );
      assert.deepEqual(
        requests.map((request) => request.body.event),
        EXPECTED_BATCH_EVENTS,
      );
      assert.ok(
        requests.every(
          (request) => request.body.session_id === result.session_id,
        ),
      );
      assert.doesNotMatch(JSON.stringify(requests), /login|account/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("send_test_batch preserves each ack and structured partial failure", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      if (callCount === 2) {
        return {
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ ok: false, error: "unknown_app" }),
        };
      }
      if (callCount === 5) {
        throw new TypeError("private network detail");
      }
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ ok: true }),
      };
    };
    try {
      const result = await createBridgeDispatcher()({
        action: "send_test_batch",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });

      assert.equal(result.deliveries.length, 8);
      assert.equal(result.acknowledged_count, 6);
      assert.deepEqual(result.deliveries[1].error, {
        code: "server_rejected",
        http_status: 403,
        server_error: "unknown_app",
      });
      assert.equal(result.deliveries[1].status, 403);
      assert.deepEqual(result.deliveries[4].error, {
        code: "network_error",
      });
      assert.equal(result.deliveries[4].status, null);
      assert.ok(
        result.deliveries
          .filter((_delivery, index) => index !== 1 && index !== 4)
          .every((delivery) => delivery.acknowledged === true),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("simulation versions derive safely from the entered strict version", () => {
  assert.deepEqual(deriveSimulationVersions("7.4.2"), [
    "7.4.1",
    "7.4.2",
    "7.4.3",
  ]);
  assert.deepEqual(deriveSimulationVersions("0.0.0"), [
    "0.0.0",
    "0.0.1",
    "0.0.2",
  ]);
  assert.deepEqual(deriveSimulationVersions("7.4.2-beta.1+build.9"), [
    "7.4.1",
    "7.4.2-beta.1+build.9",
    "7.4.3",
  ]);
  assert.throws(
    () => deriveSimulationVersions("v7.4"),
    (error) =>
      error instanceof BridgeRequestError && error.code === "invalid_request",
  );
});

test("simulate_devices creates ten anonymous SDK identities with planned distributions", async () => {
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
      const requestNumber = payloads.length;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (requestNumber === 7 || requestNumber === 23) {
          return {
            ok: false,
            status: 403,
            text: async () =>
              JSON.stringify({ ok: false, error: "unknown_app" }),
          };
        }
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
      const result = await createBridgeDispatcher()({
        action: "simulate_devices",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
        app_version: "7.4.2",
      });

      assert.equal(result.device_count, 10);
      assert.equal(result.devices.length, 10);
      assert.equal(result.deliveries.length, 50);
      assert.equal(result.acknowledged_count, 48);
      assert.equal(payloads.length, 50);
      assert.equal(maximumActiveRequests, 1);
      assert.ok(
        startTimes
          .slice(1)
          .every((startedAt, index) => startedAt - startTimes[index] >= 150),
      );
      assert.equal(
        new Set(result.devices.map((device) => device.install_id)).size,
        10,
      );
      assert.equal(
        new Set(result.devices.map((device) => device.session_id)).size,
        10,
      );
      assert.ok(
        result.devices.every(
          (device) =>
            UUID_V4_PATTERN.test(device.install_id) &&
            UUID_V4_PATTERN.test(device.session_id) &&
            device.deliveries.length === 5,
        ),
      );
      assert.deepEqual(
        new Set(result.devices.map((device) => device.channel)),
        new Set(["official", "wechat", "bilibili"]),
      );
      assert.deepEqual(
        new Set(result.devices.map((device) => device.arch)),
        new Set(["x64", "arm64"]),
      );
      assert.deepEqual(
        new Set(result.devices.map((device) => device.app_version)),
        new Set(["7.4.1", "7.4.2", "7.4.3"]),
      );
      assert.deepEqual(result.simulation_versions, ["7.4.1", "7.4.2", "7.4.3"]);
      assert.deepEqual(
        Object.fromEntries(
          ["7.4.1", "7.4.2", "7.4.3"].map((version) => [
            version,
            result.devices.filter((device) => device.app_version === version)
              .length,
          ]),
        ),
        { "7.4.1": 3, "7.4.2": 4, "7.4.3": 3 },
      );
      assert.deepEqual(
        Object.fromEntries(
          ["official", "wechat", "bilibili"].map((channel) => [
            channel,
            result.devices.filter((device) => device.channel === channel)
              .length,
          ]),
        ),
        { official: 5, wechat: 3, bilibili: 2 },
      );
      assert.deepEqual(
        Object.fromEntries(
          ["x64", "arm64"].map((arch) => [
            arch,
            result.devices.filter((device) => device.arch === arch).length,
          ]),
        ),
        { x64: 7, arm64: 3 },
      );
      assert.ok(
        result.devices.every(
          (device) =>
            device.deliveries[0].event === "app_install" &&
            device.deliveries[1].event === "app_start",
        ),
      );
      assert.equal(
        result.deliveries.filter((delivery) => !delivery.acknowledged).length,
        2,
      );
      assert.ok(
        result.deliveries
          .filter((delivery) => !delivery.acknowledged)
          .every(
            (delivery) =>
              delivery.status === 403 &&
              delivery.error.code === "server_rejected" &&
              delivery.error.server_error === "unknown_app",
          ),
      );
      assert.equal(
        new Set(payloads.map((payload) => payload.event_id)).size,
        50,
      );
      assert.equal(
        new Set(result.deliveries.map((delivery) => delivery.event_id)).size,
        50,
      );
      assert.equal(
        new Set(payloads.map((payload) => payload.install_id)).size,
        10,
      );
      assert.deepEqual(
        new Set(payloads.map((payload) => payload.app_version)),
        new Set(["7.4.1", "7.4.2", "7.4.3"]),
      );
      assert.doesNotMatch(JSON.stringify(payloads), /login|account/i);
      assert.ok(
        payloads.every((payload) =>
          [
            "app_install",
            "app_start",
            "feature_used",
            "task_started",
            "task_succeeded",
            "task_failed",
          ].includes(payload.event),
        ),
      );
      assert.deepEqual(
        Object.fromEntries(
          [
            "app_install",
            "app_start",
            "feature_used",
            "task_started",
            "task_succeeded",
            "task_failed",
          ].map((event) => [
            event,
            payloads.filter((payload) => payload.event === event).length,
          ]),
        ),
        {
          app_install: 10,
          app_start: 10,
          feature_used: 10,
          task_started: 10,
          task_succeeded: 7,
          task_failed: 3,
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("simulate_devices shares one timeout window and releases the action queue", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    let hangingCalls = 0;
    globalThis.fetch = async () => {
      hangingCalls += 1;
      return new Promise(() => {});
    };
    try {
      const dispatch = createBridgeDispatcher({ simulationTimeoutMs: 40 });
      const startedAt = performance.now();
      const result = await dispatch({
        action: "simulate_devices",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });

      assert.ok(performance.now() - startedAt < 2_000);
      assert.equal(hangingCalls, 1);
      assert.equal(result.deliveries.length, 50);
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
      const nextResult = await dispatch({
        action: "send_test_batch",
        state_dir: stateDirectory,
        endpoint: "https://telemetry.example.com/v1/track",
        allow_network: true,
        confirmation: "POST",
        ...BASE_REQUEST,
      });
      assert.equal(nextResult.acknowledged_count, 8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("check_update_url fetches the exact full URL every time with stable SDK identity", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const updateUrl =
      "https://updates.example.com/releases/example-tool/windows.json";
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      const body =
        calls.length === 1
          ? updateManifest({
              latest_version: "0.1.0",
              min_supported_version: "0.1.0",
            })
          : updateManifest({ latest_version: "0.2.0" });
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

      assert.deepEqual(first.decision, {
        kind: "none",
        reason: "up_to_date",
      });
      assert.equal(first.config.latest_version, "0.1.0");
      assert.equal(second.decision.kind, "optional");
      assert.equal(second.decision.config.latest_version, "0.2.0");
      assert.equal(second.config.latest_version, "0.2.0");
      assert.equal(first.install_id, second.install_id);
      assert.ok(UUID_V4_PATTERN.test(first.install_id));
      assert.equal(first.is_first_install, true);
      assert.equal(second.is_first_install, false);
      assert.equal(calls.length, 2);
      const afterDispatcherRestart = await createBridgeDispatcher()(request);
      assert.equal(afterDispatcherRestart.install_id, first.install_id);
      assert.equal(afterDispatcherRestart.is_first_install, false);
      assert.equal(calls.length, 3);
      assert.ok(calls.every((call) => call.url === updateUrl));
      assert.ok(
        calls.every(
          (call) =>
            call.init.method === "GET" &&
            call.init.cache === "no-store" &&
            !Object.hasOwn(call.init.headers, "cache-control") &&
            !Object.hasOwn(call.init, "body"),
        ),
      );
      assert.equal(first.original_url, updateUrl);
      assert.equal(first.actual_url, updateUrl);
      assert.equal(first.fetch_diagnostic.cache, "no-store");
      assert.equal(first.fetch_diagnostic.sdk_request_url, updateUrl);
      assert.equal(second.fetch_diagnostic.http_status, 200);
      assert.equal(
        calls.filter((call) => call.init.method === "POST").length,
        0,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("check_update_url retains safe config summaries for disabled and rollout decisions", async () => {
  await withTemporaryDirectory(async (stateDirectory) => {
    const originalFetch = globalThis.fetch;
    const manifests = [
      updateManifest({ enabled: false }),
      updateManifest({ rollout: 0 }),
    ];
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(manifests.shift()),
    });
    try {
      const dispatch = createBridgeDispatcher();
      const request = {
        action: "check_update_url",
        state_dir: join(stateDirectory, "stable-update-identity"),
        update_url: "https://updates.example.com/example-tool/windows.json",
        allow_network: true,
        confirmation: "GET",
        ...BASE_REQUEST,
      };
      const disabled = await dispatch(request);
      const rollout = await dispatch(request);
      assert.deepEqual(disabled.decision, {
        kind: "none",
        reason: "disabled",
      });
      assert.equal(disabled.config.enabled, false);
      assert.deepEqual(rollout.decision, {
        kind: "none",
        reason: "rollout",
      });
      assert.equal(rollout.config.rollout, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("new network actions reject missing consent and noncanonical URLs before fetching", async () => {
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
          action: "send_test_batch",
          state_dir: stateDirectory,
          endpoint: "https://telemetry.example.com/v1/track",
          ...BASE_REQUEST,
        }),
        (error) =>
          error instanceof BridgeRequestError &&
          error.code === "network_consent_required",
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
      assert.equal(fetchCalls, 0);
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
          headers: {
            accept: "application/json",
          },
          cache: "no-store",
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
