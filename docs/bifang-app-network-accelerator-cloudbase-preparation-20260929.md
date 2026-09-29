# bifang-app-network-accelerator CloudBase 接入准备回执（2026-09-29）

> 状态更新：负责人在审阅本文件后明确回复“继续”，本计划中的目标云端步骤已完成并通过验收。
> 本文件以下内容保留为写入前审查证据；最终事实见
> [CloudBase 部署回执](bifang-app-network-accelerator-cloudbase-deployment-20260929.md)。

## 当前状态

本次已在运营精灵仓库登记 `bifang-app-network-accelerator`。应用发布流为
Windows / x64 / stable，code 为
`bifang-app-network-accelerator-windows-x64`。

本地登记、资源隔离设计、目标专属部署计划、看板过滤计划和线上只读预检均已完成，
**尚未执行本应用的 CloudBase 写入或部署**。机器可读证据见
[预检与部署计划](bifang-app-network-accelerator-cloudbase-preflight-20260929.json)。

依据 `$bifang-public-services-onboarding` 的 CloudBase 写入门禁，本轮停在最终预检之后；负责人再次
明确回复“继续”前，不执行任何目标云端写入。

## 目标仓库核对

目标仓库为 `https://github.com/BFTools366/bifang-app-network-accelerator`，本机已有独立 checkout。
私有 GitHub 远端需要交互凭据，本任务没有重新授权，因此没有把本地缓存的远端引用冒充实时远端 HEAD。

| 字段              | 值                                                    |
| ----------------- | ----------------------------------------------------- |
| 当前分支          | `codex/full-rust-tauri-migration`                     |
| 当前提交          | `cd085f73a067f4eeff844161934cff5796217587`            |
| 缓存默认分支      | `master` / `3646bc8086f36b1ca7df0a7b617e56553983f1b2` |
| 版本              | `1.3.0`，权威来源为根 `Cargo.toml`                    |
| 技术栈            | Tauri 2 / Rust 2024 / React / TypeScript              |
| 目标平台          | Windows x64                                           |
| APP_ID            | `bifang-app-network-accelerator`                      |
| 发布流            | `bifang-app-network-accelerator-windows-x64`          |
| 客户端 Profile v2 | 尚不存在                                              |
| 客户端修改        | 未执行                                                |

只读扫描覆盖 330 个文件，无跳过文件；未发现运行时 APP_ID、`daily_active`、application-version API
或旧静态更新实现。目标仓库原有的三个删除状态均已保留，没有 reset、stash、clean、切分支或覆盖：

- `.cursor/plans/code_audit_plan.md`
- `.cursor/plans/first_run.md`
- `.vscode/settings.json`

目标项目已批准的产品规格当前仍明确禁用远程遥测和真实自动更新，Tauri updater 保持 `NotConfigured`，
endpoints 和 public key 均为空。因此本轮云端准备不会自动让客户端发请求；客户端 Profile、隐私同意、
`daily_active` 和 application-version v1 迁移需要在目标项目自己的任务中另行批准与实施。

## 待执行的精确云端目标

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 规则                                                                                  |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 新建集合     | `telemetry_bifang_app_network_accelerator`             | `ADMINONLY`；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`          |
| 新建函数     | `telemetry-bifang-app-network-accelerator`             | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active` |
| 新建路由     | `/apps/bifang-app-network-accelerator/v1/track`        | 绑定上述函数；安全域名和路径透传开启；QPS 总计 100、单 IP 10                          |
| 新建空集合   | `versions_bifang_app_network_accelerator`              | `ADMINONLY`；两个标准版本查询索引；不写版本记录                                       |
| 新建空集合   | `ads_bifang_app_network_accelerator`                   | `ADMINONLY`；标准广告查询索引；不写广告记录                                           |
| 新建空集合   | `audit_bifang_app_network_accelerator`                 | `ADMINONLY`；标准审计索引；不写记录                                                   |
| 原位更新看板 | `operations-dashboard-api`                             | 使用精确 12 应用过滤映射；不上传原始 secret                                           |
| 保留看板路由 | `/dashboard`、`/admin/v1/metrics`                      | 线上已存在；不重建、不删除、不改变现有 QPS                                            |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新共享函数或路由，不生成本应用凭据，不写版本或广告记录                            |

非系统索引：

- `versions_bifang_app_network_accelerator`：
  `idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；
  `idx_version_sort` =
  `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_app_network_accelerator`：
  `idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_app_network_accelerator`：
  `idx_audit_occurred_at` = `{occurred_at:-1}`。

完成后资源数量预期从 13 个函数、14 条路由、48 个集合变为 **14 / 15 / 52**；静态托管仍为
6 个对象。新增 versions / ads / audit 集合保持空。

## 并发登记与看板过滤

最新只读复核显示，`bifang-browser-multi-instance` 的函数、路由和四个集合已经就绪，线上看板也已从
原有 10 应用补入该应用，当前为 11 应用映射；本计划会再加入本应用，形成 12 应用映射。

`bifang-multi-instance-display` 的四个集合在最后刷新时已经出现，但目标函数和路由仍不存在，线上看板
也尚未包含它。为避免 fail-closed 看板引用未完成的应用，本计划暂不纳入该应用，也不创建或修改它的
任何云资源。真实写入前会再次刷新；若它届时已完成云端验收，则必须重算为包含它的最新映射和材料摘要
后再展示确认。

当前 12 应用编码映射为 1,826 UTF-8 字节，完整函数环境变量为 2,126 字节，分别低于仓库 3,840
字节安全线和平台 4,096 字节上限。定向看板材料 SHA-256 为
`44be8037b2a517fc20bc78124399b6ed9ced3415862732c0c44f38d9d0b9a0f6`；32 个文件、
28,916,421 字节；原始 secret 上传数为 0，删除列表为空。

## 最新云端只读预检

最终刷新时间：北京时间 **2026-09-29 09:46**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项       | 结果                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| 环境         | 仅有 `bftoos-sh-d3ga7hahz59229f0a`；`baas_trial` 体验版，NORMAL，上海      |
| 费用开关     | 自动续费 false；超限扣费 false；无活动订单；到期 2027-03-17 23:59:59       |
| 积分         | 已用 27.99 / 3000；资源包及按量扣减均为 0                                  |
| 默认域名     | 启用；SUCCESS；DNS 与平台 CNAME DNS 均为 OK；HTTP_AND_HTTPS                |
| 当前资源     | 13 个函数、14 条路由、48 个集合、6 个静态托管对象                          |
| 目标冲突     | 本应用函数、路由和四个集合均不存在                                         |
| 共享版本函数 | 本轮不触碰 `application-version-api` 和单层 v1 路由                        |
| 运营看板     | Active / Available；线上为 11 应用，已包含 `bifang-browser-multi-instance` |

积分不是人民币金额。真实写入前会立即再次刷新套餐、积分、费用开关、函数、路由、集合、ACL、索引、
看板映射和托管对象；如出现付费、升级、超限、自动续费、资源漂移、目标冲突或材料摘要变化，立即停止并
重新确认。本次只读预检没有读取业务记录正文。

## application-version 限制

本次参照近期历史项目做法，只预留独立 versions / ads / audit 集合，不扩大共享版本服务范围：不部署
`application-version-api`、不生成凭据、不写版本或广告记录。因此云端写入完成后，telemetry 与看板
可以完成服务端验收；目标客户端仍不会执行真实版本检查，真实版本服务和 GUI E2E 保持 `Unverified`。

后续若要启用，需要先在目标项目中完成 Profile v2、低权限运行凭据注入、严格七字段解析、安全外链和
完整退出，再单独审查共享函数映射、全部已登记发布流的凭据覆盖及十端点公网 E2E。

## 收到下一次“继续”后的执行与验收

1. 再次刷新套餐、费用开关、函数、路由、集合、ACL、索引、看板映射和托管清单；任何漂移立即停止。
2. 创建上述四个集合、`ADMINONLY` 权限和精确索引；versions / ads / audit 保持空。
3. 仅部署 `telemetry-bifang-app-network-accelerator`，仅创建本应用 track 路由。
4. 使用重新审阅的材料原位更新 `operations-dashboard-api` 为当时全部云端就绪应用的精确映射；保留两条
   既有看板路由。
5. 回读函数、路由、ACL、TTL、索引、集合计数和看板映射。
6. 使用随机匿名安装身份提交同一个合成 `daily_active` 事件两次，要求只新增一条幂等记录；该记录会
   暂时计入日活，并按 30 天 TTL 清理。
7. 验证看板能读取本应用和其他选定应用；这不等同于真实桌面客户端 E2E。

若任一步失败，停止后续写入并重新读取实际状态，不自动重试有副作用的步骤。看板可恢复为部署前映射
和上一版函数；四个新集合、函数和路由不会自动删除。任何删除都必须另列精确目标并再次取得授权。

本计划不包含第二个 CloudBase 环境、共享版本函数或路由更新、凭据生成、版本或广告记录、
`bifang-multi-instance-display` 云资源、托管写入、全量部署、强制清理、购买、套餐升级、自动续费、
超限扣费、目标客户端修改/构建/安装/发布或 Git 推送。

## 修改与验证

运营精灵仓库已登记本应用及 Windows x64 stable 发布流，并重新生成 CloudBase 示例配置；相关全局契约
测试已同步更新。目标客户端仓库只做了只读检查，没有改动。

已执行并通过：330 文件完整扫描、CloudBase 配置生成、目标专属 telemetry 计划、12 应用定向看板计划、
19 个受影响根契约测试、受影响文件格式检查和 `git diff --check`。

全仓 `npm run check` 已执行，但在仓库既有或无关的 81 个 Prettier/换行问题处停止，尚未进入后续全仓
typecheck、test、build 和 examples typecheck；没有把这些基线问题冒充为本次通过项，也没有批量改写无关文件。

运营精灵基线提交为 `8c855c0837d33d1f4fa48925bdc4202f4d1a0888`；目标项目当前提交为
`cd085f73a067f4eeff844161934cff5796217587`。本次未创建提交。

**未执行：本应用 CloudBase 部署或写入、共享版本 API 更新、凭据生成、版本或广告记录写入、目标客户端
修改/构建/安装/发布、购买、Git 推送或云资源删除。**
