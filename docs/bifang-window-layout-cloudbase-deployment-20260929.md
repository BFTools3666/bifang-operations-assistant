# bifang-window-layout CloudBase 部署回执（2026-09-29）

负责人在审阅[准备回执](bifang-window-layout-cloudbase-preparation-20260929.md)和
[重算后的部署前计划](bifang-window-layout-cloudbase-preflight-20260929.json)后第二次明确回复“继续”。目标云端
接入已完成并通过公网验收；机器可读结果见
[部署结果 JSON](bifang-window-layout-cloudbase-deployment-20260929.json)。

## 结果

- 在既有 CloudBase 环境 `bftoos-sh-d3ga7hahz59229f0a` 部署了专属 telemetry 函数和路由。
- 创建了四个 `ADMINONLY` 隔离集合及审核过的索引；versions、ads、audit 保持为空。
- 运营看板完整保留原有 14 个线上应用并追加本应用，最终映射 15 个应用。
- 合成 `daily_active` 最终仅保存 1 条；首次有效请求及受控幂等重试均返回 202。
- 未修改目标客户端；真实客户端 telemetry 与 application-version v1 仍需在目标项目中另行迁移和验收。

## 已部署资源

| 类型           | 结果                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 函数           | `telemetry-bifang-window-layout`；Node.js 20.19；`index.main`；3 秒；256 MB；Active / Available                        |
| 路由           | `/apps/bifang-window-layout/v1/track` → 目标函数；安全域名和路径透传开启；认证关闭；总 QPS 100、单 IP 10               |
| telemetry 集合 | `telemetry_bifang_window_layout`；`ADMINONLY`；`expires_at_ttl={expires_at:1}`、`expireAfterSeconds=0`；1 条合成记录   |
| versions 集合  | `versions_bifang_window_layout`；`ADMINONLY`；`idx_version_created`、`idx_version_sort`；0 条                          |
| ads 集合       | `ads_bifang_window_layout`；`ADMINONLY`；`idx_ads_created`；0 条                                                       |
| audit 集合     | `audit_bifang_window_layout`；`ADMINONLY`；`idx_audit_occurred_at`；0 条                                               |
| 看板           | `operations-dashboard-api` 原位更新；15 个应用；`/admin/v1/metrics` 与 `/dashboard` 均保留；材料摘要与重算计划完全一致 |

四个集合创建后均直接读回为 `ADMINONLY`，因此没有执行 `ModifyDatabaseACL`，也没有修改任何既有集合。

## 公网验收

合成事件使用版本 `2.3.5+cloudbase-e2e`、Windows x64、SDK 3.0.0 和随机 UUID v4 匿名安装身份：

| 检查                          | 结果                                         |
| ----------------------------- | -------------------------------------------- |
| OPTIONS                       | 204                                          |
| 不支持的方法                  | 405                                          |
| 跨应用 APP_ID                 | 403                                          |
| 未知字段                      | 400                                          |
| 负例后的目标记录数            | 0                                            |
| 第一次有效 `daily_active`     | 202，`{"ok":true}`                           |
| 第一次完全相同的即时重试      | 504，`FUNCTIONS_TIME_LIMIT_EXCEEDED`         |
| 504 后回读                    | 函数仍为 Active / Available；记录仍恰好 1 条 |
| 回读后的受控相同重试          | 202，`{"ok":true}`                           |
| 最终目标记录数                | 1，幂等通过                                  |
| versions / ads / audit 记录数 | 0 / 0 / 0                                    |

504 后没有盲目连续重试，而是先回读实际记录数和函数状态；确认未产生重复记录后才执行一次受控重试。这条合成记录
会暂时计入本工具日活，并按 30 天 TTL 到期清理。

看板第一次只读聚合因数据库冷启动返回一次 504；没有发生写入。随后原样重试通过全部 13 项公网检查，包括
静态页面、登录会话、未授权拒绝、15 应用聚合、管理令牌校验和退出。

## 并发状态处理

第一次“继续”后的写前刷新发现 `bifang-content-production-assistant` 已由并发任务完成函数、路由、四个集合
和看板接入。本任务在任何写入前停止，重新计算并展示 15 应用看板材料；收到第二次“继续”后才执行。本次
没有修改该应用的专属资源，并在看板中完整保留其映射。

## 免费额度与最终清单

- 套餐：`baas_trial` / 体验版，状态 `NORMAL`，到期时间 2027-03-17 23:59:59。
- 自动续费：关闭；超限按量：关闭；活动订单：无；升级提示：无。
- 当前计费周期资源点用量：30.02 / 3000；资源包扣费 0；按量扣费 0。
- 最终清单：17 个函数、18 条 HTTP 服务路由、60 个集合、6 个静态托管对象、15 个看板应用。
- `application-version-api` 最后修改时间仍为 2026-09-17 16:32:11，本次没有修改共享函数或路由。

## 验证

实际通过：

- `npm run cloudbase:config:check`
- 相关根契约测试 14/14
- telemetry 函数测试 32/32
- 运营看板函数测试 26/26
- 工作区 TypeScript typecheck
- 函数、路由、ACL、TTL、全部业务索引、记录数、最终资源清单和费用回读
- telemetry 公网负例、幂等写入和运营看板 13 项公网验证

全仓 `npm run check` 在部署前已经执行，但停在仓库既有的 80 个 Prettier/换行问题处；本次另行执行并
通过了受影响文件检查和上述定向验证，没有批量改写无关文件。

运营精灵基线提交为 `832bf7cec8f9eac39beefd06e5ede945726dde3b`；目标项目提交为
`ada9be87c016b685956c4d9c02c2bf1ad77095d4`。目标项目工作树保持干净，本次未创建提交。

## 明确未执行

- 未创建第二个 CloudBase 环境，未购买套餐、域名、证书或资源包，未开启自动续费或超限。
- 未生成 application-version 凭据，未写入版本、广告或审计记录。
- 未执行 hosting 写入、删除、下线、prune 或旧资源清理。
- 未修改、构建、安装、发布或推送 `bifang-window-layout` 客户端。
- 未创建 Git 提交，未推送运营精灵仓库。
