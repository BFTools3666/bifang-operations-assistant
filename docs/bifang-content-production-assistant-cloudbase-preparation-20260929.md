# bifang-content-production-assistant CloudBase 接入准备回执（2026-09-29）

> 状态更新：负责人审阅本文件后明确回复“继续”，本计划中的目标云端步骤已完成并通过验收。
> 本文件以下内容保留为写入前审查证据；最终事实见
> [CloudBase 部署回执](bifang-content-production-assistant-cloudbase-deployment-20260929.md)。

## 当前状态

已在运营精灵仓库登记 `bifang-content-production-assistant`，发布流为：

- Windows / x64 / stable：`bifang-content-production-assistant-windows-x64`
- macOS / arm64 / stable：`bifang-content-production-assistant-macos-arm64`

本地登记、资源隔离设计、定向部署计划、看板计划和线上只读预检已完成，**尚未执行本应用的
CloudBase 写入或部署**。机器可读证据见
[预检与部署计划](bifang-content-production-assistant-cloudbase-preflight-20260929.json)。

依据 `$bifang-public-services-onboarding` 的 CloudBase 写入门禁，本轮停在最终预检之后；负责人明确回复
“继续”前，不执行目标云端写入。

## 目标仓库核对

目标仓库为 `https://github.com/BFTools366/bifang-content-production-assistant`。远端默认分支 `master` 和
提交 `7e4d4c95c5b4c176a168eb29d814814699bc4367` 已在线核对；目标仓库仅做了临时只读检出，没有改动。

| 字段              | 值                                              |
| ----------------- | ----------------------------------------------- |
| 产品名            | 毕方内容生产助手                                |
| 版本              | `0.2.17`                                        |
| 技术栈            | Tauri 2 / Rust / React / TypeScript             |
| 目标平台          | Windows x64、macOS arm64                        |
| APP_ID            | `bifang-content-production-assistant`           |
| 客户端 Profile v2 | 尚不存在                                        |
| 当前更新器        | `NotConfigured`；endpoints 与 public key 均为空 |
| 客户端修改        | 未执行                                          |

只读扫描覆盖 472 个文件；`legal/THIRD_PARTY_LICENSES.txt` 因超过扫描器大小限制被跳过，因此扫描状态必须标记为
不完整。已扫描范围内未发现运行时 APP_ID、`daily_active`、application-version API 或旧静态更新实现；这不
等同于“完整扫描已证明旧实现清零”。

本轮只准备云端资源，不会自动让目标客户端发请求。客户端 Profile、隐私同意、`daily_active`、
application-version v1 和真实 GUI E2E 仍需在目标项目自己的任务中另行授权与实施。

## 待执行的精确云端目标

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 规则                                                                                  |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 新建集合     | `telemetry_bifang_content_production_assistant`        | `ADMINONLY`；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`          |
| 新建函数     | `telemetry-bifang-content-production-assistant`        | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active` |
| 新建路由     | `/apps/bifang-content-production-assistant/v1/track`   | 绑定上述函数；安全域名和路径透传开启；QPS 总计 100、单 IP 10                          |
| 新建空集合   | `versions_bifang_content_production_assistant`         | `ADMINONLY`；两个标准版本查询索引；不写版本记录                                       |
| 新建空集合   | `ads_bifang_content_production_assistant`              | `ADMINONLY`；标准广告查询索引；不写广告记录                                           |
| 新建空集合   | `audit_bifang_content_production_assistant`            | `ADMINONLY`；标准审计索引；不写记录                                                   |
| 原位更新看板 | `operations-dashboard-api`                             | 从线上 13 应用扩为精确 14 应用过滤映射；不上传原始 secret                             |
| 保留看板路由 | `/dashboard`、`/admin/v1/metrics`                      | 线上已存在；不删除、不改变现有 QPS                                                    |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新共享函数或路由，不生成凭据，不写版本或广告记录                                  |

非系统索引：

- `versions_bifang_content_production_assistant`：
  `idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；
  `idx_version_sort` = `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_content_production_assistant`：
  `idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_content_production_assistant`：
  `idx_audit_occurred_at` = `{occurred_at:-1}`。

完成后资源数量预期从 15 个函数、16 条路由、52 个集合变为 **16 / 17 / 56**；静态托管仍为 6 个对象。
新增 versions / ads / audit 集合保持空。

## 并发登记隔离

共享工作树在本次操作期间另有 `bifang-window-layout` 登记。它当前只存在于本地登记，不在线上 13 应用看板
范围内。本次定向计划明确排除它：不会创建它的函数、路由、集合，也不会把它加入看板。

本次看板范围固定为线上现有 13 个应用加 `bifang-content-production-assistant`，共 14 个应用。最新材料
SHA-256 为 `7dd18d229a380f248b9f0fdeea79b9f3b4c74bc29da168f75412e0eebcb9b8eb`；32 个文件、
28,919,886 字节；原始 secret 上传数为 0，删除列表为空。若写入前范围或摘要改变，必须停止并重新确认。

## 最新云端只读预检

最终函数/路由刷新时间：北京时间 **2026-09-29 10:33**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项       | 结果                                                                  |
| ------------ | --------------------------------------------------------------------- |
| 环境         | 仅有 `bftoos-sh-d3ga7hahz59229f0a`；`baas_trial` 体验版，NORMAL，上海 |
| 费用开关     | 自动续费 false；超限扣费 false；无活动订单；到期 2027-03-17 23:59:59  |
| 积分         | 已用 30.02 / 3000；资源包及按量扣减均为 0                             |
| 当前资源     | 15 个函数、16 条路由、52 个集合、6 个静态托管对象、看板 13 个应用     |
| 目标冲突     | 本应用函数、路由和四个集合均不存在                                    |
| 共享版本函数 | 本轮不触碰 `application-version-api` 和单层 v1 路由                   |
| 运营看板     | 当前线上验证 13 / 13 通过；本应用尚未加入                             |

积分不是人民币金额。真实写入前会立即再次刷新套餐、积分、费用开关、函数、路由、集合、ACL、索引、看板映射和
托管对象；如出现付费、升级、超限、自动续费、资源漂移、目标冲突或材料摘要变化，立即停止并重新确认。本次只读
预检没有读取业务记录正文。

## 收到“继续”后的执行与验收

1. 再次刷新费用与全部目标资源；任何漂移立即停止。
2. 创建上述四个集合、`ADMINONLY` 权限和精确索引；versions / ads / audit 保持空。
3. 仅部署 `telemetry-bifang-content-production-assistant`，仅创建本应用 track 路由。
4. 使用已审阅材料原位更新 `operations-dashboard-api` 为精确 14 应用映射；保留两条既有看板路由。
5. 回读函数、路由、ACL、TTL、索引、集合计数和看板映射。
6. 使用随机匿名安装身份提交同一个合成 `daily_active` 事件两次，要求只新增一条幂等记录；该记录会暂时
   计入日活，并按 30 天 TTL 清理。
7. 验证看板能读取本应用和其他选定应用；这不等同于真实桌面客户端 E2E。

若任一步失败，停止后续写入并重新读取实际状态，不自动重试有副作用的步骤。看板可恢复为部署前映射和
上一版函数；四个新集合、函数和路由不会自动删除。任何删除都必须另列精确目标并再次取得授权。

本计划不包含第二个 CloudBase 环境、共享版本函数或路由更新、凭据生成、版本或广告记录、
`bifang-window-layout` 云资源、托管写入、全量部署、强制清理、购买、套餐升级、自动续费、超限扣费、目标
客户端修改/构建/安装/发布或 Git 推送。

## 修改与验证

运营精灵仓库已登记本应用及两个发布流，并重新生成 CloudBase 示例配置；相关契约测试已同步。目标客户端
仓库未改动。

已执行并通过：CloudBase 配置检查、目标专属 telemetry 计划、14 应用定向看板计划、线上看板 13 / 13
验证、两个相关根契约测试文件中的 14 个测试、受影响文件格式检查和 `git diff --check`。

全仓 `npm run check` 已执行，但在仓库既有或无关的 80 个 Prettier/换行问题处停止，尚未进入后续全仓
typecheck、test、build 和 examples typecheck；没有批量改写无关文件。

运营精灵基线提交为 `832bf7cec8f9eac39beefd06e5ede945726dde3b`；目标项目提交为
`7e4d4c95c5b4c176a168eb29d814814699bc4367`。本次未创建提交。

**未执行：本应用 CloudBase 部署或写入、共享版本 API 更新、凭据生成、版本或广告记录写入、目标客户端
修改/构建/安装/发布、购买、Git 推送或云资源删除。**
