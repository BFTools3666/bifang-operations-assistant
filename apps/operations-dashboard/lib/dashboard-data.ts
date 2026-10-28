import appRegistry from '../../../cloudbase/apps.json';
import appLabels from '../../../cloudbase/functions/operations-dashboard/src/app-labels.json';

const labels: Readonly<Record<string, string>> = appLabels;
export const APP_OPTIONS = appRegistry.apps.map((app) => ({
  id: app.app_id,
  label: labels[app.app_id] ?? app.app_id,
  shortLabel: labels[app.app_id] ?? app.app_id,
}));

export type AppId = (typeof APP_OPTIONS)[number]['id'];
export type AppFilter = 'all' | AppId;
export type RangeDays = 7 | 14 | 30;

export type TrendPoint = {
  date: string;
  total: number;
  byApp: Record<AppId, number>;
};

export type DistributionItem = {
  label: string;
  value: number;
  percent: number;
  tone?: 'mint' | 'lime' | 'amber' | 'ink';
};

export type ReleaseStreamSummary = {
  appId: AppId;
  code: string;
  platform: 'windows' | 'macos' | 'linux';
  architecture: 'x64' | 'arm64' | 'ia32';
  channel: string;
  highestVersion: string | null;
  status: 'empty' | 'normal' | 'prompt' | 'forced' | 'stopped';
  updatedAt: string | null;
};

export type DashboardAlert = {
  id: string;
  tone: 'warning' | 'success' | 'neutral';
  title: string;
  detail: string;
  time: string;
};

export type DashboardSnapshot = {
  schemaVersion: 2;
  mode: 'live';
  connection: 'connected';
  connectionNote: string;
  environmentId: string;
  timezone: 'Asia/Shanghai';
  generatedAt: string;
  rangeDays: RangeDays;
  selectedAppId: AppFilter;
  appIds: AppId[];
  appLabels: Record<AppId, string>;
  totals: {
    todayActive: number;
    yesterdayActive: number;
    periodActive: number;
    returningToday: number;
    returningRate: number;
    lastReceivedAt: string | null;
  };
  trend: TrendPoint[];
  versions: DistributionItem[];
  platforms: DistributionItem[];
  architectures: DistributionItem[];
  releaseStreams: ReleaseStreamSummary[];
  alerts: DashboardAlert[];
};

export function isRangeDays(value: number): value is RangeDays {
  return value === 7 || value === 14 || value === 30;
}
export function isAppFilter(value: string): value is AppFilter {
  return value === 'all' || APP_OPTIONS.some((app) => app.id === value);
}
