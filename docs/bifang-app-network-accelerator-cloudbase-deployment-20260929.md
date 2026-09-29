# bifang-app-network-accelerator CloudBase 部署回执（2026-09-29）

负责人在审阅[准备回执](bifang-app-network-accelerator-cloudbase-preparation-20260929.md)和
[部署前计划](bifang-app-network-accelerator-cloudbase-preflight-20260929.json)后明确回复“继续”。本次目标云端接入已完成并通过公网验收；机器可读结果见
[部署结果 JSON](bifang-app-network-accelerator-cloudbase-deployment-20260929.json)。

## 结果

- 在既有 CloudBase 环境 `bftoos-sh-d3ga7hahz59229f0a` 部署了专属 telemetry 函数和路由。
- 创建了四个 `ADMINONLY` 隔离集合及审核过的索引；versions、ads、audit 保持为空。
- 运营看板在保留原有 12 个线上应用的基础上追加本应用，最终映射 13 个应用。
- 使用随机 UUID v4 提交同一个合成 `daily_active` 两次，两次均返回 202，最终只保存 1 条记录。
- 未修改目标客户端；真实客户端 telemetry 与 application-version v1 仍需在目标项目中另行获得产品/隐私授权后实施。

## 已部署资源

| 类型           | 结果                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 函数           | `telemetry-bifang-app-network-accelerator`；Node.js 20.19；`index.main`；3 秒；256 MB；Active / Available                          |
| 路由           | `/apps/bifang-app-network-accelerator/v1/track` → 目标函数；安全域名和路径透传开启；认证关闭；总 QPS 100、单 IP 10                 |
| telemetry 集合 | `telemetry_bifang_app_network_accelerator`；`ADMINONLY`；`expires_at_ttl` = `{expires_at:1}`、`expireAfterSeconds:0`；1 条合成记录 |
| versions 集合  | `versions_bifang_app_network_accelerator`；`ADMINONLY`；`idx_version_created`、`idx_version_sort`；0 条                            |
| ads 集合       | `ads_bifang_app_network_accelerator`；`ADMINONLY`；`idx_ads_created`；0 条                                                         |
| audit 集合     | `audit_bifang_app_network_accelerator`；`ADMINONLY`；`idx_audit_occurred_at`；0 条                                                 |
| 看板           | `operations-dashboard-api` 原地更新；13 个应用；`/admin/v1/metrics` 与 `/dashboard` 均保留                                         |

四个集合在 `CreateTable` 后直接读回为 `ADMINONLY`，因此没有执行权限修正，也没有修改任何既有集合。

## 公网验收

合成事件使用版本 `1.3.0+cloudbase-e2e`、Windows x64、SDK 3.0.0 和随机匿名安装身份：

| 检查                      | 结果               |
| ------------------------- | ------------------ |
| OPTIONS                   | 204                |
| 不支持的方法              | 405                |
| 跨应用 APP_ID             | 403                |
| 未知字段                  | 400                |
| 负例后的目标记录数        | 0                  |
| 第一次有效 `daily_active` | 202，`{"ok":true}` |
| 完全相同的重试            | 202，`{"ok":true}` |
| 最终目标记录数            | 1，幂等通过        |

看板首次只读聚合因数据库冷启动返回一次 504；没有发生写入。随后原样重试通过全部 13 项公网检查，包括静态页面、登录会话、未授权拒绝、13 应用聚合、管理令牌校验和退出。

## 并发状态处理

写前刷新时，另一个已登记应用 `bifang-multi-instance-display` 已完成函数、路由、集合和看板接入。本次没有修改它的专属资源，只在看板更新时保留其既有映射。第一次看板部署尝试在本地快照阶段发现生成配置仍缺少两个并发新增应用并安全停止，尚未调用云端更新；配置生成完成后重新计算材料摘要，再以 `f831d97b15517dbd0e1bc9051e477848a0485ce430f9f36c5b1d0391c0d2fb90` 完成一次云端更新。

## 免费额度与最终清单

- 套餐：`baas_trial` / 体验版，状态 `NORMAL`，到期时间 2027-03-17 23:59:59。
- 自动续费：关闭；超限按量：关闭；活动订单：无。
- 当前计费周期资源点用量：27.99 / 3000；资源包扣费 0；按量扣费 0。
- 最终清单：15 个函数、16 条 HTTP 服务路由、52 个集合、6 个静态托管对象、13 个看板应用。
- `application-version-api` 最后修改时间仍为 2026-09-17 16:32:11，本次没有修改共享函数或路由。

## 明确未执行

- 未创建第二个 CloudBase 环境，未购买套餐、域名、证书或资源包，未开启自动续费或超限。
- 未生成 application-version 凭据，未写入版本、广告或审计记录。
- 未执行 hosting 写入、删除、下线、prune 或旧资源清理。
- 未修改、构建、安装、发布或推送 `bifang-app-network-accelerator` 客户端。
- 未创建 Git 提交，未推送运营精灵仓库。
