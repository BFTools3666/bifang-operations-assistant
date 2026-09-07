export const APP_OPTIONS = [
  {
    id: 'bifang-screen-recorder',
    label: '毕方录屏助手',
    shortLabel: '录屏助手',
  },
  {
    id: 'bifang-mouse-clicker',
    label: '毕方鼠标精灵',
    shortLabel: '鼠标精灵',
  },
] as const;

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

export type UpdateManifestSummary = {
  appId: AppId;
  platform: 'windows' | 'macos';
  enabled: boolean;
  forceUpdate: boolean;
  rollout: number;
  latestVersion: string;
  minSupportedVersion: string;
  publishedAt: string;
  manifestUrl: string;
  source: 'cloudbase' | 'unavailable';
};

export type DashboardAlert = {
  id: string;
  tone: 'warning' | 'success' | 'neutral';
  title: string;
  detail: string;
  time: string;
};

export type DashboardSnapshot = {
  schemaVersion: 1;
  mode: 'live';
  connection: 'connected';
  connectionNote: string;
  environmentId: string;
  timezone: 'Asia/Shanghai';
  generatedAt: string;
  rangeDays: RangeDays;
  selectedAppId: AppFilter;
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
  manifests: UpdateManifestSummary[];
  alerts: DashboardAlert[];
};

export function isRangeDays(value: number): value is RangeDays {
  return value === 7 || value === 14 || value === 30;
}
export function isAppFilter(value: string): value is AppFilter {
  return value === 'all' || APP_OPTIONS.some((app) => app.id === value);
}
