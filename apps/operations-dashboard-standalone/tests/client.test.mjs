import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(
  new URL("../public/app.js", import.meta.url),
  "utf8",
);

function client(search, appIds, labels) {
  const nodes = new Map();
  const calls = [];
  const urls = [];
  class Element {
    children = [];
    classList = { toggle() {} };
    style = { setProperty() {} };
    get options() {
      return this.children;
    }
    append(...children) {
      this.children.push(...children);
    }
    replaceChildren(...children) {
      this.children = [...children];
    }
    querySelectorAll() {
      return [];
    }
    setAttribute() {}
  }
  const context = vm.createContext({
    URLSearchParams,
    Intl,
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, new Element());
        return nodes.get(id);
      },
      createElement() {
        return new Element();
      },
    },
    location: { search },
    history: { replaceState: (_state, _title, url) => urls.push(url) },
    fetch: async (url) => {
      calls.push(url);
      const query = new URL(url, "https://dashboard.test").searchParams;
      return Response.json({
        appIds,
        appLabels: labels,
        selectedAppId: query.get("app"),
        rangeDays: Number(query.get("days")),
        connectionNote: "生产集合",
        totals: {
          todayActive: 0,
          yesterdayActive: 0,
          periodActive: 0,
          returningToday: 0,
          returningRate: 0,
          lastReceivedAt: null,
        },
        trend: [],
        versions: [],
        releaseStreams: [],
        alerts: [],
      });
    },
  });
  vm.runInContext(
    `${source.replace("boot();", "")}
globalThis.client = { state, readUrlState, loadMetrics };`,
    context,
  );
  return { ...context.client, nodes, calls, urls };
}

test("registered URL selections restore after runtime identity discovery and names refresh", async () => {
  const appId = "bifang-ai-usage-collector";
  const labels = { [appId]: "毕方AI用量看板" };
  const page = client(`?app=${appId}&days=30`, [appId], labels);
  page.readUrlState();
  await page.loadMetrics();
  assert.deepEqual(page.calls, [
    "/api/metrics?app=all&days=30",
    `/api/metrics?app=${appId}&days=30`,
  ]);
  assert.equal(page.state.app, appId);
  const select = page.nodes.get("app-filter");
  assert.deepEqual(
    Array.from(select.options, (option) => [option.value, option.textContent]),
    [
      ["all", "全部应用"],
      [appId, labels[appId]],
    ],
  );
  labels[appId] = "更新后的正式名称";
  await page.loadMetrics();
  assert.equal(select.options.length, 2);
  assert.equal(select.options[1].textContent, labels[appId]);
  assert.match(page.nodes.get("hero-note").textContent, /更新后的正式名称/);
});

test("unregistered URL candidates never become requests or filter options", async () => {
  const appId = "bifang-screen-recorder";
  const page = client(
    "?app=bifang-multi-instance-display-plus&days=7",
    [appId],
    {
      [appId]: "毕方录屏助手",
    },
  );
  page.readUrlState();
  await page.loadMetrics();
  assert.deepEqual(page.calls, ["/api/metrics?app=all&days=7"]);
  assert.equal(page.state.app, "all");
  assert.equal(page.urls.at(-1), "/?app=all&days=7");
  assert.deepEqual(
    Array.from(page.nodes.get("app-filter").options, (option) => option.value),
    ["all", appId],
  );
});
