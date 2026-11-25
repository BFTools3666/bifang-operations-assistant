"use strict";
const base = "__DASHBOARD_BASE_PATH__";
const el = (id) => document.getElementById(id);
const appSelect = el("app"),
  preview = el("preview"),
  apply = el("apply");
let catalog,
  cards = [],
  generation = 0,
  busy = false;
const labels = {
  name: "发布名称",
  code: "发布流标识",
  codeVersion: "版本号",
  downloadUrl: "下载地址",
  promptContent: "提示文案",
  updateContent: "更新说明",
  mode: "更新方式",
  updateCriteria: "适用条件",
  versionCriteria: "条件版本",
};
const modes = {
  recommend: "推荐更新",
  force: "强制更新",
  manual: "仅手动检查",
  cancel: "停止更新",
};
const mode = (r) =>
  r.stopUpdate
    ? "cancel"
    : r.forcedUpdate
      ? "force"
      : r.promptUpdate
        ? "recommend"
        : "manual";
function display(r) {
  return r ? { ...r, mode: modes[mode(r)] } : {};
}
function lines(target, items) {
  target.replaceChildren();
  for (const s of items) {
    const p = document.createElement("p");
    p.textContent = s;
    target.append(p);
  }
}
async function api(input) {
  const resp = await fetch(
    base + "/api/releases",
    input
      ? {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Dashboard-Request": "release",
          },
          body: JSON.stringify(input),
        }
      : { cache: "no-store" },
  );
  if (resp.status === 401) {
    location.assign(base + "/");
    throw Error("请登录后台");
  }
  const result = await resp.json();
  if (!resp.ok)
    throw Object.assign(Error(result.error || "请求失败"), {
      status: resp.status,
    });
  return result;
}
function invalidate() {
  for (const c of cards) {
    c.plan = null;
    c.diff.replaceChildren();
  }
  apply.hidden = true;
}
function cardFor(appId, stream) {
  const section = el("stream").content.firstElementChild.cloneNode(true);
  el("streams").append(section);
  const field = (n) => section.querySelector('[name="' + n + '"]');
  section.querySelector("h2").textContent = [
    stream.platform,
    stream.architecture,
    stream.channel,
  ].join(" · ");
  const card = {
    section,
    field,
    diff: section.querySelector(".diff"),
    target: { appId, code: stream.code },
    state: null,
    plan: null,
  };
  field("action").disabled = true;
  field("action").onchange = () => {
    const action = field("action").value,
      r = card.state.drafts[action];
    section.querySelector(".editor").hidden = !r;
    if (r) {
      for (const name of Object.keys(labels))
        field(name).value = name === "mode" ? mode(r) : (r[name] ?? "");
      field("versionCriteria").disabled = !r.updateCriteria;
    }
    invalidate();
  };
  field("updateCriteria").onchange = () => {
    const version = field("versionCriteria");
    version.disabled = !field("updateCriteria").value;
    if (version.disabled) version.value = "";
    invalidate();
  };
  section.addEventListener("input", invalidate);
  return card;
}
async function readCard(card) {
  const status = card.section.querySelector(".status");
  try {
    card.state = await api({ ...card.target, stage: "details" });
    const r = card.state.record;
    status.textContent = r
      ? r.codeVersion + " · " + modes[mode(r)]
      : "尚未发布版本";
    lines(
      card.section.querySelector(".current"),
      r
        ? Object.entries(labels).map(
            ([k, l]) => l + "　" + (display(r)[k] || "—"),
          )
        : ["尚无版本记录"],
    );
    for (const opt of card.field("action").options)
      opt.disabled = !r && !["", "new", "reset"].includes(opt.value);
    card.field("action").value = "";
    card.field("action").disabled = false;
    card.section.querySelector(".editor").hidden = true;
  } catch (err) {
    card.state = null;
    card.field("action").disabled = true;
    status.textContent = err.message;
  }
}
async function loadApp() {
  const seq = ++generation;
  apply.hidden = true;
  preview.hidden = true;
  el("streams").replaceChildren();
  el("message").textContent = "";
  const app = catalog.apps.find((a) => a.appId === appSelect.value);
  cards = (app?.releaseStreams || []).map((s) => cardFor(app.appId, s));
  if (!cards.length) {
    el("message").textContent = "此应用尚未登记发布平台。";
    return;
  }
  for (const card of cards) {
    if (seq !== generation) return;
    await readCard(card);
  }
  if (seq === generation) preview.hidden = !cards.some((c) => c.state);
}
function requestFor(card) {
  const val = (k) => card.field(k).value,
    action = val("action");
  const req = { ...card.target, action, baseline: card.state.baseline };
  if (["new", "reset"].includes(action)) {
    const m = val("mode"),
      rule = val("updateCriteria");
    req.release = {
      name: val("name"),
      code: card.target.code,
      codeVersion: val("codeVersion"),
      downloadUrl: val("downloadUrl"),
      promptContent: val("promptContent"),
      updateContent: val("updateContent"),
      forcedUpdate: m === "force",
      promptUpdate: m === "recommend",
      stopUpdate: m === "cancel",
    };
    if (rule) {
      req.release.updateCriteria = rule;
      req.release.versionCriteria = val("versionCriteria");
    }
  }
  return req;
}
async function submit(confirming) {
  if (busy) return;
  busy = true;
  const selected = cards.filter((c) =>
    confirming ? c.plan : c.state && c.field("action").value,
  );
  el("message").textContent = selected.length
    ? "处理中…"
    : "请先选择要调整的平台和操作。";
  const controls = document.querySelectorAll(
    "main button, main select, main input, main textarea",
  );
  const enabled = [...controls].filter((e) => !e.disabled);
  enabled.forEach((e) => (e.disabled = true));
  let ok = 0;
  try {
    for (const c of selected) {
      try {
        if (confirming) {
          const result = await api({ ...c.plan, stage: "apply" });
          await readCard(c);
          lines(c.diff, [
            "已保存并读回 · " +
              result.record.codeVersion +
              " · " +
              modes[mode(result.record)],
            "记录 ID　" + result.id,
          ]);
          c.plan = null;
        } else {
          const req = requestFor(c),
            p = await api({ ...req, stage: "preview" });
          const reusesDownload =
            p.method === "POST" &&
            p.before?.downloadUrl === p.after.downloadUrl;
          const before = display(p.before),
            after = display(p.after);
          lines(
            c.diff,
            p.unchanged
              ? ["当前设置已经一致。"]
              : Object.entries(labels)
                  .filter(([k]) => before[k] !== after[k])
                  .map(
                    ([k, l]) =>
                      l + "　" + (before[k] || "—") + " → " + (after[k] || "—"),
                  )
                  .concat(
                    reusesDownload
                      ? ["新版本沿用上一版本的下载地址，请核对制品。"]
                      : [],
                    after.mode === "强制更新"
                      ? ["符合条件的旧版本下次检查时将要求更新。"]
                      : [],
                  ),
          );
          c.plan = p.unchanged ? null : { ...req, proof: p.proof };
        }
        ok++;
      } catch (err) {
        c.plan = null;
        if (!confirming && err.status === 400) {
          lines(c.diff, [err.message]);
          continue;
        }
        await readCard(c);
        lines(c.diff, [
          err.message,
          c.state
            ? "已重新读取当前设置，请核对后再操作。"
            : "当前状态仍待核验，请稍后刷新。",
        ]);
      }
    }
    if (selected.length)
      el("message").textContent =
        (confirming ? "保存并读回" : "预览") +
        "成功 " +
        ok +
        " / " +
        selected.length +
        " 个发布流";
  } finally {
    enabled.forEach((e) => (e.disabled = false));
    for (const c of cards) c.field("action").disabled = !c.state;
    busy = false;
    apply.hidden = !cards.some((c) => c.plan);
  }
}
preview.onclick = () => submit(false);
apply.onclick = () => submit(true);
appSelect.onchange = loadApp;
(async () => {
  try {
    catalog = await api();
    for (const app of catalog.apps)
      appSelect.add(
        new Option(catalog.labels[app.appId] || app.appId, app.appId),
      );
    await loadApp();
  } catch (err) {
    el("message").textContent = err.message;
  }
})();
