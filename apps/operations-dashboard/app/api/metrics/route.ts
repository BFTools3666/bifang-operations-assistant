import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  APP_OPTIONS,
  isAppFilter,
  isRangeDays,
  type DashboardSnapshot,
} from '@/lib/dashboard-data';

export const dynamic = 'force-dynamic';

const CLOUDBASE_ORIGIN =
  'https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com';
const CLOUDBASE_METRICS_ENDPOINT = `${CLOUDBASE_ORIGIN}/admin/v1/metrics`;

export async function GET(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === 'production') {
    const user = await getChatGPTUser();
    if (!user) {
      return Response.json(
        { error: 'authentication_required' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
  }

  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get('days') ?? '14');
  const requestedApp = url.searchParams.get('app') ?? 'all';
  if (
    !isRangeDays(requestedDays) ||
    !isAppFilter(requestedApp) ||
    [...url.searchParams.keys()].some(
      (key) =>
        !['days', 'app'].includes(key) ||
        url.searchParams.getAll(key).length !== 1,
    ) ||
    (url.searchParams.has('days') &&
      !['7', '14', '30'].includes(url.searchParams.get('days')!))
  ) {
    return noStore({ error: 'invalid_query' }, 400);
  }
  const days = requestedDays;
  const app = requestedApp;
  const token = process.env.CLOUDBASE_METRICS_TOKEN?.trim();

  if (!token) {
    return noStore({ error: 'metrics_not_configured' }, 503);
  }

  try {
    const cloudUrl = new URL(CLOUDBASE_METRICS_ENDPOINT);
    cloudUrl.searchParams.set('days', String(days));
    if (app !== 'all') cloudUrl.searchParams.set('app_id', app);

    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(8_000),
    ]);
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal.throwIfAborted();
      response = await fetch(cloudUrl, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
        signal,
      });
      if (response.status !== 429 || attempt === 2) break;
      await response.body?.cancel();
      // Respect the upstream burst limit without changing its protection.
      await new Promise((resolve) =>
        setTimeout(resolve, 1_200 * (attempt + 1)),
      );
    }
    if (!response) throw new Error('metrics_unavailable');
    if (!response.ok) throw new Error(`metrics_status_${response.status}`);

    const payload = (await response.json()) as unknown;
    if (!isDashboardSnapshot(payload, days, app)) {
      throw new Error('invalid_metrics_shape');
    }
    return noStore(toSafeDashboardSnapshot(payload));
  } catch {
    return noStore({ error: 'metrics_unavailable' }, 503);
  }
}

function noStore(
  payload: DashboardSnapshot | { error: string },
  status = 200,
): Response {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function toSafeDashboardSnapshot(
  payload: DashboardSnapshot,
): DashboardSnapshot {
  return {
    schemaVersion: 1,
    mode: 'live',
    connection: 'connected',
    connectionNote: payload.connectionNote,
    environmentId: payload.environmentId,
    timezone: 'Asia/Shanghai',
    generatedAt: payload.generatedAt,
    rangeDays: payload.rangeDays,
    selectedAppId: payload.selectedAppId,
    totals: {
      todayActive: payload.totals.todayActive,
      yesterdayActive: payload.totals.yesterdayActive,
      periodActive: payload.totals.periodActive,
      returningToday: payload.totals.returningToday,
      returningRate: payload.totals.returningRate,
      lastReceivedAt: payload.totals.lastReceivedAt,
    },
    trend: payload.trend.map((point) => ({
      date: point.date,
      total: point.total,
      byApp: {
        'bifang-screen-recorder': point.byApp['bifang-screen-recorder'],
        'bifang-mouse-clicker': point.byApp['bifang-mouse-clicker'],
      },
    })),
    versions: payload.versions.map((item) => ({
      label: item.label,
      value: item.value,
      percent: item.percent,
      tone: item.tone,
    })),
    platforms: payload.platforms.map((item) => ({
      label: item.label,
      value: item.value,
      percent: item.percent,
      tone: item.tone,
    })),
    architectures: payload.architectures.map((item) => ({
      label: item.label,
      value: item.value,
      percent: item.percent,
      tone: item.tone,
    })),
    manifests: payload.manifests.map((item) => ({
      appId: item.appId,
      platform: item.platform,
      enabled: item.enabled,
      forceUpdate: item.forceUpdate,
      rollout: item.rollout,
      latestVersion: item.latestVersion,
      minSupportedVersion: item.minSupportedVersion,
      publishedAt: item.publishedAt,
      manifestUrl: item.manifestUrl,
      source: item.source,
    })),
    alerts: payload.alerts.map((item) => ({
      id: item.id,
      tone: item.tone,
      title: item.title,
      detail: item.detail,
      time: item.time,
    })),
  };
}

function isDashboardSnapshot(
  value: unknown,
  expectedDays: number,
  expectedApp: string,
): value is DashboardSnapshot {
  if (!isRecord(value)) return false;
  const item = value;
  return (
    item.schemaVersion === 1 &&
    item.mode === 'live' &&
    item.connection === 'connected' &&
    isShortText(item.connectionNote, 200) &&
    item.timezone === 'Asia/Shanghai' &&
    isIsoDate(item.generatedAt) &&
    item.environmentId === 'bifang-telemetry-prod-d8efa6a8d3' &&
    item.rangeDays === expectedDays &&
    item.selectedAppId === expectedApp &&
    isTotals(item.totals) &&
    Array.isArray(item.trend) &&
    item.trend.length === expectedDays &&
    item.trend.every(isTrendPoint) &&
    isDistribution(item.versions) &&
    isDistribution(item.platforms) &&
    isDistribution(item.architectures) &&
    Array.isArray(item.manifests) &&
    item.manifests.every(isManifest) &&
    Array.isArray(item.alerts) &&
    item.alerts.every(isAlert)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isShortText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maxLength
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && value >= 0 && value <= 100;
}

function isTotals(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isCount(value.todayActive) &&
    isCount(value.yesterdayActive) &&
    isCount(value.periodActive) &&
    isCount(value.returningToday) &&
    isPercent(value.returningRate) &&
    (value.lastReceivedAt === null || isIsoDate(value.lastReceivedAt))
  );
}

function isTrendPoint(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.byApp)) return false;
  const byApp = value.byApp;
  return (
    typeof value.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.date) &&
    isCount(value.total) &&
    Object.keys(byApp).length === APP_OPTIONS.length &&
    APP_OPTIONS.every((app) => isCount(byApp[app.id]))
  );
}

function isDistribution(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every(
    (item) =>
      isRecord(item) &&
      isShortText(item.label, 100) &&
      isCount(item.value) &&
      isPercent(item.percent) &&
      (item.tone === undefined ||
        (typeof item.tone === 'string' &&
          ['mint', 'lime', 'amber', 'ink'].includes(item.tone))),
  );
}

function isManifest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const appId = value.appId;
  const platform = value.platform;
  if (
    typeof appId !== 'string' ||
    !APP_OPTIONS.some((app) => app.id === appId) ||
    (platform !== 'windows' && platform !== 'macos') ||
    (value.source !== 'cloudbase' && value.source !== 'unavailable') ||
    typeof value.manifestUrl !== 'string'
  ) {
    return false;
  }
  let manifestUrl: URL;
  try {
    manifestUrl = new URL(value.manifestUrl);
  } catch {
    return false;
  }
  return (
    typeof value.enabled === 'boolean' &&
    typeof value.forceUpdate === 'boolean' &&
    isCount(value.rollout) &&
    value.rollout <= 100 &&
    isShortText(value.latestVersion, 64) &&
    isShortText(value.minSupportedVersion, 64) &&
    isIsoDate(value.publishedAt) &&
    manifestUrl.origin === CLOUDBASE_ORIGIN &&
    manifestUrl.pathname === `/updates/${appId}/${platform}.json` &&
    manifestUrl.search === '' &&
    manifestUrl.hash === ''
  );
}

function isAlert(value: unknown): boolean {
  return (
    isRecord(value) &&
    isShortText(value.id, 100) &&
    typeof value.tone === 'string' &&
    ['warning', 'success', 'neutral'].includes(value.tone) &&
    isShortText(value.title, 200) &&
    isShortText(value.detail, 500) &&
    isShortText(value.time, 100)
  );
}
