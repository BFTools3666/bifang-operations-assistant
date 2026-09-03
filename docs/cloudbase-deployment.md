# CloudBase Phase 1 部署回执

## 1. 部署结论

CloudBase Phase 1 于 2026-09-03 在腾讯云上海地域完成首次部署，并在同日完成修正协议的覆盖部署与真实公网/数据库验收。本回执只记录非敏感资源标识和验证证据，不包含腾讯云登录态、兑换码、密钥、Token、Cookie 或账号身份信息。

本次部署用于 `example-tool` 基础设施 smoke test，不代表真实业务客户端已接入或可发布。客户端配置必须只使用下文列出的 `https://` 地址。

> 当前状态：Task4 的旧协议首次部署保留为历史基线。Task7 校正后的事件 properties、telemetry validator 和 14 字段更新清单已由 Task8 覆盖部署到同一现有环境，并在 2026-09-03 14:13（UTC+8）前完成复验。当前云端与本仓库的 Phase 1 v1 协议一致；Task8 未创建、删除或重建任何环境、套餐、数据库、集合、函数、路由、域名或其他资源。

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

| 项目        | 实际值                                                                               |
| ----------- | ------------------------------------------------------------------------------------ |
| 函数名      | `telemetry`                                                                          |
| 函数类型    | 普通 Event 函数                                                                      |
| Function ID | `lam-hpo8qqz1`                                                                       |
| Resource ID | `scf-sh-hpo8qqz1`                                                                    |
| 运行时      | `Nodejs20.19`                                                                        |
| 入口        | `index.main`                                                                         |
| 内存        | `256 MB`                                                                             |
| 超时        | `5 s`                                                                                |
| 依赖安装    | 已开启                                                                               |
| 环境变量    | `ALLOWED_APP_IDS=example-tool`                                                       |
| 部署状态    | `Active` / `Available`                                                               |
| 部署时间    | Task4 首次 `2026-09-03 12:43:55 +08:00`；Task8 代码更新 `2026-09-03 14:05:43 +08:00` |

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

Task4 首次新增两个仓库文件；Task8 只覆盖这两个已存在对象，未使用 `--prune`，也未删除或覆盖环境内的 `__auth/`、`cloud-admin/` 等系统文件：

| 云端路径                            | Task4 历史字节数 / MD5                      | Task8 当前字节数 / MD5 / 远端 ETag          |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------- |
| `updates/example-tool/windows.json` | `392` / `a7acb6b1ab3e3b0d1054e5f20e28a1ab`  | `560` / `8e92acf6f2c18c25edfddc40c31d8a86`  |
| `updates/update.schema.json`        | `1589` / `0f01aff2e2bc753c860b1f65640308e6` | `2727` / `6bfa459c2d98fd0540ec061e40d0cd2e` |

## 5. 部署过程证据

### Task4 历史首次部署

- 使用临时安装的官方 `@cloudbase/cli@3.8.1` 和用户本人完成的设备授权；未使用永久密钥登录。
- 用户选择不向 CLI 发送匿名使用数据。
- 本地 `npm ci` 成功；`npm run check` 成功，格式、类型检查、构建及当时的 53/53 个测试全部通过。
- 声明式 `validate --json` 返回 `valid: true`，资源摘要为 1 个函数、1 个静态托管、0 个数据库迁移、2 条网关路由。
- `deploy --dry-run` 只计划首次创建 `telemetry`、部署 `updates`、创建 `/v1/track` 和 `/updates`，没有删除项；正式部署返回 4/4 项成功。
- CLI 3.8.1 的内置 schema 当时不接受模板中的 `hosting.verify` 和 `hosting.safe`；Task5 已从仓库模板移除这两个字段。

### Task8 修正协议覆盖部署

- 继续使用官方 `@cloudbase/cli@3.8.1` 和 Task4 的设备授权登录态；未人工读取、创建或输出永久密钥、Token、Cookie 或其他登录材料。
- 部署前 `npm ci` 成功；`npm run check` 成功，格式、类型检查、构建及当前 60/60 个测试全部通过。
- 只读核查确认环境 `NORMAL`、集合 `telemetry_events` 权限 `ADMINONLY`、唯一函数 `telemetry` 为 Event 类型，运行时 `Nodejs20.19`、入口 `index.main`、256 MB、5 秒、云端安装依赖、`ALLOWED_APP_IDS=example-tool` 均未漂移。
- `DescribeHTTPServiceRoute` 确认默认域名协议仍为 `HTTP_AND_HTTPS`；网关仍只有 `/v1/track` 与 `/updates`，前者总 QPS `100`、单客户端 IP QPS `10`、匿名、路径透传开启，后者前缀重写为 `/updates`。没有修改路由、QPS、CORS 或协议。
- 临时本地配置的 `validate --json` 返回 `valid: true`。`deploy --only functions,hosting --refresh --dry-run --json` 只计划覆盖现有 `telemetry` 和直传 `/updates` 两个文件，`deleted=[]`，没有 gateway、database、环境或其他资源动作。
- 正式执行使用更窄的资源级命令：`fn code update telemetry` 只更新现有函数代码并在云端安装依赖；两个 `hosting deploy <file> <existing-path>` 只覆盖两个已存在对象。没有使用 `fn deploy` 创建函数、顶层 `deploy`、`--prune`、删除命令或数据库写命令。
- 函数更新后重新查询为 `Active` / `Available`，Function ID 与 Resource ID 未变；运行时、入口、内存、超时、依赖安装和环境变量全部保持原值。
- CLI 的单文件 `--verify` 返回体出现 `successCount=0`、`failedCount=0`、`verified=false` 的不一致计数，因此没有把该字段当作成功证据；随后以静态对象列表、两个公网域名的原始字节、MD5/ETag 和逐字段 JSON 比对确认部署结果。

## 6. 公网与数据库验收

### Task4 历史基线

Task4 的首次验收时间为 2026-09-03 12:47 至 12:48（UTC+8）。当时的旧协议已实测 `OPTIONS` 204、合法/重复 POST 202、幂等数据库计数 1、未知 app 403 且零写入、非法 JSON 与 4114 字节 body 400、GET 405、额外路径 404，以及 392 字节旧清单的 ETag/MD5 一致。历史事件 `_id=01234567-89ab-4def-8123-456789abcdef` 未被 Task8 删除。

### Task8 当前 v1 契约

Task8 的公网与数据库验收时间为 2026-09-03 14:11 至 14:13（UTC+8）。

更新清单与 Schema：

- 网关域名和静态托管域名的 `windows.json` 均返回 `200 application/json`，原始内容均为 560 字节，逐字节、逐字段与本地文件一致；两端 ETag 与本地 MD5 均为 `8e92acf6f2c18c25edfddc40c31d8a86`。
- 远端清单精确包含 14 个键：`schema_version`、`app_id`、`platform`、`latest_version`、`min_supported_version`、`enabled`、`force_update`、`rollout`、`title`、`message`、`download_url`、`release_notes_url`、`sha256`、`published_at`。
- 可读字段与本地一致：`title="Example Tool 0.1.0"`、`message="Initial smoke-test manifest; no newer update is offered."`、`sha256=""`、`published_at="2026-09-03T04:43:55.000Z"`。
- 两个域名的 `update.schema.json` 均返回 200 和 2727 字节；远端 ETag 与本地 MD5 均为 `6bfa459c2d98fd0540ec061e40d0cd2e`。
- 使用公网清单实际运行 `UpdateChecker`，当前版本 `0.1.0` 返回 `none / up_to_date`。`rollout`、`force_update` 与严格 SemVer 的分支由本次通过的本地 60/60 测试覆盖。
- 两个系统默认域名仍返回 `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`。

HTTP 合同：

| 验收项                                             | Task8 实际结果                                            |
| -------------------------------------------------- | --------------------------------------------------------- |
| `OPTIONS /v1/track`，Origin 为 `tauri://localhost` | `204 No Content`；允许该 Origin、`POST` 与 `Content-Type` |
| `GET /v1/track`                                    | `405 {"ok":false,"error":"method_not_allowed"}`           |
| `POST /v1/track/extra`                             | `404 {"ok":false,"error":"not_found"}`                    |

六类合法 `channel=official` 事件均使用新的 UUID，返回 202 并在 `telemetry_events` 中各有且仅有一条：

| 事件                  | 精确 properties                                               | event_id                               | 状态 | 数据库数量 | 服务端 received_at         |
| --------------------- | ------------------------------------------------------------- | -------------------------------------- | ---- | ---------- | -------------------------- |
| `feature_used`        | `{"feature_id":"open_dashboard"}`                             | `51282fc9-97f5-440b-89e9-f8654a41287e` | 202  | 1          | `2026-09-03T06:11:33.105Z` |
| `task_started`        | `{"task_type":"export_report"}`                               | `48126280-7d57-418c-b5ee-0c4081c4920d` | 202  | 1          | `2026-09-03T06:11:34.810Z` |
| `task_succeeded`      | `{"task_type":"export_report","duration_ms":321}`             | `f5463914-7082-4128-82d9-3e3d846b86f5` | 202  | 1          | `2026-09-03T06:11:35.143Z` |
| `task_failed`         | `{"task_type":"export_report","error_code":"EXPORT_TIMEOUT"}` | `c6ebede4-a1d5-4b52-9ee4-5783ab9e1bdb` | 202  | 1          | `2026-09-03T06:11:35.417Z` |
| `update_prompt_shown` | `{"target_version":"0.2.0"}`                                  | `3647a404-5676-490a-8fb4-b73c000a4f28` | 202  | 1          | `2026-09-03T06:11:35.742Z` |
| `update_clicked`      | `{"target_version":"0.2.0"}`                                  | `ffb9d768-593a-4ccf-bd3d-29e02da57907` | 202  | 1          | `2026-09-03T06:11:36.029Z` |

`feature_used` 的同一 `event_id=51282fc9-97f5-440b-89e9-f8654a41287e` 再次发送仍返回 202，数据库查询上限为 2 时仍只返回 1 条。首次请求携带的伪造 `received_at=2000-01-01T00:00:00.000Z` 未进入数据库，实际值由服务端生成。每份文档都精确为 15 个顶层键（协议 13 键、`_id`、`received_at`），`_id=event_id`，properties 与请求精确一致，不含 IP、headers、原始 body、request context 或额外字段。

拒绝用例全部使用独立 UUID；下表状态符合合同，并按 `_id` 查询确认数据库数量为 0：

| 用例                                         | event_id                               | 状态 | 数据库数量 |
| -------------------------------------------- | -------------------------------------- | ---- | ---------- |
| 旧 `feature`                                 | `9a024d11-bbfc-4aa8-8ab6-aebbca8ff082` | 400  | 0          |
| 旧 `latest_version` + `required`             | `eb94f2a6-92d6-443c-8de6-b1ab5eecb772` | 400  | 0          |
| 旧 `latest_version` + `action`               | `2269f537-b924-48e2-81c3-7c6c604dd825` | 400  | 0          |
| `task_failed` 缺 `task_type`                 | `052c2ead-97e8-4639-a358-423b3f627eae` | 400  | 0          |
| `task_succeeded` 缺 `duration_ms`            | `61e1108d-ad9a-4995-8711-3d3af02af8a2` | 400  | 0          |
| properties 额外字段                          | `f209b2b4-7c42-4402-8342-3d70c092a077` | 400  | 0          |
| 顶层额外字段                                 | `dee5aae7-b2f7-49fe-aadb-99cfcc05217a` | 400  | 0          |
| 未知 app                                     | `f2c1c000-d361-46db-9d48-39d07d7a4a39` | 403  | 0          |
| 非法 JSON                                    | `433a66a0-3904-4436-83ba-a59bf2293b49` | 400  | 0          |
| 4097 字节、JSON 本身合法但超过函数 body 上限 | `c45a8ac2-f2aa-4a8e-a2a6-a7029779a177` | 400  | 0          |

Task8 新增的 6 条成功 smoke 记录和 Task4 历史记录均保留在集合中；没有执行任何删除。真实 CloudBase 当前环境身份、文档数据库写入、重复键幂等、精确 properties、拒绝零写入、HTTP Event 形态、CORS、精确路径、方法限制和 4096 字节请求体限制均已通过实测，不是本地 mock 结论。

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
2. 填写清单全部 14 个键：真实版本、安全 UI 文案、已签名安装包及发布说明的公网 HTTPS URL、64 位十六进制 `sha256` 与严格 RFC3339 `published_at`。
3. 绑定已备案自定义域名、证书和 DNS，配置约 300 秒缓存并复验。
4. 将业务客户端的 telemetry endpoint 与 update base URL 明确配置为 HTTPS。
5. 在真实宿主中人工验收 optional/required 更新 UI、退出流程及关闭 telemetry 时零网络请求。

Task8 未创建业务客户端、安装器、发布包、自定义域名、EdgeOne 或任何 Phase 2 资源，也未接入真实业务客户端。它只更新 Task4 已有函数的代码/依赖和两个已有静态对象；环境、套餐、数据库、集合权限、函数配置、网关、QPS、CORS、域名与其他资源保持不变。

Task8 已完成当前 Phase 1 v1 协议的云端一致性验证。剩余工作仅是上述真实业务接入与生产运维边界，不属于本 Task。
