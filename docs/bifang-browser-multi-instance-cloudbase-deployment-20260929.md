# bifang-browser-multi-instance CloudBase 部署回执（2026-09-29）

## 当前状态

**已完成 `bifang-browser-multi-instance` 的独立 CloudBase 专属资源部署、公网 HTTP 幂等验收和 11 应用运营看板接入；目标客户端尚未修改。**

看板部署前，并发任务在共享工作区登记了 `bifang-multi-instance-display` 和
`bifang-app-network-accelerator`，使首次审阅的材料摘要失效。摘要门禁在启动任何看板云端子进程前
拒绝了旧计划。只读复查确认两者尚无对应云资源，负责人最终明确“部署自己即可”；本轮因此完整保留
这两个本地登记，但没有部署它们，也没有把它们加入看板。完整机器证据见
[部署结果 JSON](bifang-browser-multi-instance-cloudbase-deployment-20260929.json)。

## 应用与环境

| 项目           | 已确认值                                                             |
| -------------- | -------------------------------------------------------------------- |
| APP_ID         | `bifang-browser-multi-instance`                                      |
| 源仓库         | `https://github.com/BFTools366/bifang-browser-multi-instance`        |
| 源码状态       | 当前会话无法访问私有仓库内容，未核对默认分支、提交、版本和技术栈     |
| CloudBase 环境 | `bftoos-sh-d3ga7hahz59229f0a`，上海                                  |
| 发布流         | Windows x64 stable，code `bifang-browser-multi-instance-windows-x64` |
| 更新服务       | 保持未启用；未生成凭据，未写版本或广告记录                           |

## 已完成的云端目标

| 资源                                           | 结果                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `telemetry-bifang-browser-multi-instance`      | Active / Available；Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只绑定本 APP_ID    |
| `/apps/bifang-browser-multi-instance/v1/track` | 安全域名与路径透传开启；QPS 总计 100、单 IP 10                                             |
| `telemetry_bifang_browser_multi_instance`      | `ADMINONLY`；TTL `expires_at_ttl` = `{expires_at:1}`、`expireAfterSeconds:0`；1 条合成记录 |
| `versions_bifang_browser_multi_instance`       | `ADMINONLY`；`idx_version_created`、`idx_version_sort`；0 条记录                           |
| `ads_bifang_browser_multi_instance`            | `ADMINONLY`；`idx_ads_created`；0 条记录                                                   |
| `audit_bifang_browser_multi_instance`          | `ADMINONLY`；`idx_audit_occurred_at`；0 条记录                                             |
| `operations-dashboard-api`                     | 原位更新为 compact schema v2 的 11 应用映射；认证和既有路由保持不变                        |
| `/dashboard`、`/admin/v1/metrics`              | 保留既有路由；没有重建、删除或改变 QPS                                                     |
| `application-version-api`                      | 未修改；修改时间仍为 2026-09-17 16:32:11                                                   |

四个集合均逐项读回 ACL、索引和记录数量。最终环境为 **13 个函数、14 条 HTTP 服务路由、44 个集合、6 个静态托管对象**。

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

合成记录使用随机 UUID v4、Windows x64、SDK 3.0.0 和版本标记 `0.0.0+cloudbase-e2e`。它计入
2026-09-29 的活跃，并按 30 天 TTL 到期清理。这证明云端 HTTP、函数和数据库链路，不等同于真实客户端 E2E。

## 看板、版本服务与费用

看板公网验证 **13/13** 通过：页面与静态资源、会话状态、认证、指标、管理 API 和登出均符合合同。
11 个已上线应用全部可读；本应用查询为 live 模式，今日活跃 1、昨日活跃 0、周期活跃 1，唯一非零
趋势为 2026-09-29 的 1 条合成记录。Windows x64 发布流 code 为
`bifang-browser-multi-instance-windows-x64`，状态为 `empty`、最高版本为 null，符合未写版本记录的范围。

最终看板映射使用 compact schema v2：映射 1707 字节，完整函数环境变量 2007 字节，低于仓库
3840 字节安全门槛和平台 4096 字节上限。实际部署材料 SHA-256 为
`c2916c22532969eaae711652b1464420a666d0fe22a149c90008b63cca098271`，32 个文件、28,916,421 字节；
没有上传原始 secret，没有路由写入或删除。

部署后费用复核：环境仍为 `baas_trial` 体验版 / NORMAL，到期 `2027-03-17 23:59:59`；自动续费
false、超限扣费 false、扩展包和活动订单为空，资源包及按量扣减均为 0。当前周期用量为
**27.99 / 3000**；积分不是人民币金额。

## 本地交付与边界

正式统计地址：

```text
https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/apps/bifang-browser-multi-instance/v1/track
```

[运营看板](https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/dashboard)继续沿用现有认证方式。

部署后专项验证通过：受影响根测试 19/19、运营看板测试 26/26、CloudBase 配置检查、类型检查和
`git diff --check`，以及公网看板 13/13。完整 `npm.cmd test` 的工作区测试通过；根测试中的 Python
驱动项因当前 Windows 环境没有 `py` 启动器而返回 9009。全仓检查在仓库既有 80 个格式问题处停止。

由于当前会话无法读取目标 GitHub 私有仓库，本轮没有修改、构建、安装或发布客户端，真实客户端
`daily_active` 和更新检查仍未验收。没有创建第二环境、购买、开启超限、生成凭据、写版本/广告
记录、修改静态托管或删除资源。本回执记录的 CloudBase 部署阶段没有提交或推送 Git；版本入库由
部署完成后的单独授权步骤执行。

运营精灵基线提交为 `8c855c0837d33d1f4fa48925bdc4202f4d1a0888`。工作区中既有用户文件和
两个并发应用登记均保留；后两者不属于本轮云端部署。
