# bifang-content-production-assistant CloudBase 部署回执（2026-09-29）

负责人在审阅[准备回执](bifang-content-production-assistant-cloudbase-preparation-20260929.md)和
[部署前计划](bifang-content-production-assistant-cloudbase-preflight-20260929.json)后明确回复“继续”。本次目标
云端接入已完成并通过公网验收；机器可读结果见
[部署结果 JSON](bifang-content-production-assistant-cloudbase-deployment-20260929.json)。

## 结果

- 在既有 CloudBase 环境 `bftoos-sh-d3ga7hahz59229f0a` 部署了专属 telemetry 函数和路由。
- 创建了四个 `ADMINONLY` 隔离集合及审核过的索引；versions、ads、audit 保持为空。
- 运营看板在保留原有 13 个线上应用的基础上追加本应用，最终映射 14 个应用、23 条发布流。
- 使用随机 UUID v4 提交同一个合成 `daily_active` 两次，两次均返回 202，最终只保存 1 条记录。
- 未修改目标客户端；真实客户端 telemetry 与 application-version v1 仍需在目标项目中另行授权与实施。

## 已部署资源

| 类型           | 结果                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 函数           | `telemetry-bifang-content-production-assistant`；Node.js 20.19；`index.main`；3 秒；256 MB；Active / Available                          |
| 路由           | `/apps/bifang-content-production-assistant/v1/track` → 目标函数；安全域名和路径透传开启；认证关闭；总 QPS 100、单 IP 10                 |
| telemetry 集合 | `telemetry_bifang_content_production_assistant`；`ADMINONLY`；`expires_at_ttl` = `{expires_at:1}`、`expireAfterSeconds:0`；1 条合成记录 |
| versions 集合  | `versions_bifang_content_production_assistant`；`ADMINONLY`；`idx_version_created`、`idx_version_sort`；0 条                            |
| ads 集合       | `ads_bifang_content_production_assistant`；`ADMINONLY`；`idx_ads_created`；0 条                                                         |
| audit 集合     | `audit_bifang_content_production_assistant`；`ADMINONLY`；`idx_audit_occurred_at`；0 条                                                 |
| 看板           | `operations-dashboard-api` 原地更新；14 个应用；`/admin/v1/metrics` 与 `/dashboard` 均保留                                              |

四个集合在 `CreateTable` 后直接读回为 `ADMINONLY`，因此没有执行权限修正，也没有修改任何既有集合。
TTL 和全部标准索引均通过 `listIndexes` 精确回读。

## 公网验收

合成事件使用版本 `0.2.17+cloudbase-e2e`、Windows x64、SDK 3.0.0 和随机匿名安装身份：

| 检查                      | 结果               |
| ------------------------- | ------------------ |
| OPTIONS                   | 204                |
| 不支持的方法              | 405                |
| 跨应用 APP_ID             | 403                |
| 未知字段                  | 400                |
| 第一次有效 `daily_active` | 202，`{"ok":true}` |
| 完全相同的重试            | 202，`{"ok":true}` |
| 最终目标记录数            | 1，幂等通过        |

看板公网验证通过全部 13 项检查，包括静态页面、登录会话、未授权拒绝、14 应用聚合、管理令牌校验和
退出。聚合回读显示本应用当天活跃为 1；两个发布流均已出现，版本状态为 `empty`，符合本轮不写版本记录的
边界。

## 免费额度与最终清单

- 套餐：`baas_trial` / 体验版，状态 `NORMAL`，到期时间 2027-03-17 23:59:59。
- 自动续费：关闭；超限按量：关闭；扩展资源包为空；活动订单和升级提示均为空。
- 当前计费周期资源点用量：30.02 / 3000；资源包扣费 0；按量扣费 0。
- 最终清单：16 个函数、17 条 HTTP 服务路由、56 个集合、6 个静态托管对象、14 个看板应用。
- `application-version-api` 最后修改时间仍为 2026-09-17 16:32:11，本次没有修改共享函数或路由。

## 验证结果

- CloudBase 配置检查通过。
- telemetry 函数测试 32 / 32、看板测试 6 / 6、相关根契约测试 14 / 14 通过。
- workspace TypeScript 类型检查通过。
- 全仓 `npm run check` 在部署前因 80 个既有或无关的 Prettier/换行问题停止；没有批量改写无关文件。
- 目标源码只读扫描因一个超大许可证清单被跳过而保持 `scan_incomplete=true`；没有把已扫描范围内的零命中
  冒充为完整客户端迁移证明。

## 客户端边界

目标仓库当前提交为 `7e4d4c95c5b4c176a168eb29d814814699bc4367`，版本 `0.2.17`。它仍没有 Profile v2、
`daily_active` 或 application-version v1 客户端实现，更新器仍为 `NotConfigured`。本次结果是云端资源就绪，
不是桌面客户端真实 E2E；后续必须从目标项目自己的任务中单独发起客户端阶段。

## 明确未执行

- 未创建第二个 CloudBase 环境，未购买套餐、域名、证书或资源包，未开启自动续费或超限。
- 未创建或部署 `bifang-window-layout` 的云资源，未把它加入线上看板。
- 未生成 application-version 凭据，未写入版本、广告或审计记录。
- 未执行 hosting 写入、删除、下线、prune 或旧资源清理。
- 未修改、构建、安装、发布或推送目标客户端。
- 未创建 Git 提交，未推送运营精灵仓库。
