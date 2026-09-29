# bifang-multi-local-proxy CloudBase 部署回执（2026-09-29）

## 当前状态

**已完成 `bifang-multi-local-proxy` 的 CloudBase 专属资源部署、公网 HTTP 幂等验收和 10 应用运营看板接入；`bifang-browser-sync` 已完整保留，目标客户端尚未修改。**

第一次“继续”后的写入期间，`bifang-browser-sync` 由并发任务上线并加入看板。为避免覆盖其映射，本任务在看板写入前暂停；负责人随后明确批准“继续，并保留 bifang-browser-sync”，本轮才按[重新对齐预检](bifang-multi-local-proxy-cloudbase-reconciled-preflight-20260928.json)完成剩余步骤。完整机器证据见[部署结果 JSON](bifang-multi-local-proxy-cloudbase-deployment-20260929.json)。

## 应用与环境

| 项目           | 已确认值                                                        |
| -------------- | --------------------------------------------------------------- |
| APP_ID         | `bifang-multi-local-proxy`                                      |
| 源仓库         | `https://github.com/BFTools366/bifang-multi-local-proxy`        |
| 源码状态       | 仓库可访问但没有 HEAD、分支或任何 ref；无法核对版本和框架       |
| CloudBase 环境 | `bftoos-sh-d3ga7hahz59229f0a`，上海                             |
| 发布流         | Windows x64 stable，code `bifang-multi-local-proxy-windows-x64` |
| 更新服务       | 保持未启用；未生成凭据，未写版本或广告记录                      |

## 已完成的云端目标

| 资源                                      | 结果                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `telemetry-bifang-multi-local-proxy`      | Active / Available；Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只绑定本 APP_ID    |
| `/apps/bifang-multi-local-proxy/v1/track` | 安全域名与路径透传开启；QPS 总计 100、单 IP 10                                             |
| `telemetry_bifang_multi_local_proxy`      | `ADMINONLY`；TTL `expires_at_ttl` = `{expires_at:1}`、`expireAfterSeconds:0`；1 条合成记录 |
| `versions_bifang_multi_local_proxy`       | `ADMINONLY`；`idx_version_created`、`idx_version_sort`；0 条记录                           |
| `ads_bifang_multi_local_proxy`            | `ADMINONLY`；`idx_ads_created`；0 条记录                                                   |
| `audit_bifang_multi_local_proxy`          | `ADMINONLY`；`idx_audit_occurred_at`；0 条记录                                             |
| `operations-dashboard-api`                | 原位更新为 compact schema v2 的 10 应用映射；认证保持不变                                  |
| `/dashboard`                              | 保留既有路由，更新时间仍为 2026-09-22 13:29:13                                             |
| `application-version-api`                 | 未修改；修改时间仍为 2026-09-17 16:32:11                                                   |

四个集合按 CloudBase [`CreateTable`](https://cloud.tencent.com/document/product/876/127968) 的 `PermissionInfo` 合同创建为 `ADMINONLY`，随后逐项读回 ACL、索引和记录数量。最终环境为 **12 个函数、13 条 HTTP 服务路由、40 个集合、6 个静态托管对象**。

## 公网 telemetry E2E

| 检查                    | 实际结果           |
| ----------------------- | ------------------ |
| OPTIONS                 | 204                |
| 不支持的方法            | 405                |
| 跨应用 APP_ID           | 403                |
| 未知字段                | 400                |
| 首次合法 `daily_active` | 202，`{"ok":true}` |
| 完全相同重试            | 202，`{"ok":true}` |
| 最终记录数              | 1，没有重复记录    |

合成记录使用随机 UUID v4、Windows x64、SDK 3.0.0 和版本标记 `0.0.0+cloudbase-e2e`。它计入 2026-09-28 的活跃，并按 30 天 TTL 到期清理。这证明云端 HTTP、函数和数据库链路，不等同于真实客户端 E2E。

## 看板、版本服务与费用

看板公网验证 13/13 通过：页面、JS、CSS、未登录状态、错误凭据、正确安全 Cookie 会话、指标、管理 API 认证和登出均符合合同。10 个应用均保留，其中包含 `bifang-browser-sync` 和 `bifang-multi-local-proxy`。

本工具的看板查询为 live 模式；2026-09-29 今日活跃为 0，7 日周期活跃为 1，非零趋势是 2026-09-28 的 1 条合成记录。Windows x64 发布流状态为 `empty`，符合未写版本记录的范围。

看板映射使用 compact schema v2，完整函数环境变量为 1890 字节，低于仓库 3840 字节安全门槛和平台 4096 字节上限。部署没有上传原始 secret，也没有创建、修改或删除路由。

部署后费用复核：环境仍为 `baas_trial` 体验版 / NORMAL，到期 `2027-03-17 23:59:59`；自动续费 false、超限扣费 false、扩展包和活动订单为空，资源包及按量扣减均为 0。当前周期用量为 **27.11 / 3000**；积分不是人民币金额。

## 本地交付与边界

正式统计地址：

```text
https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/apps/bifang-multi-local-proxy/v1/track
```

[运营看板](https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/dashboard)继续沿用现有认证方式。

部署后专项验证通过：受影响根测试 24/24、运营看板测试 26/26、CloudBase 配置检查、`git diff --check`，以及公网看板 13/13。按负责人要求未运行完整测试。

目标 GitHub 仓库没有修改、构建、安装或发布；仓库目前为空，因此真实客户端尚未实现每日门禁、匿名安装身份和 telemetry 发送。没有创建第二环境、购买、开启超限、生成凭据、写版本/广告记录、修改静态托管、删除资源、提交或推送 Git。

运营精灵基线提交为 `a08a77fcef2c5709d1980a9d6acdedb2c47a0734`，工作区中既有用户和并发任务改动均保留。
