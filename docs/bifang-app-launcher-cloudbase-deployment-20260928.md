# 毕方应用启动器 CloudBase 部署回执（2026-09-28）

## 当前状态

**已完成重新对齐并获授权的 `bifang-app-launcher` CloudBase 资源部署、公网 HTTP 验收和八应用运营看板接入；目标客户端尚未修改。**

第一次“继续”后的写前刷新发现 `bifang-codex-skins` 已由并发任务上线，原七应用看板计划因此停止。负责人确认“继续，并保留 `bifang-codex-skins`”后，本轮按[重新对齐预检](bifang-app-launcher-cloudbase-reconciled-preflight-20260928.json)执行。完整机器证据见[部署结果 JSON](bifang-app-launcher-cloudbase-deployment-20260928.json)。

## 应用与环境

| 项目            | 已确认值                                                       |
| --------------- | -------------------------------------------------------------- |
| APP_ID          | `bifang-app-launcher`                                          |
| 源仓库          | `https://github.com/BFTools366/bifang-app-launcher`            |
| 审阅分支 / 提交 | `master` / `f4fb6b043dfee81f0b1a1b208dbd39a5bfd16eb9`          |
| 当前源码版本    | `1.1.4`，以根 `Cargo.toml` 的 `workspace.package.version` 为准 |
| CloudBase 环境  | `bftoos-sh-d3ga7hahz59229f0a`，上海                            |
| 发布流          | Windows x64、macOS x64、macOS arm64，均为 stable               |
| 更新服务        | 保持未启用；未生成凭据，未写版本或广告记录                     |

## 已完成的云端目标

| 资源                                 | 结果                                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `telemetry-bifang-app-launcher`      | Active / Available；Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只绑定本 APP_ID  |
| `/apps/bifang-app-launcher/v1/track` | 唯一路由；安全域名与路径透传开启；QPS 总计 100、单 IP 10                                 |
| `telemetry_bifang_app_launcher`      | ADMINONLY；TTL `expires_at_ttl` = `{expires_at:1}`、`expireAfterSeconds:0`；1 条合成记录 |
| `versions_bifang_app_launcher`       | ADMINONLY；`idx_version_created`、`idx_version_sort` 合同匹配；0 条记录                  |
| `ads_bifang_app_launcher`            | ADMINONLY；`idx_ads_created` 合同匹配；0 条记录                                          |
| `audit_bifang_app_launcher`          | ADMINONLY；`idx_audit_occurred_at` 合同匹配；0 条记录                                    |
| `operations-dashboard-api`           | 仅原位更新环境映射；保留代码、认证、规格与路由；现含八个应用                             |
| `application-version-api`            | 未修改；仍为原三款应用和 11 份凭据                                                       |

集合按腾讯云 [`CreateTable`](https://cloud.tencent.com/document/product/876/127968) 当前合同以 `PermissionInfo` 内的 `ADMINONLY` 创建，随后逐项读回 ACL、索引和记录数量。最终环境为 **10 个函数、11 条 HTTP 服务路由、32 个集合、6 个静态托管对象**。

## 公网 E2E

正式 track 路由验收结果：

| 检查                    | 实际结果                                                 |
| ----------------------- | -------------------------------------------------------- |
| OPTIONS                 | 204                                                      |
| 不支持的方法            | 405                                                      |
| 跨应用 APP_ID           | 403；集合仍为 0 条                                       |
| 未知字段                | 400；集合仍为 0 条                                       |
| 首次合法 `daily_active` | 504，`FUNCTIONS_TIME_LIMIT_EXCEEDED`，发生在数据库冷启动 |
| 完全相同重试            | 202，`{"ok":true}`                                       |
| 最终记录数              | 1；没有重复记录                                          |

合成记录使用随机 UUID v4、Windows x64、SDK 3.0.0 和版本标记 `1.1.4+cloudbase-e2e`。它暂时计入本工具今日活跃，并按 30 天 TTL 到期清理。首次数据库请求触发了一次 3 秒冷启动超时，重试成功且最终只有一条记录；该现象已如实保留在回执中，没有通过增加记录或修改函数规格掩盖。

这证明云端 HTTP、函数和数据库链路，不等同于真实 Tauri 客户端 E2E。

## 看板、版本服务与费用

看板公网验证 13/13 通过：页面、JS、CSS、未登录状态、错误凭据、正确安全 Cookie 会话、指标、管理 API 认证和登出均符合合同。八个应用均保留，包含 `bifang-codex-skins`；启动器今日活跃为 1，三条发布流状态均为 `empty`。看板环境配置为 3874 字节，低于平台 4096 字节限制。

共享 `application-version-api` 修改时间仍是 `2026-09-17 16:32:11`，只映射原三款应用并保留 11 份既有凭据；启动器没有启用版本 API。

部署后费用复核：环境仍为 `baas_trial` 体验版 / NORMAL，到期 `2027-03-17 23:59:59`；自动续费 false、超限扣费 false、扩展包和活动订单为空，资源包及按量扣减均为 0。当前周期用量为 **8.22 / 3000**；积分不是人民币金额。

## 本地交付与边界

正式统计地址：

```text
https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/apps/bifang-app-launcher/v1/track
```

[运营看板](https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/dashboard)继续沿用现有认证方式。

目标 GitHub 仓库没有修改、构建、安装或发布；真实客户端尚未实现每日门禁、匿名安装身份和 telemetry 发送。没有创建第二环境、购买、开启超限、生成凭据、写版本/广告记录、修改静态托管、删除资源、提交或推送 Git。

部署前已通过完整本地验证：workspace 131/131、根 Node 140/140、Python 42/42、类型检查、构建和示例检查。部署后再次执行 CloudBase 配置检查与应用登记定向测试 20/20；整仓格式检查仍受 80 个既有文件问题影响，未把它误报为通过。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`，工作区中既有用户和并发任务改动均保留。
