# bifang-multi-instance-display CloudBase 部署回执（2026-09-29）

## 结果

负责人审阅
[部署前计划](bifang-multi-instance-display-cloudbase-preflight-20260929.json)
并明确回复“继续”后，`bifang-multi-instance-display` 已完成阶段 4 的精确 CloudBase 写入和公网
HTTP 验收。机器可读事实见
[部署回执 JSON](bifang-multi-instance-display-cloudbase-deployment-20260929.json)。

复用环境 `bftoos-sh-d3ga7hahz59229f0a`，没有创建第二环境、购买套餐或开启超限。部署后环境仍为
`baas_trial` 体验版、NORMAL；自动续费 false、超限扣费 false、扩展包为空、无活动订单，
资源包和按量扣减均为 0。最新用量为 27.99 / 3000 积分。

## 已部署资源

| 类型     | 精确目标                                               | 最终状态                                      |
| -------- | ------------------------------------------------------ | --------------------------------------------- |
| 函数     | `telemetry-bifang-multi-instance-display`              | Active / Available，Nodejs20.19，3 秒，256 MB |
| 路由     | `/apps/bifang-multi-instance-display/v1/track`         | 已启用，绑定目标函数，无网关认证，路径透传    |
| 遥测集合 | `telemetry_bifang_multi_instance_display`              | `ADMINONLY`，1 条合成 E2E 记录                |
| 版本集合 | `versions_bifang_multi_instance_display`               | `ADMINONLY`，0 条记录                         |
| 广告集合 | `ads_bifang_multi_instance_display`                    | `ADMINONLY`，0 条记录                         |
| 审计集合 | `audit_bifang_multi_instance_display`                  | `ADMINONLY`，0 条记录                         |
| 看板函数 | `operations-dashboard-api`                             | Active / Available，精确 12 应用映射          |
| 看板路由 | `/dashboard`、`/admin/v1/metrics`                      | 保留既有路由                                  |
| 版本服务 | `application-version-api`、`/tools/version-control/v1` | 完全保留，未修改                              |

四个集合创建后平台初始 ACL 为 PRIVATE；本次只对这四个新集合执行了精确
`ModifyDatabaseACL`，并逐一回读为 `ADMINONLY`，没有修改任何既有集合。

索引回读结果：

- telemetry：`expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`；
- versions：`idx_version_created`、`idx_version_sort`，键序和升降序与审阅计划一致；
- ads：`idx_ads_created`；
- audit：`idx_audit_occurred_at`。

部署后总量为 14 个函数、15 条 HTTP 路由、48 个集合、6 个静态托管对象、12 个看板应用。

## Telemetry 公网 E2E

使用随机 UUID v4 匿名安装身份和版本 `1.2.0+cloudbase-e2e` 执行：

| 检查                       | 结果 |
| -------------------------- | ---- |
| OPTIONS                    | 204  |
| 不支持的方法               | 405  |
| 跨 APP_ID                  | 403  |
| 未知字段                   | 400  |
| 第一次有效 `daily_active`  | 202  |
| 完全相同请求再次发送       | 202  |
| 两次有效请求后的最终记录数 | 1    |

负例没有写入记录；相同有效请求保持幂等。合成记录会暂时计入今日活跃，并由 30 天 TTL 清理。

## 看板验收

看板部署使用审阅摘要
`acd128e11c89d1236afbc9543feeab68a5a1a81445220a61c09f8437f6c8f5bf`，原始 secret
上传数为 0。部署时保留线上 11 个已就绪应用，只追加本应用；仍只有本地登记的
`bifang-app-network-accelerator` 被明确排除。

公共看板验证器 13/13 通过，包括页面、JS、CSS、未认证拒绝、错误凭据拒绝、安全登录 Cookie、
认证会话、管理接口鉴权和退出。目标应用的管理接口回读为：HTTP 200、今日活跃 1；
`bifang-multi-instance-display-windows-x64` 发布流状态为 `empty`，最高版本为 null。

## application-version 边界

按审阅范围，没有修改共享 `application-version-api` 或其路由；函数修改时间仍为
2026-09-17 16:32:11。没有生成凭据，也没有创建版本、广告或审计记录。

客户端源码已经迁移到 application-version API v1，但当前缺少绑定本 code 的低权限运行凭据，因此
版本检查会安静跳过。真实版本服务和客户端 GUI E2E 仍为 `Unverified`，不能把本次 telemetry/
看板验收表述成版本更新功能已上线。

## 客户端与本地验证

目标项目完成了匿名 `daily_active`、单次 v1 版本检查、安全外链、完整退出、Profile v2 和隐私说明。
38 个单元测试与 `compileall` 通过；54 个文件完整扫描无跳过，旧静态更新门禁 clear。

运营精灵仓库通过配置生成检查、14 个受影响根契约测试、四个工作区共 131 个测试、类型检查、构建和
示例类型检查。全仓 `npm.cmd run check` 仍在仓库既有 80 个 Prettier/换行问题处停止，本次没有对
未触及文件做全库重排。

运营精灵基线提交为 `8c855c0837d33d1f4fa48925bdc4202f4d1a0888`；目标项目基线提交为
`25891c9d0615a579311e18fa143bdc7772b5125d`。本次未创建提交。

**未执行：共享版本 API 更新、凭据生成、版本/广告记录、`bifang-app-network-accelerator` 云资源、
托管写入、付费/续费/超限、客户端构建/安装/发布、Git 提交/推送、删除或清理。**
