# 公共埋点与更新服务 Phase 1

本文是 `毕方运营精灵` 公共基础设施仓库的长期维护文档。仓库只提供埋点接收、更新清单和框架无关 SDK，不包含任何业务客户端、产品 UI、自动下载器或安装器。

Task4 已将 `example-tool` smoke test 首次部署到腾讯云 CloudBase；Task8 又把 Task7 校正后的 v1 精确协议覆盖部署到同一现有环境，并完成公网、数据库写入、拒绝用例与幂等复验。实际资源、HTTPS 地址、事件 ID、内容哈希与默认域名限制见 [`cloudbase-deployment.md`](cloudbase-deployment.md)。该 smoke 环境不代表真实业务客户端已经接入，也未完成自定义域名、真实下载地址或生产运维配置。

Task7 在本地把事件 properties 与更新清单校正为本文所述的 v1.0 精确协议；Task8 已于 2026-09-03 更新现有 `telemetry` 函数代码/依赖和两份现有静态文件，并完成真实公网与数据库复验。当前云端与本仓库的 Phase 1 v1 协议一致；环境、集合、路由、QPS、CORS、默认域名和 `ALLOWED_APP_IDS` 均保持原配置。

## 1. 修改文件列表

Phase 1 的文件及职责如下：

- 根目录：`.env.example`、`.gitignore`、`.prettierignore`、`package.json`、`package-lock.json`、`tsconfig.base.json`、`cloudbaserc.json.example`、`README.md`。
- SDK 清单：`packages/telemetry-update-sdk/package.json`、`packages/telemetry-update-sdk/tsconfig.json`、`packages/telemetry-update-sdk/tsconfig.build.json`，以及该目录下的 `src/constants.ts`、`src/identity.ts`、`src/index.ts`、`src/node.ts`、`src/semver.ts`、`src/telemetry-client.ts`、`src/transport.ts`、`src/types.ts`、`src/update-checker.ts`、`src/validation.ts`。
- SDK 测试：`packages/telemetry-update-sdk/test/identity-and-telemetry.test.mjs`、`packages/telemetry-update-sdk/test/node-storage.test.mjs`、`packages/telemetry-update-sdk/test/update-checker.test.mjs`。
- 云函数：`cloudbase/functions/telemetry/index.js`、`cloudbase/functions/telemetry/package.json`、`cloudbase/functions/telemetry/src/burst-guard.js`、`cloudbase/functions/telemetry/src/handler.js`、`cloudbase/functions/telemetry/src/validation.js`、`cloudbase/functions/telemetry/src/writer.js`、`cloudbase/functions/telemetry/test/telemetry.test.js`。
- 更新清单：`cloudbase/updates/update.schema.json`、`cloudbase/updates/example-tool/windows.json`。
- 示例与仓库测试：`examples/host-integration.ts`、`examples/telemetry-event.json`、`examples/tsconfig.json`、`tests/repository-contract.test.mjs`。
- Python SDK 手动测试客户端：`tools/python-sdk-test-client/client.py`、`tools/python-sdk-test-client/bridge.mjs`、`tools/python-sdk-test-client/README.md`、`tools/python-sdk-test-client/tests/test_client.py`；Node 跨语言集成测试为 `tests/python-sdk-test-client.test.mjs`。
- 文档：`cloudbase/README.md`、`docs/telemetry-and-update.md`、`docs/cloudbase-deployment.md`。

`example-tool` 和所有 `.example.invalid` URL 都是明确的 smoke/不可用占位值，不是现有业务产品或生产下载地址。Task4/Task8 部署 `example-tool` 仅用于验证基础设施。

## 2. 架构与模块说明

```text
业务宿主
  ├─ 明确的 AppConfig 目录 ─> InstallIdentity / NodeFileIdentityStorage
  ├─ TelemetryClient ─HTTPS POST─> HTTP 网关 /v1/track
  │                                      └─> telemetry Event 云函数
  │                                             └─> telemetry_events 集合
  └─ UpdateChecker ─HTTPS GET─> 静态托管 /updates/<app_id>/<platform>.json
           └─> none | optional | required ─> 宿主自己的 UI 与退出逻辑
```

### TypeScript SDK

`packages/telemetry-update-sdk` 是无框架依赖的库：

- `InstallIdentity` 创建 UUID v4 `install_id`，每次初始化创建新的 `session_id`。存储通过 `IdentityStorage` 注入。
- 同一 `IdentityStorage` 实例上的并发初始化会串行执行，只建立一次安装标记；宿主应复用一个存储实例。Node 文件适配器还通过完整临时文件与原子硬链接，在同一路径的不同实例/进程间选出唯一身份；自定义共享存储若存在这类并发，必须实现可选的原子 `readOrCreate`。持久化失败时仅使用本次进程的临时身份且不发送 `app_install`。
- `NodeFileIdentityStorage` 是 Node.js 参考适配器。调用方必须传入其软件自己的绝对 AppConfig 目录；适配器不猜测系统目录，不读取 MAC、硬盘、CPU、机器码或浏览器指纹。新身份先完整写入不超过 4 KiB 的临时 JSON，再以原子硬链接选出唯一文件。既有文件缺失时静默新建；主文件不可读或损坏时不会被无锁删除，而是由各实例对固定 recovery sidecar 做同样的原子选主，后续复用该稳定身份且不补发 `app_install`。若主文件后来被合法修复，则重新优先使用主文件。
- `TelemetryClient` 是业务层唯一上报入口。`track()` 返回 `void`，把发送安排为低优先级异步任务；默认超时 2 秒，失败丢弃，不重试、不建立离线队列，也不会把错误抛回业务控制流。
- `UpdateChecker` 默认超时 3 秒，读取严格的 v1 JSON，进行 Semantic Version 比较和稳定灰度分桶，并返回 `none`、`optional` 或 `required`。网络、超时、非 2xx、非法 JSON 或非法配置都静默返回 `none`。
- URL 校验仅接受无凭据的公网 HTTPS URL，拒绝 `localhost`、明显的私网/保留 IP、`file:`、`javascript:` 等地址；默认 fetch 还拒绝重定向。

SDK 自身默认关闭 telemetry：只有 `enabled: true` 且配置全部合法时才发送。`channel` 未传时规范化为 `official`；显式传入空值、空白或非法 channel 不会回退，而会安全禁用发送。初始化仍会建立本地身份标记；因此用户先以 telemetry 关闭状态运行、日后再开启时，不会补发历史 `app_install`。

### CloudBase telemetry Event 云函数

`cloudbase/functions/telemetry` 是 CommonJS 普通 Event 云函数，入口为 `index.main`。它由 CloudBase HTTP 访问服务/HTTP 网关把标准 HTTP 请求包装为 Event 后调用；它不是需要监听端口 9000 的 HTTP Web 云函数。

函数只做四件事：提取 HTTP 请求、严格验证并重建白名单字段、检查 `ALLOWED_APP_IDS`、写入 `telemetry_events`。它不保存原始 body、请求头或客户端 IP。数据库适配器固定使用官方 `@cloudbase/js-sdk@3.8.2`；CloudBase v3.1 起已在该包中内置 Node.js 适配器。普通 Event 云函数运行时使用当前环境身份，不向公共客户端发放 secret。

本仓库有意不使用旧的 `@cloudbase/node-sdk`。实现阶段对候选版本 `3.18.3` 的 `npm audit` 显示其旧依赖链带来 4 个 high severity 漏洞；继续采用它会给这个小型公共服务增加不必要的维护和审计风险。依赖切换不改变 Event 函数、HTTP 网关或数据库协议。Task4 已在真实函数环境验证 `@cloudbase/js-sdk` 当前环境识别、鉴权和数据库写入；升级 SDK 前仍须重新运行测试与 `npm audit`。

### 更新静态文件

`cloudbase/updates/update.schema.json` 是 JSON Schema 2020-12 的 v1 规范。清单必须精确包含以下 14 个键，缺少或增加任何键都会被 SDK 拒绝：`schema_version`、`app_id`、`platform`、`enabled`、`latest_version`、`min_supported_version`、`force_update`、`rollout`、`title`、`message`、`download_url`、`release_notes_url`、`sha256`、`published_at`。

`title` 为 1–120 个 Unicode code point，`message` 为 1–1000 个；两者必须包含可见内容，并拒绝 C0/C1、DEL、零宽/BOM、双向文本控制等危险不可见字符。合法语言连接符和 emoji ZWJ 只有与可见内容一起出现时才可用。它们始终是远端不可信纯文本，宿主必须用 text/textContent 等文本通道渲染，不得解释成 HTML、Markdown 或脚本。`sha256` 只能是空字符串或 64 位十六进制；空字符串表示 smoke 占位或尚未提供校验值，不代表已验证安装包。`published_at` 必须是带 `Z` 或合法时区偏移、实际日期有效的严格 RFC3339 时间。SDK 会把这四个字段原样保留在更新决策的 `config` 中供宿主 UI 与下载校验流程使用，但不会下载或验证安装包。

`cloudbase/updates/example-tool/windows.json` 是 Windows 示例，初始 `latest_version` 与 `min_supported_version` 都是 `0.1.0`，所以版本同为 `0.1.0` 的客户端不会看到更新提示。

更新判定顺序是：

1. 本地检查关闭或远端 `enabled=false`：`none`。
2. `current_version >= latest_version`：`none`。
3. `current_version < min_supported_version` 或 `force_update=true`：`required`。
4. 否则计算稳定的 `hash(install_id + latest_version) % 100`；桶值小于 `rollout` 时为 `optional`，否则为 `none`。

`rollout` 必须是 0 到 100 的整数。常规 prerelease 参与 SemVer 比较，build metadata 不影响优先级；例如 `1.10.0 > 1.9.0`。

JSON Schema 约束字段拓扑、长度、基础 URI/SemVer 语法；SDK 解析器是运行时安全边界，还会拒绝带凭据、localhost、明显私网/保留地址等 Schema 不适合完整表达的 URL。清单只有同时通过两层检查才可发布。

## 3. CloudBase 资源拓扑与历史部署

Task4 已为 `example-tool` smoke test 创建并验证第 1 至 5 项；Task8 没有新建、删除或重建资源，只覆盖第 2、5 项并复验第 1 至 5 项。真实 ID、配置、当前 ETag 与验收事件 ID 见部署回执。第 6、7 项仍包含正式业务接入前的待办：

1. 一个 CloudBase 环境，公开回执记录环境 ID、地域和计费模式；负责人由内部运维记录，不写入公开文档。
2. 一个名为 `telemetry` 的 Node.js 20 普通 Event 云函数，入口 `index.main`，安装函数目录中的生产依赖。
3. 一个 NoSQL 集合 `telemetry_events`。禁止公共客户端直接读写；仅让云函数的服务端身份执行插入及必要的运维查询。
4. 一条 HTTP 网关路由：`/v1/track` 指向 `telemetry` Event 云函数，路径透传开启并允许匿名调用。目标模板使用 `protocol=HTTP_TO_HTTPS`；当前系统默认域名实际只能使用 `HTTP_AND_HTTPS`，客户端必须只配置 HTTPS。匿名是因为协议不携带客户端 secret，并不等于取消参数白名单、全局限频或监控。
5. 一个静态托管站点/资源，把 `cloudbase/updates` 发布到 `/updates`。
6. 当前 smoke 使用系统默认 HTTPS 域名；正式业务仍需已备案自定义域名、证书和 DNS，并复验 HTTP 到 HTTPS 跳转及约 300 秒缓存。
7. Task4 已配置网关总 QPS `100`、单客户端 IP QPS `10`。网关外层请求体限制以及日志、告警、预算和保留策略仍需在生产接入前补齐并留证。

仓库的 `cloudbaserc.json.example` 是声明式配置起点，不是生产就绪证明。Task4 使用 CloudBase CLI 3.8.1 验证了核心拓扑，并发现 `hosting.verify`、`hosting.safe` 不被该版本 Schema 接受；集成分支已移除这两个字段。每次重新部署仍须用当时安装的 CLI 做 `validate`、`--dry-run` 并在控制台复核字段兼容性。

## 4. 部署与重新部署步骤

以下命令只供独立部署或重新部署 Task 使用；不要在 SDK 编码 Task 中执行，也不要把本节当成已完成操作的替代证据。

1. 在腾讯云控制台完成账号、实名、计费与 CloudBase 环境创建，记下真实环境 ID。
2. 在数据库页创建 `telemetry_events`，配置为不允许公共端直接读写。
3. 在部署工作站安装 Node.js 20+ 与当前 CloudBase CLI，并登录：

   ```powershell
   npm install --global @cloudbase/cli
   tcb login
   ```

4. 从仓库模板生成仅供本机部署的配置，并填入真实值：

   ```powershell
   Copy-Item -LiteralPath .\cloudbaserc.json.example -Destination .\cloudbaserc.json
   $env:ENV_ID = "<YOUR_CLOUDBASE_ENV_ID>"
   $env:ALLOWED_APP_IDS = "<YOUR_REAL_APP_ID>"
   ```

   `cloudbaserc.json` 含环境 ID，不应误提交。若需要多个 app，使用逗号分隔，例如 `tool-a,tool-b`。模板为避免误绑地域而省略了 `region`；CloudBase CLI 当前允许上海环境省略该项，其他地域必须按目标环境和当日配置 Schema 在正确位置补入真实 `region`，再继续验证。

5. 在根目录安装锁定依赖并完成本地校验：

   ```powershell
   npm ci
   npm run check
   ```

6. 先查看声明式变更计划，确认只包含预期环境、函数、静态资源和路由，再执行部署：

   ```powershell
   tcb validate
   tcb deploy --dry-run
   tcb deploy
   ```

7. 在 CloudBase HTTP 网关/API 网关或相邻安全层确认 `HTTP_TO_HTTPS` 生效，并设置全局和按客户端 IP 限频。模板中的 `qpsTotal=100`、单 IP `limitValue=10` 只是保守起点，需要按真实流量调整。若控制台提供请求体大小规则，将 body 上限设为 4 KiB；若平台最小可选值更大，仍保留函数内 4096 字节硬限制并记录外层实际值。若后续把路由拆到不同域名，需为每个域名分组显式核对协议策略。
8. 为更新 JSON 配置约 5 分钟缓存，即 `Cache-Control: max-age=300` 或控制台等价策略。部署新清单后确认 CDN 刷新；回滚或紧急停更时主动刷新/清除对应路径缓存。
9. 绑定真实 HTTPS 域名后执行本文后面的公网验收。只有全部核验通过，才能把真实 URL 写进业务宿主的发布配置。

如 CLI 模板与当前控制台能力不一致，停止部署并根据同版本官方文档调整该独立部署 Task 中的配置；不要为了“跑通”而把 Event 函数改成端口型 Web 服务。

## 5. 人工环境变量与宿主配置

### CloudBase 与部署工作站

| 名称               | 位置                   | 必需 | 说明                                                            |
| ------------------ | ---------------------- | ---- | --------------------------------------------------------------- |
| `ENV_ID`           | 部署工作站             | 是   | `cloudbaserc.json.example` 的模板替换值；不是客户端配置。       |
| `ALLOWED_APP_IDS`  | `telemetry` 函数运行时 | 是   | 逗号分隔的合法 app ID。空值会安全地拒绝所有 app。               |
| `CLOUDBASE_ENV_ID` | 函数运行时             | 否   | 仅在必须显式覆盖数据库环境时设置；正常 Event 函数使用当前环境。 |

不得把腾讯云 SecretId、SecretKey、API Key 或数据库凭据放进桌面/WebView 客户端。此公共 API 不需要客户端 secret。

### 每个业务宿主的发布配置

宿主应维护并显式映射以下值；这些名称是接入约定，不是 SDK 自动读取的环境变量：

| 发布配置键             | SDK 参数                        | 必需 | 示例占位                               |
| ---------------------- | ------------------------------- | ---- | -------------------------------------- |
| `APP_ID`               | `appId`                         | 是   | `<YOUR_REAL_APP_ID>`                   |
| `APP_VERSION`          | `appVersion` / `currentVersion` | 是   | `0.1.0`                                |
| `CHANNEL`              | `channel`                       | 否   | 省略时为 `official`                    |
| `UPDATE_BASE_URL`      | `UpdateChecker.baseUrl`         | 是   | `https://<YOUR_HTTPS_DOMAIN>/updates`  |
| `TELEMETRY_ENDPOINT`   | `TelemetryClient.endpoint`      | 是   | `https://<YOUR_HTTPS_DOMAIN>/v1/track` |
| `telemetry_enabled`    | `TelemetryClient.enabled`       | 是   | 开发默认 `false`；发布配置明确决定     |
| `update_check_enabled` | `UpdateChecker.enabled`         | 是   | 发布配置明确决定                       |

`platform` 和 `arch` 由宿主从受支持枚举中明确提供：平台为 `windows | macos | linux`，架构为 `x64 | arm64 | ia32`。

## 6. HTTP 路由与协议

| 方法与路径                              | 用途                             | 正常结果          |
| --------------------------------------- | -------------------------------- | ----------------- |
| `POST /v1/track`                        | 接收一个 telemetry 事件          | `202 {"ok":true}` |
| `OPTIONS /v1/track`                     | Tauri/Electron/WebView CORS 预检 | `204`             |
| `GET /updates/<app_id>/<platform>.json` | 静态托管更新清单                 | `200` 与 JSON     |

其他 telemetry 路径返回安全的 404；`/v1/track` 的其他方法返回 405；非法请求返回 `400 {"ok":false,"error":"invalid_payload"}`；未知 app 返回 403；实例突发保护返回 429；内部写入错误只返回通用 500，不返回栈、数据库或环境细节。

CORS 当前允许任意 Origin，但只允许 `POST, OPTIONS` 和 `Content-Type` 请求头。真实业务接入或重新部署时应根据宿主 Origin 和 CloudBase 能力判断是否收紧；桌面自定义 scheme/WebView 的 Origin 必须实际验证。

公网入口必须使用 HTTPS。模板在 `/v1/track` 路由上显式配置 `HTTP_TO_HTTPS`；CloudBase 对同一域名分组采用首条路由的协议设置，因此以后调整域名或路由顺序时必须重新核对，并实测 HTTP 请求确实跳转到 HTTPS。

## 7. update.json 地址模板

SDK 拼接规则固定为：

```text
{UPDATE_BASE_URL}/{app_id}/{platform}.json
```

按仓库的预期托管路径，模板是：

```text
https://<YOUR_HTTPS_DOMAIN>/updates/<YOUR_REAL_APP_ID>/windows.json
```

当前 `example-tool` smoke test 的实际路径为：

```text
https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/updates/example-tool/windows.json
```

真实业务接入时，`<YOUR_HTTPS_DOMAIN>`、`example-tool` 以及示例中的两个 `.example.invalid` 链接都必须替换。Task4 已实测 smoke 路由没有重复的 `/updates/updates/` 或缺少 `/updates/`。

## 8. telemetry API 地址模板

```text
https://<YOUR_HTTPS_DOMAIN>/v1/track
```

当前 `example-tool` smoke test 的实际 API 是：

```text
https://bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com/v1/track
```

该地址是系统默认域名，只能作为本阶段验证与接入准备依据；真实业务仍应使用稳定的自定义 HTTPS 域名。

## 9. 本地测试

需要 Node.js 20+ 与 Python 3.9+；仓库脚本通过 `python` 命令运行客户端测试。在仓库根目录运行：

```powershell
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

也可以一次运行完整检查：

```powershell
npm run check
```

工作区脚本会构建 SDK，运行 SDK 测试、telemetry 函数测试、仓库契约测试、Node bridge 集成测试和 Python unittest。测试覆盖身份首次/再次初始化、事件清洗、网络失败与超时静默、SemVer 和灰度、更新决策、非法请求及未知 app 零写入、服务端 `received_at`、CORS、实例 burst guard 以及 `_id=event_id` 写入策略。

也可以只运行 Python 手动测试客户端的专项测试：

```powershell
npm run build --workspace @bifang/telemetry-update-sdk
node --test .\tests\python-sdk-test-client.test.mjs
python -m unittest discover -s .\tools\python-sdk-test-client\tests -p "test_*.py" -v
```

该工具通过薄 Node JSONL bridge 调用构建后的真实 TypeScript SDK；自动测试只使用捕获 transport、注入 fetch 或 mock，不会向公网 POST/GET。启动和人工操作说明见 [`tools/python-sdk-test-client/README.md`](../tools/python-sdk-test-client/README.md)。

这些是依赖注入/mocked 的本地测试，不等于真实 CloudBase、真实公网、真实数据库或真实宿主 GUI 测试。

## 10. Windows PowerShell 兼容的 curl.exe 命令

Windows PowerShell 中 `curl` 可能是 `Invoke-WebRequest` 的别名，因此必须显式调用 `curl.exe`。下列命令应在独立部署 Task 完成后运行，并先替换其中的公网 URL。Task4 使用旧协议快照完成过等价实测；Task8 已使用当前示例契约完成真实复验。

```powershell
$TelemetryUrl = "https://<YOUR_HTTPS_DOMAIN>/v1/track"
$UpdateUrl = "https://<YOUR_HTTPS_DOMAIN>/updates/example-tool/windows.json"

curl.exe -i -X OPTIONS $TelemetryUrl `
  -H "Origin: tauri://localhost" `
  -H "Access-Control-Request-Method: POST" `
  -H "Access-Control-Request-Headers: Content-Type"

curl.exe -i -X POST $TelemetryUrl `
  -H "Content-Type: application/json" `
  --data-binary "@examples/telemetry-event.json"

curl.exe -i $UpdateUrl
```

Task8 实测结果分别为 204、202 和 200。`examples/telemetry-event.json` 的 `app_id` 是 `example-tool`，所以函数的 `ALLOWED_APP_IDS` 必须暂时包含该值，或先把示例复制到临时文件并替换成真实 app ID。重复发送原样示例会复用同一个 `event_id`，应用层应看到幂等成功而不是新增第二条记录。

## 11. 已实现事件

| 事件                  | 唯一允许的 properties                          | 用途                                                    |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------- |
| `app_install`         | `{}`                                           | 首次建立有效本地安装标记时至多排队一次。                |
| `app_start`           | `{}`                                           | 每次 SDK 初始化。                                       |
| `feature_used`        | `{ feature_id: string }`                       | 记录稳定、非用户输入的功能标识。                        |
| `task_started`        | `{ task_type: string }`                        | 记录任务开始。                                          |
| `task_succeeded`      | `{ task_type: string, duration_ms: 非负整数 }` | 记录任务成功与耗时。                                    |
| `task_failed`         | `{ task_type: string, error_code: string }`    | 记录任务类型与稳定错误码，绝不记录异常原文。            |
| `update_prompt_shown` | `{ target_version: SemVer }`                   | 宿主实际展示更新提示后调用辅助方法。                    |
| `update_clicked`      | `{ target_version: SemVer }`                   | 用户实际点击“更新/立即更新”后调用，不记录其他 UI 动作。 |

功能、任务类型和错误码应是长度不超过 64 的低熵稳定标识符，只含字母、数字、点、下划线、冒号或连字符。客户端和服务端还会拒绝高置信度的 MAC、手机号、UUID、JWT、长十六进制串和疑似 Base64URL；这些语法检查不是语义敏感信息检测器，调用方仍只能传受控枚举，绝不能把用户正文“编码”成标识符绕过隐私边界。

## 12. 新工具复用方法

1. 选定永久、低熵、合法的 `APP_ID`，例如 `invoice-helper`，不要使用显示名称或用户 ID。
2. 在新工具的独立部署/配置 Task 中把该 ID 加入 `ALLOWED_APP_IDS`，重新部署函数配置并验证未知 app 仍被拒绝。
3. 复制 `cloudbase/updates/example-tool/` 为 `cloudbase/updates/<APP_ID>/`；填写全部 14 个键，包括 UI 文案、真实公网 HTTPS URL、可用的安装包 `sha256` 和严格 RFC3339 `published_at`。
4. 用 `update.schema.json` 和仓库测试校验清单；保证 `min_supported_version <= latest_version`。
5. 在宿主中安装/引用 `@bifang/telemetry-update-sdk`。Node 宿主从 `@bifang/telemetry-update-sdk/node` 导入文件存储适配器，并传入该工具自己的绝对 AppConfig 目录；非 Node 宿主实现 `IdentityStorage`。
6. 显式映射六个必需发布配置键；`CHANNEL` 可省略并默认 `official`。开发配置让 telemetry 关闭，发布配置由产品/隐私决策明确开启或关闭。
7. 只从本表选择事件和属性；新增事件属于协议变更，应同时更新客户端类型、客户端清洗、服务端白名单、测试、文档和 schema 版本策略。
8. 宿主实现可选更新、强制更新和退出 UI，完成真实手工验收后再发布。

### SDK 接入示例

```ts
import {
  TelemetryClient,
  UpdateChecker,
  isSafeExternalUrl,
  runUpdateHostHooks,
  type AvailableUpdateDecision,
} from "@bifang/telemetry-update-sdk";
import { NodeFileIdentityStorage } from "@bifang/telemetry-update-sdk/node";

const identityStorage = new NodeFileIdentityStorage(
  hostPaths.absoluteAppConfigDirectory,
);

const telemetry = await TelemetryClient.init({
  appId: releaseConfig.APP_ID,
  appVersion: releaseConfig.APP_VERSION,
  platform: "windows",
  arch: "x64",
  channel: releaseConfig.CHANNEL,
  endpoint: releaseConfig.TELEMETRY_ENDPOINT,
  enabled: releaseConfig.telemetry_enabled === true,
  identityStorage,
});

telemetry.track("feature_used", { feature_id: "export_pdf" });
telemetry.track("task_failed", {
  task_type: "export",
  error_code: "EXPORT_TIMEOUT",
});

async function checkAndPresentUpdate(): Promise<void> {
  const decision = await new UpdateChecker({
    baseUrl: releaseConfig.UPDATE_BASE_URL,
    appId: releaseConfig.APP_ID,
    platform: "windows",
    currentVersion: releaseConfig.APP_VERSION,
    installId: telemetry.installId,
    enabled: releaseConfig.update_check_enabled === true,
  }).check();

  await runUpdateHostHooks(decision, {
    async onOptionalUpdate(update) {
      await host.showOptionalUpdate(update); // “立即更新 / 稍后提醒”
      telemetry.trackUpdatePromptShown(update);
    },
    async onRequiredUpdate(update) {
      await host.showRequiredUpdate(update); // “立即更新 / 退出”
      telemetry.trackUpdatePromptShown(update);
      host.blockIncompatibleActions();
    },
  });
}

function checkForUpdatesInBackground(): void {
  setTimeout(() => {
    void checkAndPresentUpdate().catch(() => undefined);
  }, 0);
}

await host.completeStartupAndShowMainWindow();
checkForUpdatesInBackground();

async function openUpdateAfterUserClick(update: AvailableUpdateDecision) {
  if (!isSafeExternalUrl(update.config.download_url)) return;
  telemetry.trackUpdateClicked(update);
  await host.openExternal(update.config.download_url);
}
```

更新检查必须像上例或 `examples/host-integration.ts` 一样，在应用启动完成并显示主界面后显式触发。触发函数同步返回，不等待最长 3 秒的网络，也不等待 UI hook；异常在后台静默。初始化路径不得直接 `await checker.check()`。`drain()` 只适合测试或宿主明确的短暂关闭阶段；正常业务不要等待埋点发送。SDK 不下载、不校验安装包签名或 `sha256`、不执行安装，也不打开浏览器。

## 宿主 UI 与安全责任

SDK 只返回决策并提供 hooks。宿主必须负责：

- `optional`：展示“立即更新 / 稍后提醒”，用户选择后才打开经过校验的 HTTPS 链接。
- `required`：后台检查返回该决策后展示“立即更新 / 退出”，并阻止后续不兼容操作；不要让启动路径等待更新网络，也不要提供“稍后提醒”。
- 真正展示后再调用 `trackUpdatePromptShown()`；只有用户真正点击“更新/立即更新”后才调用 `trackUpdateClicked()`。稍后提醒和退出不是该事件。
- 使用系统浏览器或平台认可的安全 API 打开 URL；不要在高权限内嵌 WebView 中直接执行远端内容。
- 把清单的 `title` 与 `message` 当作不可信纯文本渲染，绝不作为 HTML 或 Markdown 注入 UI。
- 业务发布流程自行负责安装包签名、哈希/签名校验、下载、安装、回滚和用户数据兼容性。这些均不属于 SDK。

## 隐私边界与输入限制

禁止采集或变相采集：姓名、邮箱、手机号、身份证号、账号、密码、Token、Cookie、MAC、硬盘号、CPU/机器码、浏览器指纹、文件路径、文件内容、用户正文、聊天内容、剪贴板、完整 URL、异常原文或可还原这些内容的编码值。

服务端边界：

- 原始 UTF-8 body 最大 4096 字节，必须是 `application/json`；拒绝 base64 编码请求和二进制 body。
- `properties` 最多 20 个键，只允许 string/number/boolean；拒绝嵌套对象和数组。
- 单个字符串最多 200 个 Unicode code point，并拒绝控制字符及显式 base64/data URL 前缀。
- 功能、任务类型和错误码还执行更窄的标识符校验，拒绝高置信度的 MAC、手机号、UUID、JWT、长十六进制串和疑似 Base64URL；这只能提供纵深防御，不能替代调用方的受控枚举白名单。
- 每个事件还必须满足上表的专属精确字段集；SDK 遇到缺字段、旧别名或额外字段会丢弃整个事件，服务端则拒绝整个请求，二者不会静默裁剪成另一种形状。
- `duration_ms` 必须是 0 到 604800000 的安全整数。
- `app_id`、UUID v4、严格 SemVer、ISO 时间、平台、架构、channel、SDK 版本和事件名都经过校验。
- `received_at` 始终由服务端覆盖生成；客户端 IP 不写业务数据库。

函数内另有每个 warm instance、每个 app ID、10 秒最多 120 次的轻量 fixed-window burst guard。这不是全局限流：实例扩容或冷启动后计数不共享，不能替代 CloudBase HTTP 网关/API 网关的全局 QPS、单 IP 限频、WAF/防滥用和请求体限制。

## 幂等与索引取舍

服务端将 `event_id` 同时用作 CloudBase 文档 `_id`。CloudBase `_id` 的唯一性可让同一个请求因网关重放或调用方重复发送时最多保存一份；writer 将可识别的 duplicate-key/已存在错误视作已经接受。无需额外的复合唯一索引，查询时仍可按实际报表需求另建 `app_id + received_at` 等普通索引。

这是尽力而为的幂等策略：

- 当前 SDK 本身不重试，所以幂等主要防重复调用或基础设施重放。
- 本地 mock 验证 `_id=event_id` 和重复错误识别；Task4 又用真实 CloudBase SDK/集合验证了同一事件重复提交时数据库精确计数仍为 1。
- 若平台返回了当前识别逻辑之外的错误码，重复请求可能返回通用 500，但仍不应覆盖已有文档。
- 不能用同一 `event_id` 发送不同内容；后来的内容不会替换先前记录。

## 更新发布、缓存与回滚

1. 在独立发布流程中完成安装包构建、签名和安全扫描，把产物与 release notes 放到真实公网 HTTPS URL。
2. 先用小范围 `rollout` 发布可选更新；确认指标和人工反馈后逐步提高。改变 `latest_version` 会重新计算稳定桶。
3. 只有版本确实不兼容时才提高 `min_supported_version` 或启用 `force_update`。`force_update` 不会让已是最新版本的客户端重复提示。
4. 修改对应平台 JSON，运行 `npm run check`，review 14 个精确键、真实 URL、版本、文案、哈希与发布时间，再部署静态文件。
5. 将更新 JSON 的 CDN/浏览器缓存保持在约 5 分钟，并在发布后从真实公网 URL 检查内容与 `Cache-Control`。短缓存意味着配置收敛仍可能延迟约 5 分钟。
6. 回滚时恢复上一份清单或设 `enabled=false`，重新部署并刷新该 JSON 的 CDN 缓存；必要时保留旧安装包 URL，避免仍在缓存窗口内的客户端拿到失效链接。

## 故障静默语义

Telemetry 发送失败、超时、服务端拒绝、身份文件错误及 debug logger 错误都不会打断宿主。失败事件直接丢弃且不重试。更新检查失败、超时、内容超限、JSON 非法、配置不匹配或 URL 不安全时返回 `none`，宿主应继续正常运行。

“静默”只适用于最终用户控制流，不表示运维可以忽略故障。正式生产接入应为函数 5xx、429、调用量、数据库写入失败、成本和更新 URL 4xx/5xx 建立不含事件正文的聚合监控与告警。

## CloudBase 控制台验收清单

Task4 的首次部署和 Task8 的当前契约复验均已记录在部署回执；下面保留为后续重新部署及正式生产接入时的持续验收清单：

- 环境：ID、地域、计费状态与部署账号正确。
- 函数：名称 `telemetry`，类型为普通 Event，Node.js 20 运行时，入口 `index.main`，依赖安装成功；没有端口 9000 健康检查要求。
- 环境变量：`ALLOWED_APP_IDS` 只含批准的 app；确认是否使用默认当前环境或显式 `CLOUDBASE_ENV_ID`。
- 数据库：`telemetry_events` 已存在，公共端权限关闭，函数可插入；文档 `_id` 等于 `event_id`，`received_at` 是服务端时间，记录中无 IP、原始 body 或未知字段。
- 网关：真实 HTTPS 域名的 `/v1/track` 指向 Event 函数，路径透传正确，匿名调用、OPTIONS/CORS、QPS/单 IP 限制和 body 限制符合预期。
- 静态托管：真实 URL 能读取对应 JSON，路径没有重复，响应是预期内容。当前默认域名强制 `no-store`；正式自定义域名需把缓存设为约 300 秒并重新留证。
- 协议：合法 POST 为 202；非法 JSON 为 400 且集合无写入；未知 app 为 403 且集合无写入；OPTIONS 为 204；服务端错误不泄露栈或资源信息。
- 幂等：连续两次发送相同 `event_id`，HTTP 行为符合文档，集合只保留一条。
- 宿主：在真实测试版本中分别人工走通 optional 的“立即更新/稍后提醒”和 required 的“立即更新/退出”，并验证 telemetry 关闭时没有网络发送。

## 部署回执与剩余生产风险

- Task7 校正了本地源码、示例、测试和文档；Task8 已将该版本的 telemetry 函数与静态清单部署到 Task4 的现有环境，并完成公网、数据库和内容一致性验收。以后任何协议或依赖变更仍必须在独立部署 Task 中重做这些验收。
- CLI schema、Node.js 运行时名称和控制台选项可能随 CloudBase 版本或地域变化，必须以每次部署当日的 CLI `validate`、`--dry-run` 与控制台为准。
- Task4/Task8 已公网验证当前环境的 HTTP event shape、路径透传、CORS、自定义 scheme Origin 和响应头；更换环境、域名、路由或运行时后必须重新实测。
- Task4/Task8 已验证当前环境身份访问 NoSQL、集合权限和重复事件幂等；更换环境、地域或 SDK 后必须重新验证。
- 当前系统默认域名不能设置 HTTP 强制跳转，且强制 `Cache-Control: no-store`。自定义域名备案/证书/DNS、生效时间、CDN 缓存与刷新仍取决于真实账号和地域。
- 模板限频值只是起点，无法替代容量评估、防滥用策略、预算告警和数据保留/删除政策。
- SDK 的 URL 校验是降低误用风险，不是安装包供应链验证；签名、哈希、发布账号安全和回滚仍由业务发布流程负责。

## 官方参考

- [通过 HTTP 访问云函数](https://docs.cloudbase.net/service/access-cloud-function)
- [CloudBase 网关配置](https://docs.cloudbase.net/cli-v1/gateway)
- [CloudBase CLI 部署云函数](https://docs.cloudbase.net/cli-v1/functions/deploy)
- [CloudBase 静态网站托管快速开始](https://docs.cloudbase.net/hosting/quick-start)
- [CloudBase 静态资源与缓存管理](https://docs.cloudbase.net/hosting/manage)
- [`@cloudbase/js-sdk` 初始化与 Node.js 运行环境](https://docs.cloudbase.net/en/api-reference/webv3-next/initialization)
- [CloudBase Node.js 适配器](https://docs.cloudbase.net/api-reference/webv3-pg/adapter/node-adapter)
