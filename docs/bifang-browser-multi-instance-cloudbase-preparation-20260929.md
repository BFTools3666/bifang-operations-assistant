# bifang-browser-multi-instance CloudBase 接入准备回执（2026-09-29）

> 后续状态：本应用专属 CloudBase 资源、公网 telemetry 幂等 E2E 和 11 应用运营看板接入均已完成。
> 看板写入前出现的两个并发本地登记应用没有相应云资源；负责人最终明确“部署自己即可”，因此
> 它们被完整保留在工作区，但不纳入本轮云端部署或看板。最终结果见
> [部署回执](bifang-browser-multi-instance-cloudbase-deployment-20260929.md)和
> [机器证据](bifang-browser-multi-instance-cloudbase-deployment-20260929.json)。

## 当前状态

本次已按负责人确认的“独立应用”方案，在运营精灵仓库登记
`bifang-browser-multi-instance`。它与既有 `bifang-browser-sync` 相互独立，发布流为
Windows / x64 / stable，code 为
`bifang-browser-multi-instance-windows-x64`。

本地登记、资源隔离设计、目标专属部署计划、看板容量检查、云端部署和公网验收均已完成。
部署前机器证据见[预检与部署计划](bifang-browser-multi-instance-cloudbase-preflight-20260929.json)，
并发变化与最终范围决策见
[重新对齐预检](bifang-browser-multi-instance-cloudbase-reconciled-preflight-20260929.json)。
`cloudbase/apps.json` 仍是应用登记的唯一权威。本文件后续章节保留部署前计划口径，实际结果以最终
部署回执为准。

## 目标仓库与身份边界

目标仓库为
`https://github.com/BFTools366/bifang-browser-multi-instance`。当前任务无法取得仓库内容：
匿名 GitHub 与网页访问返回 404，非交互 Git 需要凭据，系统未安装 `gh`，已登录浏览器会话也未能通过
自动化通道读取。因此本轮没有扫描目标源码，无法核对默认分支、提交、版本、技术栈、安装身份、
既有 telemetry 或更新实现。

负责人已明确确认它是独立应用，并确认以下身份：

| 字段   | 值                                          |
| ------ | ------------------------------------------- |
| APP_ID | `bifang-browser-multi-instance`             |
| 平台   | `windows`                                   |
| 架构   | `x64`                                       |
| 渠道   | `stable`                                    |
| code   | `bifang-browser-multi-instance-windows-x64` |

本轮不修改、构建、安装或发布目标客户端。云端完成后只能证明服务端就绪；真实客户端
`daily_active` 和 application-version E2E 仍需在取得目标源码访问后单独实施和验收。

## 已执行的精确云端目标

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 规则                                                                                  |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 新建集合     | `telemetry_bifang_browser_multi_instance`              | `ADMINONLY`；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`          |
| 新建函数     | `telemetry-bifang-browser-multi-instance`              | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active` |
| 新建路由     | `/apps/bifang-browser-multi-instance/v1/track`         | 绑定上述函数；安全域名和路径透传开启；QPS 总计 100、单 IP 10                          |
| 新建空集合   | `versions_bifang_browser_multi_instance`               | `ADMINONLY`；两个标准版本查询索引；不写版本记录                                       |
| 新建空集合   | `ads_bifang_browser_multi_instance`                    | `ADMINONLY`；标准广告查询索引；不写广告记录                                           |
| 新建空集合   | `audit_bifang_browser_multi_instance`                  | `ADMINONLY`；标准审计索引；不写记录                                                   |
| 原位更新看板 | `operations-dashboard-api`                             | 保留线上 10 个应用并只追加本应用，形成 11 应用映射；不上传原始 secret                 |
| 保留看板路由 | `/dashboard`、`/admin/v1/metrics`                      | 线上已存在；不重建、不删除、不改变现有 QPS                                            |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新共享函数或路由，不生成本应用凭据，不启用版本发布流                              |
| 保留其他资源 | 既有函数、路由、集合和 6 个托管对象                    | 不删除、不迁移、不全量部署                                                            |

非系统索引：

- `versions_bifang_browser_multi_instance`：
  `idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；
  `idx_version_sort` =
  `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_browser_multi_instance`：
  `idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_browser_multi_instance`：
  `idx_audit_occurred_at` = `{occurred_at:-1}`。

完成后资源数量预期从 12 个函数、13 条路由、40 个集合变为 **13 / 14 / 44**；
静态托管仍为 6 个对象；看板从 10 个应用变为 11 个。新增 versions / ads / audit 集合保持空。

## 部署前云端只读预检

最终刷新时间：北京时间 **2026-09-29 09:17**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项       | 结果                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------- |
| 环境         | 仅有 `bftoos-sh-d3ga7hahz59229f0a`；`baas_trial` 体验版，NORMAL，上海；数据库 RUNNING     |
| 费用开关     | 自动续费 false；超限扣费 false；扩展包为空；订单字段与提示为空；到期 2027-03-17 23:59:59  |
| 积分         | 周期 2026-09-17 至 2026-10-17；已用 27.11 / 3000；资源包及按量扣减均为 0                  |
| 当前资源     | 12 个函数、13 条路由、40 个集合、6 个静态托管对象                                         |
| 集合基线     | 40 个既有集合全部为 `ADMINONLY`；TTL 与业务索引契约完整，无差异                           |
| 目标冲突     | 本应用函数、路由和四个集合均不存在                                                        |
| 默认域名     | HTTPS origin 正常；域名 SUCCESS / DNS OK；既有 13 条路由全部启用                          |
| 共享版本函数 | `application-version-api` 自 2026-09-17 16:32:11 起未修改；本轮不触碰                     |
| 运营看板     | `operations-dashboard-api` 当前修改时间 2026-09-29 08:22:32；本轮计划原位追加第 11 个应用 |

本次只读取环境、计费、用量、函数、路由、集合元数据、ACL、索引和托管对象清单，
没有读取业务记录正文，也没有写测试数据。积分不是人民币金额。写入前仍会立即刷新一次；
如出现付费、升级、超限、自动续费、资源漂移、目标冲突或材料摘要变化，立即停止并重新确认。

## 看板容量和部署材料

11 应用 compact schema v2 映射为 1707 UTF-8 字节；完整看板环境变量为 2007 字节，
低于仓库 3840 字节安全门槛和平台 4096 字节上限。

定向看板计划为原位更新 `operations-dashboard-api`，材料 SHA-256 为
`ca21d4a15e0d017860160a2e2a189ff99626a4887bc80e72f292434d34abd768`；
32 个文件、28,913,187 字节；原始 secret 上传数 0，删除列表为空。线上已有
`/dashboard` 与 `/admin/v1/metrics`，执行时只保留这两条路由，不采用计划器对未知线上状态给出的
“创建路由”占位建议。

## 已执行的部署与验收步骤

1. 再次刷新套餐、费用开关、函数、路由、集合、ACL、索引和托管清单；任何漂移立即停止。
2. 创建上述四个集合、`ADMINONLY` 权限和精确索引；versions / ads / audit 保持空。
3. 仅部署 `telemetry-bifang-browser-multi-instance`，仅创建本应用 track 路由。
4. 使用已审阅材料原位更新 `operations-dashboard-api` 为 11 应用映射；保留两条既有看板路由。
5. 回读函数、路由、ACL、TTL、索引、集合计数和看板映射。
6. 使用随机匿名安装身份提交同一个合成 `daily_active` 事件两次，要求只新增一条幂等记录；
   该记录会暂时计入日活，并按 30 天 TTL 清理。
7. 验证看板能读取本应用及原有 10 个应用；这不等同于真实桌面客户端 E2E。

执行期间材料摘要因并发本地登记变化而失效，安全门禁在任何看板云端子进程启动前拒绝了旧计划。
在负责人最终明确“部署自己即可”后，重新计算并审阅 11 应用材料，再完成看板原位更新；没有自动
重试旧摘要，也没有删除任何资源。

本计划不包含第二个 CloudBase 环境、共享版本函数或路由更新、凭据生成、版本或广告记录、
托管写入、全量部署、强制清理、购买、套餐升级、自动续费、超限扣费、目标客户端修改、构建、
安装、发布或 Git 推送。

## 修改与验证

本轮在现有用户未跟踪文件上追加并保留其原状：

- 登记 `bifang-browser-multi-instance` 及 Windows x64 stable 发布流。
- 重新生成 CloudBase 示例配置，加入专属 telemetry 和本地 11 应用映射。
- 同步应用、函数、路由和发布流契约测试。
- 新增本准备回执和机器可读预检计划。

已执行并通过：CloudBase 配置生成检查、目标专属 telemetry 计划、11 应用定向看板计划、
受影响契约测试、operations-dashboard 工作区测试、类型检查、构建、示例类型检查、涉及文件的
Prettier 检查、`git diff --check`、公网 telemetry E2E 和看板公网验证 13/13。

全仓 `npm.cmd run check` 已执行，但在仓库既有 80 个格式问题处停止。完整 `npm.cmd test` 的
四个工作区测试全部通过；根测试中的 Python 驱动项因当前 Windows 环境没有 `py` 启动器而返回
9009。因新增应用导致的两处契约期望已修正并经定向测试通过。

运营精灵部署前基线提交为 `8c855c0837d33d1f4fa48925bdc4202f4d1a0888`。本回执记录的 CloudBase
部署阶段未创建提交；版本入库由部署完成后的单独授权步骤执行。

**CloudBase 部署阶段未执行：共享版本 API 更新、凭据生成、版本或广告记录写入、客户端修改/构建/
安装/发布、第二个环境、购买、静态托管写入、Git 提交或推送、云资源删除。**
