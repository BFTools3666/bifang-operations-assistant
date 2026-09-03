# CloudBase 资源说明

本目录保存可重复部署的源码和静态配置。Task4 曾将 `example-tool` 旧协议快照部署到 CloudBase 并完成当时的公网与数据库验收；实际资源、HTTPS 地址和系统默认域名限制见 [`docs/cloudbase-deployment.md`](../docs/cloudbase-deployment.md)。Task7 校正后的本地函数与 14 字段静态清单尚未部署，Task8 必须部署两者并重新验收后才能恢复生产一致性。该 smoke 环境不代表真实业务客户端已经接入或达到生产发布条件；完整协议、SDK 和维护说明见 [`docs/telemetry-and-update.md`](../docs/telemetry-and-update.md)。

## 目录

- `functions/telemetry/`：Node.js 20 CommonJS 普通 Event 云函数，入口 `index.main`。
- `updates/update.schema.json`：更新清单 v1 JSON Schema。
- `updates/example-tool/windows.json`：Windows 占位清单；`example-tool` 和 `.example.invalid` 必须替换。

`telemetry` 由 CloudBase HTTP 访问服务/HTTP 网关映射到 `/v1/track`。它不是监听 9000 端口的 HTTP Web 云函数。

## 已部署的 smoke 拓扑与生产边界

Task4 已按以下核心拓扑创建并验证第 1 至 5 项，但该证据仅对应 Task4 的历史快照；Task8 仍需重新部署并复验第 2、5 项。第 6 项仍是正式业务接入前的生产要求：

1. CloudBase 环境。
2. `telemetry` Event 云函数，Node.js 20，入口 `index.main`。
3. NoSQL 集合 `telemetry_events`，禁止公共端直接读写。
4. 匿名 HTTP 网关路由 `POST/OPTIONS /v1/track`，指向该 Event 函数并透传路径。目标配置是 `HTTP_TO_HTTPS`；当前系统默认域名实际为 `HTTP_AND_HTTPS`，客户端必须只使用 HTTPS。
5. 静态托管 `/updates`，公开更新 JSON。
6. 正式业务使用已备案自定义 HTTPS 域名，并补齐网关外层请求体限制、约 5 分钟的 JSON 缓存、监控与告警。当前默认域名强制 `no-store`。

函数运行时必须配置 `ALLOWED_APP_IDS=<批准的逗号分隔 app_id>`。普通 Event 函数默认使用当前 CloudBase 环境访问数据库；只有确实要覆盖时才设置 `CLOUDBASE_ENV_ID`。公共客户端不使用腾讯云 secret。

数据库适配器固定使用官方 `@cloudbase/js-sdk@3.8.2`；该包自 v3.1 起内置 Node.js 适配器。本仓库有意不使用旧的 `@cloudbase/node-sdk@3.18.3`，因为实现阶段的 `npm audit` 显示其旧依赖链存在 4 个 high severity 漏洞。Task4 已在真实 Event 函数中复核当前环境鉴权、数据库写入和重复事件幂等；后续升级依赖仍必须重新运行测试与审计。

## 部署模板

仓库根目录的 `cloudbaserc.json.example` 是可重复部署起点，不是已验证的生产配置。模板已移除 CloudBase CLI 3.8.1 不接受的 `hosting.verify` 与 `hosting.safe` 字段；重新部署时仍须先校验：

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

模板刻意不固定地域。CloudBase CLI 3.8.1 允许本次上海环境省略 `region`，其他地域必须按真实环境与当日配置 Schema 补入该字段。执行 `tcb deploy` 前，必须确认 validate 通过且 dry-run 只触碰目标环境和上述资源；自定义域名还要核对 `HTTP_TO_HTTPS` 确实生效。CLI/控制台字段如与模板不一致，以执行当日同版本官方文档为准。

## 公网地址模板

```text
Telemetry: https://<YOUR_HTTPS_DOMAIN>/v1/track
Updates:   https://<YOUR_HTTPS_DOMAIN>/updates/<YOUR_REAL_APP_ID>/<platform>.json
```

本次 `example-tool` smoke test 的实际 HTTPS 地址是：

- Telemetry: <https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/v1/track>
- Updates: <https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/updates/example-tool/windows.json>

这些是系统默认域名上的 Task4 历史 smoke 地址，不应作为真实业务客户端的长期生产配置。Task8 前，新 SDK 会拒绝旧静态清单，新事件 properties 也不应向旧云函数发送。

## 安全与容量边界

- `POST /v1/track` 只接受 JSON，原始 body 最大 4096 字节。
- 未通过 schema、UUID v4、SemVer、时间、平台、架构、事件、app 白名单或事件属性白名单的请求不写库。
- `properties` 最多 20 个 primitive 值；拒绝嵌套、数组、base64/二进制，字符串最多 200 个 code point。功能、任务类型和错误码另拒绝高置信度的 MAC、手机号、UUID、JWT、长十六进制串和疑似 Base64URL；调用方仍必须只传受控枚举。
- 服务端重建数据并生成 `received_at`；不保存客户端 IP、原始 body 或未知字段。
- `_id=event_id` 提供尽力而为的重复写幂等；Task4 已验证同一事件重复提交两次时集合中仍只有一条记录。
- 函数内 burst guard 默认每个 warm instance、每个 app ID、10 秒 120 次；它不是全局限流。网关模板的总 QPS 100、单 IP 10 只是需按真实流量调整的起点。
- 更新 JSON 建议 `Cache-Control: max-age=300`；紧急停更或回滚后刷新对应 CDN 路径。

## Task4 验收结果与生产待办

Task4 smoke test 已完成下列服务端验收；详细状态码、资源 ID 和数据库证据见部署回执：

- 函数类型确为 Event、入口正确、依赖已安装、数据库插入权限正常。
- `OPTIONS /v1/track` 返回 204，合法 POST 返回 202。
- 非法 payload 返回 400、未知 app 返回 403，并且两者都没有数据库写入。
- 同一 `event_id` 重复提交后集合中仍只有一条。
- `received_at` 来自服务端，记录中没有客户端 IP 或敏感正文。
- 更新 URL 在 Task4 验收时返回正确 JSON，内容与 ETag 匹配当时的本地快照；它目前不代表 Task7 的 14 字段清单。系统默认域名实际强制 `no-store`，300 秒左右缓存需在以后绑定自定义域名后复验。
- optional/required 的宿主 UI、真实下载 URL、安装包签名与退出路径由业务客户端另行人工测试。

Windows PowerShell 公网验证请显式使用 `curl.exe`，具体命令见完整文档。不要把本地 mock 测试称作真实 CloudBase 或真实宿主验收。
