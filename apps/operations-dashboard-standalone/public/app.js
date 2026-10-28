const state = {
  app: "all",
  pendingApp: null,
  days: 14,
  snapshot: null,
  distribution: "versions",
  loading: false,
};

const elements = Object.fromEntries(
  [
    "loading-view",
    "login-view",
    "dashboard-view",
    "login-form",
    "access-token",
    "toggle-password",
    "login-button",
    "login-error",
    "logout-button",
    "connection-badge",
    "hero-note",
    "app-filter",
    "range-filter",
    "refresh-button",
    "error-panel",
    "error-retry",
    "today-active",
    "today-change",
    "period-label",
    "period-active",
    "returning-rate",
    "returning-detail",
    "last-received",
    "trend-peak",
    "trend-chart",
    "distribution-list",
    "generated-at",
    "release-rows",
    "alerts-list",
    "environment-label",
  ].map((id) => [id, document.getElementById(id)]),
);

boot();

async function boot() {
  bindEvents();
  readUrlState();
  try {
    const response = await fetch("/api/session", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const session = await response.json();
    if (session.authenticated) {
      showDashboard();
      await loadMetrics();
    } else {
      showLogin();
    }
  } catch {
    showLogin("无法检查会话，请确认独立站服务正在运行。");
  }
}

function bindEvents() {
  elements["login-form"].addEventListener("submit", login);
  elements["toggle-password"].addEventListener("click", () => {
    const input = elements["access-token"];
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    elements["toggle-password"].textContent = visible ? "显示" : "隐藏";
  });
  elements["logout-button"].addEventListener("click", logout);
  elements["refresh-button"].addEventListener("click", loadMetrics);
  elements["error-retry"].addEventListener("click", loadMetrics);
  elements["app-filter"].addEventListener("change", (event) => {
    state.app = event.target.value;
    updateUrl();
    loadMetrics();
  });
  elements["range-filter"].addEventListener("click", (event) => {
    const button = event.target.closest("[data-days]");
    if (!button) return;
    state.days = Number(button.dataset.days);
    setRangeButtons();
    updateUrl();
    loadMetrics();
  });
  document.querySelectorAll("[data-distribution]").forEach((button) => {
    button.addEventListener("click", () => {
      state.distribution = button.dataset.distribution;
      document.querySelectorAll("[data-distribution]").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderDistribution();
    });
  });
}

async function login(event) {
  event.preventDefault();
  const accessToken = elements["access-token"].value;
  setLoginError("");
  elements["login-button"].disabled = true;
  elements["login-button"].textContent = "正在验证…";
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ accessToken }),
    });
    if (!response.ok) {
      const messages = {
        401: "访问密钥不正确。",
        429: "尝试次数过多，请稍后再试。",
        503: "独立站尚未配置访问密钥。",
      };
      throw new Error(messages[response.status] ?? "登录暂时不可用。");
    }
    elements["access-token"].value = "";
    showDashboard();
    await loadMetrics();
  } catch (error) {
    setLoginError(error instanceof Error ? error.message : "登录暂时不可用。");
  } finally {
    elements["login-button"].disabled = false;
    elements["login-button"].textContent = "进入看板";
  }
}

async function logout() {
  try {
    await fetch("/api/session", {
      method: "DELETE",
      credentials: "same-origin",
    });
  } finally {
    state.snapshot = null;
    showLogin();
  }
}

async function loadMetrics() {
  if (state.loading) return;
  state.loading = true;
  setLoadingState(true);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const params = new URLSearchParams({
        app: state.app,
        days: String(state.days),
      });
      const response = await fetch(`/api/metrics?${params}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.status === 401) {
        showLogin("会话已过期，请重新输入访问密钥。");
        return;
      }
      if (!response.ok) throw new Error("metrics_unavailable");
      state.snapshot = await response.json();
      const pendingApp = state.pendingApp;
      state.pendingApp = null;
      if (pendingApp !== null) {
        state.app = state.snapshot.appIds.includes(pendingApp)
          ? pendingApp
          : "all";
        updateUrl();
      }
      hydrateAppFilter(state.snapshot.appIds);
      if (state.app !== state.snapshot.selectedAppId) continue;
      elements["error-panel"].hidden = true;
      renderSnapshot();
      return;
    }
    throw new Error("invalid_metrics_selection");
  } catch {
    state.snapshot = null;
    renderUnavailable();
  } finally {
    state.loading = false;
    setLoadingState(false);
  }
}

function renderSnapshot() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  elements["connection-badge"].className = "connection-badge connected";
  elements["connection-badge"].innerHTML =
    '<i aria-hidden="true"></i>生产环境 · 已连接';
  elements["hero-note"].textContent =
    `${appLabel(snapshot.selectedAppId)} · 近 ${snapshot.rangeDays} 天 · ${snapshot.connectionNote}`;
  elements["today-active"].textContent = formatNumber(
    snapshot.totals.todayActive,
  );
  elements["period-active"].textContent = formatNumber(
    snapshot.totals.periodActive,
  );
  elements["period-label"].textContent = `${snapshot.rangeDays}D`;
  elements["returning-rate"].textContent =
    `${formatNumber(snapshot.totals.returningRate, 1)}%`;
  elements["returning-detail"].textContent =
    `${formatNumber(snapshot.totals.returningToday)} 台今日设备曾在前 29 天出现`;
  elements["last-received"].textContent = formatDateTime(
    snapshot.totals.lastReceivedAt,
    true,
  );

  const yesterday = snapshot.totals.yesterdayActive;
  const today = snapshot.totals.todayActive;
  elements["today-change"].textContent = yesterday
    ? `较昨日 ${signedPercent(today, yesterday)}`
    : "昨日为 0，暂不计算变化率";
  elements["generated-at"].textContent =
    `生成时间 ${formatDateTime(snapshot.generatedAt)}`;
  elements["environment-label"].textContent = `环境 ${snapshot.environmentId}`;
  renderTrend(snapshot.trend);
  renderDistribution();
  renderReleaseStreams(snapshot.releaseStreams);
  renderAlerts(snapshot.alerts);
}

function renderUnavailable() {
  elements["error-panel"].hidden = false;
  elements["connection-badge"].className = "connection-badge unavailable";
  elements["connection-badge"].innerHTML =
    '<i aria-hidden="true"></i>生产数据不可用';
  elements["hero-note"].textContent = "请求失败时不会显示演示数据或伪造零值。";
  ["today-active", "period-active", "returning-rate", "last-received"].forEach(
    (id) => {
      elements[id].textContent = "—";
    },
  );
  elements["today-change"].textContent = "等待生产数据";
  elements["returning-detail"].textContent = "等待生产数据";
  elements["trend-peak"].textContent = "峰值 —";
  elements["generated-at"].textContent = "生成时间 —";
  elements["environment-label"].textContent = "环境 —";
  empty(elements["trend-chart"], "暂无可展示的生产趋势");
  empty(elements["distribution-list"], "暂无可展示的生产分布");
  emptyTable("生产发布流暂时不可用");
  empty(elements["alerts-list"], "生产诊断暂时不可用");
}

function renderTrend(points) {
  elements["trend-chart"].replaceChildren();
  const max = Math.max(0, ...points.map((point) => point.total));
  elements["trend-peak"].textContent = `峰值 ${formatNumber(max)}`;
  const chart = document.createElement("div");
  chart.className = "bars";
  const labelEvery = points.length <= 7 ? 1 : Math.ceil(points.length / 8);
  points.forEach((point, index) => {
    const item = document.createElement("div");
    item.className = "bar-item";
    item.title = `${point.date}：${formatNumber(point.total)} 台`;
    const value = document.createElement("span");
    value.className = "bar-value";
    value.textContent = formatNumber(point.total);
    const bar = document.createElement("span");
    bar.className = "bar";
    const barHeight = max === 0 ? 3 : Math.max(3, (point.total / max) * 100);
    bar.style.height = `${barHeight}%`;
    item.style.setProperty("--bar-height", `${barHeight}%`);
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent =
      index % labelEvery === 0 || index === points.length - 1
        ? index === points.length - 1
          ? "今天"
          : point.date.slice(5).replace("-", "/")
        : "";
    item.append(value, bar, label);
    chart.append(item);
  });
  elements["trend-chart"].append(chart);
}

function renderDistribution() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const items = snapshot[state.distribution] ?? [];
  elements["distribution-list"].replaceChildren();
  if (!items.length) {
    empty(elements["distribution-list"], "当前周期没有活跃设备数据");
    return;
  }
  items.slice(0, 8).forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "distribution-row";
    const heading = document.createElement("div");
    heading.className = "distribution-heading";
    const label = document.createElement("strong");
    label.textContent = item.label;
    const value = document.createElement("span");
    value.textContent = `${formatNumber(item.value)} · ${formatNumber(item.percent, 1)}%`;
    heading.append(label, value);
    const track = document.createElement("div");
    track.className = "progress-track";
    const indicator = document.createElement("i");
    indicator.className = `tone-${item.tone ?? ["mint", "lime", "amber", "ink"][index % 4]}`;
    indicator.style.width = `${Math.min(100, item.percent)}%`;
    track.append(indicator);
    row.append(heading, track);
    elements["distribution-list"].append(row);
  });
}

function renderReleaseStreams(streams) {
  elements["release-rows"].replaceChildren();
  if (!streams.length) {
    emptyTable("当前筛选没有发布流");
    return;
  }
  streams.forEach((stream) => {
    const row = document.createElement("tr");
    const values = [
      appLabel(stream.appId),
      stream.code,
      `${platformLabel(stream.platform)} / ${stream.architecture}`,
      stream.highestVersion ?? "—",
    ];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (index === 1) cell.className = "code-cell";
      row.append(cell);
    });
    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `status-badge status-${stream.status}`;
    badge.textContent = statusLabel(stream.status);
    statusCell.append(badge);
    const updatedCell = document.createElement("td");
    updatedCell.textContent = formatDateTime(stream.updatedAt);
    row.append(statusCell, updatedCell);
    elements["release-rows"].append(row);
  });
}

function renderAlerts(alerts) {
  elements["alerts-list"].replaceChildren();
  if (!alerts.length) {
    const item = document.createElement("div");
    item.className = "alert-item success";
    item.innerHTML =
      '<i aria-hidden="true"></i><div><strong>当前没有聚合诊断提醒</strong><p>继续观察下一次刷新结果。</p></div><time>现在</time>';
    elements["alerts-list"].append(item);
    return;
  }
  alerts.forEach((alert) => {
    const item = document.createElement("div");
    item.className = `alert-item ${alert.tone}`;
    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = alert.title;
    const detail = document.createElement("p");
    detail.textContent = alert.detail;
    content.append(title, detail);
    const time = document.createElement("time");
    time.textContent = alert.time;
    item.append(dot, content, time);
    elements["alerts-list"].append(item);
  });
}

function hydrateAppFilter(appIds) {
  const select = elements["app-filter"];
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "全部应用";
  select.replaceChildren(all);
  appIds.forEach((appId) => {
    const option = document.createElement("option");
    option.value = appId;
    option.textContent = appLabel(appId);
    select.append(option);
  });
  select.value =
    appIds.includes(state.app) || state.app === "all" ? state.app : "all";
}

function readUrlState() {
  const params = new URLSearchParams(location.search);
  const days = Number(params.get("days"));
  if ([7, 14, 30].includes(days)) state.days = days;
  const app = params.get("app");
  if (app && app !== "all") state.pendingApp = app;
  setRangeButtons();
}

function updateUrl() {
  const params = new URLSearchParams({
    app: state.app,
    days: String(state.days),
  });
  history.replaceState(null, "", `/?${params}`);
}

function setRangeButtons() {
  elements["range-filter"].querySelectorAll("[data-days]").forEach((button) => {
    button.classList.toggle(
      "active",
      Number(button.dataset.days) === state.days,
    );
  });
}

function setLoadingState(loading) {
  elements["refresh-button"].disabled = loading;
  elements["refresh-button"].classList.toggle("loading", loading);
  if (loading && !state.snapshot) {
    elements["connection-badge"].className = "connection-badge waiting";
    elements["connection-badge"].innerHTML =
      '<i aria-hidden="true"></i>正在连接';
  }
}

function showLogin(message = "") {
  elements["loading-view"].hidden = true;
  elements["dashboard-view"].hidden = true;
  elements["login-view"].hidden = false;
  setLoginError(message);
  requestAnimationFrame(() => elements["access-token"].focus());
}

function showDashboard() {
  elements["loading-view"].hidden = true;
  elements["login-view"].hidden = true;
  elements["dashboard-view"].hidden = false;
}

function setLoginError(message) {
  elements["login-error"].textContent = message;
  elements["login-error"].hidden = !message;
}

function empty(container, message) {
  container.replaceChildren();
  const element = document.createElement("p");
  element.className = "empty-state";
  element.textContent = message;
  container.append(element);
}

function emptyTable(message) {
  elements["release-rows"].replaceChildren();
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 6;
  cell.className = "table-empty";
  cell.textContent = message;
  row.append(cell);
  elements["release-rows"].append(row);
}

function formatNumber(value, maximumFractionDigits = 0) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(
    value,
  );
}

function formatDateTime(value, compact = false) {
  if (!value) return "暂无";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    ...(compact ? {} : { year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai",
  }).format(date);
}

function signedPercent(current, previous) {
  const value = ((current - previous) / previous) * 100;
  if (Math.abs(value) < 0.05) return "持平";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function appLabel(appId) {
  if (appId === "all") return "全部应用";
  return state.snapshot?.appLabels[appId] ?? appId;
}

function platformLabel(platform) {
  return (
    { windows: "Windows", macos: "macOS", linux: "Linux" }[platform] ?? platform
  );
}

function statusLabel(status) {
  return (
    {
      empty: "暂无版本",
      normal: "普通更新",
      prompt: "提示更新",
      forced: "强制更新",
      stopped: "暂停更新",
    }[status] ?? status
  );
}
