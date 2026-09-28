# 毕方 CodeX 皮肤工坊 CloudBase 接入准备回执（2026-09-28）

> 后续状态：负责人已明确回复“继续”，本次云端范围已经部署并完成公网验收。见[部署回执](bifang-codex-skins-cloudbase-deployment-20260928.md)。以下保留部署前的准备与审批记录。

## 当前状态

**本节记录部署前状态：当时本地登记、云端只读预检和定向部署计划已完成，CloudBase 和目标客户端均未修改。**

本次参照现有应用的隔离规则，登记 `bifang-codex-skins`，为 Windows x64 与 macOS arm64 各保留一条 `stable` 发布流；计划部署每日活跃统计并加入运营看板。共享版本服务本轮不更新、不生成凭据、不写版本或广告记录。

机器可读证据见[本次预检与部署计划](bifang-codex-skins-cloudbase-preflight-20260928.json)。`cloudbase/apps.json` 仍是应用登记的唯一机器权威。

## 目标仓库依据

| 项目                | 核对结果                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub 仓库         | `https://github.com/BFTools366/bifang-codex-themes`（私有）                                     |
| 默认分支 / 当前提交 | `master` / `53c03c0e583c0c9323299cb8c8728ff3e25f113d`；本地精确镜像与远端 HEAD 一致且工作树干净 |
| 产品 / 当前源码版本 | 毕方CodeX皮肤工坊 / `1.1.0`；package、Cargo 与 Tauri 配置一致                                   |
| 技术栈              | Tauri 2、Rust、React                                                                            |
| APP_ID              | 客户端源码已有 `bifang-codex-skins`                                                             |
| 当前发布目标        | Windows x64、macOS arm64                                                                        |
| 当前统计实现        | 旧 SLS 启动统计；未实现北京时区的 `daily_active` 本地门禁                                       |
| 当前更新实现        | 外部版本服务；不是本仓库 CloudBase application-version 协议                                     |

本次只操作运营精灵仓库和既有 CloudBase 环境，不从本仓库修改目标客户端。客户端迁移应后续在目标仓库中单独发起接入，并替换旧统计实现；其现有版本实现含客户端侧凭据，也应在迁移时轮换，不能复制到本仓库或回执中。

已登记的发布流：

| 平台    | 架构  | 渠道   | code                             |
| ------- | ----- | ------ | -------------------------------- |
| Windows | x64   | stable | `bifang-codex-skins-windows-x64` |
| macOS   | arm64 | stable | `bifang-codex-skins-macos-arm64` |

## 待确认的精确云端目标

复用上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 配置 / 用途                                                                                  |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 新建函数     | `telemetry-bifang-codex-skins`                         | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；仅接收本 APP_ID 的 `daily_active`        |
| 新建路由     | `/apps/bifang-codex-skins/v1/track`                    | 绑定上述函数；安全域名和路径透传开启；QPS 总计 100、单 IP 10                                 |
| 新建集合     | `telemetry_bifang_codex_skins`                         | ADMINONLY；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`；服务端保留 30 天 |
| 新建空集合   | `versions_bifang_codex_skins`                          | ADMINONLY；创建两条标准版本查询索引；不写发布记录                                            |
| 新建空集合   | `ads_bifang_codex_skins`                               | ADMINONLY；创建标准广告查询索引；不写广告记录                                                |
| 新建空集合   | `audit_bifang_codex_skins`                             | ADMINONLY；创建 `occurred_at` 降序索引；不写记录                                             |
| 更新函数     | `operations-dashboard-api`                             | 仅把应用映射从 6 个追加到 7 个；保留现有代码、认证值和两条看板路由                           |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新线上映射、代码或 11 份既有凭据；新应用的版本 API 保持未启用                            |
| 保留其他资源 | 其余 6 个应用全部资源、6 个静态托管对象                | 不修改、不迁移、不删除                                                                       |

精确非系统索引：

- `versions_bifang_codex_skins`：`idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；`idx_version_sort` = `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_codex_skins`：`idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_codex_skins`：`idx_audit_occurred_at` = `{occurred_at:-1}`。

部署完成后的预期总量为 9 个函数、10 条路由、28 个集合和 6 个静态托管对象。验收会使用一个随机 UUID v4 发送同一条合成 `daily_active` 两次，要求只新增 1 条记录；这条记录会暂时计入本工具日活并在 30 天后由 TTL 清理。

## 最新只读预检

查询时间：**北京时间 2026-09-28 16:51–16:52**，使用仓库固定的 CloudBase CLI 3.8.1。以下均来自本轮重新读取。

| 检查项             | 结果                                                                          |
| ------------------ | ----------------------------------------------------------------------------- |
| 环境与套餐         | `baas_trial` 体验版，NORMAL；到期 2027-03-17 23:59:59                         |
| 费用开关           | 自动续费 false；超限扣费 false；扩展包、有效订单及升级提示均为空              |
| 积分               | 周期 09-17 至 10-17；已用 5.7 / 3000；资源包及按量扣减均为 0                  |
| 函数 / 路由 / 集合 | 8 / 9 / 24；本工具计划新增的目标均不存在，没有命名冲突                        |
| 默认域名           | 唯一默认域名，SUCCESS / DNS OK                                                |
| 既有隔离集合       | 抽查最新一组 telemetry、versions、ads、audit 均为 ADMINONLY，索引符合现行规范 |
| 看板               | Active / Available；当前 6 个应用，环境变量约 2877 字节                       |
| 看板部署计划       | 7 个应用；环境变量估算 3240 字节，低于 4096 字节上限                          |
| 共享版本函数       | Active / Available；仍只启用最早 3 个应用和 11 份凭据，本轮保持不变           |
| 静态托管           | 6 个既有对象，全部保留                                                        |

积分不等于人民币金额，本回执不承诺未来费用。真正写入前仍会再次刷新套餐、费用开关、完整资源清单和材料哈希；如出现付费、升级、超限、命名冲突或材料漂移，将停止并重新展示差异。

## 执行顺序与验收

1. 收到明确“继续”后再次做只读预检，并核对目标仓库 HEAD 未变化。
2. 创建四个独立集合、ADMINONLY 权限和上面列出的精确索引；版本相关三个集合保持空。
3. 仅部署 `telemetry-bifang-codex-skins`，仅创建本应用 track 路由。
4. 使用定向 helper 原位更新 `operations-dashboard-api` 的 7 应用映射；保留 `/dashboard` 与 `/admin/v1/metrics`。
5. 读回函数、路由、ACL 与索引；发送同一合成事件两次，要求仅有一条记录。
6. 验证看板能显示新应用且原 6 个应用仍可读取。该步骤是云端合成验收，不代表真实桌面客户端已经完成 E2E。

最终重算的看板部署材料 SHA-256 为 `6717536f6d320141f82a07d7ee1a993d92cf9e980a206154fd0ffca054f72016`，共 32 个文件、28,908,099 字节。任何受绑定材料变化都必须重新生成计划，不会使用全量部署、强制覆盖、清理旧资源或购买资源。

回滚只恢复被更新的看板函数及原配置。新集合默认保留；任何删除都必须另列精确目标并再次获得授权。

## 本地修改与边界

本轮已在工作树中完成：

- `cloudbase/apps.json`：新增应用与两条 stable 发布流。
- `cloudbaserc.example.json`：由现行生成器生成目标函数、路由和共享映射。
- 三个契约测试：同步 7 应用、9 函数、10 路由及版本配置容量门禁。
- 本回执与机器预检 JSON。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`；工作树原有的历史项目改动已保留，本次未创建提交。

验证结果：生成配置及配置一致性检查通过；本次涉及的登记、目标部署计划、看板部署和版本凭据容量契约测试 **25/25 通过**；工作区 TypeScript 类型检查、构建和 examples 类型检查均通过。`npm.cmd run check` 已真实执行，但仍在整仓格式检查处停止：我新增的回执及本次涉及文件已单独通过格式检查，其余 **80 个既有文件**仍有格式问题。随后单独运行的 `npm.cmd test` 中，4 个 workspace 包共 **131/131 通过**；仓库级 Node 测试因当前机器没有 `py` 启动器而出现 **71 个退出码 9009 的环境失败**，其余 69 个通过，Python 客户端阶段未执行。未把这些环境失败表述为通过，也未修改测试或安装系统软件绕过门禁。

**未执行：CloudBase 写入或部署、版本发布、购买、Git 推送、云资源删除、凭据生成、目标客户端修改/构建/安装、真实 GUI E2E。**
