# bifang-vm-sync-agentless CloudBase 接入准备回执（2026-09-28）

## 当前状态

**本准备阶段之后，负责人已按重新对齐的差异清单授权并完成 CloudBase 部署；目标客户端仍未修改。**

> 本文保留最初准备时点的资源快照。并发 LAN 接入造成的云端漂移见[重新对齐预检](bifang-vm-sync-agentless-cloudbase-reconciled-preflight-20260928.json)，最终结果见[部署回执](bifang-vm-sync-agentless-cloudbase-deployment-20260928.md)和[机器可读回执](bifang-vm-sync-agentless-cloudbase-deployment-20260928.json)。

按负责人确认，本次 APP_ID 为 `bifang-vm-sync-agentless`，先登记 Windows x64 / stable，发布流 code 为 `bifang-vm-sync-agentless-windows-x64`。云端范围沿用最近项目：每日活跃 telemetry、运营看板，以及预建空的 versions / ads / audit 集合。版本检查暂不启用，不生成新凭据、不写版本或广告记录。

最初机器可读计划见[本次预检与部署计划](bifang-vm-sync-agentless-cloudbase-preflight-20260928.json)。`cloudbase/apps.json` 仍是应用登记的机器权威。

## 目标仓库核对

| 项目            | 结果                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| 仓库            | `https://github.com/BFTools366/bifang-vm-sync-agentless`                                          |
| 默认分支 / 提交 | `master` / `41da893edc0c3ab037ae000481179c1e310fb94e`；只读分析 checkout 干净                     |
| 当前版本        | `1.6.12`，权威来源为 `src/VmwareSync/App.cs` 的 `AppEntry.Version`                                |
| 技术栈          | Windows C# / WPF；使用 .NET Framework 编译器                                                      |
| 架构说明        | 构建脚本当前为 `/platform:anycpu`；Windows x64 发布流来自负责人明确确认，不伪装成源码自动识别结果 |
| 安装器身份      | Inno Setup `AppId` GUID 仅用于安装器，不作为毕方 APP_ID                                           |
| 既有毕方接入    | 未发现 APP_ID、`daily_active`、毕方版本 API 或旧静态更新协议                                      |

本轮只修改运营精灵仓库的云端登记与计划。目标 GitHub 仓库未修改、未构建、未安装、未发布。

## 待部署的精确云资源

复用上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 规则                                                                                         |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 新建函数     | `telemetry-bifang-vm-sync-agentless`                   | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；仅接受本 APP_ID 的 `daily_active`        |
| 新建路由     | `/apps/bifang-vm-sync-agentless/v1/track`              | 绑定上述函数；安全域名与路径透传开启；QPS 总计 100、单 IP 10                                 |
| 新建集合     | `telemetry_bifang_vm_sync_agentless`                   | ADMINONLY；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`；服务端保留 30 天 |
| 新建空集合   | `versions_bifang_vm_sync_agentless`                    | ADMINONLY；两个标准版本查询索引；不写版本记录                                                |
| 新建空集合   | `ads_bifang_vm_sync_agentless`                         | ADMINONLY；标准广告查询索引；不写广告记录                                                    |
| 新建空集合   | `audit_bifang_vm_sync_agentless`                       | ADMINONLY；标准审计索引；不写记录                                                            |
| 更新函数     | `operations-dashboard-api`                             | 仅把本应用追加到现有四个线上应用；保留认证值、路由和函数规格                                 |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新函数、不扩充线上映射和 11 份既有凭据                                                   |
| 保留其他资源 | 现有应用资源、6 个静态托管对象                         | 不删除、不迁移、不全量部署                                                                   |

非系统索引：

- `versions_bifang_vm_sync_agentless`：`idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；`idx_version_sort` = `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_vm_sync_agentless`：`idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_vm_sync_agentless`：`idx_audit_occurred_at` = `{occurred_at:-1}`。

完成上述目标后，环境预期从 6 个函数、7 条 HTTP 服务路由、16 个集合变为 **7 / 8 / 20**；新增的三个版本相关集合保持空。

## 最新云端只读预检

查询时间：北京时间 **2026-09-28 15:41–15:48**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项         | 结果                                                                      |
| -------------- | ------------------------------------------------------------------------- |
| 环境与套餐     | 现有 `baas_trial` 体验版，NORMAL，上海；到期 2027-03-17 23:59:59          |
| 费用开关       | 自动续费 false；超限扣费 false；扩展包为空，订单字段和提示文本为空        |
| 积分           | 周期 2026-09-17 至 2026-10-17；已用 5.66 / 3000；资源包及按量扣减均为 0   |
| 当前资源       | 6 个函数、7 条 HTTP 服务路由、16 个集合、6 个静态托管对象                 |
| 目标冲突       | 本工具的函数、路由和四个集合均不存在                                      |
| 既有集合       | 16 个集合均为 ADMINONLY，标准索引符合现行配置；既有 telemetry 均有 TTL    |
| 默认 HTTP 域名 | SUCCESS / DNS OK；当前 7 条路由全部启用                                   |
| 运营看板       | Active / Available，3 秒 / 256 MB；当前只映射已上线的四个应用，不含本工具 |
| 共享版本函数   | Active / Available；仍为原三款应用和 11 份凭据，不含本工具                |

预检只读取环境、计费、函数、路由、集合元数据、ACL、索引及记录数量，没有读取业务记录正文，也没有写测试数据。积分不是人民币金额；正式执行前仍要刷新本表，遇到付费、升级、超限或资源漂移立即停止。

## 共享看板的并发隔离

准备期间，工作区出现了另一项用户改动：`bifang-lan-file-transfer` 已登记但尚未部署。完整生成配置因此同时含有两个未上线应用，直接部署会夹带另一项目。

本次为看板部署 helper 增加了显式 `--app-ids` 范围绑定，并把应用列表计入部署材料 SHA-256。已审核计划只包含以下五个应用：

- `bifang-screen-recorder`
- `bifang-mouse-clicker`
- `bifang-tools`
- `bifang-ai-usage-collector`
- `bifang-vm-sync-agentless`

`bifang-lan-file-transfer` 明确排除。当前看板环境键值合计 1824 字节，定向计划为 2157 字节。定向看板材料 SHA-256 为 `99f3569507b5f9a6744236006c6aec81bccf06a5bb5982a41dcbe611b946c1a8`；材料或应用范围变化时必须重新计划并重新确认。

## 收到“继续”后的执行与验收

1. 刷新费用开关和完整资源清单；目标、材料或计费状态漂移时停止。
2. 创建上述四个集合、ADMINONLY 权限及精确索引；versions / ads / audit 保持空。
3. 仅部署 `telemetry-bifang-vm-sync-agentless`，仅创建本工具 track 路由。
4. 使用已绑定五应用范围的计划更新 `operations-dashboard-api`；保留 `/dashboard` 和 `/admin/v1/metrics`。
5. 回读函数、路由、ACL、TTL、索引和看板映射。
6. 使用随机匿名安装身份提交一个合成 `daily_active` 事件及相同重试，要求只新增一条本工具记录；该记录会暂时计入日活，并按 30 天 TTL 清理。
7. 验证看板能看到本工具，且原四个应用仍可读取；这不等同于真实桌面客户端 E2E。

回滚只恢复看板函数上一版代码与配置；新建集合默认保留。删除任何资源都需要另列精确目标并再次授权。本计划不包含购买、扩容、按量超限、版本服务更新、托管写入、全量部署、强制清理或删除。

## 修改与验证

本轮在现有用户改动上追加：

- 登记 `bifang-vm-sync-agentless` 及 Windows x64 / stable 发布流，并重新生成 CloudBase 示例配置。
- 同步应用、函数、路由和发布流契约测试。
- 为共享看板部署 helper 增加显式 APP_ID 范围绑定，避免夹带并发登记应用；补充测试与说明。
- 新增本回执和机器可读预检计划。

验证结果：配置生成检查通过；定向测试 25/25、workspace 测试 131/131、根 Node 测试 140/140、Python 客户端测试 42/42 通过；类型检查、构建和示例类型检查通过。根测试在主机缺少 Python 依赖时先失败，随后使用桌面内置 Python 和一次性临时 PyYAML 依赖重跑通过。`npm run format:check` 仍因 80 个既有文件格式问题失败，本轮未擅自全仓格式化。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`，本次未创建提交。

后续已在负责人再次明确回复“继续”后完成重新对齐清单中的 CloudBase 写入和公网 E2E。仍未执行：版本发布、购买、Git 推送、云资源删除、凭据生成、目标客户端修改/构建/安装。详见最终部署回执。
