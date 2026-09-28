# 毕方应用启动器 CloudBase 接入准备回执（2026-09-28）

## 当前状态

`bifang-app-launcher` 已在运营精灵仓库完成本地登记、资源隔离设计、目标专属部署计划和线上只读预检，**尚未执行 CloudBase 写入或部署**。GitHub 私有仓库授权已通过 Edge 完成。

> 负责人回复“继续”后的写前刷新发现 `bifang-codex-skins` 已由并发任务上线并加入运营看板，因此本页的原始 7 应用计划已停止执行。最新差异和保留该线上应用的 8 应用计划见[重新对齐预检](bifang-app-launcher-cloudbase-reconciled-preflight-20260928.json)。

> 后续状态：负责人再次确认“继续，并保留 `bifang-codex-skins`”后，重新对齐范围已部署并完成公网验收，见[最终部署回执](bifang-app-launcher-cloudbase-deployment-20260928.md)。

机器可读证据见[预检与部署计划](bifang-app-launcher-cloudbase-preflight-20260928.json)。`cloudbase/apps.json` 仍是应用登记的唯一权威。

## 目标仓库核对

| 项目            | 结果                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------- |
| 仓库            | `https://github.com/BFTools366/bifang-app-launcher`                                             |
| 默认分支 / 提交 | `master` / `f4fb6b043dfee81f0b1a1b208dbd39a5bfd16eb9`；只读分析 checkout 干净                   |
| 当前版本        | `1.1.4`，权威来源为根 `Cargo.toml` 的 `workspace.package.version`                               |
| 技术栈          | Tauri 2 / Rust / React / TypeScript；包含 GUI 与 CLI                                            |
| 目标平台        | Windows x64、macOS x64、macOS arm64                                                             |
| 构建目标        | `x86_64-pc-windows-msvc`、`x86_64-apple-darwin`、`aarch64-apple-darwin`                         |
| 既有毕方接入    | 未发现 APP_ID、`daily_active` 或毕方版本 API；扫描器命中的 `updates` 是界面文案，不是旧更新协议 |

扫描覆盖 216 个文件且完整。目标仓库未修改、未构建、未安装、未发布。

登记的发布流：

| 平台    | 架构  | 渠道   | code                              |
| ------- | ----- | ------ | --------------------------------- |
| Windows | x64   | stable | `bifang-app-launcher-windows-x64` |
| macOS   | x64   | stable | `bifang-app-launcher-macos-x64`   |
| macOS   | arm64 | stable | `bifang-app-launcher-macos-arm64` |

## 待部署的精确云资源

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 规则                                                                                         |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 新建函数     | `telemetry-bifang-app-launcher`                        | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active`        |
| 新建路由     | `/apps/bifang-app-launcher/v1/track`                   | 绑定上述函数；安全域名与路径透传开启；QPS 总计 100、单 IP 10                                 |
| 新建集合     | `telemetry_bifang_app_launcher`                        | ADMINONLY；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`；服务端保留 30 天 |
| 新建空集合   | `versions_bifang_app_launcher`                         | ADMINONLY；两个标准版本查询索引；不写版本记录                                                |
| 新建空集合   | `ads_bifang_app_launcher`                              | ADMINONLY；标准广告查询索引；不写广告记录                                                    |
| 新建空集合   | `audit_bifang_app_launcher`                            | ADMINONLY；标准审计索引；不写记录                                                            |
| 更新函数     | `operations-dashboard-api`                             | 原位更新为六个线上应用加本工具的七应用范围；保留认证值、路由和函数规格                       |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新函数、不扩充线上映射、不生成新凭据                                                     |
| 保留其他资源 | 现有应用资源、6 个静态托管对象                         | 不删除、不迁移、不全量部署                                                                   |

非系统索引：

- `versions_bifang_app_launcher`：`idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；`idx_version_sort` = `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_app_launcher`：`idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_app_launcher`：`idx_audit_occurred_at` = `{occurred_at:-1}`。

完成后资源数量预期从 8 个函数、9 条路由、24 个集合变为 **9 / 10 / 28**；静态托管仍为 6 个对象；新增 versions / ads / audit 集合保持空。

## 最新云端只读预检

查询时间：北京时间 **2026-09-28 17:09**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项         | 结果                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| 环境与套餐     | 现有 `baas_trial` 体验版，NORMAL，上海；到期 2027-03-17 23:59:59        |
| 费用开关       | 自动续费 false；超限扣费 false；扩展包为空，订单字段和提示文本为空      |
| 积分           | 周期 2026-09-17 至 2026-10-17；已用 5.70 / 3000；资源包及按量扣减均为 0 |
| 当前资源       | 8 个函数、9 条 HTTP 服务路由、24 个集合、6 个静态托管对象               |
| 目标冲突       | 本工具的函数、路由和四个集合均不存在                                    |
| 既有集合       | 24 个集合均为 ADMINONLY；四类集合的标准索引名符合当前合同               |
| 默认 HTTP 域名 | SUCCESS / DNS OK；当前 9 条路由全部启用                                 |
| 运营看板       | Active / Available，3 秒 / 256 MB；当前映射六个线上应用，不含本工具     |
| 共享版本函数   | Active / Available；仍为原三款应用和 11 份凭据，不含本工具              |

预检只读取环境、计费、函数、路由、集合元数据、ACL、索引及记录数量，没有读取业务记录正文，也没有写测试数据。积分不是人民币金额；实际部署前还会刷新本表，遇到付费、升级、超限或资源漂移立即停止。

## 并发隔离与版本服务边界

工作区中已有另一项用户改动 `bifang-codex-skins`，它已登记但云端没有对应函数、路由或集合。启动器的看板计划显式绑定以下七个应用，排除 `bifang-codex-skins`：

- `bifang-screen-recorder`
- `bifang-mouse-clicker`
- `bifang-tools`
- `bifang-ai-usage-collector`
- `bifang-vm-sync-agentless`
- `bifang-lan-file-transfer`
- `bifang-app-launcher`

定向看板材料 SHA-256 为 `54414ac27c60ef315ff8821a4cba117f573fd5b9c0c341898e3a137a86d51bb1`。材料或应用范围变化时必须重新计划并重新确认。

八个登记应用的完整版本凭据摘要已超过运行时解析器的 4096 字节限制，也无法满足 3840 字节的函数环境部署安全门槛。因此本轮不更新共享版本函数、不生成新凭据、不写版本或广告记录。

## 收到“继续”后的执行与验收

1. 刷新费用开关和完整资源清单；目标、材料或计费状态漂移时停止。
2. 创建上述四个集合、ADMINONLY 权限及精确索引；versions / ads / audit 保持空。
3. 仅部署 `telemetry-bifang-app-launcher`，仅创建本工具 track 路由。
4. 使用已绑定七应用范围的计划原位更新 `operations-dashboard-api`；保留 `/dashboard` 和 `/admin/v1/metrics`。
5. 回读函数、路由、ACL、TTL、索引和看板映射。
6. 使用随机匿名安装身份提交一个合成 `daily_active` 事件及相同重试，要求只新增一条本工具记录；该记录会暂时计入日活，并按 30 天 TTL 清理。
7. 验证看板能看到本工具，且原六个应用仍可读取；这不等同于真实桌面客户端 E2E。

回滚只恢复看板函数上一版代码与配置；新建集合默认保留。删除任何资源都需要另列精确目标并再次授权。本计划不包含购买、扩容、按量超限、版本服务更新、托管写入、全量部署、强制清理或删除。

## 修改与验证

本轮在现有用户改动上追加：

- 登记 `bifang-app-launcher` 及三个 stable 发布流，并重新生成 CloudBase 示例配置。
- 同步应用、函数、路由和发布流契约测试。
- 新增本回执和机器可读预检计划。

已通过：CloudBase 配置生成检查、目标专属 telemetry 计划、七应用定向看板计划、定向 Node 测试 20/20、workspace 测试 131/131、根 Node 测试 140/140、Python 客户端测试 42/42、类型检查、构建、示例类型检查，以及涉及文件的 Prettier 与 `git diff --check`。

`npm.cmd run check` 已执行；配置检查通过，但随后因 80 个本轮前已存在的格式问题停止。后续步骤已单独执行。主机没有名为 `python` 的命令，因此测试先以 9009 失败；改用桌面内置 Python，并把 PyYAML 6.0.2 安装到一次性临时目录后，以上三个测试组共 313 项全部通过，仓库与全局 Python 均未写入依赖。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`，本次未创建提交。

**未执行：CloudBase 部署或写入、共享看板更新、版本发布、购买、Git 推送、云资源删除、凭据生成、目标客户端修改/构建/安装。**
