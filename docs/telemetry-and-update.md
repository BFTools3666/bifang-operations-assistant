# 每日启动遥测与 Application-version API v1

## 1. 现行协议

基础设施根版本为 `3.0.0`，接入 Skill 为 `2.0.0`，application-version 契约为 `1.0.0`。现行能力只有两部分：

1. 固定 `daily_active` 的低频启动遥测；
2. 固定入口 `/tools/version-control/v1` 的版本、广告和管理契约。

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
- 当前 SDK/适配器版本 `sdk_version`
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

## 3. Application-version API v1

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

主窗口显示完成后异步检查版本，不阻塞启动。标题与正文按不可信纯文本渲染；下载/说明 URL 必须再次验证为安全公网 HTTPS。提示更新可稍后处理；强制更新退出必须走宿主完整退出路径，释放托盘、快捷键、输入观察器、录制或后台资源。

Tauri/Rust 把凭据、HTTP 和固定请求保留在 Rust 可信层；WebView 只能接收更新决策和固定动作。Node/Electron 把这些能力留在主进程，以最小 IPC 通知 renderer。任何框架都不能让前端提交任意 URL、文件路径或读取凭据。

应用自己的版本号必须来自唯一发布来源。旧版本检查实现、静态清单 URL、14 字段 parser、rollout 算法和兼容开关在迁移中直接删除；通用 SemVer、安全外链和完整退出逻辑可继续复用。

## 6. 验收

### 本地

- Profile v2 通过 Schema 和确定性语义校验；
- Base URL 精确单层 v1，`/v1/v1` 被拒绝；
- 发布流 code 唯一且绑定准确平台/架构/渠道；
- 两个认证头均发送，Key/Secret 不出现在源码、Profile 或日志；
- 版本无更新、提示、强制、停止和错误包装均按契约处理；
- 超时、400/401/403/404/429/500 安静失败且不阻塞主窗口；400 可作为网关收到请求的联通结果，不是版本检查成功；
- telemetry 的联网前落盘、同日一次、失败不重试保持不变；
- 完整扫描证明生产代码、配置和活跃测试没有旧静态更新协议。

### 公网 HTTP

- 当前免费环境、默认域名、函数、路由、集合、索引、凭据绑定和费用经过最新只读预检；
- 明确确认后才部署或写测试数据；
- 十个端点、鉴权、跨 app/code 拒绝、限流、事务和审计得到真实请求证据；
- 旧静态云资源只在两个真实客户端新协议 E2E 后，按精确清单再次确认删除。

### 真实客户端

- 证据绑定本次 EXE/APP 的版本、SHA-256、安装路径、进程、窗口和实际请求；
- 鼠标精灵完成 Windows 新协议场景且不再请求旧协议；
- 录屏助手 Windows 使用独立 code；macOS 必须在真实 Mac 上单独验证；
- 构建、HTTP E2E、WebView/DOM 检查和原生 GUI E2E 分开报告，不能互相替代。

## 7. 运维与隐私

运营看板只读取服务端聚合结果，不暴露 `ADMINONLY` 集合。真实零值按零显示，读取失败显示“生产数据暂时不可用”。外发截图遮挡 Token、凭据、IP 和其他个人信息。

发布、推送、部署、购买和删除都不是测试通过后的自动动作。每次外部写入先展示最终目标和最新预检，再等待负责人明确“继续”。
