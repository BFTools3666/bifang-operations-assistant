import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  APP_OPTIONS,
  isAppFilter,
  isRangeDays,
  type DashboardSnapshot,
} from '@/lib/dashboard-data';
import appRegistry from '../../../../../cloudbase/apps.json';

export const dynamic = 'force-dynamic';

const CLOUDBASE_ORIGIN =
  'https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com';
const CLOUDBASE_METRICS_ENDPOINT = `${CLOUDBASE_ORIGIN}/admin/v1/metrics`;
const MAX_RELEASE_STREAMS_PER_APP = 12;

type RegisteredReleaseStream = {
  appId: string;
  code: string;
  platform: string;
  architecture: string;
  channel: string;
};

const REGISTERED_RELEASE_STREAMS = readRegisteredReleaseStreams(appRegistry);

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
    schemaVersion: 2,
    mode: 'live',
    connection: 'connected',
    connectionNote: payload.connectionNote,
    environmentId: payload.environmentId,
    timezone: 'Asia/Shanghai',
    generatedAt: payload.generatedAt,
    rangeDays: payload.rangeDays,
    selectedAppId: payload.selectedAppId,
    appIds: APP_OPTIONS.map((app) => app.id),
    appLabels: Object.fromEntries(
      APP_OPTIONS.map((app) => [app.id, payload.appLabels[app.id]]),
    ),
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
      byApp: Object.fromEntries(
        APP_OPTIONS.map((app) => [app.id, point.byApp[app.id]]),
      ),
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
    releaseStreams: payload.releaseStreams.map((item) => ({
      appId: item.appId,
      code: item.code,
      platform: item.platform,
      architecture: item.architecture,
      channel: item.channel,
      highestVersion: item.highestVersion,
      status: item.status,
      updatedAt: item.updatedAt,
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
    item.schemaVersion === 2 &&
    item.mode === 'live' &&
    item.connection === 'connected' &&
    isShortText(item.connectionNote, 200) &&
    item.timezone === 'Asia/Shanghai' &&
    isIsoDate(item.generatedAt) &&
    item.environmentId === 'bftoos-sh-d3ga7hahz59229f0a' &&
    item.rangeDays === expectedDays &&
    item.selectedAppId === expectedApp &&
    isAppIds(item.appIds) &&
    isAppLabels(item.appLabels) &&
    isTotals(item.totals) &&
    Array.isArray(item.trend) &&
    item.trend.length === expectedDays &&
    item.trend.every(isTrendPoint) &&
    isDistribution(item.versions) &&
    isDistribution(item.platforms) &&
    isDistribution(item.architectures) &&
    isReleaseStreams(item.releaseStreams, expectedApp) &&
    Array.isArray(item.alerts) &&
    item.alerts.every(isAlert)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAppIds(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === APP_OPTIONS.length &&
    new Set(value).size === APP_OPTIONS.length &&
    value.every((appId) => APP_OPTIONS.some((app) => app.id === appId))
  );
}

function isAppLabels(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === APP_OPTIONS.length &&
    APP_OPTIONS.every((app) => {
      const label = value[app.id];
      return (
        Object.hasOwn(value, app.id) &&
        typeof label === 'string' &&
        label.trim() === label &&
        Array.from(label).length >= 1 &&
        Array.from(label).length <= 100 &&
        !/[\p{Cc}\p{Cf}<>]/u.test(label)
      );
    })
  );
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
      isShortText(item.label, 265) &&
      isCount(item.value) &&
      isPercent(item.percent) &&
      (item.tone === undefined ||
        (typeof item.tone === 'string' &&
          ['mint', 'lime', 'amber', 'ink'].includes(item.tone))),
  );
}

function readRegisteredReleaseStreams(
  value: unknown,
): readonly RegisteredReleaseStream[] | null {
  if (!isRecord(value) || value.schema_version !== 3) return null;
  if (!Array.isArray(value.apps) || value.apps.length !== APP_OPTIONS.length) {
    return null;
  }

  const expectedAppIds = new Set<string>(APP_OPTIONS.map((app) => app.id));
  const seenAppIds = new Set<string>();
  const seenCodes = new Set<string>();
  const seenIdentities = new Set<string>();
  const result: RegisteredReleaseStream[] = [];

  for (const app of value.apps) {
    if (
      !isRecord(app) ||
      typeof app.app_id !== 'string' ||
      !expectedAppIds.has(app.app_id) ||
      seenAppIds.has(app.app_id) ||
      !Array.isArray(app.release_streams) ||
      app.release_streams.length > MAX_RELEASE_STREAMS_PER_APP
    ) {
      return null;
    }
    seenAppIds.add(app.app_id);

    for (const stream of app.release_streams) {
      if (
        !isRecord(stream) ||
        typeof stream.code !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(stream.code) ||
        typeof stream.platform !== 'string' ||
        !['windows', 'macos', 'linux'].includes(stream.platform) ||
        typeof stream.architecture !== 'string' ||
        !['x64', 'arm64', 'ia32'].includes(stream.architecture) ||
        typeof stream.channel !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(stream.channel)
      ) {
        return null;
      }

      const registered = {
        appId: app.app_id,
        code: stream.code,
        platform: stream.platform,
        architecture: stream.architecture,
        channel: stream.channel,
      };
      const identity = releaseStreamIdentity(registered);
      if (seenCodes.has(registered.code) || seenIdentities.has(identity)) {
        return null;
      }
      seenCodes.add(registered.code);
      seenIdentities.add(identity);
      result.push(registered);
    }
  }

  return seenAppIds.size === expectedAppIds.size ? result : null;
}

function releaseStreamIdentity(value: RegisteredReleaseStream): string {
  return [
    value.appId,
    value.code,
    value.platform,
    value.architecture,
    value.channel,
  ].join('\u0000');
}

function isReleaseStreams(value: unknown, expectedApp: string): boolean {
  if (!Array.isArray(value) || !REGISTERED_RELEASE_STREAMS) return false;
  const expected = REGISTERED_RELEASE_STREAMS.filter(
    (stream) => expectedApp === 'all' || stream.appId === expectedApp,
  );
  if (value.length !== expected.length) return false;

  const expectedIdentities = new Set(expected.map(releaseStreamIdentity));
  const seenIdentities = new Set<string>();
  const streamCountByApp = new Map<string, number>();
  for (const item of value) {
    if (!isRecord(item)) return false;
    const identityFields = {
      appId: item.appId,
      code: item.code,
      platform: item.platform,
      architecture: item.architecture,
      channel: item.channel,
    };
    if (
      typeof item.appId !== 'string' ||
      typeof item.code !== 'string' ||
      typeof item.platform !== 'string' ||
      typeof item.architecture !== 'string' ||
      typeof item.channel !== 'string' ||
      !['empty', 'normal', 'prompt', 'forced', 'stopped'].includes(
        String(item.status),
      ) ||
      (item.status === 'empty' &&
        (item.highestVersion !== null || item.updatedAt !== null)) ||
      (item.status !== 'empty' &&
        (typeof item.highestVersion !== 'string' ||
          !/^[0-9]+(?:\.[0-9]+)*$/.test(item.highestVersion) ||
          item.highestVersion.length > 50 ||
          !isIsoDate(item.updatedAt)))
    ) {
      return false;
    }

    const identity = releaseStreamIdentity(
      identityFields as RegisteredReleaseStream,
    );
    if (!expectedIdentities.has(identity) || seenIdentities.has(identity)) {
      return false;
    }
    seenIdentities.add(identity);

    const appCount = (streamCountByApp.get(item.appId) ?? 0) + 1;
    if (appCount > MAX_RELEASE_STREAMS_PER_APP) return false;
    streamCountByApp.set(item.appId, appCount);
  }
  return seenIdentities.size === expectedIdentities.size;
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
