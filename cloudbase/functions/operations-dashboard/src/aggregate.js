"use strict";

const {
  UUID_V4,
  isCalendarDate,
  isDottedVersion,
  isRfc3339,
  isSemVer,
} = require("./validation");

function createDashboardSnapshot(options) {
  const now = options.now instanceof Date ? options.now : new Date(options.now);
  if (Number.isNaN(now.getTime()))
    throw new TypeError("now must be a valid date");
  const days = options.days;
  if (![7, 14, 30].includes(days))
    throw new TypeError("days must be 7, 14, or 30");

  const apps = options.apps;
  const selectedAppId = options.selectedAppId || "all";
  const selectedApps =
    selectedAppId === "all"
      ? apps
      : apps.filter((app) => app.appId === selectedAppId);
  if (selectedApps.length === 0) throw new TypeError("unknown selected app");

  const knownAppIds = new Set(selectedApps.map((app) => app.appId));
  const today = toShanghaiDate(now);
  const periodStart = addDays(today, -(days - 1));
  const retentionStart = addDays(today, -29);
  if (!Array.isArray(options.events))
    throw new TypeError("events must be an array");
  const dailyDevices = new Map();
  for (const event of options.events) {
    if (!isUsableEvent(event, knownAppIds, retentionStart, today, now)) {
      throw new TypeError("telemetry event is invalid");
    }
    const safe = {
      app_id: event.app_id,
      app_version: event.app_version,
      install_id: event.install_id.toLowerCase(),
      platform: event.platform,
      arch: event.arch,
      active_date: event.active_date,
      received_at: event.received_at,
    };
    const key = `${deviceKey(safe)}\u0000${safe.active_date}`;
    const previous = dailyDevices.get(key);
    if (!previous || isLater(safe, previous)) dailyDevices.set(key, safe);
  }
  const safeEvents = [...dailyDevices.values()];

  const trend = [];
  for (let offset = -(days - 1); offset <= 0; offset += 1) {
    const date = addDays(today, offset);
    const byApp = Object.fromEntries(apps.map((app) => [app.appId, 0]));
    for (const event of safeEvents) {
      if (event.active_date === date) byApp[event.app_id] += 1;
    }
    trend.push({
      date,
      total: Object.values(byApp).reduce((sum, value) => sum + value, 0),
      byApp,
    });
  }

  const periodEvents = safeEvents.filter(
    (event) => event.active_date >= periodStart,
  );
  const todayKeys = new Set(
    safeEvents.filter((event) => event.active_date === today).map(deviceKey),
  );
  const priorKeys = new Set(
    safeEvents.filter((event) => event.active_date < today).map(deviceKey),
  );
  const returningToday = [...todayKeys].filter((key) =>
    priorKeys.has(key),
  ).length;
  const latestByDevice = new Map();
  for (const event of periodEvents) {
    const key = deviceKey(event);
    const previous = latestByDevice.get(key);
    if (!previous || isLater(event, previous)) {
      latestByDevice.set(key, event);
    }
  }
  const latestEvents = [...latestByDevice.values()];
  const lastReceivedAt =
    safeEvents
      .map((event) => event.received_at)
      .filter(Boolean)
      .sort()
      .at(-1) || null;

  const versions = makeDistribution(
    latestEvents.map((event) =>
      selectedAppId === "all"
        ? `${shortAppName(event.app_id)} ${event.app_version}`
        : event.app_version,
    ),
  );
  const platforms = makeDistribution(
    latestEvents.map((event) => platformLabel(event.platform)),
  );
  const architectures = makeDistribution(
    latestEvents.map((event) => event.arch),
  );
  const todayActive = trend.at(-1)?.total || 0;
  const yesterdayActive = safeEvents.filter(
    (event) => event.active_date === addDays(today, -1),
  ).length;
  const releaseStreams = normalizeReleaseSummaries(
    selectedApps,
    options.releaseSummaries,
  );
  // Always use yesterday through seven days ago, independent of chart range.
  const priorWeekAverage =
    safeEvents.filter(
      (event) =>
        event.active_date >= addDays(today, -7) && event.active_date < today,
    ).length / 7;

  return {
    schemaVersion: 2,
    mode: "live",
    connection: "connected",
    connectionNote: "CloudBase 只读聚合接口已连接。",
    environmentId: options.environmentId || "current",
    timezone: "Asia/Shanghai",
    generatedAt: now.toISOString(),
    rangeDays: days,
    selectedAppId,
    totals: {
      todayActive,
      yesterdayActive,
      periodActive: latestByDevice.size,
      returningToday,
      returningRate:
        todayKeys.size === 0
          ? 0
          : Math.round((returningToday / todayKeys.size) * 1000) / 10,
      lastReceivedAt,
    },
    trend,
    versions,
    platforms,
    architectures,
    releaseStreams,
    alerts: createAlerts({
      todayActive,
      priorWeekAverage,
      lastReceivedAt,
      releaseStreams,
      now,
    }),
  };
}

function createAlerts({
  todayActive,
  priorWeekAverage,
  lastReceivedAt,
  releaseStreams,
  now,
}) {
  const alerts = [];

  if (todayActive === 0) {
    alerts.push({
      id: "no-data-today",
      tone: "neutral",
      title: "今天尚未收到活跃数据",
      detail:
        "仅统计已授权且成功上报的客户端；今天尚未结束，当前零条记录不代表服务异常。",
      time: "今天",
    });
  } else if (priorWeekAverage > 0) {
    alerts.push({
      id: "activity-comparison",
      tone: "neutral",
      title: "今日累计与前 7 个完整日对照",
      detail: `今日累计 ${todayActive} 台，前 7 个完整日平均 ${(Math.round(priorWeekAverage * 10) / 10).toFixed(1)} 台/日。今天尚未结束，不据此判定活跃下降。`,
      time: "观察参考",
    });
  } else {
    alerts.push({
      id: "activity-steady",
      tone: "success",
      title: "活跃数据持续写入",
      detail: `${todayActive} 台匿名安装设备已在今天产生有效记录。`,
      time: "今天",
    });
  }

  const fresh =
    lastReceivedAt &&
    Number.isFinite(Date.parse(lastReceivedAt)) &&
    now.getTime() - Date.parse(lastReceivedAt) < 24 * 60 * 60 * 1000;
  alerts.push({
    id: "data-freshness",
    tone: fresh ? "success" : "neutral",
    title: fresh ? "最近 24 小时有数据写入" : "数据新鲜度需要观察",
    detail: fresh
      ? "只读聚合查询正常，原始标识与来源 IP 未出站。"
      : lastReceivedAt
        ? "最近一次写入超过 24 小时，可能只是尚无真实使用。"
        : "近 30 天尚无有效活跃记录。",
    time: "数据新鲜度",
  });

  const empty = releaseStreams.filter(
    (stream) => stream.status === "empty",
  ).length;
  const stopped = releaseStreams.filter(
    (stream) => stream.status === "stopped",
  ).length;
  const forced = releaseStreams.filter(
    (stream) => stream.status === "forced",
  ).length;
  alerts.push(
    empty > 0
      ? {
          id: "update-state",
          tone: "warning",
          title: `${empty} 个发布流尚无版本`,
          detail: "数据库读取成功；这些发布流当前确实没有版本记录。",
          time: "需要复核",
        }
      : stopped > 0
        ? {
            id: "update-state",
            tone: "warning",
            title: `${stopped} 个发布流已暂停更新`,
            detail: "请复核对应 code 的最高版本和暂停状态。",
            time: "更新服务",
          }
        : forced > 0
          ? {
              id: "update-state",
              tone: "warning",
              title: `${forced} 个发布流为强制更新`,
              detail: "请复核对应 code 的最高版本与客户端退出流程。",
              time: "更新服务",
            }
          : {
              id: "update-state",
              tone: "success",
              title: `${releaseStreams.length} 个发布流读取正常`,
              detail: "已从应用隔离的版本集合读取各 code 当前最高版本。",
              time: "更新服务",
            },
  );
  return alerts;
}

function makeDistribution(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  const total = values.length;
  const tones = ["mint", "lime", "amber", "ink"];
  return [...counts.entries()]
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .map(([label, value], index) => ({
      label,
      value,
      percent: total === 0 ? 0 : Math.round((value / total) * 1000) / 10,
      tone: tones[index % tones.length],
    }));
}

function isUsableEvent(event, knownAppIds, start, end, now) {
  return Boolean(
    event &&
    typeof event === "object" &&
    event.schema_version === 2 &&
    event.event === "daily_active" &&
    knownAppIds.has(event.app_id) &&
    typeof event.install_id === "string" &&
    UUID_V4.test(event.install_id) &&
    isCalendarDate(event.active_date) &&
    event.active_date >= start &&
    event.active_date <= end &&
    isRfc3339(event.received_at) &&
    new Date(event.received_at).toISOString() === event.received_at &&
    Date.parse(event.received_at) <= now.getTime() &&
    toShanghaiDate(new Date(event.received_at)) === event.active_date &&
    isSemVer(event.app_version) &&
    ["windows", "macos", "linux"].includes(event.platform) &&
    ["x64", "arm64", "ia32"].includes(event.arch),
  );
}

function isLater(event, previous) {
  const a = `${event.received_at}\u0000${event.app_version}\u0000${event.platform}\u0000${event.arch}`;
  const b = `${previous.received_at}\u0000${previous.app_version}\u0000${previous.platform}\u0000${previous.arch}`;
  return a > b;
}

function normalizeReleaseSummaries(apps, values) {
  if (!Array.isArray(values)) {
    throw new TypeError("release summaries must be an array");
  }
  const expected = apps.flatMap((app) =>
    app.releaseStreams.map((stream) => ({ app, stream })),
  );
  if (values.length !== expected.length) {
    throw new TypeError("release summary count does not match configuration");
  }

  return expected.map(({ app, stream }) => {
    const matches = values.filter(
      (value) => value?.appId === app.appId && value.code === stream.code,
    );
    if (matches.length !== 1) {
      throw new TypeError("release summary mapping is ambiguous");
    }
    const value = matches[0];
    const expectedKeys =
      "appId,architecture,channel,code,highestVersion,platform,status,updatedAt";
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== expectedKeys ||
      value.platform !== stream.platform ||
      value.architecture !== stream.architecture ||
      value.channel !== stream.channel ||
      !["empty", "normal", "prompt", "forced", "stopped"].includes(
        value.status,
      ) ||
      (value.status === "empty" &&
        (value.highestVersion !== null || value.updatedAt !== null)) ||
      (value.status !== "empty" &&
        (!isDottedVersion(value.highestVersion) ||
          !isRfc3339(value.updatedAt) ||
          new Date(value.updatedAt).toISOString() !== value.updatedAt))
    ) {
      throw new TypeError("release summary is invalid");
    }
    return {
      appId: app.appId,
      code: stream.code,
      platform: stream.platform,
      architecture: stream.architecture,
      channel: stream.channel,
      highestVersion: value.highestVersion,
      status: value.status,
      updatedAt: value.updatedAt,
    };
  });
}

function deviceKey(event) {
  return `${event.app_id}\u0000${event.install_id}`;
}

function shortAppName(appId) {
  if (appId === "bifang-screen-recorder") return "录屏";
  if (appId === "bifang-mouse-clicker") return "鼠标";
  return appId;
}

function platformLabel(platform) {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  if (platform === "linux") return "Linux";
  return platform;
}

function toShanghaiDate(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function addDays(date, offset) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + offset);
  return parsed.toISOString().slice(0, 10);
}

module.exports = {
  addDays,
  createDashboardSnapshot,
  makeDistribution,
  normalizeReleaseSummaries,
  toShanghaiDate,
};
