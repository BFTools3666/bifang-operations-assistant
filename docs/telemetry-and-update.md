# 每日启动遥测与客户端更新

当前个人分支数据库默认 PostgreSQL + pgdoc，HTTP 合同保持不变；三类服务统一使用 Node SDK v3。数据库资源及 TTL 核验边界见 [PostgreSQL 适配](../skills/bifang-public-services-onboarding/references/postgresql.md)。

> 本文记录既有基础设施与公司模式历史，不是个人版执行入口；正文所称“新接入”和门禁均按历史语境理解。个人流程已定义环境、资源、参数/请求、UI 与本地实施、客户手动发布配置及预检五道门禁，以 [个人版接入指南](毕方小工具公共服务分步接入指南.md) 和 [个人版第五门禁](../skills/bifang-public-services-onboarding/references/personal-update-preflight.md) 为准，预检通过后才进入 EXE 测试；不得把历史公司 POST/201 或 block_new_operations 套入个人 GET/200。历史协议链接固定到旧版标签。

## 1. 现行协议

基础设施根版本为 `3.0.0`，接入 Skill 为 `2.1.5`。第一个硬门禁必须确认仅更新、仅统计或两者，明确回答前不进入接入流程。以下两项按用户选择独立接入，不默认捆绑：

1. 固定 `daily_active` 的低频启动遥测；
2. 客户端更新中心 `https://update.meetelf.com` 的 POST 更新协议。

负责人明确要求本机联调时，可使用 `http://127.0.0.1:8080/`；该本地地址及测试结果不作为生产服务或客户端线上 E2E 的验证依据。

旧 application-version 版本、广告和管理服务仍可能在线运行，下文第 3 节仅记录其历史合同；不得当作新客户端接入说明或自动删除。新协议见 [客户端更新中心接入合同](https://github.com/BFTools3666/bifang-operations-assistant/blob/skill-v2.1.5-company-managed/skills/bifang-public-services-onboarding/references/client-update-center.md)。

旧静态更新清单已经退出现行协议。由于毕方客户端旧版本未公开发布，不提供双轨、兼容模式、回退开关或旧清单解析。历史部署回执只证明当时发生过什么，不是可继续实现的规范。

## 2. Daily-active 统计口径

`daily_active` 表示一个匿名安装在北京时间当天正常启动使用过，**不是安装动作、账号人数或功能使用次数**。安装后未启动不计；同一人多台设备可能多计，清除 AppConfig 或重装可能生成新的匿名安装 ID。

客户端只提供：

- `schema_version = 2`
- 一次性 UUID v4 `event_id`
- 固定 `event = daily_active`
- 当前工具 `app_id` 与 SemVer `app_version`
- AppConfig 中持久化的匿名 UUID v4 `install_id`
- `platform`、`arch`
- 固定 `sdk_version = 3.0.0`，服务端等值校验，不使用 Rust crate/适配器版本
- UTC RFC3339 `occurred_at`

不采集账号、用户名、主机名、MAC、硬盘号、CPU 序列号、渠道、功能点击、任务内容或任意 `properties`。客户端不得发送 IP、`active_date` 或 `received_at`；来源 IP 和两个时间字段只由服务端可信上下文补充。

### 2.1 客户端门禁

1. 在应用专属 AppConfig 目录、以 APP_ID 隔离地原子读取或创建 `install_id`。
2. 正常启动时按 `Asia/Shanghai` 计算当天日期。
3. **在联网前**原子领取并落盘当天已尝试标记。
4. 只有领取成功的进程才低优先级发送一次；失败当天不重试、不排离线队列。
5. 遥测初始化和网络失败均不能阻塞主窗口。

服务端以 `app_id + active_date + install_id` 生成确定性 `_id`，抵御并发或网关重放。服务端幂等不能替代客户端联网前落盘，因为到达函数前已经消耗网关额度。

### 2.2 精确请求

```http
POST /apps/<app_id>/v1/track
Content-Type: application/json
```

```json
{
  "schema_version": 2,
  "event_id": "28dc8ac6-cb7f-4f50-a4a8-d3d73cf4796f",
  "event": "daily_active",
  "app_id": "bifang-mouse-clicker",
  "app_version": "0.2.4",
  "install_id": "5e74d84a-1972-4c1f-b27c-85b3b441f152",
  "platform": "windows",
  "arch": "x64",
  "sdk_version": "3.0.0",
  "occurred_at": "2026-09-10T04:00:00.000Z"
}
```

成功固定返回 `202 {"ok":true}`；同日同安装重复请求也返回 202，但集合仍只有一个文档。OPTIONS 返回 204。路径、方法、字段、APP_ID、大小、时间或来源不合法时拒绝且零写入；内部写入失败返回 500，不伪造成功。

### 2.3 应用版本的来源与验证

`app_version` 已是既有协议的必填字段，不另设版本上报接口。公共 SDK 将宿主 `appVersion` 写入此字段；原生适配器发送相同的十字段对象。版本来自当前实际运行制品的唯一发布配置或宿主版本 API，不能使用 SDK 版本、Profile 快照或写死的占位值。`sdk_version` 固定为 `3.0.0`，服务端进行等值校验，不能填 Rust crate/适配器的实际版本；应用恰好也为 `3.0.0` 合法。

十字段类型、UUID v4、SemVer 长度、日期格式、4096 字节上限与错误响应见 [CloudBase 日活完整合同](https://github.com/BFTools3666/bifang-operations-assistant/blob/skill-v2.1.5-company-managed/skills/bifang-public-services-onboarding/references/integration-contract.md#cloudbase-日活完整合同)。当前日活没有客户端 Bearer 或 x-app-key/x-app-secret；下面历史服务的认证头不得用于日活。服务端 active_date 取接收时间对应的北京时间日期，不由 occurred_at 决定。

本地验收捕获宿主实际序列化请求，断言版本值与来源一致；更换测试版本来源后，在新的测试日期上报应随之变化。缺字段、空值或非法 SemVer 被拒绝，不自动补 `0.0.0`。即使当天升级了客户端，也不清除已领取的每日门禁；下一次正常的新日上报再反映新版本。不得为了即时显示版本新增事件、同日重报或绕过存储门禁。

看板活跃版本画像读取 telemetry 的 `app_version`；“发布流最高版本”读取管理端 `versions_*` 的已发布 `code_version`。客户端每日上报和更新检查均不创建正式发布记录，版本发布必须按管理写入的独立授权完成，不能将观测到的客户端版本自动发布。

## 3. 既有 Application-version API v1（历史服务）

机器权威是：

- [`../contracts/application-version-api-v1/openapi.json`](../contracts/application-version-api-v1/openapi.json)
- [`../contracts/application-version-api-v1/schema.json`](../contracts/application-version-api-v1/schema.json)
- [`../contracts/application-version-api-v1/fixtures/runtime-decision-cases.json`](../contracts/application-version-api-v1/fixtures/runtime-decision-cases.json)
- [`../cloudbase/functions/application-version-api`](../cloudbase/functions/application-version-api)

规范 Base URL：

```text
https://<平台默认域名>/tools/version-control/v1
https://gateway.kaiwhale.com/tools/version-control/v1  # 已批准生产网关
```

已批准生产网关只为 application-version 提供同一单层 v1 入口；telemetry 继续走 CloudBase 默认 origin。Profile 校验器对独立网关使用精确允许列表，不接受任意自定义域名。

`v1` 是 API 版本，只出现一次；服务端不提供双 `/v1` 别名。所有请求发送：

```http
x-app-key: <runtime-or-management-key>
x-app-secret: <runtime-or-management-secret>
```

凭据原值不得进入 Git、Profile、普通日志、命令行参数或截图。服务端只保存密码学摘要，并把凭据绑定到准确 `app_id`、允许的 `codes` 与最小 `scopes`。

### 3.1 客户端运行时

```http
GET /versions/{code}/{currentVersion}
GET /app/{code}/ads/show
```

版本检查返回冻结的裸七字段 JSON 对象，客户端映射无更新、提示更新、强制更新和停止更新。广告端点返回裸数组；只有产品已存在广告界面或负责人另行批准该产品能力时才接入，不能为“凑齐接口”扩张客户端功能。

每份客户端运行凭据只绑定一个发布流 code，且只给 `versions:check`。运行时凭据不能展示广告、列表、读取详情或写管理数据。管理读取固定为 `versions:read + ads:read`，管理写入固定为另一份 `versions:write + ads:write` 凭据；部署配置必须覆盖每条登记发布流，并全局提供一份不可导出的 `contract-ads-*` 凭据执行 `ads:show` 契约测试。

### 3.2 管理端

管理端共八个端点，执行版本/广告的列表、详情、创建、修改和删除。读写 scope 分离，写入与审计记录在同一数据库事务中；失败不得留下无审计的业务写入。精确方法、Path、请求/响应和错误码以机器契约为准，不能从摘要猜测。

### 3.3 平台和发布流

运行时请求没有 `platform` 或 `arch` 字段，所以每个 `(platform, architecture, channel)` 使用一个独立 `code`。不得依赖 User-Agent 猜平台，尤其不能据此发布强制更新。

推荐稳定流：

```text
bifang-mouse-clicker
bifang-screen-recorder-windows-x64
bifang-screen-recorder-macos-arm64
```

不同 code 可以属于同一 APP_ID，但每份客户端运行凭据只能允许其中一个 code；同一应用的不同平台/架构不能共用一份运行凭据。

## 4. CloudBase 隔离

所有工具复用一个负责人确认的现有免费环境和平台默认 HTTPS 域名：

- telemetry：每个 APP_ID 一套 `telemetry-<app_id>`、`/apps/<app_id>/v1/track` 和 `telemetry_<normalized_app_id>`；
- version service：一个 `application-version-api` 和一个 `/tools/version-control/v1`；
- data：每个 APP_ID 独立 `versions_<normalized>`、`ads_<normalized>`、`audit_<normalized>`，权限固定 `ADMINONLY`；
- auth：共享函数先认证再选定集合，不能根据客户端自由输入跨应用搜索。

它们仍共享额度和平台故障域。任何非零金额、套餐升级、按量超限、自动续费、资源包、自定义域名或证书购买提示都必须停止；不得自行创建第二个环境。

## 5. 宿主接入

新客户端以 [客户端更新中心接入合同](https://github.com/BFTools3666/bifang-operations-assistant/blob/skill-v2.1.5-company-managed/skills/bifang-public-services-onboarding/references/client-update-center.md) 为准：POST、运行时客户端 Token、目标字段、强更策略、下载校验和安装前复检均按新协议实现。旧 GET、code 和两个认证头仅适用于仍在运行的历史服务。

标题与正文按不可信纯文本渲染；下载/说明 URL 必须再次验证为安全 HTTPS。强更阻止新业务，不中断已运行任务，并保留更新、重试和完整退出；离线行为按产品明确选择的策略处理。

Tauri/Rust 把凭据、HTTP 和固定请求保留在 Rust 可信层；WebView 只能接收更新决策和固定动作。Node/Electron 把这些能力留在主进程，以最小 IPC 通知 renderer。任何框架都不能让前端提交任意 URL、文件路径或读取凭据。

应用自己的版本号必须来自唯一发布来源。旧版本检查实现、静态清单 URL、14 字段 parser、rollout 算法和兼容开关在迁移中直接删除；通用 SemVer、安全外链和完整退出逻辑可继续复用。

## 6. 验收

### 本地

新协议验收以客户端更新中心接入合同为准：检查 POST 和目标字段、Bearer、201/错误、强更/离线、下载校验、安装前复检及真实安装后的版本。以下旧 GET/CloudBase 版本服务检查仅适用于该历史服务，不作为新客户端接入完成条件。

- Profile v2 通过 Schema 和确定性语义校验；
- Base URL 精确单层 v1，`/v1/v1` 被拒绝；
- 发布流 code 唯一且绑定准确平台/架构/渠道；
- 两个认证头均发送，Key/Secret 不出现在源码、Profile 或日志；
- 版本无更新、提示、强制、停止和错误包装均按契约处理；
- 超时、400/401/403/404/429/500 安静失败且不阻塞主窗口；400 可作为网关收到请求的联通结果，不是版本检查成功；
- telemetry 的联网前落盘、同日一次、失败不重试保持不变；
- 捕获宿主序列化请求，`app_version` 与唯一版本来源一致，`sdk_version` 独立正确；更换来源版本和测试日期后值随之变化，缺失/非法版本无有效写入；
- 完整扫描证明生产代码、配置和活跃测试没有旧静态更新协议。

### 公网 HTTP

- 当前免费环境、默认域名、函数、路由、集合、索引、凭据绑定和费用经过最新只读预检；
- 明确确认后才部署或写测试数据；
- 十个端点、鉴权、跨 app/code 拒绝、限流、事务和审计得到真实请求证据；
- 旧静态云资源只在两个真实客户端新协议 E2E 后，按精确清单再次确认删除。

### 真实客户端

- 证据绑定本次 EXE/APP 的版本、SHA-256、安装路径、进程、窗口和实际请求；
- 服务端接受的 `app_version` 与该制品版本一致，并可在对应应用/平台/架构的活跃版本画像核对；同日门禁已领取时等待正常新日，不重置生产身份或每日状态；
- 鼠标精灵完成 Windows 新协议场景且不再请求旧协议；
- 录屏助手 Windows 使用独立 code；macOS 必须在真实 Mac 上单独验证；
- 构建、HTTP E2E、WebView/DOM 检查和原生 GUI E2E 分开报告，不能互相替代。

## 7. 运维与隐私

运营看板只读取服务端聚合结果，不暴露 `ADMINONLY` 集合。真实零值按零显示，读取失败显示“生产数据暂时不可用”。外发截图遮挡 Token、凭据、IP 和其他个人信息。

发布、推送、部署、购买和删除都不是测试通过后的自动动作。每次外部写入先展示最终目标和最新预检，再等待负责人明确“继续”。
