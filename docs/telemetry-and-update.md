# 每日启动统计与更新服务 Phase 1

本文是 `毕方运营精灵` 公共基础设施仓库的长期维护文档。第一期只解决两个问题：

1. 软件今天是否被启动使用过，以及大致是什么系统、架构和来源 IP。
2. 客户端启动后检查静态 `windows.json`，判断是否有可选或必须更新。

当前基础设施根版本为 `2.1.0`。新增的跨项目接入向导 `$bifang-public-services-onboarding` 版本为 `1.0.0`；本次没有改变 SDK 公共 API 或线上协议，因此 `@bifang/telemetry-update-sdk` 继续保持 `2.0.0`。

统计事件固定为 `daily_active`，表示“软件在北京时间当天第一次启动使用”，**不是安装事件**。安装后从未启动不计数；同一个匿名 `install_id` 按 `Asia/Shanghai` 每天最多上报一次。第一期不统计渠道、功能点击、任务开始/成功/失败、更新提示或更新点击，也不接收任意 `properties`。

Task4/Task8 在 2026-09-03 部署并验收的是历史 v1 多事件协议。证据保留在 [历史 v1 部署回执](cloudbase-deployment.md)，但它不证明当前 `daily_active` 版本已部署。发布新版客户端前必须先部署新版云函数并重新验收。

当前方案支持多个小工具。它们可以共用一个免费 CloudBase 环境和默认 HTTPS 域名，但每个工具必须拥有独立的应用编号、函数、路由、数据库集合、本地状态目录和更新清单。这样统计数据和版本发布完全分开，只共享平台免费额度。命名和新增流程见[多工具隔离指南](multi-tool-isolation.md)。

全部工具登记在 `cloudbase/apps.json`。新增工具使用 `npm run cloudbase:app:add -- <app_id>`；该命令会安全创建默认关闭的更新清单，并重生成同时包含所有已登记函数和路由的 `cloudbaserc.json.example`。部署前用 `npm run cloudbase:config:check` 防止登记表、更新文件和生成模板漂移。

跨项目向导的权威源码位于 [`skills/bifang-public-services-onboarding`](../skills/bifang-public-services-onboarding)。每次修改公共协议、资源命名、SDK 接入顺序或上线门禁时，都必须同步检查该 Skill 的版本元数据、三份按阶段加载的参考资料、Profile Schema、确定性脚本和行为测试。Skill 只引用本仓库权威路径并记录对应基础设施版本与源提交，不复制整份长期文档。

## 1. 统计口径

### 1.1 “每天有多少人在用”怎么计算

进入目标工具自己的 `telemetry_<规范化应用编号>` 集合后，固定筛选：

- `event = daily_active`；
- `app_id = 目标应用`；
- `active_date = 目标北京时间日期`。

服务端使用 `app_id + active_date + install_id` 生成确定性文档 `_id`，所以同一匿名设备当天即使发生请求重放，集合中也只保存一条。筛选后的文档数量就是“当天实际启动设备数”，无需再按 IP 去重。

这个数只能近似观察使用人数，**不是账号人数**：

- 同一人使用两台设备会计为两台启动设备。
- 重装软件或清除本地标记可能生成新的 `install_id`。
- 多个人可能共用一台电脑。
- 本阶段没有账号体系，也不采集账号名、主机名、MAC、硬盘号、CPU 序列号或浏览器指纹。

### 1.2 为什么 IP 不能用于人数去重

家庭、公司、学校或网吧中的多台设备可能共用同一个公网 IP；移动网络、拨号和代理也可能让同一设备的 IP 改变。因此 `source_ip` 只适合排查来源和粗略安全分析，不能当作用户 ID，也不能用于“人数”去重。

`source_ip` 属于个人信息。正式接入前必须：

- 在隐私说明中明确告知收集目的。
- 只保留完成目的所必需的最短时间，并建立到期删除流程。
- 限制数据库访问权限。
- 对外分享截图、日志或导出文件时遮挡 IP。
- 不把 IP 拼接进客户端 `install_id`，也不建立跨应用画像。

## 2. 省流量设计

客户端只在软件启动时检查当天标记：

1. 根据 `Asia/Shanghai` 计算今天。
2. 在联网前原子写入“今天已尝试上报”的本地标记。
3. 只有抢到当天标记的进程才排队发送一个 `daily_active`。
4. 即使网络超时、网关限流或服务端失败，当天也不重试，不建立离线队列。
5. 第二天第一次启动才有下一次上报机会。

这项取舍优先保护免费网关，接受偶发少计。同一程序当天反复启动不会持续请求；测试程序模拟 10 台匿名设备时最多产生 10 次 POST。从同一测试电脑发送时，这 10 台模拟设备通常具有相同公网 IP，这是正常现象。

服务端还有第二道幂等保护：同一 `app_id + active_date + install_id` 只能保存一份。它用于处理网关重放或并发，不应代替客户端的每日落盘门禁，因为到达云函数前的请求已经消耗网关额度。

## 3. 架构

```text
业务宿主启动
  ├─ AppConfig 目录
  │    ├─ 匿名 install_id
  │    └─ 每日上报标记（Asia/Shanghai，发送前落盘）
  ├─ TelemetryClient ─HTTPS POST─> /apps/<app_id>/v1/track
  │                                      └─> telemetry-<app_id> Event 云函数
  │                                             └─> telemetry_<规范化app_id>
  └─ UpdateChecker ─HTTPS GET─> /updates/<app_id>/<platform>.json
                                └─> none | optional | required
```

### TypeScript SDK

`packages/telemetry-update-sdk` 是无框架依赖的库：

- `InstallIdentity` 创建并持久化随机 UUID v4 `install_id`。
- `NodeFileIdentityStorage` 由宿主传入该软件自己的绝对 AppConfig 目录；它不猜测系统目录，不读取任何硬件身份。
- `TelemetryClient.init()` 在启动初始化时尝试领取当天标记，成功后低优先级发送唯一的 `daily_active`。
- telemetry 默认关闭；只有 `enabled: true` 且应用、版本、平台、架构和 HTTPS endpoint 全部合法时才发送。
- 默认超时 2 秒，失败静默，不重试，不建立离线队列，不影响业务启动。
- 不再暴露渠道、功能、任务、安装或更新交互上报入口。
- `UpdateChecker` 默认超时 3 秒；网络或配置异常时静默返回 `none`。

### CloudBase 云函数

`cloudbase/functions/telemetry` 是所有工具复用的 Node.js 20 CommonJS 函数源码，入口 `index.main`。部署时为每个工具创建一份独立 Event 云函数，例如 `telemetry-bifang-tools`；HTTP 网关把 `POST /apps/bifang-tools/v1/track` 包装成 Event 后调用它。它不是监听 9000 端口的 Web 云函数。

函数只做以下工作：

1. 检查路径、方法、Content-Type、4 KiB body 上限和精确字段拓扑。
2. 只接受 schema v2、SDK 2.0.0 和固定事件 `daily_active`。
3. 检查请求中的 `app_id` 是否与该函数唯一配置的 `ALLOWED_APP_IDS` 相同；新模板中这个变量只允许一个值。
4. 按服务端时钟生成 `active_date` 和 `received_at`。
5. 只从 CloudBase 可信请求上下文读取 `source_ip`；忽略客户端可伪造的 `X-Forwarded-For` 等请求头，取不到时保存 `null`。
6. 生成每日确定性 `_id` 并写入该函数由 `TELEMETRY_COLLECTION` 指定的独立集合；重复键视为已接受。

函数不保存原始 body、全部请求头、Cookie、Token 或未知字段。数据库由云函数当前环境身份访问，公共客户端不需要也不得持有腾讯云 SecretId、SecretKey、API Key 或数据库凭据。

## 4. 精确协议

### 4.1 客户端 POST

```json
{
  "schema_version": 2,
  "event_id": "01234567-89ab-4def-8123-456789abcdef",
  "event": "daily_active",
  "app_id": "bifang-tools",
  "app_version": "0.1.0",
  "install_id": "11111111-2222-4333-8444-555555555555",
  "platform": "windows",
  "arch": "x64",
  "sdk_version": "2.0.0",
  "occurred_at": "2026-09-04T01:00:00.000Z"
}
```

真正描述应用/设备的客户端字段只有：

| 字段          | 含义                        |
| ------------- | --------------------------- |
| `app_id`      | 应用编号                    |
| `app_version` | 当前软件版本                |
| `install_id`  | 本地生成的匿名安装标识      |
| `platform`    | `windows \| macos \| linux` |
| `arch`        | `x64 \| arm64 \| ia32`      |

`schema_version`、固定 `event`、一次性 `event_id`、`sdk_version`、`occurred_at` 是协议控制字段，不包含渠道、功能、任务或用户输入。请求不得包含 `channel`、`session_id`、`properties`、IP 或其他额外键；额外键会导致 400 且不写库。

### 4.2 服务端存储

在验证后的客户端字段之外，服务端添加：

| 字段          | 说明                                                            |
| ------------- | --------------------------------------------------------------- |
| `_id`         | `sha256(app_id + active_date + install_id)`，用于每天每安装幂等 |
| `active_date` | 服务端按 `Asia/Shanghai` 计算的 `YYYY-MM-DD`                    |
| `received_at` | 服务端实际接收时间，UTC RFC3339                                 |
| `source_ip`   | CloudBase 可信请求上下文中的来源 IP；不可得时为 `null`          |

客户端发送同名字段、伪造转发头或未知字段都会被拒绝或忽略，不能覆盖服务端值。

### 4.3 HTTP 结果

| 方法与路径                              | 用途                    | 结果              |
| --------------------------------------- | ----------------------- | ----------------- |
| `POST /apps/<app_id>/v1/track`          | 接收一个 `daily_active` | `202 {"ok":true}` |
| `OPTIONS /apps/<app_id>/v1/track`       | CORS 预检               | 204               |
| `GET /updates/<app_id>/<platform>.json` | 获取静态更新清单        | 200 与 JSON       |

其他 telemetry 路径返回 404；错误方法返回 405；非法 payload 返回 400；未知 app 返回 403；实例突发保护可能返回 429；内部错误返回通用 500。客户端对任何失败都静默丢弃，当天不重试。

公网配置只接受 HTTPS。CloudBase 平台默认域名已提供 HTTPS，本阶段不要求购买域名或证书。

## 5. 配置

### CloudBase 与部署工作站

| 名称                   | 位置                           | 必需 | 说明                                                    |
| ---------------------- | ------------------------------ | ---- | ------------------------------------------------------- |
| `ENV_ID`               | 部署工作站                     | 是   | `cloudbaserc.json.example` 的本地替换值，不是客户端配置 |
| `ALLOWED_APP_IDS`      | 每个 `telemetry-<app_id>` 函数 | 是   | 新模板只填该函数唯一允许的一个应用编号；不要填逗号列表  |
| `TELEMETRY_COLLECTION` | 每个 `telemetry-<app_id>` 函数 | 是   | 该工具独立集合，例如 `telemetry_bifang_tools`           |
| `TRACK_PATH`           | 每个 `telemetry-<app_id>` 函数 | 是   | 独立路由，例如 `/apps/bifang-tools/v1/track`            |
| `CLOUDBASE_ENV_ID`     | 函数运行时                     | 否   | 通常不设置，函数使用当前 CloudBase 环境                 |

共享 `/v1/track` 只为历史部署兼容保留，不用于新增工具。新工具必须让自己的函数仅配置一个 `ALLOWED_APP_IDS` 值，并使用 `/apps/<app_id>/v1/track`，否则就没有函数、路由和数据库级隔离。

基础设施 `app_id` 长度为 1–50，只能含小写字母、数字和短横线，且首尾必须是字母或数字。这一窄规则使函数名、路由与集合名可以无碰撞地相互推导。

### 每个业务宿主

| 发布配置键             | SDK 参数                        | 必需 | 示例                                        |
| ---------------------- | ------------------------------- | ---- | ------------------------------------------- |
| `APP_ID`               | `appId`                         | 是   | `bifang-tools`                              |
| `APP_VERSION`          | `appVersion` / `currentVersion` | 是   | `0.1.0`                                     |
| `TELEMETRY_ENDPOINT`   | `TelemetryClient.endpoint`      | 是   | `https://<默认域名>/apps/<app_id>/v1/track` |
| `UPDATE_BASE_URL`      | `UpdateChecker.baseUrl`         | 是   | `https://<默认域名>/updates`                |
| `telemetry_enabled`    | `TelemetryClient.enabled`       | 是   | 开发默认 `false`，发布配置明确决定          |
| `update_check_enabled` | `UpdateChecker.enabled`         | 是   | 发布配置明确决定                            |

没有 `CHANNEL`。`platform` 和 `arch` 必须来自受支持枚举。环境 ID、账号密钥、Token、Cookie 或腾讯云密码都不填进业务 GUI。

## 6. 宿主接入

```ts
import { TelemetryClient, UpdateChecker } from "@bifang/telemetry-update-sdk";
import { NodeFileIdentityStorage } from "@bifang/telemetry-update-sdk/node";

const identityStorage = new NodeFileIdentityStorage(
  "C:\\Users\\<user>\\AppData\\Roaming\\ExampleTool",
  { appId: releaseConfig.APP_ID },
);

const telemetry = await TelemetryClient.init({
  enabled: releaseConfig.telemetry_enabled,
  endpoint: releaseConfig.TELEMETRY_ENDPOINT,
  appId: releaseConfig.APP_ID,
  appVersion: releaseConfig.APP_VERSION,
  platform: "windows",
  arch: "x64",
  identityStorage,
});

// init() 只会在北京时间当天首次启动时排队一个 daily_active。
// 不再调用 track()，也不记录功能、任务或更新交互。

const checker = new UpdateChecker({
  enabled: releaseConfig.update_check_enabled,
  baseUrl: releaseConfig.UPDATE_BASE_URL,
  appId: releaseConfig.APP_ID,
  currentVersion: releaseConfig.APP_VERSION,
  platform: "windows",
  installId: telemetry.installId,
});
```

更新检查应在主界面显示后异步触发，不能阻塞软件启动。SDK 只返回更新决策，不下载、不安装、不打开浏览器；签名、哈希校验、UI、退出与回滚由业务客户端负责。

## 7. `windows.json` 更新清单

更新清单必须精确包含 14 个键：

`schema_version`、`app_id`、`platform`、`latest_version`、`min_supported_version`、`enabled`、`force_update`、`rollout`、`title`、`message`、`download_url`、`release_notes_url`、`sha256`、`published_at`。

逐字段中文解释见 [`WINDOWS_JSON_FIELDS.zh-CN.md`](../cloudbase/updates/WINDOWS_JSON_FIELDS.zh-CN.md)。JSON 不能写注释，也不能新增 `_说明` 或 `comment`；`update.schema.json` 使用 `additionalProperties: false`。

`cloudbase/updates/bifang-tools/windows.json` 是仓库内第一个工具示例；当前仍是 smoke 清单：

- `enabled=false`、`rollout=0`，默认不会向任何客户端显示更新。
- `latest_version` 与 `min_supported_version` 都是 `0.1.0`，只是占位版本。
- 标题和正文是中文纯文本。
- `download_url`、`release_notes_url` 中的 `.example.invalid` 故意不可访问，**正式上线前必须替换**。
- `sha256=""` 只表示尚未放入真实安装包哈希，不代表已验证。

更新判定顺序：

1. 本地或远端关闭：`none`。
2. 当前版本不低于最新版本：`none`。
3. 当前版本低于最低支持版本，或 `force_update=true`：`required`。
4. 其他情况按 `install_id + latest_version` 做稳定灰度，命中 `rollout` 时为 `optional`。

`title` 和 `message` 始终按不可信纯文本显示，不得解释为 HTML、Markdown 或脚本。下载地址必须是无凭据的公网 HTTPS；正式安装包必须签名并提供真实 SHA-256。

## 8. 部署顺序

1. 复用已有免费 CloudBase 环境、平台默认 HTTPS 域名和 `/updates` 静态托管。
2. 为目标工具创建独立集合 `telemetry_<规范化app_id>`。
3. 为目标工具部署独立函数 `telemetry-<app_id>`，配置单值 `ALLOWED_APP_IDS`、`TELEMETRY_COLLECTION` 和 `TRACK_PATH`。
4. 创建 `/apps/<app_id>/v1/track` 独立网关路由，且只指向该工具函数。
5. 上传 `/updates/<app_id>/<platform>.json` 独立更新清单。
6. 本地运行 `npm ci` 和 `npm run check`。
7. 运行 `tcb validate`、`tcb deploy --dry-run`，确认不会删除其他工具资源，也没有陌生资源或收费项。
8. **先部署目标工具的新版 telemetry 云函数。**
9. 用新版测试程序验证 `daily_active`、每日幂等、服务端日期/时间/IP 和更新清单。
10. 验收通过后再发布该工具客户端。

不能先发新版客户端：历史 v1 云函数会拒绝 schema v2。若已有历史客户端，它们仍可能继续向网关发高频旧事件；更新云函数只能拒绝并阻止写库，不能让已经到达网关的请求“免计”。应尽快让历史客户端升级或关闭旧 telemetry。

生成器不会创建或删除数据库集合，也不会替负责人清理云端遗留资源。新增、改名或删除应用均须检查 dry-run 中的旧函数、旧路由、集合和孤儿更新目录。历史共享链路迁移时按“保留旧资源 → 部署并验收新资源 → 切换客户端 → 观察迁移期 → 人工下线旧资源”的顺序进行，避免旧客户端 404 和新旧集合统计分裂。

本轮简化不新增付费服务。平台免费额度、套餐和价格以后可能变化；凡控制台出现非零金额、自动续费、超限按量、资源包、自定义域名、证书购买或 EdgeOne，都必须先告知负责人并停止操作。详细页面位置和截图见 [CloudBase 新手图文版](cloudbase-quickstart.md)。

## 9. 验收清单

### 本地

```powershell
npm ci
npm run check
```

应覆盖：

- 同一北京时间日期多次初始化只安排一次 POST。
- 发送前先落盘；失败后当天不重试。
- 上海日期跨日后允许下一次上报。
- 渠道、功能、任务、安装和更新交互接口/字段已经移除。
- 云函数只接受精确 schema v2 `daily_active`。
- `active_date` 和 `received_at` 来自服务端。
- `source_ip` 只信任 CloudBase 上下文，伪造转发头无效。
- 同一 `app_id + active_date + install_id` 只保存一份。
- 更新清单仍通过 14 字段 Schema 与 SDK 验证。

### 公网

新版部署后重新验证：

- `OPTIONS /apps/<app_id>/v1/track` 为 204。
- 合法 POST 为 202，数据库出现一条 `daily_active`。
- 同一安装当天重放不新增文档；次日首次启动可新增。
- 十台模拟设备最多 10 次 POST；同公网 IP 不影响 10 个 `install_id` 分别计数。
- 客户端提供 `source_ip`、`active_date`、`received_at` 或旧 `channel/properties` 时被拒绝。
- 未知 app 与非法 JSON 不写库。
- `windows.json` 返回 200，14 字段与本地一致，`.example.invalid` 未进入正式发布配置。

不要把本地 mock 结果称为真实 CloudBase 验收。新的真实结果应另建回执；不要覆盖 [历史 v1 部署回执](cloudbase-deployment.md)。

## 10. 运维与隐私

- 在该工具的独立集合中每天按 `active_date` 统计文档数即可；不要按 IP 去重。
- 为 `active_date` 建普通查询索引前，先用真实规模确认必要性。
- 定期清理超过隐私说明保留期限的记录；删除流程应留有内部审计记录，但不公开原始 IP。
- 监控 400/403/429/500 比例和免费额度；不要记录原始 body 或完整 IP 到普通应用日志。
- 更新清单变更先通过 Schema/SDK 测试，再上传；紧急停更可设 `enabled=false`。
- 平台默认域名适合本阶段开发、演示和内部验收。它可能强制 `no-store`，会增加更新检查回源；这不构成购买自定义域名的理由。

## 官方参考

- [通过 HTTP 访问云函数](https://docs.cloudbase.net/service/access-cloud-function)
- [CloudBase 网关配置](https://docs.cloudbase.net/cli-v1/gateway)
- [CloudBase CLI 部署云函数](https://docs.cloudbase.net/cli-v1/functions/deploy)
- [CloudBase 静态网站托管快速开始](https://docs.cloudbase.net/hosting/quick-start)
- [CloudBase 静态资源与缓存管理](https://docs.cloudbase.net/hosting/manage)
- [`@cloudbase/js-sdk` 初始化与 Node.js 运行环境](https://docs.cloudbase.net/en/api-reference/webv3-next/initialization)
- [CloudBase Node.js 适配器](https://docs.cloudbase.net/api-reference/webv3-pg/adapter/node-adapter)
