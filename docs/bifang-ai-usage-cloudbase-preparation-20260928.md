# 毕方AI用量看板 CloudBase 接入准备回执（2026-09-28）

> 后续状态：负责人已明确回复“继续”，本次范围已部署并完成公网 HTTP 验收。见[部署回执](bifang-ai-usage-cloudbase-deployment-20260928.md)。以下保留当时的准备与审批记录。

## 当前状态

**本地登记和部署准备已完成，等待负责人确认部署。云端和客户端均未修改。**

按负责人本次确认，APP_ID 为 `bifang-ai-usage-collector`，首批 Windows x64、macOS arm64，渠道均为 `stable`；启用每日活跃统计并加入运营看板。版本发布流及隔离存储先准备好，更新地址保持空，暂不启用版本检查、不生成新凭据、不写版本记录。

沿用已有应用的独立 telemetry 与空版本集合做法。空下载地址只存在于交接准备信息中，不能写成无效的线上版本记录。后续启用完整版本服务仍需解决共享函数配置容量门禁。

机器证据和分项计划见 [本次预检与部署计划](bifang-ai-usage-cloudbase-preflight-20260928.json)。本回执是一次性实施记录；`cloudbase/apps.json` 仍是应用登记的唯一权威。

## 仓库依据与负责人确认

| 项目                | 核对结果                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------- |
| GitHub 仓库         | `https://github.com/BFTools366/bifang-ai-usage-collector`                                 |
| 默认分支 / 当前提交 | `master` / `580a89fc711d87050306f8a77ef84803aa360ea7`；最终复核未变化，分析 checkout 干净 |
| 产品 / 当前源码版本 | 毕方AI用量看板 / `1.4.24`，以根 Cargo workspace version 为准                              |
| 技术栈              | Tauri 2、Rust、React                                                                      |
| Tauri identifier    | `com.manonloki.bifang-codex-usage`；不是毕方 APP_ID                                       |
| 源码已有接入        | 无毕方 Profile、APP_ID、daily_active 或毕方版本 API 配置                                  |
| APP_ID 来源         | 负责人明确提供，不能误记为 GitHub 源码已有信息                                            |
| 平台 / 渠道来源     | 负责人确认 Windows x64、macOS arm64 均接入 stable；Linux 架构和接入时机待确认             |
| 更新与安装包地址    | 按负责人要求暂留空；不推测、不创建占位版本记录                                            |

固定提交证据：[Cargo](https://github.com/BFTools366/bifang-ai-usage-collector/blob/580a89fc711d87050306f8a77ef84803aa360ea7/Cargo.toml)、[Tauri 配置](https://github.com/BFTools366/bifang-ai-usage-collector/blob/580a89fc711d87050306f8a77ef84803aa360ea7/bifang_ai_usage_dashboard_gui/tauri.conf.json)、[README](https://github.com/BFTools366/bifang-ai-usage-collector/blob/580a89fc711d87050306f8a77ef84803aa360ea7/README.md)。`.harness/release-context.json` 的 `1.4.18` 是历史上下文，未作为当前发布事实。

已使用现行登记命令写入两条发布流，并重新生成配置：

| 平台    | 架构  | 渠道   | code                                    |
| ------- | ----- | ------ | --------------------------------------- |
| Windows | x64   | stable | `bifang-ai-usage-collector-windows-x64` |
| macOS   | arm64 | stable | `bifang-ai-usage-collector-macos-arm64` |

旧三款应用的登记内容、独立函数配置及所有既有路由与本轮开始前逐项一致。共享函数的本地模板仅追加新应用映射；模板包含资源不代表全部都会部署，严禁使用全量部署命令。

## 最终云资源清单

复用环境 `bftoos-sh-d3ga7hahz59229f0a`（上海），默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 配置 / 用途                                                                           |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 新建函数     | `telemetry-bifang-ai-usage-collector`                  | Event / Nodejs20.19 / index.main / 3 秒 / 256 MB；仅接收本 APP_ID 的 daily_active     |
| 新建路由     | `/apps/bifang-ai-usage-collector/v1/track`             | 精确绑定上述函数；安全域名和路径透传开启；QPS 总计 100、单 IP 10                      |
| 新建集合     | `telemetry_bifang_ai_usage_collector`                  | ADMINONLY；`expires_at_ttl`，`expires_at:1`，`expireAfterSeconds:0`；服务端保留 30 天 |
| 新建空集合   | `versions_bifang_ai_usage_collector`                   | ADMINONLY；以下两个标准版本查询索引；不写发布记录                                     |
| 新建空集合   | `ads_bifang_ai_usage_collector`                        | ADMINONLY；标准广告查询索引；不写广告记录、不增加客户端广告界面                       |
| 新建空集合   | `audit_bifang_ai_usage_collector`                      | ADMINONLY；`occurred_at(desc)` 索引；不写记录                                         |
| 更新函数     | `operations-dashboard-api`                             | 追加本应用统计与两条发布流映射；保留既有登录及指标凭据；3 秒 / 256 MB                 |
| 保留路由     | `/dashboard`、`/admin/v1/metrics`                      | 不新建、不改写现有路由                                                                |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 本轮不更新函数、线上应用映射或 11 份既有凭据；新应用版本检查保持未启用                |
| 保留其他资源 | 原三款应用全部资源、6 个静态托管对象                   | 不删除、不迁移                                                                        |

精确非系统索引：

- `versions_bifang_ai_usage_collector`：`idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；`idx_version_sort` = `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_ai_usage_collector`：`idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_ai_usage_collector`：`idx_audit_occurred_at` = `{occurred_at:-1}`。

看板会读取每个应用的版本集合，因此在追加映射前先创建空版本集合；空流按现有逻辑显示未发布，不作为完整更新流程已验证的证据。计划完成后，环境预期为 6 个函数、7 条路由、16 个集合。

## 最新云端只读预检

查询时间：**北京时间 2026-09-28 11:45:09–11:47:01**，使用仓库固定 CloudBase CLI 3.8.1。以下均来自本轮重新读取，不是旧回执推断。

| 检查项              | 结果                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| 环境与套餐          | 现有 `baas_trial` 体验版，NORMAL；到期 2027-03-17 23:59:59                  |
| 费用开关            | 自动续费 false；超限扣费 false                                              |
| 积分                | 周期 09-17 至 10-17；已用 4.83 / 3000，剩余 2995.17；资源包及按量扣减均为 0 |
| 订单与升级提示      | 本环境返回的订单字段为空、扩展包为空、提示文本为空；结论限本次 API 返回范围 |
| 函数 / 路由 / 集合  | 5 / 6 / 12；本工具计划新增的目标均不存在，没有命名冲突                      |
| 既有集合            | 全部 ADMINONLY，索引符合现行配置；9 个版本/广告/审计集合记录数均为 0        |
| 既有 telemetry 记录 | 毕方小工具 1、鼠标精灵 1、录屏助手 5，均有 TTL 索引                         |
| 默认域名            | 唯一默认域名，SUCCESS / DNS OK                                              |
| 看板                | Active / Available；两份认证值与本地一致，除应用映射外配置一致              |
| 看板配置容量        | 当前环境变量 1351 字节，计划模板估计 1824 字节                              |
| 共享版本函数        | Active / Available；仍为原三款应用、11 份绑定，既有凭据配置与本地一致       |
| 静态托管            | 6 个既有对象，全部保留                                                      |

随后于北京时间 11:49 下载只读的线上看板代码用于核对和回滚准备：本地看板 13 个源码/配置/测试文件与线上逐字节一致，无额外源码文件；依赖目录未作逐字节比较。本次不修改看板源码。

只读取元数据、ACL、索引和记录数量；未读业务记录正文，未写测试数据。积分不等于人民币金额，本回执不承诺未来费用；执行前仍要刷新费用开关和资源状态，发现付费、升级、超限或目标变化时停止。

## 部署顺序与验收范围

1. 收到负责人明确“继续”后，刷新本环境费用、资源完整清单和部署材料校验值；如目标或材料变化，停止并重新展示差异。
2. 准备可恢复的看板代码与上一版配置。线上代码已只读下载，本轮前的生成配置已在仓库外保留；恢复时沿用已核对的现有凭据，不轮换。
3. 创建清单内四个集合、ADMINONLY 权限及精确索引；版本相关三个集合保持空。
4. 仅部署 `telemetry-bifang-ai-usage-collector`，仅创建本工具的 track 路由。
5. 使用既有定向看板部署 helper 更新 `operations-dashboard-api` 的新映射，保留 `/dashboard` 和 `/admin/v1/metrics`。
6. 读回配置、路由、ACL、TTL 与索引。云端验收计划包含一个随机匿名安装身份的合成 daily_active 事件及一次相同重试，要求仅新增一条本工具测试记录；该记录会暂时计入本工具日活，按 30 天 TTL 清理，不写其他应用数据。
7. 验证看板可读、新应用统计可见、原应用仍可读取。此验收不等同于真实桌面客户端 E2E。

JSON 中分别保留现行 telemetry 计划器输出、三个空集合的补充清单、看板计划与实际保留路由的预检结论。telemetry 计划器自身不负责版本集合或看板；补充目标在此单独明确，不隐式扩大它的执行范围。

看板部署材料 SHA-256：`d28a9026d0602c48de19f4076efa9a77b7307d53281a03f7bd5cffc068cba589`。任何受绑定材料变化都需重新生成计划；不会使用全量函数部署、强制覆盖、清理旧资源或购买资源。

回滚只恢复被更新的看板函数及原配置。新集合默认保留，删除必须另外列出精确目标并确认；本次确认不包含删除许可。

## 版本服务与客户端后续事项

更新地址留空，因此本轮仅登记发布流与预留存储。新增两条运行绑定及管理读写绑定的既有容量模拟为 4225 字节，超过 3840 字节安全门槛，也超过计划器记录的 4096 字节平台限额。该限制影响后续版本服务启用，不影响本轮独立 telemetry 与看板部署。未来需在同一环境解决配置容量，保留原应用与凭据，不降低门槛、不购买升级。

客户端尚未接入，需要在该工具自己的仓库中实施：

- README 当前明确不发送启动统计；应按新确认范围实现 `daily_active`，使用应用独立随机 UUID v4 和北京时间每日联网前落盘门禁。
- 不复用 `stable_device_id.rs` 的系统/硬件身份，不上传 AI 用量内容或账号资料。
- 当前 Tauri updater 的 endpoints/pubkey 为空，生产为 NotConfigured；毕方版本 API 不能直接填入官方 updater 即视为兼容。未来需单独实现 Rust 适配、发布凭据注入和验收。
- 当前安装包公开 HTTPS 地址、发布内容、后续凭据注入位置及 Linux 接入维度均待确认；没有猜测或填入示例值。

## 修改、验证与边界

本轮实际修改：

- `cloudbase/apps.json`：新增应用及两条 stable 发布流。
- `cloudbaserc.example.json`：由现行生成器生成新应用函数、路由及共享映射。
- `tests/cloudbase-multi-app-config.test.mjs`、`tests/repository-contract.test.mjs`：同步应用清单、函数和路由数量的现有契约断言。
- 本回执及配套 JSON：更新确认信息、实际预检、资源差异与计划。

验证结果：生成配置检查通过；相关契约、部署计划器、telemetry 和看板测试 **111/111 通过**。`npm.cmd run check` 已执行，仍因 **80 个既有文件格式问题**停止，后续阶段未由该命令执行，不能声称整仓通过。本轮开始前的用户改动已保留，不擅自批量格式化。

运营精灵基线提交 `30a6681eb69741f0328fa33b5b89138220636859`；本次未创建新提交。指定 GitHub 源码保持不变。

**未执行：CloudBase 部署或写入、版本发布、购买、Git 推送、云资源删除、凭据生成、客户端修改/构建/安装、真实 GUI E2E。** 按负责人最初要求和仓库阶段边界，最终清单展示后等待明确“继续”。
