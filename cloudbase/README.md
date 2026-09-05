# CloudBase 每日启动统计资源说明

本目录保存可重复部署的源码和静态配置。仓库当前协议已收缩为固定的 `daily_active`：它表示软件在北京时间当天第一次启动使用，**不是安装事件**。同一个匿名 `install_id` 每天最多保存一条，不再接收渠道、功能、任务或更新交互统计。

Task4/Task8 部署及验收的是历史 v1 多事件协议，记录见 [`docs/cloudbase-deployment.md`](../docs/cloudbase-deployment.md)。它不证明当前 `daily_active` 代码已经上线。发布新版客户端前必须先部署新版云函数并重新验收；否则旧函数会拒绝新请求。完整协议、SDK 和维护说明见 [`docs/telemetry-and-update.md`](../docs/telemetry-and-update.md)。

## 目录

- `apps.json`：全部工具及其 Windows/macOS 更新平台的唯一登记表；部署模板同时保留这里列出的所有工具。
- `add-app.mjs`：安全追加一个工具，并为明确登记的平台创建默认关闭的更新清单。
- `add-app-platform.mjs`：为已登记工具安全追加一个更新平台，不覆盖既有清单。
- `generate-cloudbaserc.mjs`：根据登记表生成根目录 `cloudbaserc.json.example`，并校验所有登记平台清单。
- `plan-app-deployment.mjs`：只读生成单个目标应用的资源级阶段 4 计划，不执行命令。
- `functions/telemetry/`：所有工具实例复用的 Node.js 20 CommonJS Event 函数源码，入口 `index.main`。
- `updates/update.schema.json`：更新清单 v1 JSON Schema。
- `updates/<app_id>/<platform>.json`：每个工具、每个平台独立的更新清单；当前支持 `windows.json` 和 `macos.json`，禁用清单使用当前默认 HTTPS 域名下的 `not-published` 404 地址，正式发布前必须替换。
- `updates/WINDOWS_JSON_FIELDS.zh-CN.md`：平台更新清单全部 14 个字段的中文说明；文件名作为历史兼容入口保留。

生成器为每个工具创建一个 `telemetry-<app_id>` 配置，并由 HTTP 网关映射到 `/apps/<app_id>/v1/track`。这些都是普通 Event 云函数，不是监听 9000 端口的 HTTP Web 云函数。

## 目标拓扑与历史部署边界

当前目标是在同一个免费 CloudBase 环境内做业务资源隔离。每个工具都有：

1. 唯一 `app_id`，只含小写字母、数字和短横线，长度 1–50，且首尾是字母或数字。
2. `telemetry-<app_id>` Event 云函数，Node.js 20，入口 `index.main`。
3. `telemetry_<规范化app_id>` NoSQL 集合；规范化只把每个短横线替换为下划线，权限必须是 `ADMINONLY` 或控制台中含义相同的仅管理员可读写。
4. 匿名 HTTP 网关路由 `POST/OPTIONS /apps/<app_id>/v1/track`，只指向该工具函数并透传路径。
5. 静态清单 `/updates/<app_id>/<platform>.json`。

所有工具只共享环境、平台默认 HTTPS 域名、`/updates` 静态托管入口、免费额度和平台故障域。自定义域名、EdgeOne 或套餐升级不属于本阶段；一旦出现非零价格或按量付费，必须先提醒负责人并停止。

每个函数必须配置三个由生成器写入的值：

```text
ALLOWED_APP_IDS=<该函数唯一app_id>
TELEMETRY_COLLECTION=telemetry_<规范化app_id>
TRACK_PATH=/apps/<app_id>/v1/track
```

虽然保留了历史变量名 `ALLOWED_APP_IDS`，新模板中它是单值，不能使用逗号列表。缺少或格式非法的 `TELEMETRY_COLLECTION`、`TRACK_PATH` 会 fail closed，函数不会回退到历史共享集合或共享路径；生成检查用于防止三个合法值彼此漂移。普通 Event 函数默认使用当前 CloudBase 环境访问数据库；只有确实要覆盖时才设置 `CLOUDBASE_ENV_ID`。公共客户端不使用腾讯云 secret。

Task4/Task8 创建并验收的是下面“历史验收”章节所述的旧单函数拓扑。迁移时不要直接覆盖或先删除旧资源：先保留旧资源，部署并验证独立资源，再切换客户端，观察迁移期后才人工下线，避免旧客户端 404 或新旧集合统计分裂。

数据库适配器固定使用官方 `@cloudbase/js-sdk@3.8.2`；该包自 v3.1 起内置 Node.js 适配器。本仓库有意不使用旧的 `@cloudbase/node-sdk@3.18.3`，因为实现阶段的 `npm audit` 显示其旧依赖链存在 4 个 high severity 漏洞。Task4 已在真实 Event 函数中复核当前环境鉴权、数据库写入和重复事件幂等；后续升级依赖仍必须重新运行测试与审计。

## 部署模板

仓库根目录的 `cloudbaserc.json.example` 由 `apps.json` 生成，是包含全部已登记工具的可重复部署起点，不是已验证的生产配置。新增工具例如 `bifang-tools-pdf`：

```powershell
npm run cloudbase:app:add -- bifang-tools-pdf
```

默认只登记 Windows；新应用同时支持 Windows 和 macOS 时在命令末尾追加 `windows macos`。已登记应用新增 macOS 时使用：

```powershell
npm run cloudbase:app:platform:add -- bifang-tools-pdf macos
```

两个命令都会拒绝非法或重复编号/平台，不覆盖已有目录或清单，并创建 `enabled=false`、`rollout=0`、使用当前默认 HTTPS 域名下 `not-published` 404 地址的安全禁用清单。随后修改真实清单并执行：

```powershell
npm ci
npm run cloudbase:config:check
Copy-Item -LiteralPath .\cloudbaserc.json.example -Destination .\cloudbaserc.json
$env:ENV_ID = "<YOUR_CLOUDBASE_ENV_ID>"

npm run check
tcb login
tcb validate
tcb deploy --dry-run
```

生成器不会创建数据库集合。每个新工具都要先在 CloudBase 数据库页面手工创建派生集合并设为仅管理员可读写。

模板刻意不固定地域。CloudBase CLI 3.8.1 允许本次上海环境省略 `region`，其他地域必须按真实环境与当日配置 Schema 补入该字段。必须确认 validate 通过，且 dry-run 保留所有已登记工具，没有删除旧函数/路由、陌生资源或收费项。新增、改名或删除工具时还要人工核对云端集合和孤儿更新目录；`apps.json` 不会自动清理云端。CLI/控制台字段如与模板不一致，以执行当日同版本官方文档为准。

顶层 `tcb deploy` 会协调所有登记应用和共享 `/updates`，不能用于“只部署一个新应用”。阶段 3 只生成以下只读计划：

```powershell
npm run cloudbase:app:deploy:plan -- bifang-tools-pdf --env-id <现有免费环境ID> --origin https://<平台默认域名>
```

计划输出使用参数数组固化目标集合、单个函数、单条路由和逐平台单文件上传，并禁止 `--all`、`--force`、`--prune`、目录级托管上传与删除命令。它不会执行任何 CloudBase 写入。进入阶段 4 后仍须先读取云端现状、确认免费额度和零删除，再展示最终参数并等待负责人明确继续。

## 公网地址模板

```text
Telemetry: https://<YOUR_HTTPS_DOMAIN>/apps/<YOUR_REAL_APP_ID>/v1/track
Updates:   https://<YOUR_HTTPS_DOMAIN>/updates/<YOUR_REAL_APP_ID>/<platform>.json
```

历史 `example-tool` smoke test 的实际 HTTPS 地址是：

- Telemetry: <https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/v1/track>
- Updates: <https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/updates/example-tool/windows.json>

这些是系统默认域名上的 Task4/Task8 历史 smoke 地址。当前线上 `/v1/track` 仍按历史 v1 验收，不能拿它证明新版 `daily_active` 已部署；静态清单中的 `.example.invalid` 下载/发布说明地址也不能上线。

## 安全与容量边界

- `POST /apps/<app_id>/v1/track` 只接受 JSON，原始 body 最大 4096 字节。
- 只接受固定事件 `daily_active`。请求中不再有 `channel`、`session_id`、`properties`、功能 ID、任务结果或更新交互。
- 客户端提供的业务识别字段只有 `app_id`、`app_version`、匿名 `install_id`、`platform`、`arch`；协议还带固定版本/事件名、一次性 `event_id`、SDK 版本和客户端发生时间用于验证与诊断。
- 服务端按 `Asia/Shanghai` 生成 `active_date`，并生成 `received_at`；`source_ip` 只从 CloudBase 可信请求上下文提取，忽略客户端可伪造的转发请求头，取不到时保存 `null`。
- 文档 `_id` 由 `app_id + active_date + install_id` 计算；同一匿名安装在同一北京时间日期即使请求重放，也只保存一条。
- 客户端在联网前先原子落盘当天标记；即使发送失败，当天也不重试。这里优先保护免费网关，接受偶发少计。
- 函数内 burst guard 默认每个 warm instance、每个 app ID、10 秒 120 次；它不是全局限流。网关模板的总 QPS 100、单 IP 10 只是需按真实流量调整的起点。
- 更新 JSON 建议 `Cache-Control: max-age=300`；紧急停更或回滚后刷新对应 CDN 路径。

统计口径是“当天实际启动使用过的设备数”，可近似观察每天有多少人在用，但不是账号人数。同一人多台设备会多计，重装或清除本地标记也可能产生新 ID；IP 不能用于人数去重，同一公网 IP 下可能有多台设备。`source_ip` 属于个人信息，必须在隐私说明中告知用途，设置满足业务所需的最短保留期限，并在截图、日志、导出和分享前遮挡。

## 历史验收与新版待办

Task4/Task8 曾针对历史 v1 多事件协议完成下列验收，详细证据见部署回执。这些结果不可直接继承给新版：

- 函数类型确为 Event、入口正确、依赖已安装、数据库插入权限正常。
- `OPTIONS /v1/track` 返回 204，合法 POST 返回 202。
- 非法 payload 返回 400、未知 app 返回 403，并且两者都没有数据库写入。
- 历史协议曾验证重复事件幂等；新版必须改验同一 `install_id + active_date` 只保存一条。
- 历史协议不保存 IP；新版必须验证 `source_ip` 只来自可信上下文，客户端伪造头无效。
- 更新 URL 曾返回 14 字段 JSON；本地示例现已改为中文标题/正文，重新部署后还要逐字段复验。系统默认域名可能强制 `no-store`。
- optional/required 的宿主 UI、真实下载 URL、安装包签名与退出路径由业务客户端另行人工测试。

新版部署后至少验收：当天同一安装反复启动最多一次 POST/一条记录；第二天可再上报一次；十台模拟设备最多 10 次 POST 且在同一电脑测试时可能同公网 IP；渠道/功能/任务/更新交互字段均被拒绝；`active_date`、`received_at`、`source_ip` 均由服务端决定。

本轮简化不新增付费服务，但不能据此保证平台未来价格。看到套餐升级、非零订单、自动续费、超限按量或收费域名/加速产品时，先告知负责人，不要继续。

Windows PowerShell 公网验证请显式使用 `curl.exe`，具体命令见完整文档。不要把本地 mock 测试称作真实 CloudBase 或真实宿主验收。
