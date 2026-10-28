"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  APP_LABELS,
  getAppLabel,
  projectAppLabels,
  validateAppLabels,
} = require("../src/app-labels");

test("display metadata preserves the approved names without registering resources", () => {
  assert.equal(Object.keys(APP_LABELS).length, 16);
  assert.equal(Object.isFrozen(APP_LABELS), true);
  const approved = {
    "bifang-vm-sync-agentless": "毕方VM虚拟机同步助手",
    "bifang-multi-local-proxy": "毕方本地代理多开器",
    "bifang-browser-multi-instance": "毕方浏览器多开器",
    "bifang-multi-instance-display": "毕方多窗口显示助手",
    "bifang-app-network-accelerator": "毕方多应用加速器",
    "bifang-window-layout": "毕方多窗口排布器",
    "bifang-multi-instance-display-plus": "毕方多窗口显示助手Plus",
  };
  for (const [appId, name] of Object.entries(approved)) {
    assert.equal(getAppLabel(appId), name);
  }
  assert.deepEqual(
    projectAppLabels([{ appId: "bifang-multi-instance-display" }]),
    { "bifang-multi-instance-display": "毕方多窗口显示助手" },
  );
  assert.deepEqual(projectAppLabels(["unlisted-runtime-app"]), {
    "unlisted-runtime-app": "unlisted-runtime-app",
  });
});

test("display metadata validation rejects markup, controls and malformed catalogs", () => {
  for (const value of [null, [], {}, "name", new Date()]) {
    assert.throws(() => validateAppLabels(value), TypeError);
  }
  for (const name of [
    "",
    " leading",
    "trailing ",
    "x".repeat(101),
    "<script>",
    "name>value",
    "line\nbreak",
    "hidden\u0000value",
    "hidden\u007fvalue",
    "hidden\u200evalue",
    42,
  ]) {
    assert.throws(() => validateAppLabels({ "valid-app": name }), TypeError);
  }
  for (const appId of ["Bad_App", "x".repeat(51), "-leading", "trailing-"]) {
    assert.throws(() => validateAppLabels({ [appId]: "毕方工具" }), TypeError);
  }
  const value = { "valid-app": "毕方工具Plus" };
  const checked = validateAppLabels(value);
  value["valid-app"] = "changed";
  assert.equal(checked["valid-app"], "毕方工具Plus");
  assert.equal(Object.isFrozen(checked), true);
  assert.equal(
    validateAppLabels({ "valid-app": "中".repeat(100) })["valid-app"].length,
    100,
  );
});
