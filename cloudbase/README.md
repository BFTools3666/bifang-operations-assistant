# CloudBase 资源说明

本目录只含待部署源码和静态配置，没有创建、部署或验证任何腾讯云资源。真实 CloudBase 操作属于独立 Task4；完整协议、SDK 和维护说明见 [`docs/telemetry-and-update.md`](../docs/telemetry-and-update.md)。

## 目录

- `functions/telemetry/`：Node.js 20 CommonJS 普通 Event 云函数，入口 `index.main`。
- `updates/update.schema.json`：更新清单 v1 JSON Schema。
- `updates/example-tool/windows.json`：Windows 占位清单；`example-tool` 和 `.example.invalid` 必须替换。

`telemetry` 由 CloudBase HTTP 访问服务/HTTP 网关映射到 `/v1/track`。它不是监听 9000 端口的 HTTP Web 云函数。

## Task4 资源拓扑

Task4 需要在控制台或经审核的声明式部署中创建：

1. CloudBase 环境。
2. `telemetry` Event 云函数，Node.js 20，入口 `index.main`。
3. NoSQL 集合 `telemetry_events`，禁止公共端直接读写。
4. 匿名 HTTP 网关路由 `POST/OPTIONS /v1/track`，指向该 Event 函数并透传路径，协议设为 `HTTP_TO_HTTPS`。
5. 静态托管 `/updates`，公开更新 JSON。
6. HTTPS 域名、全局/单 IP 限频、请求体限制、约 5 分钟的 JSON 缓存、监控与告警。

函数运行时必须配置 `ALLOWED_APP_IDS=<批准的逗号分隔 app_id>`。普通 Event 函数默认使用当前 CloudBase 环境访问数据库；只有确实要覆盖时才设置 `CLOUDBASE_ENV_ID`。公共客户端不使用腾讯云 secret。

数据库适配器固定使用官方 `@cloudbase/js-sdk@3.8.2`；该包自 v3.1 起内置 Node.js 适配器。本仓库有意不使用旧的 `@cloudbase/node-sdk@3.18.3`，因为实现阶段的 `npm audit` 显示其旧依赖链存在 4 个 high severity 漏洞。Task4 必须在真实 Event 函数中复核当前环境鉴权和数据库写入，后续升级依赖也必须重新运行测试与审计。

## 部署模板

仓库根目录的 `cloudbaserc.json.example` 是起点，不是已验证的生产配置。Task4 使用时：

```powershell
Copy-Item -LiteralPath .\cloudbaserc.json.example -Destination .\cloudbaserc.json
$env:ENV_ID = "<YOUR_CLOUDBASE_ENV_ID>"
$env:ALLOWED_APP_IDS = "<YOUR_REAL_APP_ID>"

npm ci
npm run check
tcb login
tcb validate
tcb deploy --dry-run
tcb deploy
```

模板刻意不固定地域。CloudBase CLI 当前允许上海环境省略 `region`，其他地域必须按真实环境与当日配置 Schema 补入该字段。执行 `tcb deploy` 前，必须确认 validate 通过且 dry-run 只触碰目标环境和上述资源；还要核对 `HTTP_TO_HTTPS` 在最终域名分组生效。CLI/控制台字段如与模板不一致，以 Task4 当日同版本官方文档为准。

## 公网地址模板

```text
Telemetry: https://<YOUR_HTTPS_DOMAIN>/v1/track
Updates:   https://<YOUR_HTTPS_DOMAIN>/updates/<YOUR_REAL_APP_ID>/<platform>.json
```

仓库未绑定环境或域名，所以没有可用的“实际地址”。

## 安全与容量边界

- `POST /v1/track` 只接受 JSON，原始 body 最大 4096 字节。
- 未通过 schema、UUID v4、SemVer、时间、平台、架构、事件、app 白名单或事件属性白名单的请求不写库。
- `properties` 最多 20 个 primitive 值；拒绝嵌套、数组、base64/二进制，字符串最多 200 个 code point。功能、任务类型和错误码另拒绝高置信度的 MAC、手机号、UUID、JWT、长十六进制串和疑似 Base64URL；调用方仍必须只传受控枚举。
- 服务端重建数据并生成 `received_at`；不保存客户端 IP、原始 body 或未知字段。
- `_id=event_id` 提供尽力而为的重复写幂等，真实 duplicate-key 行为需在 Task4 验证。
- 函数内 burst guard 默认每个 warm instance、每个 app ID、10 秒 120 次；它不是全局限流。网关模板的总 QPS 100、单 IP 10 只是需按真实流量调整的起点。
- 更新 JSON 建议 `Cache-Control: max-age=300`；紧急停更或回滚后刷新对应 CDN 路径。

## Task4 最小验收

部署后至少确认：

- 函数类型确为 Event、入口正确、依赖已安装、数据库插入权限正常。
- `OPTIONS /v1/track` 返回 204，合法 POST 返回 202。
- 非法 payload 返回 400、未知 app 返回 403，并且两者都没有数据库写入。
- 同一 `event_id` 重复提交后集合中仍只有一条。
- `received_at` 来自服务端，记录中没有客户端 IP 或敏感正文。
- 更新 URL 返回正确 JSON，实际路径和 300 秒左右的缓存策略正确。
- optional/required 的宿主 UI、真实下载 URL、安装包签名与退出路径由业务客户端另行人工测试。

Windows PowerShell 公网验证请显式使用 `curl.exe`，具体命令见完整文档。不要把本地 mock 测试称作真实 CloudBase 或真实宿主验收。
