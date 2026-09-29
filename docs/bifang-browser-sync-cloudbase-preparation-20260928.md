# 毕方浏览器多开同步器 CloudBase 接入准备回执（2026-09-28）

## 当前状态

`bifang-browser-sync` 已在运营精灵仓库完成 GitHub 私有仓库授权、完整扫描、本地登记、资源隔离设计、目标专属部署计划和线上只读预检，**尚未执行 CloudBase 写入或部署**。机器可读证据见[预检与部署计划](bifang-browser-sync-cloudbase-preflight-20260928.json)。

> 后续状态：负责人明确回复“继续”后，计划内资源已部署并完成公网遥测与看板验收，见[最终部署回执](bifang-browser-sync-cloudbase-deployment-20260928.md)。

`cloudbase/apps.json` 仍是登记状态的唯一权威。工作区中的并发登记 `bifang-multi-local-proxy` 已保留，但不在本次云部署和看板映射范围内。

## 目标仓库核对

| 项目            | 结果                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 仓库            | `https://github.com/BFTools366/bifang-browser-sync`；通过 Edge 完成 GitHub 授权                                        |
| 默认分支 / 提交 | `master` / `ae5f1eb0ac413ed8602f2af2a9a13ea9403f415c`                                                                  |
| 当前检出        | `feature-rust-tauri-full-migration-20260923`，提交与远端默认 HEAD 相同，但存在大量用户所有的 Electron → Tauri 迁移改动 |
| 当前版本        | `1.2.9`，权威来源为根 `Cargo.toml` 的 `workspace.package.version`                                                      |
| 技术栈          | Tauri 2 / Rust / React / TypeScript，GUI                                                                               |
| 目标平台        | Windows x64；根工作区元数据声明 `target-platforms = ["windows"]`                                                       |
| 既有毕方接入    | 未发现 APP_ID、`daily_active`、毕方版本 API 或旧静态更新协议                                                           |
| 官方更新器      | 已安装 Tauri 官方 updater，但 endpoints 为空、pubkey 为空，当前状态为 NotConfigured，不产生更新网络请求                |

扫描覆盖 304 个文件且完整。扫描器同时命中 updater 控制器中的 x64 / arm64 枚举，人工复核后以根工作区的 Windows-only 元数据为准。本次没有重置、暂存、切换或修改目标仓库，也没有执行版本号变更、构建、安装或发布。

登记的发布流：

| 平台    | 架构 | 渠道   | code                              |
| ------- | ---- | ------ | --------------------------------- |
| Windows | x64  | stable | `bifang-browser-sync-windows-x64` |

## 待部署的精确云资源

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 规则                                                                                         |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 新建函数     | `telemetry-bifang-browser-sync`                        | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active`        |
| 新建路由     | `/apps/bifang-browser-sync/v1/track`                   | 绑定上述函数；安全域名与路径透传开启；QPS 总计 100、单 IP 10                                 |
| 新建集合     | `telemetry_bifang_browser_sync`                        | ADMINONLY；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`；服务端保留 30 天 |
| 新建空集合   | `versions_bifang_browser_sync`                         | ADMINONLY；两个标准版本查询索引；不写版本记录                                                |
| 新建空集合   | `ads_bifang_browser_sync`                              | ADMINONLY；标准广告查询索引；不写广告记录                                                    |
| 新建空集合   | `audit_bifang_browser_sync`                            | ADMINONLY；标准审计索引；不写记录                                                            |
| 更新函数     | `operations-dashboard-api`                             | 保留现有 8 个线上应用并只追加本工具；显式排除 `bifang-multi-local-proxy`                     |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新函数、不扩充线上映射、不生成新凭据                                                     |
| 保留其他资源 | 现有应用资源、6 个静态托管对象                         | 不删除、不迁移、不全量部署                                                                   |

非系统索引：

- `versions_bifang_browser_sync`：`idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；`idx_version_sort` = `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_browser_sync`：`idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_browser_sync`：`idx_audit_occurred_at` = `{occurred_at:-1}`。

完成后资源数量预期从 10 个函数、11 条路由、32 个集合变为 **11 / 12 / 36**；静态托管仍为 6 个对象；新增 versions / ads / audit 集合保持空。

## 最新云端只读预检

查询时间：北京时间 **2026-09-28 18:30**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项         | 结果                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| 环境与套餐     | 现有 `baas_trial` 体验版，NORMAL，上海；到期 2027-03-17 23:59:59        |
| 费用开关       | 自动续费 false；超限扣费 false；扩展包为空，订单字段和提示文本为空      |
| 积分           | 周期 2026-09-17 至 2026-10-17；已用 9.55 / 3000；资源包及按量扣减均为 0 |
| 当前资源       | 10 个函数、11 条 HTTP 服务路由、32 个集合、6 个静态托管对象             |
| 目标冲突       | 本工具的函数、路由和四个集合均不存在                                    |
| 默认 HTTP 域名 | SUCCESS / DNS OK；当前 11 条路由全部启用                                |
| 运营看板       | Active / Available；当前映射 8 个线上应用，不含本工具                   |
| 共享版本函数   | 自 2026-09-17 起未修改，仍保留原三款应用和 11 份凭据；本轮不触碰        |

预检只读取环境、计费、函数、路由、集合元数据和托管对象清单，没有读取业务记录正文，也没有写测试数据。现有 32 个集合的 ACL 与索引由紧邻的应用启动器部署回执完成验证；任何实际写入前仍会完整刷新一次，遇到付费、升级、超限、ACL/索引冲突或资源漂移立即停止。积分不是人民币金额。

## 并发隔离、看板容量与版本服务边界

当前本地登记包含并发项目 `bifang-multi-local-proxy`，但它在线上没有函数、路由或集合。本次看板计划精确绑定现有 8 个线上应用加 `bifang-browser-sync`，排除该并发项目。定向看板材料 SHA-256 为 `371967eb81aa7c245fe095caa1e5366df0f305d98f8ee6025632308fdc8a02ad`；九应用环境变量预计 1783 UTF-8 字节，低于 4096 字节平台上限。材料、应用范围或线上清单变化时必须重新计划并重新确认。

共享 application-version 函数继续保持原样。本轮会创建本工具的三个空版本相关集合，以保持资源隔离和未来接入能力，但不部署共享版本函数、不生成凭据、不写版本或广告记录。

## 客户端边界

目标仓库的迁移中产品规范当前明确禁止远程 telemetry，而公共 `daily_active` 协议要求应用专属随机 UUID `install_id`。加上目标工作树含大量尚未提交的用户迁移，本轮没有在客户端侧做任何修改。云端部署完成后只能证明服务端已就绪，真实客户端不会自动上报；后续必须先在目标仓库明确更新产品隐私决策，再按其 Skill 流程实现、提权版本号并完成 Windows GUI E2E。

## 收到“继续”后的执行与验收

1. 刷新费用开关和完整资源清单，并回读全部相关 ACL 与索引；目标、材料或计费状态漂移时停止。
2. 创建上述四个集合、ADMINONLY 权限及精确索引；versions / ads / audit 保持空。
3. 仅部署 `telemetry-bifang-browser-sync`，仅创建本工具 track 路由。
4. 使用已绑定九应用范围的计划原位更新 `operations-dashboard-api`；保留 `/dashboard` 和 `/admin/v1/metrics`，不加入 `bifang-multi-local-proxy`。
5. 回读函数、路由、ACL、TTL、索引和看板映射。
6. 使用随机匿名安装身份提交一个合成 `daily_active` 事件及相同重试，要求只新增一条本工具记录；该记录会暂时计入日活，并按 30 天 TTL 清理。
7. 验证看板能看到本工具，且原 8 个应用仍可读取；这不等同于真实桌面客户端 E2E。

回滚只恢复看板函数上一版代码与配置；新建集合默认保留。删除任何资源都需要另列精确目标并再次授权。本计划不包含购买、扩容、按量超限、版本服务更新、托管写入、全量部署、强制清理或删除。

## 修改与验证

本轮在现有用户和并发改动上追加：

- 登记 `bifang-browser-sync` 及 Windows x64 stable 发布流，并重新生成 CloudBase 示例配置。
- 同步应用、函数、路由和发布流契约测试。
- 新增本回执和机器可读预检计划。

已通过：CloudBase 配置生成检查、目标专属 telemetry 计划、九应用定向看板计划、定向 Node 测试 20/20、类型检查、构建、示例类型检查、涉及文件的 Prettier 与 `git diff --check`。

`npm.cmd run check` 已执行，但在仓库原有的 80 个格式问题处停止；本次涉及文件不在该清单中。随后启动的无关全量测试按负责人要求停止，停止前没有失败；本回执只采用上述针对本次改动的定向 20 项结果作为验收依据。

运营精灵基线提交为 `a08a77fcef2c5709d1980a9d6acdedb2c47a0734`，当前本地 `main` 比 `origin/main` 超前 1 个提交；本次未创建提交。

**未执行：CloudBase 部署或写入、共享看板更新、版本发布、购买、Git 推送、云资源删除、凭据生成、目标客户端修改/构建/安装。**
