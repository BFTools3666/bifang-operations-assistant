# 运营看板 CloudBase 后端部署回执（2026-09-21）

## 结论

2026-09-21（北京时间），经负责人明确回复“继续”，在既有 CloudBase 免费体验环境 `bftoos-sh-d3ga7hahz59229f0a` 中首次创建运营看板聚合函数和固定管理路由。公网鉴权、查询校验与响应脱敏验收通过。

本次只创建 `operations-dashboard-api` 与 `/admin/v1/metrics`。没有修改既有 telemetry 函数、application-version 函数、业务路由、数据库集合或记录；没有创建第二个环境，没有购买域名、证书、套餐或资源包，没有开启自动续费或超限扣费。

## 部署前门禁

- 环境地域：`ap-shanghai`
- 套餐：体验版（`baas_trial`），状态 `NORMAL`
- 自动续费：关闭
- 超限扣费：关闭
- 套餐到期：2027-03-17 23:59:59
- 2026-09-01 至 2026-09-21 预检用量：数据库读 51 次、写 59 次，云函数 3 GBs / 28 次调用，HTTP 网关 11 次调用，静态托管 0
- 原有函数：`application-version-api` 和三个逐应用 telemetry 函数；目标函数不存在
- 原有默认域名状态：`SUCCESS`，DNS 状态 `OK`；目标路由不存在
- 12 个预期集合全部存在并为 `ADMINONLY`
- telemetry 记录数：毕方小工具 1、鼠标精灵 1、录屏助手 2；三者均有 `expires_at_ttl`（`expires_at: 1`、`expireAfterSeconds: 0`）
- 9 个 versions / ads / audit 集合均为 0 条，所需索引齐全

免费体验版固定云函数超时为 3 秒且不允许修改。预检发现仓库原目标为 8 秒，因此在写入前将生成器与生成模板统一改为 3 秒并重新验证；未触发套餐升级。

## 创建的资源

| 资源          | 最终配置                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------- |
| 函数          | `operations-dashboard-api`                                                               |
| 函数 ID       | `lam-rteriz3b`                                                                           |
| 类型 / 运行时 | Event / `Nodejs20.19`                                                                    |
| Handler       | `index.main`                                                                             |
| 超时 / 内存   | 3 秒 / 256 MB                                                                            |
| 依赖安装      | CloudBase 自动安装                                                                       |
| 路由          | `/admin/v1/metrics` -> SCF `operations-dashboard-api`                                    |
| 路由开关      | enabled、safe domain、path transmission；CloudBase 网关鉴权关闭，由函数校验 Bearer Token |
| 限流          | 总 QPS 100；单 ClientIP QPS 2                                                            |

函数创建时间为 2026-09-21 15:15:45，部署后状态为 `Active / Available`。路由创建时间为 2026-09-21 15:17:01；创建请求 RequestId 为 `68e6f1d1-7c74-4d0c-8e2f-ead8fe4b8058`，读回时默认域名仍为 `SUCCESS / DNS OK`。

函数环境变量只包含以下四个键：

- `CLOUDBASE_ENV_ID`
- `DASHBOARD_APPS_JSON`
- `DASHBOARD_PATH`
- `DASHBOARD_TOKEN_SHA256`

原始 `CLOUDBASE_METRICS_TOKEN` 仅保存在 Git 忽略的 `apps/operations-dashboard-standalone/.env.server.local`；CloudBase 只保存 SHA-256。回执不记录原始 Token 或完整摘要。

## 验证结果

- `cloudbase/functions/operations-dashboard/test/dashboard.test.js`：24/24 通过
- CloudBase 生成配置与仓库契约专项测试：14/14 通过
- 生成配置检查和 Prettier 检查通过
- 公网无 Token：`401 {"error":"unauthorized"}`
- 公网错误 Token：`401 {"error":"unauthorized"}`
- 公网正确 Token、`days=7&app_id=all`：`200`
- 公网非法 `days=31`：`400 {"error":"invalid_query"}`
- 正确响应未发现 `install_id`、`source_ip`、下载地址、提示正文、富文本、凭据、Secret 或 Token 字段

整仓 `npm run check` 未能执行，因为当前执行环境没有可用的 `npm` 命令。另行尝试 `node --test tests/*.test.mjs` 时有 64/135 通过；其余 onboarding 测试调用不可用的 Python 命令并以 Windows `9009` 退出，因此不把该次运行报告为整仓通过。本次直接相关的函数、配置、仓库契约和公网 E2E 均已独立通过。

首次正确公网请求的端到端耗时约 5.4 秒，包含网关、TLS 和冷启动；函数在免费版 3 秒执行上限内成功返回。后续服务器侧仍应保留合理的上游请求超时和错误提示。

## 未执行事项

- 未把独立站压缩包上传到用户服务器，也未启动服务器进程或配置反向代理、HTTPS、systemd/Windows 服务。
- 未发布 ChatGPT Site 或 CloudBase 静态托管。
- 未修改、发布或重新构建任何业务客户端。
- 未删除、覆盖或迁移任何既有 CloudBase 资源。
- 未推送 Git 远端。
