"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createDashboardSnapshot } = require("../src/aggregate");
const { emptyReleaseSummary } = require("../src/version-reader");

const source = readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const html = readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
const APP_IDS = [
  "bifang-screen-recorder",
  "bifang-vm-sync-agentless",
  "bifang-multi-instance-display-plus",
  "future-runtime-app",
];
const APPS = APP_IDS.map((appId) => ({
  appId,
  releaseStreams: [
    {
      platform: "windows",
      architecture: "x64",
      channel: "stable",
      code: appId,
    },
  ],
}));

function snapshot(selectedAppId, days) {
  const apps = APPS.filter(
    (app) => selectedAppId === "all" || app.appId === selectedAppId,
  );
  return createDashboardSnapshot({
    apps: APPS,
    days,
    now: new Date("2026-09-07T04:00:00.000Z"),
    selectedAppId,
    events: apps.map((app, index) => ({
      schema_version: 2,
      event: "daily_active",
      app_id: app.appId,
      app_version: "1.2.3",
      install_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      platform: "windows",
      arch: "x64",
      active_date: "2026-09-07",
      received_at: "2026-09-07T03:00:00.000Z",
    })),
    releaseSummaries: apps.flatMap((app) =>
      app.releaseStreams.map((stream) => emptyReleaseSummary(app, stream)),
    ),
  });
}

class Element {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.style = { setProperty() {} };
    this.classList = { toggle() {} };
    this.value = "";
    this.textContent = "";
  }
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = [...children];
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  setAttribute() {}
  focus() {}
  querySelectorAll() {
    return [];
  }
}

async function browser(search) {
  const elements = new Map();
  const requests = [];
  const history = [];
  const context = vm.createContext({
    URLSearchParams,
    Intl,
    location: { search },
    history: { replaceState: (_state, _title, url) => history.push(url) },
    requestAnimationFrame: (callback) => callback(),
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, new Element());
        return elements.get(id);
      },
      createElement: (tagName) => new Element(tagName),
      querySelectorAll: () => [],
    },
    fetch: async (url) => {
      if (url.endsWith("/api/session")) {
        return { ok: true, json: async () => ({ authenticated: true }) };
      }
      const params = new URLSearchParams(url.split("?")[1]);
      const appId = params.get("app_id");
      requests.push(appId);
      return {
        ok: true,
        json: async () => snapshot(appId, Number(params.get("days"))),
      };
    },
  });
  vm.runInContext(source, context, { filename: "public/app.js" });
  await new Promise(setImmediate);
  return { context, elements, requests, history };
}

test("browser resolves new-app deep links against enabled IDs and uses projected names", async () => {
  const result = await browser(
    "?app=bifang-multi-instance-display-plus&days=7",
  );
  assert.deepEqual(result.requests, [
    "all",
    "bifang-multi-instance-display-plus",
  ]);
  const select = result.elements.get("app-filter");
  assert.deepEqual(
    select.children.map((option) => [option.value, option.textContent]),
    [
      ["all", "全部应用"],
      [APP_IDS[0], "毕方录屏助手"],
      [APP_IDS[1], "毕方VM虚拟机同步助手"],
      [APP_IDS[2], "毕方多窗口显示助手Plus"],
      [APP_IDS[3], APP_IDS[3]],
    ],
  );
  assert.equal(select.value, APP_IDS[2]);
  assert.match(
    result.elements.get("hero-note").textContent,
    /^毕方多窗口显示助手Plus · 近 7 天/,
  );
  assert.equal(result.elements.has("release-rows"), false);
  assert.doesNotMatch(html, /发布流状态|release-rows/);
  assert.equal(
    result.elements.get("distribution-list").children[0].children[0].children[0]
      .textContent,
    "1.2.3",
  );
  assert.ok(
    result.elements
      .get("alerts-list")
      .children.every(
        (item) =>
          !item.children[1]?.children[0]?.textContent?.includes("发布流"),
      ),
  );
  assert.equal(result.elements.get("today-active").textContent, "1");
});

test("browser rebuilds renamed options and never promotes metadata-only identities", async () => {
  const result = await browser("?app=bifang-window-layout&days=14");
  assert.deepEqual(result.requests, ["all"]);
  assert.equal(result.elements.get("app-filter").value, "all");
  assert.equal(
    result.elements.get("app-filter").children.length,
    APP_IDS.length + 1,
  );
  vm.runInContext(
    `state.snapshot.appLabels["bifang-vm-sync-agentless"] = "新的中文名称";
     hydrateAppFilter(state.snapshot.appIds);
     renderSnapshot();`,
    result.context,
  );
  assert.equal(
    result.elements.get("app-filter").children[2].textContent,
    "新的中文名称",
  );
  assert.equal(
    result.elements.get("app-filter").children.length,
    APP_IDS.length + 1,
  );
  assert.equal(result.elements.get("today-active").textContent, "4");
  assert.match(result.history[0], /app=all&days=14$/);
});
