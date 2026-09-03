# CloudBase Phase 1 部署回执

## 1. 部署结论

CloudBase Phase 1 已于 2026-09-03 在腾讯云上海地域完成真实部署与公网验收。本回执只记录非敏感资源标识和验证证据，不包含腾讯云登录态、兑换码、密钥、Token、Cookie 或账号身份信息。

本次部署用于 `example-tool` 基础设施 smoke test，不代表真实业务客户端已接入或可发布。客户端配置必须只使用下文列出的 `https://` 地址。

## 2. 环境与资源

| 项目           | 实际值                                                    |
| -------------- | --------------------------------------------------------- |
| 环境显示名     | `bifang-telemetry-prod`                                   |
| 环境 ID        | `bifang-telemetry-prod-d8efa6a8d3`                        |
| 地域           | 上海 `ap-shanghai`                                        |
| 套餐           | 体验版，创建页实付 `0.00 CNY`                             |
| 环境状态       | `NORMAL`                                                  |
| 环境创建时间   | `2026-09-03 12:25:56 +08:00`                              |
| 环境到期时间   | `2027-03-03 23:59:59 +08:00`                              |
| 文档数据库实例 | `tnt-mrek6p8cw`                                           |
| 数据库集合     | `telemetry_events`                                        |
| 集合权限       | `ADMINONLY`，公共客户端无读写权限                         |
| 静态托管桶     | `93be-static-bifang-telemetry-prod-d8efa6a8d3-1251031333` |

环境创建时未启用自动续费、超套餐按量付费、EdgeOne、自定义域名或 Phase 2 资源。

## 3. 云函数

| 项目        | 实际值                         |
| ----------- | ------------------------------ |
| 函数名      | `telemetry`                    |
| 函数类型    | 普通 Event 函数                |
| Function ID | `lam-hpo8qqz1`                 |
| Resource ID | `scf-sh-hpo8qqz1`              |
| 运行时      | `Nodejs20.19`                  |
| 入口        | `index.main`                   |
| 内存        | `256 MB`                       |
| 超时        | `5 s`                          |
| 依赖安装    | 已开启                         |
| 环境变量    | `ALLOWED_APP_IDS=example-tool` |
| 部署状态    | `Active` / `Available`         |
| 部署时间    | `2026-09-03 12:43:55 +08:00`   |

未设置 `CLOUDBASE_ENV_ID`，函数使用 CloudBase 当前环境身份访问同环境文档数据库；未配置或下发 SecretId、SecretKey、API Key 等客户端凭据。

## 4. HTTP 网关与静态托管

默认 HTTP 网关域名：

```text
bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com
```

已部署路由：

| 路由        | 上游                       | 跨域 | 路径透传                    | 身份认证           | 限频                               |
| ----------- | -------------------------- | ---- | --------------------------- | ------------------ | ---------------------------------- |
| `/v1/track` | `SCF:telemetry`            | 开启 | 开启                        | 关闭，允许匿名调用 | 总 QPS `100`；单客户端 IP QPS `10` |
| `/updates`  | `STATIC_STORE:staticstore` | 开启 | 关闭；前缀重写为 `/updates` | 关闭               | 未单独设置                         |

实际公开 HTTPS 地址：

- Telemetry endpoint: <https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/v1/track>
- Update base URL: <https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/updates>
- Windows smoke manifest: <https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/updates/example-tool/windows.json>
- 静态托管默认域名上的同一文件：<https://bifang-telemetry-prod-d8efa6a8d3-1251031333.tcloudbaseapp.com/updates/example-tool/windows.json>

静态托管新增了两个仓库既有文件，未删除或覆盖环境内的 `__auth/`、`cloud-admin/` 等系统文件：

| 云端路径                            | 字节数 | 本地 MD5 / 远端 ETag               |
| ----------------------------------- | -----: | ---------------------------------- |
| `updates/example-tool/windows.json` |    392 | `a7acb6b1ab3e3b0d1054e5f20e28a1ab` |
| `updates/update.schema.json`        |   1589 | `0f01aff2e2bc753c860b1f65640308e6` |

## 5. 部署过程证据

- 使用临时安装的官方 `@cloudbase/cli@3.8.1` 和用户本人完成的设备授权；未使用永久密钥登录。
- 用户选择不向 CLI 发送匿名使用数据。
- 本地 `npm ci` 成功；`npm run check` 成功，格式、类型检查、构建及 53/53 个测试全部通过。
- 声明式 `validate --json` 返回 `valid: true`，资源摘要为 1 个函数、1 个静态托管、0 个数据库迁移、2 条网关路由。
- `deploy --dry-run` 仅计划新建 `telemetry`、部署 `updates`、新建 `/v1/track` 和 `/updates`，没有删除项。
- 正式部署返回 4/4 项成功。
- CLI 3.8.1 的内置 schema 尚不接受模板中的 `hosting.verify` 和 `hosting.safe`；部署时只在仓库外的临时配置中移除这两个字段。仓库中的 Task3 模板和实现代码均未修改。

## 6. 公网与数据库验收

验收时间为 2026-09-03 12:47 至 12:48（UTC+8）。

| 验收项                                             | 实际结果                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `OPTIONS /v1/track`，Origin 为 `tauri://localhost` | `204 No Content`，网关返回允许该 Origin、`POST` 与 `Content-Type`                                              |
| 首次合法 `POST /v1/track`                          | `202 {"ok":true}`                                                                                              |
| 重复发送同一 `event_id`                            | 再次返回 `202`                                                                                                 |
| 幂等数据库计数                                     | `_id=01234567-89ab-4def-8123-456789abcdef` 精确计数为 `1`                                                      |
| 数据库字段                                         | `_id` 等于 `event_id`；`received_at=2026-09-03T04:48:16.622Z` 由服务端生成；无 IP、原始 body、请求头或未知字段 |
| 未授权 app                                         | `403 {"ok":false,"error":"unknown_app"}`，对应测试 `_id` 查询为空                                              |
| 非法 JSON                                          | `400 {"ok":false,"error":"invalid_payload"}`                                                                   |
| 4114 字节请求体                                    | `400 {"ok":false,"error":"invalid_payload"}`，函数内 4096 字节上限生效                                         |
| `GET /v1/track`                                    | `405 {"ok":false,"error":"method_not_allowed"}`                                                                |
| `POST /v1/track/extra`                             | `404 {"ok":false,"error":"not_found"}`                                                                         |
| 更新清单                                           | 两个 HTTPS 地址均返回 `200`、`application/json`、392 字节，远端 ETag 与本地 MD5 一致                           |

真实 CloudBase 当前环境身份、文档数据库写入、重复键幂等行为、HTTP Event 形态、CORS、精确路径、方法限制和 4 KiB 请求体限制均已通过实测，不再只是本地 mock 结论。

## 7. 默认域名已知限制

当前使用的是 CloudBase 系统默认域名，适用于本阶段无真实客户端的开发与 smoke test。平台返回的实际域名协议是 `HTTP_AND_HTTPS`；对系统内部域名调用 `VerifyHTTPServiceRoute` 会明确拒绝人工创建或修改，因此无法设置 `HTTP_TO_HTTPS`。实测 HTTP 请求不会跳转，而是直接进入路由。所有客户端与后续发布配置必须只写入 `https://` URL，不能依赖服务器重定向纠正 HTTP 地址。

网关默认域名和静态托管默认域名当前都强制返回：

```text
Cache-Control: no-store, no-cache, must-revalidate, max-age=0
```

因此约 300 秒缓存建议无法在这个系统默认域名上应用。`no-store` 不影响更新检查的正确性，只会使每次检查回源并增加请求消耗。以后绑定已备案自定义域名和证书时，应把更新清单的节点缓存与浏览器缓存都配置为约 300 秒，并重新实测 HTTP 到 HTTPS 跳转。

CloudBase 官方同样将默认域名定位为开发测试用途；正式业务应使用自定义域名。参考：[HTTP 访问服务](https://cloud.tencent.com/document/product/876/130728)、[静态网站托管](https://cloud.tencent.com/document/product/876/46900)。

## 8. Smoke 配置边界

`example-tool`、版本 `0.1.0` 以及清单中的两个 `.example.invalid` URL 都是不可用占位符。由于最新版本与最低支持版本均为 `0.1.0`，相同版本客户端不会弹出更新；该清单不能作为真实发布配置。

接入真实业务前必须在独立实现或发布 Task 中：

1. 确定真实、稳定的 `app_id`，同步更新 `ALLOWED_APP_IDS` 与清单目录。
2. 填入真实版本、已签名安装包及发布说明的公网 HTTPS URL。
3. 绑定已备案自定义域名、证书和 DNS，配置约 300 秒缓存并复验。
4. 将业务客户端的 telemetry endpoint 与 update base URL 明确配置为 HTTPS。
5. 在真实宿主中人工验收 optional/required 更新 UI、退出流程及关闭 telemetry 时零网络请求。

本 Task 未创建业务客户端、安装器、发布包、自定义域名、EdgeOne 或任何 Phase 2 资源。
