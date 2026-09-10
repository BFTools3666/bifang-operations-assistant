'use client';

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Cloud,
  Command,
  Flame,
  Info,
  Laptop,
  RefreshCw,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  APP_OPTIONS,
  isAppFilter,
  isRangeDays,
  type AppFilter,
  type DashboardAlert,
  type DashboardSnapshot,
  type DistributionItem,
  type RangeDays,
  type ReleaseStreamSummary,
} from '@/lib/dashboard-data';

const platformNames = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
} as const;

export function DashboardShell() {
  const [app, setApp] = useState<AppFilter>('all');
  const [range, setRange] = useState<RangeDays>(14);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const view = useRef({ app: 'all' as AppFilter, range: 14 as RangeDays });
  const [selectedAlert, setSelectedAlert] = useState<DashboardAlert | null>(
    null,
  );

  const loadData = useCallback(
    async (nextApp: AppFilter, nextRange: RangeDays) => {
      pending.current?.abort();
      const controller = new AbortController();
      pending.current = controller;
      view.current = { app: nextApp, range: nextRange };
      setApp(nextApp);
      setRange(nextRange);
      setSnapshot(null);
      setError(null);
      setRefreshing(true);
      window.history.replaceState(
        null,
        '',
        `?app=${encodeURIComponent(nextApp)}&days=${nextRange}`,
      );
      try {
        const params = new URLSearchParams({
          app: nextApp,
          days: String(nextRange),
        });
        const response = await fetch(`/api/metrics?${params}`, {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(15_000),
          ]),
        });
        if (!response.ok)
          throw new Error(
            response.status === 401
              ? 'authentication_required'
              : 'dashboard_request_failed',
          );
        const nextSnapshot = (await response.json()) as DashboardSnapshot;
        if (
          nextSnapshot.mode !== 'live' ||
          nextSnapshot.connection !== 'connected' ||
          nextSnapshot.selectedAppId !== nextApp ||
          nextSnapshot.rangeDays !== nextRange
        )
          throw new Error('invalid_snapshot');
        if (controller.signal.aborted) return null;
        flushSync(() => {
          setSnapshot(nextSnapshot);
          setRefreshing(false);
        });
        return nextSnapshot;
      } catch (failure) {
        if (controller.signal.aborted) return null;
        setError(
          failure instanceof Error &&
            failure.message === 'authentication_required'
            ? '登录已过期，请重新登录后读取生产数据。'
            : '无法读取生产 CloudBase。请检查网络后重试；此时不展示任何替代数字。',
        );
        return null;
      } finally {
        if (pending.current === controller) setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const nextApp = params.get('app') ?? 'all';
      const nextDays = Number(params.get('days') ?? 14);
      void loadData(
        isAppFilter(nextApp) ? nextApp : 'all',
        isRangeDays(nextDays) ? nextDays : 14,
      );
    };
    const timer = window.setTimeout(restore, 0);
    window.addEventListener('popstate', restore);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('popstate', restore);
      pending.current?.abort();
    };
  }, [loadData]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    void Promise.resolve(
      context.registerTool(
        {
          name: 'set_dashboard_view',
          title: '切换运营看板视图',
          description: '切换当前应用和统计周期，并刷新页面上同一份运营数据。',
          inputSchema: {
            type: 'object',
            properties: {
              app: {
                type: 'string',
                enum: ['all', ...APP_OPTIONS.map((item) => item.id)],
              },
              days: { type: 'integer', enum: [7, 14, 30] },
            },
            required: ['app', 'days'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          async execute(input) {
            const value = input as { app?: unknown; days?: unknown };
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.keys(value).some(
                (key) => !['app', 'days'].includes(key),
              ) ||
              typeof value.app !== 'string' ||
              !isAppFilter(value.app) ||
              typeof value.days !== 'number' ||
              !isRangeDays(value.days)
            ) {
              throw new TypeError('app 或 days 不在允许范围内');
            }
            setApp(value.app);
            setRange(value.days);
            const result = await loadData(value.app, value.days);
            if (!result) throw new Error('生产数据未能加载');
            return {
              app: result.selectedAppId,
              days: result.rangeDays,
              mode: result.mode,
              todayActive: result.totals.todayActive,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    void Promise.resolve(
      context.registerTool(
        {
          name: 'refresh_dashboard_data',
          title: '刷新运营数据',
          description: '重新读取当前看板视图的数据并更新所有可见指标。',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          async execute(input) {
            if (
              !input ||
              typeof input !== 'object' ||
              Array.isArray(input) ||
              Object.keys(input).length > 0
            ) {
              throw new TypeError('刷新操作不接受参数');
            }
            const result = await loadData(view.current.app, view.current.range);
            if (!result) throw new Error('生产数据未能加载');
            return {
              mode: result.mode,
              generatedAt: result.generatedAt,
              connection: result.connection,
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);

    return () => lifecycle.abort();
  }, [loadData]);

  function handleAppChange(value: string | null) {
    const next = value && isAppFilter(value) ? value : 'all';
    setApp(next);
    void loadData(next, range);
  }

  function handleRangeChange(value: string | number | null) {
    const parsed = Number(value);
    if (!isRangeDays(parsed)) return;
    setRange(parsed);
    void loadData(app, parsed);
  }

  const dailyChange = percentChange(
    snapshot?.totals.todayActive ?? 0,
    snapshot?.totals.yesterdayActive ?? 0,
  );
  const chart = useMemo(
    () => (snapshot ? createChart(snapshot) : null),
    [snapshot],
  );

  return (
    <TooltipProvider>
      <main className="min-h-screen bg-background text-foreground">
        <SiteHeader snapshot={snapshot} />

        <div className="mx-auto max-w-[1560px] px-4 pb-16 pt-7 sm:px-7 lg:px-10 lg:pt-9">
          <section id="overview" className="scroll-mt-24">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  <span className="h-px w-7 bg-[#12a47f]" /> OPERATIONS OVERVIEW
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="text-[clamp(1.85rem,3.3vw,3.15rem)] font-semibold leading-none tracking-[-0.045em]">
                    今日运营总览
                  </h1>
                  {!snapshot ? (
                    <span className="demo-badge">
                      <Cloud className="size-3.5" />{' '}
                      {refreshing ? '正在读取生产数据' : '生产数据不可用'}
                    </span>
                  ) : (
                    <span className="live-badge">
                      <span className="size-1.5 rounded-full bg-[#0e9f7b]" />{' '}
                      生产环境 · 已连接
                    </span>
                  )}
                </div>
                <p className="mt-3 max-w-2xl text-[15px] leading-6 text-muted-foreground">
                  查看今天启动使用的设备、活跃版本与更新状态。
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <Select value={app} onValueChange={handleAppChange}>
                  <SelectTrigger
                    aria-label="选择应用"
                    className="h-10 min-w-[210px] rounded-xl border-border/80 bg-card px-3 shadow-xs"
                  >
                    <Cloud className="size-4 text-[#12a47f]" />
                    <SelectValue>
                      {app === 'all'
                        ? '全部应用'
                        : APP_OPTIONS.find((item) => item.id === app)?.label}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="all">全部应用</SelectItem>
                    {APP_OPTIONS.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Tabs value={String(range)} onValueChange={handleRangeChange}>
                  <TabsList
                    aria-label="统计周期"
                    className="h-10 rounded-xl border border-border/80 bg-card p-1 shadow-xs"
                  >
                    {[7, 14, 30].map((days) => (
                      <TabsTrigger
                        className="h-8 rounded-lg px-3"
                        key={days}
                        value={String(days)}
                      >
                        {days} 天
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>

                <Button
                  className="h-10 rounded-xl bg-[#17201f] px-3.5 text-white shadow-sm hover:bg-[#273331]"
                  disabled={refreshing}
                  onClick={() => void loadData(app, range)}
                >
                  <RefreshCw className={refreshing ? 'animate-spin' : ''} />
                  {refreshing ? '刷新中' : '刷新数据'}
                </Button>
              </div>
            </div>

            <div className="mt-6 flex items-start gap-3 rounded-2xl border border-[#cfe4dd] bg-[#edf8f4] px-4 py-3 text-sm text-[#41645b] sm:items-center">
              <ShieldCheck className="mt-0.5 size-[18px] shrink-0 text-[#0d8d6d] sm:mt-0" />
              <div className="min-w-0 flex-1">
                <p className="leading-5">
                  统计成功写入 CloudBase
                  的匿名活跃安装设备；同一应用、同一设备、同一北京时间日期最多计
                  1 次。
                </p>
                <p className="mt-1 text-xs text-[#658078]">
                  生产集合含历史验收记录，当前协议无法可靠区分测试与自然用户；这里按实际存储记录统计。今日尚未结束。
                </p>
              </div>
              <Tooltip>
                <TooltipTrigger
                  className="ml-auto hidden shrink-0 text-[#5f7d75] sm:block"
                  aria-label="查看数据口径"
                >
                  <Info className="size-4" />
                </TooltipTrigger>
                <TooltipContent>
                  不是账号人数，不按 IP 去重；真实查询范围最多 30 天。
                </TooltipContent>
              </Tooltip>
            </div>

            {!snapshot &&
              (refreshing ? (
                <output
                  aria-label="正在加载生产数据"
                  className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  {[0, 1, 2, 3].map((index) => (
                    <Skeleton key={index} className="h-52 rounded-2xl" />
                  ))}
                </output>
              ) : (
                <Empty role="alert" className="panel-card mt-4 min-h-64">
                  <EmptyTitle>生产数据暂时不可用</EmptyTitle>
                  <EmptyDescription>{error}</EmptyDescription>
                  <Button onClick={() => void loadData(app, range)}>
                    重试读取
                  </Button>
                  {error?.includes('登录') && (
                    <a
                      className="underline"
                      href={`/signin-with-chatgpt?return_to=${encodeURIComponent(`/?app=${app}&days=${range}`)}`}
                    >
                      重新登录
                    </a>
                  )}
                </Empty>
              ))}
            {snapshot && chart && (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <MetricCard
                    accent="mint"
                    icon={<Activity />}
                    label="今日活跃设备"
                    value={number(snapshot.totals.todayActive)}
                    change={dailyChange.label}
                    trend={dailyChange.trend}
                    detail={`较昨日 · ${number(snapshot.totals.yesterdayActive)} 台`}
                  />
                  <MetricCard
                    accent="lime"
                    icon={<UsersRound />}
                    label={`近 ${range} 日活跃设备`}
                    value={number(snapshot.totals.periodActive)}
                    change={`${range}D`}
                    trend="stable"
                    detail="按应用与设备去重"
                  />
                  <MetricCard
                    accent="amber"
                    icon={<Command />}
                    label="今日回访占比"
                    value={
                      snapshot.totals.todayActive === 0
                        ? '—'
                        : `${snapshot.totals.returningRate.toFixed(1)}%`
                    }
                    change={`${number(snapshot.totals.returningToday)} 台`}
                    trend="stable"
                    detail={
                      snapshot.totals.todayActive === 0
                        ? '今日暂无样本'
                        : '今天在过去 29 天活跃过的设备'
                    }
                  />
                  <MetricCard
                    accent="ink"
                    icon={<CalendarDays />}
                    label="最新数据写入"
                    value={formatTime(snapshot.totals.lastReceivedAt)}
                    change={
                      !snapshot.totals.lastReceivedAt
                        ? '无记录'
                        : Date.parse(snapshot.generatedAt) -
                              Date.parse(snapshot.totals.lastReceivedAt) >
                            86_400_000
                          ? '超过 24 小时'
                          : '最近 24 小时'
                    }
                    trend="stable"
                    detail={`查询于 ${formatTime(snapshot.generatedAt)} · 北京时间`}
                  />
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.85fr)_minmax(320px,0.72fr)]">
                  <TrendPanel snapshot={snapshot} chart={chart} />
                  <AttentionPanel
                    alerts={snapshot.alerts}
                    onSelect={setSelectedAlert}
                  />
                </div>
              </>
            )}
          </section>

          {snapshot && (
            <>
              <section
                id="versions"
                className="mt-4 grid scroll-mt-24 gap-4 lg:grid-cols-2 xl:grid-cols-[1.1fr_0.9fr]"
              >
                <DistributionPanel
                  title="活跃版本"
                  description="每台设备取所选周期内的最近一次上报"
                  items={snapshot.versions}
                />
                <EnvironmentPanel
                  platforms={snapshot.platforms}
                  architectures={snapshot.architectures}
                />
              </section>

              <section
                id="services"
                className="panel-card mt-4 scroll-mt-24 overflow-hidden"
              >
                <div className="flex flex-col gap-3 border-b border-border/70 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                  <div>
                    <h2 className="text-base font-semibold tracking-[-0.015em]">
                      更新发布雷达
                    </h2>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                      从应用隔离的版本集合读取每个 code 的最高版本
                    </p>
                  </div>
                  <Badge
                    className="w-fit border-[#d8e3df] bg-[#eef4f2] text-[#536762]"
                    variant="outline"
                  >
                    {snapshot.releaseStreams.length} 个发布流
                  </Badge>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow className="bg-[#f7f9f8] hover:bg-[#f7f9f8]">
                      <TableHead className="h-11 pl-5 text-xs text-muted-foreground sm:pl-6">
                        应用
                      </TableHead>
                      <TableHead className="text-xs text-muted-foreground">
                        发布流 code
                      </TableHead>
                      <TableHead className="text-xs text-muted-foreground">
                        平台 / 架构
                      </TableHead>
                      <TableHead className="text-xs text-muted-foreground">
                        渠道
                      </TableHead>
                      <TableHead className="text-xs text-muted-foreground">
                        最高版本
                      </TableHead>
                      <TableHead className="pr-5 text-right text-xs text-muted-foreground sm:pr-6">
                        状态
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshot.releaseStreams.map((item) => (
                      <TableRow key={item.code}>
                        <TableCell className="py-4 pl-5 font-medium sm:pl-6">
                          {appName(item.appId)}
                        </TableCell>
                        <TableCell className="max-w-[260px] break-all py-4 font-mono text-xs text-muted-foreground">
                          {item.code}
                        </TableCell>
                        <TableCell className="py-4 text-muted-foreground">
                          {platformNames[item.platform]} / {item.architecture}
                        </TableCell>
                        <TableCell className="py-4 text-muted-foreground">
                          {item.channel}
                        </TableCell>
                        <TableCell className="py-4 font-mono text-xs tabular-nums text-muted-foreground">
                          {item.highestVersion ?? '—'}
                        </TableCell>
                        <TableCell className="py-4 pr-5 text-right sm:pr-6">
                          <span className={releaseStatus(item).className}>
                            <span className="size-1.5 rounded-full bg-current" />
                            {releaseStatus(item).label}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>

              <footer className="mt-6 flex flex-col gap-2 px-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <p>
                  北京时间 UTC+8 · 仅展示聚合数据，不返回安装标识、事件 ID
                  或来源 IP
                </p>
                <p className="break-all font-mono">
                  ENV · {snapshot.environmentId}
                </p>
              </footer>
            </>
          )}
        </div>

        <AlertDetail
          alert={selectedAlert}
          onClose={() => setSelectedAlert(null)}
        />
      </main>
    </TooltipProvider>
  );
}

function SiteHeader({ snapshot }: { snapshot: DashboardSnapshot | null }) {
  const connected = snapshot?.connection === 'connected';
  return (
    <header className="sticky top-0 z-30 border-b border-white/8 bg-[#17201f]/96 text-white backdrop-blur-xl">
      <div className="mx-auto flex h-[68px] max-w-[1560px] items-center gap-4 px-4 sm:px-7 lg:px-10">
        <div className="flex min-w-0 items-center gap-3">
          <div className="brand-mark" aria-hidden="true">
            <Flame className="size-[18px]" strokeWidth={2.3} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold tracking-[0.01em]">
              毕方运营精灵
            </p>
            <p className="truncate text-[11px] text-white/48">
              CloudBase 运营台
            </p>
          </div>
        </div>
        <nav
          className="ml-7 hidden items-center gap-1 lg:flex"
          aria-label="主导航"
        >
          <a className="nav-pill nav-pill-active" href="#overview">
            总览
          </a>
          <a className="nav-pill" href="#versions">
            版本
          </a>
          <a className="nav-pill" href="#services">
            服务状态
          </a>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.055] px-3 py-1.5 text-xs text-white/65 sm:flex">
            <span
              className={`size-1.5 rounded-full ${connected ? 'bg-[#62dcba]' : 'bg-[#e9b65c]'}`}
            />
            {connected ? 'CloudBase 实时连接' : '只读接口待连接'}
          </div>
          <div className="flex size-9 items-center justify-center rounded-full bg-[#e7f66f] text-xs font-bold text-[#17201f]">
            BF
          </div>
        </div>
      </div>
    </header>
  );
}

function TrendPanel({
  snapshot,
  chart,
}: {
  snapshot: DashboardSnapshot;
  chart: ChartGeometry;
}) {
  const labels = chart.labelPoints;
  return (
    <section
      className="panel-card overflow-hidden"
      aria-labelledby="trend-title"
    >
      <div className="flex flex-col gap-3 border-b border-border/70 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <div className="flex items-center gap-2">
            <h2
              id="trend-title"
              className="text-base font-semibold tracking-[-0.015em]"
            >
              每日活跃趋势
            </h2>
            <span className="status-dot">LIVE</span>
          </div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            全部应用时按应用合计，不做跨应用设备去重
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-[#0e9f7b]" /> 活跃设备
          </span>
          <span>峰值 {number(chart.maxValue)} 台</span>
        </div>
      </div>
      <div className="relative px-4 pb-4 pt-5 sm:px-6 sm:pb-6">
        <div className="relative h-[250px] overflow-hidden rounded-xl bg-[#f8faf9] p-4 sm:h-[276px] sm:p-5">
          <div className="absolute inset-5 hidden bg-[linear-gradient(to_bottom,transparent_calc(25%-1px),#e4e9e7_25%,transparent_calc(25%+1px),transparent_calc(50%-1px),#e4e9e7_50%,transparent_calc(50%+1px),transparent_calc(75%-1px),#e4e9e7_75%,transparent_calc(75%+1px))] sm:block" />
          <svg
            className="relative h-[210px] w-full overflow-visible sm:h-[220px]"
            viewBox="0 0 760 220"
            aria-labelledby="activity-chart-title"
          >
            <title id="activity-chart-title">
              最近 {snapshot.rangeDays} 天每日活跃趋势，今天{' '}
              {snapshot.totals.todayActive} 台
            </title>
            <defs>
              <linearGradient id="activity-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#0e9f7b" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#0e9f7b" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon
              fill="url(#activity-fill)"
              points={`0,220 ${chart.points} 760,220`}
            />
            <polyline
              fill="none"
              points={chart.points}
              stroke="#0e9f7b"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="3.5"
            />
            {chart.circles.map((point, index) => (
              <circle
                key={`${point.x}-${point.y}`}
                cx={point.x}
                cy={point.y}
                fill="#f8faf9"
                r={index === chart.circles.length - 1 ? 6 : 3.2}
                stroke="#0e9f7b"
                strokeWidth={index === chart.circles.length - 1 ? 4 : 2.2}
              />
            ))}
          </svg>
          <div className="relative mt-2 flex justify-between text-[11px] font-medium text-muted-foreground sm:text-xs">
            {labels.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
        </div>
      </div>
      <details className="px-5 pb-5 text-xs text-muted-foreground">
        <summary className="cursor-pointer">查看每日实际记录</summary>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>北京时间日期</TableHead>
              <TableHead>活跃设备</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {snapshot.trend.map((point) => (
              <TableRow key={point.date}>
                <TableCell>{point.date}</TableCell>
                <TableCell>{point.total}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </details>
    </section>
  );
}

function AttentionPanel({
  alerts,
  onSelect,
}: {
  alerts: DashboardAlert[];
  onSelect: (alert: DashboardAlert) => void;
}) {
  return (
    <section
      className="panel-card flex flex-col"
      aria-labelledby="attention-title"
    >
      <div className="flex items-center justify-between border-b border-border/70 px-5 py-5">
        <div>
          <h2
            id="attention-title"
            className="text-base font-semibold tracking-[-0.015em]"
          >
            需要关注
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            数据状态与安全边界
          </p>
        </div>
        <span className="flex size-9 items-center justify-center rounded-full bg-[#fff4de] text-[#b56a13]">
          <CircleAlert className="size-[18px]" />
        </span>
      </div>
      <div className="divide-y divide-border/60 px-5">
        {alerts.map((alert) => (
          <button
            key={alert.id}
            className="group flex w-full items-start gap-3 py-4 text-left"
            onClick={() => onSelect(alert)}
          >
            <span
              className={`mt-1.5 size-2 shrink-0 rounded-full alert-${alert.tone}`}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-foreground">
                {alert.title}
              </span>
              <span className="mt-1 block text-[13px] leading-5 text-muted-foreground">
                {alert.detail}
              </span>
              <span className="mt-2 block text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/75">
                {alert.time}
              </span>
            </span>
            <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
      <div className="mt-auto px-5 pb-5 pt-1">
        <p className="rounded-xl border border-border/80 bg-muted/45 px-3 py-2.5 text-center text-xs text-muted-foreground">
          仅在样本足够时判断趋势异常
        </p>
      </div>
    </section>
  );
}

function DistributionPanel({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items: DistributionItem[];
}) {
  return (
    <section
      className="panel-card px-5 py-5 sm:px-6"
      aria-labelledby="version-title"
    >
      <h2
        id="version-title"
        className="text-base font-semibold tracking-[-0.015em]"
      >
        {title}
      </h2>
      <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
      <div className="mt-6 space-y-5">
        {items.length === 0 && (
          <Empty>
            <EmptyDescription>所选周期暂无活跃设备</EmptyDescription>
          </Empty>
        )}
        {items.map((item) => (
          <div key={item.label}>
            <div className="mb-2 flex items-center justify-between gap-3 text-sm">
              <span className="font-medium">{item.label}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {number(item.value)} 台 · {item.percent.toFixed(1)}%
              </span>
            </div>
            <Progress
              aria-label={`${item.label} ${item.percent.toFixed(1)}%`}
              className={`distribution-${item.tone ?? 'mint'}`}
              value={item.percent}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function EnvironmentPanel({
  platforms,
  architectures,
}: {
  platforms: DistributionItem[];
  architectures: DistributionItem[];
}) {
  return (
    <section
      className="panel-card px-5 py-5 sm:px-6"
      aria-labelledby="environment-title"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            id="environment-title"
            className="text-base font-semibold tracking-[-0.015em]"
          >
            运行环境
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            活跃设备的平台与处理器架构
          </p>
        </div>
        <span className="flex size-9 items-center justify-center rounded-xl bg-[#eaf4f1] text-[#0d8d6d]">
          <Laptop className="size-[18px]" />
        </span>
      </div>
      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <MiniDistribution title="平台" items={platforms} />
        <MiniDistribution title="架构" items={architectures} />
      </div>
    </section>
  );
}

function MiniDistribution({
  title,
  items,
}: {
  title: string;
  items: DistributionItem[];
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </p>
      <div className="mt-3 space-y-3">
        {items.length === 0 && (
          <p className="text-xs text-muted-foreground">暂无样本</p>
        )}
        {items.map((item, index) => (
          <div className="flex items-center gap-3" key={item.label}>
            <span className={`size-2.5 rounded-full mini-tone-${index % 4}`} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {item.label}
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {item.percent.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AlertDetail({
  alert,
  onClose,
}: {
  alert: DashboardAlert | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={alert !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[min(92vw,430px)] sm:max-w-[430px]">
        <SheetHeader className="border-b border-border px-6 pb-5 pt-6">
          <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-[#fff3dd] text-[#b56a13]">
            <CircleAlert className="size-5" />
          </div>
          <SheetTitle className="text-xl font-semibold">
            {alert?.title ?? '运营诊断'}
          </SheetTitle>
          <SheetDescription className="mt-2 leading-6">
            {alert?.detail}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-6 py-5">
          <div className="rounded-2xl border border-border bg-[#f7f9f8] p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              建议动作
            </p>
            <p className="mt-2 text-sm leading-6">
              继续观察下一次刷新结果；看板只读，不会自动改动 CloudBase
              函数、集合、发布记录或套餐。
            </p>
          </div>
          <div className="rounded-2xl border border-[#d8e8e3] bg-[#eef8f5] p-4 text-sm leading-6 text-[#43655d]">
            原始安装标识与来源 IP 不会通过看板接口返回。
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

type MetricCardProps = {
  accent: 'mint' | 'lime' | 'amber' | 'ink';
  icon: React.ReactNode;
  label: string;
  value: string;
  change: string;
  trend: 'up' | 'down' | 'stable';
  detail: string;
};

function MetricCard({
  accent,
  icon,
  label,
  value,
  change,
  trend,
  detail,
}: MetricCardProps) {
  return (
    <article className={`metric-card metric-${accent}`}>
      <div className="flex items-start justify-between gap-3">
        <span className="metric-icon">{icon}</span>
        <span className={`metric-change metric-change-${trend}`}>
          {trend === 'up' && <ArrowUpRight />}
          {trend === 'down' && <ArrowDownRight />}
          {trend === 'stable' && <Check />}
          {change}
        </span>
      </div>
      <p className="mt-7 text-sm font-medium text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-[clamp(2rem,3vw,2.75rem)] font-semibold leading-none tracking-[-0.055em] tabular-nums">
        {value}
      </p>
      <p className="mt-3 text-xs text-muted-foreground">{detail}</p>
    </article>
  );
}

type ChartGeometry = {
  points: string;
  circles: Array<{ x: number; y: number }>;
  maxValue: number;
  labelPoints: string[];
};

function createChart(snapshot: DashboardSnapshot): ChartGeometry {
  const width = 760;
  const height = 220;
  const values = snapshot.trend.map((item) => item.total);
  const maxValue = Math.max(0, ...values);
  const top = Math.max(1, Math.ceil(maxValue * 1.18));
  const circles = values.map((value, index) => ({
    x: values.length === 1 ? width / 2 : (index / (values.length - 1)) * width,
    y: height - (value / top) * (height - 22),
  }));
  const labelIndexes = [
    0,
    Math.floor((values.length - 1) / 3),
    Math.floor(((values.length - 1) * 2) / 3),
    values.length - 1,
  ];
  return {
    points: circles
      .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
      .join(' '),
    circles,
    maxValue,
    labelPoints: labelIndexes.map((index) =>
      index === values.length - 1
        ? '今天'
        : shortDate(snapshot.trend[index]?.date),
    ),
  };
}

function percentChange(
  current: number,
  previous: number,
): { label: string; trend: 'up' | 'down' | 'stable' } {
  if (previous <= 0) return { label: '—', trend: 'stable' };
  const value = ((current - previous) / previous) * 100;
  if (Math.abs(value) < 0.05) return { label: '持平', trend: 'stable' };
  return {
    label: `${value > 0 ? '+' : ''}${value.toFixed(1)}%`,
    trend: value > 0 ? 'up' : 'down',
  };
}

function appName(appId: string): string {
  return APP_OPTIONS.find((item) => item.id === appId)?.shortLabel ?? appId;
}

function releaseStatus(item: ReleaseStreamSummary): {
  className: string;
  label: string;
} {
  if (item.status === 'empty') {
    return { className: 'release-empty', label: '暂无版本' };
  }
  if (item.status === 'stopped') {
    return { className: 'release-stopped', label: '暂停更新' };
  }
  if (item.status === 'forced') {
    return { className: 'release-forced', label: '强制更新' };
  }
  if (item.status === 'prompt') {
    return { className: 'release-prompt', label: '提示更新' };
  }
  return { className: 'release-normal', label: '普通更新' };
}

function number(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function shortDate(value?: string): string {
  if (!value) return '—';
  return value.slice(5).replace('-', '/');
}

function formatTime(value: string | null): string {
  if (!value) return '暂无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(date);
}
