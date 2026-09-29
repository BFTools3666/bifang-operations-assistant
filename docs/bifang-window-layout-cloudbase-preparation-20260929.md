# bifang-window-layout CloudBase 接入准备回执（2026-09-29）

## 当前状态

`bifang-window-layout` 已在运营精灵仓库完成本地登记、资源隔离设计、目标专属 telemetry 计划、
15 应用定向看板计划和线上只读预检。机器可读证据见
[预检与部署计划](bifang-window-layout-cloudbase-preflight-20260929.json)。

负责人第一次回复“继续”后，写入前刷新发现并发项目 `bifang-content-production-assistant` 已完成上线，
线上资源和看板范围相对已确认计划发生漂移。本任务随即停止，没有执行任何 CloudBase 创建、更新或
测试数据写入。依据 `$bifang-public-services-onboarding` 的阶段 4 门禁，负责人对重算计划再次明确回复
“继续”前，不执行线上写入。

## 目标仓库核对

目标仓库为 `https://github.com/BFTools366/bifang-window-layout`。通过 Git Bash 完成私有仓库授权后，
在独立目录 `D:/workspace/bifang-window-layout` 获取了干净 checkout；没有把目标仓库复制到运营精灵仓库。

| 字段              | 值                                          |
| ----------------- | ------------------------------------------- |
| 默认分支          | `master`                                    |
| 当前/远端提交     | `ada9be87c016b685956c4d9c02c2bf1ad77095d4`  |
| 技术栈            | Tauri 2 / Rust / React / TypeScript         |
| 发布版本          | `2.3.5`，来源为 `src-tauri/tauri.conf.json` |
| 目标平台          | Windows x64                                 |
| APP_ID            | `bifang-window-layout`                      |
| 发布流 code       | `bifang-window-layout-windows-x64`          |
| 客户端 Profile v2 | 尚不存在                                    |
| 客户端修改        | 未执行                                      |

只读扫描覆盖 230 个文本文件。NSIS 内置的
`nsis/tools/NSIS/Contrib/Modern UI/ioSpecial.ini` 被识别为二进制内容而跳过，因此
`scan_incomplete=true`，不能声称客户端迁移完成。

目标客户端已经调用单层 `/tools/version-control/v1` 形状，但当前 Base URL、code 和凭据配置仍属于原服务，
与本次登记身份不一致。代码还存在源内凭据、跳过 TLS 证书验证、记录完整更新响应，以及把硬件派生标识和
详细系统信息发送到另一遥测服务的实现。这些内容未在本轮修改，也不能当作毕方 `daily_active` 或真实
CloudBase 客户端 E2E。后续客户端迁移必须在目标项目自己的任务中单独授权并处理。

## 本地登记

已在 `cloudbase/apps.json` 追加：

```text
APP_ID:  bifang-window-layout
stream:  windows / x64 / stable
code:    bifang-window-layout-windows-x64
```

生成配置同步派生：

- telemetry 函数：`telemetry-bifang-window-layout`
- telemetry 路由：`/apps/bifang-window-layout/v1/track`
- telemetry 集合：`telemetry_bifang_window_layout`
- versions 集合：`versions_bifang_window_layout`
- ads 集合：`ads_bifang_window_layout`
- audit 集合：`audit_bifang_window_layout`

当前工作树原本已有 `bifang-multi-instance-display`、`bifang-app-network-accelerator` 和并发登记的
`bifang-content-production-assistant` 改动。本轮在其基础上追加，没有 reset、stash、clean、切分支或
覆盖这些改动。

## 最新线上只读预检

最新预检时间：北京时间 **2026-09-29 10:49**；使用仓库固定的 CloudBase CLI 3.8.1。

| 检查项       | 结果                                                                 |
| ------------ | -------------------------------------------------------------------- |
| 环境         | 仅有 `bftoos-sh-d3ga7hahz59229f0a`；上海；体验版；NORMAL             |
| 费用开关     | 自动续费 false；超限扣费 false；无活动订单；到期 2027-03-17 23:59:59 |
| 积分         | 已用 30.02 / 3000；资源包及按量扣减均为 0                            |
| 默认域名     | 启用；SUCCESS；DNS 和平台 CNAME DNS 均为 OK；HTTP_AND_HTTPS          |
| 当前资源     | 16 个函数、17 条路由、56 个集合、6 个静态托管对象                    |
| 运营看板     | Active / Available；当前精确包含 14 个已上线应用                     |
| 目标冲突     | 本应用函数、路由和四个集合均不存在                                   |
| 共享版本服务 | `application-version-api` 和单层 v1 路由存在；本轮不修改             |

积分是平台配额单位，不是人民币金额。真实写入前必须再次刷新全部状态；出现非零金额、升级、超限、自动续费、
资源漂移、目标冲突或材料摘要变化时立即停止。

`bifang-content-production-assistant` 在第一次确认后完成了函数、路由、四个集合和看板接入。本任务未
修改它的专属资源；重算后的看板范围是“现有 14 个线上应用 + `bifang-window-layout`”，会完整保留它。

## 等待确认的精确云端目标

复用现有环境和平台默认 HTTPS 域名，不创建第二环境。

| 动作         | 精确目标                                 | 约束                                                                                  |
| ------------ | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| 新建集合     | `telemetry_bifang_window_layout`         | `ADMINONLY`；`expires_at_ttl={expires_at:1}`；`expireAfterSeconds=0`                  |
| 新建函数     | `telemetry-bifang-window-layout`         | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active` |
| 新建路由     | `/apps/bifang-window-layout/v1/track`    | 绑定目标函数；安全域名与路径透传开启；总 QPS 100、单 IP 10                            |
| 新建空集合   | `versions_bifang_window_layout`          | `ADMINONLY`；`idx_version_created`、`idx_version_sort`；不写版本记录                  |
| 新建空集合   | `ads_bifang_window_layout`               | `ADMINONLY`；`idx_ads_created`；不写广告记录                                          |
| 新建空集合   | `audit_bifang_window_layout`             | `ADMINONLY`；`idx_audit_occurred_at`；不写审计记录                                    |
| 原位更新看板 | `operations-dashboard-api`               | 追加本应用；保留现有认证值、函数规格和两条既有路由                                    |
| 保留版本服务 | `application-version-api` 与单层 v1 路由 | 不更新函数/路由，不生成凭据，不写版本、广告或审计记录                                 |

计划的非系统索引：

- `versions_bifang_window_layout`
  - `idx_version_created = {doc_type:1, code:1, created_at:-1, _id:-1}`
  - `idx_version_sort = {doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`
- `ads_bifang_window_layout`
  - `idx_ads_created = {doc_type:1, app_code:1, created_at:-1, _id:-1}`
- `audit_bifang_window_layout`
  - `idx_audit_occurred_at = {occurred_at:-1}`

按当前线上状态完成后，预期为 **17 个函数、18 条路由、60 个集合、6 个托管对象、15 个看板应用**。
定向看板部署材料为 32 个文件、28,919,886 字节，SHA-256 为
`424a11270a6214120a19bba05b6aaa5e100006d6ba30c28ab332a9ede4dca2f1`；原始 Secret 上传数为 0，
删除列表为空。

## 回复“继续”后的执行与验收

1. 立即刷新套餐、费用、函数、路由、集合、ACL、索引、托管对象和看板映射；任何漂移先停止。
2. 创建上述四个 `ADMINONLY` 集合及精确索引；versions、ads、audit 保持空。
3. 仅部署 `telemetry-bifang-window-layout`，仅创建目标 track 路由。
4. 用重新计算且审核过的材料原位更新 `operations-dashboard-api`，保留两个既有看板路由。
5. 回读函数、路由、ACL、TTL、索引、集合计数和看板映射。
6. 用随机 UUID v4 提交同一合成 `daily_active` 两次，要求两次均为 202 且最终只保存一条幂等记录；
   该记录会暂时计入日活并按 30 天 TTL 清理。
7. 验证看板能读取本应用和其他选定应用；这不等同于真实桌面客户端 E2E。

任一步失败都停止后续写入并重新读取实际状态，不自动重试有副作用的步骤。回滚只能把看板恢复到部署前
映射和上一版函数；新建资源不会自动删除，任何删除都要另列精确目标并再次确认。

本计划不包含第二个 CloudBase 环境、共享版本 API 更新、凭据生成、版本/广告/审计记录、托管写入、
购买、套餐升级、自动续费、超限扣费、目标客户端修改/构建/安装/发布、Git 提交/推送或云资源删除。

## 验证结果

已执行并通过：

- `npm run cloudbase:config:check`
- `node --test tests/cloudbase-multi-app-config.test.mjs tests/repository-contract.test.mjs ...`：14/14
- 四个受影响文件的 Prettier 检查
- `git diff --check`
- 目标专属 telemetry 计划和重算后的 15 应用定向看板计划
- 线上环境、费用、域名、函数、路由、集合、托管和看板只读预检

全仓 `npm run check` 已执行，但在仓库既有的 80 个 Prettier/换行问题处停止，尚未进入后续全仓
typecheck、test、build 和 examples typecheck；没有批量改写无关文件，也没有把该基线失败冒充为通过。

运营精灵基线提交为 `832bf7cec8f9eac39beefd06e5ede945726dde3b`；目标项目提交为
`ada9be87c016b685956c4d9c02c2bf1ad77095d4`。本次未创建提交。

**未执行：CloudBase 创建/更新、共享版本服务变更、凭据生成、业务记录写入、目标客户端修改/构建/
安装/发布、购买、Git 推送或云资源删除。**
