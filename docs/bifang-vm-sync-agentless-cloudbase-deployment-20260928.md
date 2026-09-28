# bifang-vm-sync-agentless CloudBase 部署回执（2026-09-28）

## 当前状态

**已完成重新对齐并获授权的 VM 专属 CloudBase 资源部署和公网 HTTP E2E；业务客户端尚未修改或接入。**

负责人先确认原计划；发现并发 LAN 部署已提前创建 VM telemetry / versions 集合并把 VM 加入六应用看板后，本任务停止写入、刷新完整资源清单，并给出[重新对齐预检](bifang-vm-sync-agentless-cloudbase-reconciled-preflight-20260928.json)。负责人再次明确回复“继续”后，只执行剩余的两个空集合、VM telemetry 函数、VM 路由和一条匿名合成统计记录。

完整机器证据见[部署结果 JSON](bifang-vm-sync-agentless-cloudbase-deployment-20260928.json)。

## 应用与环境

| 项目            | 已确认值                                                        |
| --------------- | --------------------------------------------------------------- |
| APP_ID          | `bifang-vm-sync-agentless`                                      |
| 源仓库          | `https://github.com/BFTools366/bifang-vm-sync-agentless`        |
| 审阅分支 / 提交 | `master` / `41da893edc0c3ab037ae000481179c1e310fb94e`           |
| 当前源码版本    | `1.6.12`，以 `src/VmwareSync/App.cs` 的 `AppEntry.Version` 为准 |
| CloudBase 环境  | `bftoos-sh-d3ga7hahz59229f0a`，上海                             |
| 发布流          | Windows / x64 / stable / `bifang-vm-sync-agentless-windows-x64` |
| 更新服务        | 保持未启用；未生成凭据，未写版本记录                            |

## 已完成的云端目标

| 资源                                      | 结果                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `telemetry-bifang-vm-sync-agentless`      | Active / Available；Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；环境变量只绑定本 APP_ID、集合和路径 |
| `/apps/bifang-vm-sync-agentless/v1/track` | 唯一路由；绑定上述函数；安全域名和路径透传开启；QPS 总计 100、单 IP 10                                      |
| `telemetry_bifang_vm_sync_agentless`      | ADMINONLY；TTL `expires_at_ttl` = `{expires_at:1}`、`expireAfterSeconds:0`；当前 1 条合成记录               |
| `versions_bifang_vm_sync_agentless`       | ADMINONLY；`idx_version_created`、`idx_version_sort` 合同匹配；0 条记录                                     |
| `ads_bifang_vm_sync_agentless`            | ADMINONLY；`idx_ads_created` 合同匹配；0 条记录                                                             |
| `audit_bifang_vm_sync_agentless`          | ADMINONLY；`idx_audit_occurred_at` 合同匹配；0 条记录                                                       |

创建第一个剩余集合时，初次请求把 `AclTag` 放在顶层，被平台以 `UnknownParameter` 在参数校验阶段拒绝，目标仍不存在，没有发生云端写入。随后按腾讯云 [CreateTable](https://cloud.tencent.com/document/product/876/127968) 当前合同，把 `ADMINONLY` 放入 `PermissionInfo` 并同时绑定环境 ID；两个集合均创建成功，并逐项读回 ACL、索引和空记录状态。

最终环境清单为 **8 个函数、9 条 HTTP 服务路由、24 个集合、6 个静态托管对象**。看板和共享版本服务没有在本阶段更新。

## 公网 E2E

正式 track 路由验收结果：

| 检查                    | 实际结果                              |
| ----------------------- | ------------------------------------- |
| OPTIONS                 | 204                                   |
| 不支持的方法            | 405，`method_not_allowed`             |
| 跨应用 APP_ID           | 403，`unknown_app`；集合仍为 0 条     |
| 未知字段                | 400，`invalid_payload`；集合仍为 0 条 |
| 首次合法 `daily_active` | 202，`{"ok":true}`                    |
| 完全相同重试            | 202，`{"ok":true}`                    |
| 最终记录数              | 1，确认每日幂等                       |

合成记录使用随机 UUID v4、Windows x64、SDK 3.0.0 和版本标记 `1.6.12+cloudbase-e2e`。它暂时计入本工具今日活跃，并按 30 天 TTL 到期清理；未读取记录正文。这证明云端 HTTP、函数和数据库链路，不等同于真实 WPF 客户端 E2E。

## 看板、版本服务与费用

看板公网验证 13/13 通过：页面、JS、CSS、未登录状态、错误凭据、正确安全 Cookie 会话、指标、管理 API 认证和登出均符合合同。六个应用均能独立读取；VM 今日活跃为 1，唯一发布流状态为 `empty`。全应用今日活跃为 4，11 条发布流均可读。

共享 `application-version-api` 仍为 Active / Available，修改时间仍是 `2026-09-17 16:32:11`，只映射原三款应用并保留 11 份既有凭据；没有为本工具启用版本 API。六应用看板函数修改时间仍是 `2026-09-28 16:06:27`，说明本阶段未重部署或改写它。

部署后费用复核：环境仍为 `baas_trial` 体验版 / NORMAL，到期 `2027-03-17 23:59:59`；自动续费 false、超限扣费 false、扩展包和活动订单为空，资源包及按量扣减均为 0。当前周期用量为 **5.70 / 3000**；积分不是人民币金额。

## 本地交付与边界

正式统计地址：

```text
https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/apps/bifang-vm-sync-agentless/v1/track
```

[运营看板](https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/dashboard)继续沿用现有认证方式。

目标 GitHub 仓库没有修改、构建、安装或发布；真实客户端尚未实现每日门禁、匿名安装身份和 telemetry 发送。没有创建第二环境、购买、开启超限、生成凭据、写版本/广告记录、修改静态托管、删除资源、提交或推送 Git。

部署后再次执行 CloudBase 配置生成一致性检查并通过；与应用登记、目标定向部署、看板部署和仓库边界相关的定向测试 24/24 通过，本回执及关联 JSON 的 Prettier 检查通过。准备阶段已经通过完整 Node、Python、类型检查和构建验证；整仓格式检查仍受 80 个既有文件问题影响，未把它误报为通过。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`，工作区中既有用户和并发任务改动均保留。
