import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDashboardServer } from "../server.mjs";

const apps = JSON.parse(
  await readFile(
    new URL("../../../cloudbase/apps.json", import.meta.url),
    "utf8",
  ),
);
const ACCESS_TOKEN = "standalone-access-token-for-tests-123456";
const METRICS_TOKEN = "cloudbase-metrics-token-for-tests-123456";
const streams = apps.apps.flatMap((app) =>
  app.release_streams.map((stream) => ({ appId: app.app_id, ...stream })),
);

function fixture(selectedAppId = "all", days = 7) {
  const appIds = apps.apps.map((app) => app.app_id);
  return {
    schemaVersion: 2,
    mode: "live",
    connection: "connected",
    connectionNote: "生产集合",
    environmentId: "bftoos-sh-d3ga7hahz59229f0a",
    timezone: "Asia/Shanghai",
    generatedAt: "2026-09-21T05:00:00.000Z",
    rangeDays: days,
    selectedAppId,
    totals: {
      todayActive: 3,
      yesterdayActive: 2,
      periodActive: 8,
      returningToday: 1,
      returningRate: 33.3,
      lastReceivedAt: "2026-09-21T04:58:00.000Z",
    },
    trend: Array.from({ length: days }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, "0")}`,
      total: index,
      byApp: Object.fromEntries(appIds.map((appId) => [appId, 0])),
    })),
    versions: [{ label: "1.0.0", value: 3, percent: 100, tone: "mint" }],
    platforms: [{ label: "windows", value: 3, percent: 100 }],
    architectures: [{ label: "x64", value: 3, percent: 100 }],
    releaseStreams: streams
      .filter(
        (stream) => selectedAppId === "all" || stream.appId === selectedAppId,
      )
      .map((stream) => ({
        ...stream,
        highestVersion: "1.0.0",
        status: "normal",
        updatedAt: "2026-09-20T05:00:00.000Z",
      })),
    alerts: [],
  };
}

async function withServer(run, options = {}) {
  const server = await createDashboardServer({
    apps,
    env: {
      NODE_ENV: "test",
      COOKIE_SECURE: "false",
      DASHBOARD_ACCESS_TOKEN: ACCESS_TOKEN,
      CLOUDBASE_METRICS_TOKEN: METRICS_TOKEN,
      ...(options.env ?? {}),
    },
    fetchImpl:
      options.fetchImpl ??
      (async () => {
        throw new Error("unexpected upstream request");
      }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await run(origin);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function login(origin, token = ACCESS_TOKEN) {
  const response = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken: token }),
  });
  return {
    response,
    cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "",
  };
}

test("standalone page is served without ChatGPT host dependencies", async () => {
  await withServer(async (origin) => {
    const response = await fetch(origin);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /运营统计独立站/);
    assert.doesNotMatch(body, /chatgpt|openai/i);
    assert.match(
      response.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
  });
});

test("metrics require a standalone signed session before upstream access", async () => {
  let fetched = false;
  await withServer(
    async (origin) => {
      const response = await fetch(`${origin}/api/metrics?app=all&days=7`);
      assert.equal(response.status, 401);
      assert.equal(fetched, false);
      assert.equal(response.headers.get("cache-control"), "no-store");
    },
    {
      fetchImpl: async () => {
        fetched = true;
        return Response.json(fixture());
      },
    },
  );
});

test("login rejects a wrong key and creates an HttpOnly strict session for the right key", async () => {
  await withServer(async (origin) => {
    const wrong = await login(origin, "wrong-token");
    assert.equal(wrong.response.status, 401);
    assert.equal(wrong.cookie, "");

    const correct = await login(origin);
    assert.equal(correct.response.status, 200);
    const setCookie = correct.response.headers.get("set-cookie");
    assert.match(setCookie, /^bifang_dashboard_session=v1\./);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, new RegExp(ACCESS_TOKEN));
  });
});

test("authenticated metrics stay same-origin, bind filters and remove extra upstream fields", async () => {
  await withServer(
    async (origin) => {
      const { cookie } = await login(origin);
      const response = await fetch(`${origin}/api/metrics?app=all&days=7`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(
        text,
        /install_id|source_ip|event_id|downloadUrl|cloudbase-metrics-token/,
      );
      const payload = JSON.parse(text);
      assert.equal(payload.totals.todayActive, 3);
      assert.deepEqual(
        payload.appIds,
        apps.apps.map((app) => app.app_id),
      );
    },
    {
      fetchImpl: async (url, options) => {
        assert.equal(url.pathname, "/admin/v1/metrics");
        assert.equal(url.search, "?days=7");
        assert.equal(options.headers.Authorization, `Bearer ${METRICS_TOKEN}`);
        const payload = fixture();
        payload.install_id = "must-not-leave-server";
        payload.totals.source_ip = "must-not-leave-server";
        payload.releaseStreams[0].downloadUrl = "must-not-leave-server";
        return Response.json(payload);
      },
    },
  );
});

test("invalid filters and invalid upstream shapes fail closed without demo data", async () => {
  let calls = 0;
  await withServer(
    async (origin) => {
      const { cookie } = await login(origin);
      for (const query of [
        "app=other&days=7",
        "app=all&days=8",
        "app=all&days=07",
        "app=all&days=7&days=14",
        "app=all&days=7&admin=true",
      ]) {
        const response = await fetch(`${origin}/api/metrics?${query}`, {
          headers: { Cookie: cookie },
        });
        assert.equal(response.status, 400, query);
      }
      assert.equal(calls, 0);

      const response = await fetch(`${origin}/api/metrics?app=all&days=7`, {
        headers: { Cookie: cookie },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "metrics_unavailable" });
      assert.equal(calls, 1);
    },
    {
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ ...fixture(), mode: "demo" });
      },
    },
  );
});

test("missing server secrets never produce an authenticated or fake result", async () => {
  await withServer(
    async (origin) => {
      const result = await login(origin);
      assert.equal(result.response.status, 503);
      const session = await fetch(`${origin}/api/session`);
      assert.deepEqual(await session.json(), { authenticated: false });
    },
    {
      env: {
        DASHBOARD_ACCESS_TOKEN: "",
        CLOUDBASE_METRICS_TOKEN: "",
      },
    },
  );
});
