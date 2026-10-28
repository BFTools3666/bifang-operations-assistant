# 毕方运营精灵 WebApp 与只读聚合接口

## 产品范围

`apps/operations-dashboard` 是生产环境的只读单页运营看板。它展示成功写入 CloudBase 的每日启动使用记录、活跃版本与运行环境，以及 application-version 发布流摘要。

首版只读，包含：

- 今日活跃匿名安装数、近 7/14/30 日去重活跃安装数；
- 今日设备中在此前 29 天出现过的回访比例；
- 每日活跃趋势与数据最后写入时间；
- 每台设备在所选周期内最近一次记录对应的版本、平台和架构分布；
- 每个已登记发布流的 code、平台、架构、渠道、当前最高版本和更新状态；
- 应用和周期筛选、手动刷新、诊断详情。

这些指标不是账号人数、安装量、功能漏斗、渠道转化、收入、崩溃率或更新安装成功率。全部应用视图以 `(app_id, install_id)` 为设备键，不做跨应用设备去重。

生产页面没有模拟数据 fallback。首次加载显示等待状态；连接缺失、请求失败或响应无效时明确显示不可用，不能用演示数字或正常零值替代失败。零条记录是合法生产结果。集合内已有的历史验收记录也会按协议计入，不能把所有记录都宣称为自然用户使用。

## 数据路径

```text
CloudBase 默认 HTTPS 域名 /dashboard
    -> 同源 /dashboard/api/session（访问密钥只用于建立签名会话）
    -> 同源 /dashboard/api/metrics（校验 HttpOnly 会话）
    -> operations-dashboard-api 内部聚合
    -> ADMINONLY telemetry_* 与 versions_* 每应用独立集合
    -> 仅返回聚合 JSON
```

`cloudbase/functions/operations-dashboard` 与匿名写入函数、application-version HTTP API 完全分离。现有 `/admin/v1/metrics` 继续要求 Bearer Token，供受控服务端调用；新增 `/dashboard` 路由由同一函数提供 HTML/CSS/JS、登录会话和浏览器聚合接口。页面不从浏览器调用管理接口，也不配置 CORS。管理路由总 QPS 为 100、单 ClientIP QPS 为 2；网页路由总 QPS 为 100、单 ClientIP QPS 为 10，登录失败另在函数内按可信运行时来源做 15 分钟窗口限制。

两个原始 Token 都只保存在 Git 忽略的运维 Secret 文件中：`CLOUDBASE_METRICS_TOKEN` 继续保护管理接口，`DASHBOARD_ACCESS_TOKEN` 供本人登录网页。CloudBase 只保存对应的 `DASHBOARD_TOKEN_SHA256` 与 `DASHBOARD_ACCESS_TOKEN_SHA256`，原值不进入函数配置、浏览器、Git 或日志。网页登录成功后只设置 `HttpOnly`、`Secure`、`SameSite=Strict`、12 小时有效且限定 `/dashboard` 路径的签名 Cookie；Cookie 由访问密钥摘要签名，不包含原始密钥。

页面与接口响应统一设置禁止嵌入、禁止索引、禁止 MIME 猜测和严格同源 CSP。统计响应继续使用 `Cache-Control: no-store`。函数使用 CloudBase 运行时短期身份直接读取固定 `ADMINONLY` 集合，不配置或暴露 application-version 管理凭据、运行凭据。

## 聚合口径

- 查询窗口固定为 7、14 或 30 天。
- DAU 按应用、匿名安装与北京时间日期去重。
- 周期活跃按 `(app_id, install_id)` 去重。
- 回访设备是今日设备键与此前 29 天设备键的交集。
- 版本、平台、架构以每台设备在所选周期内最新的 `received_at` 为准。
- 发布流只来自 `DASHBOARD_APPS_JSON` 已登记的 APP_ID/code 映射；每个 code 在其应用固定 `versions_*` 集合内按内部排序键读取最高版本。
- 空集合是合法生产结果，返回 `status=empty` 与空最高版本；未知 code、跨应用结果、字段异常或任一集合读取失败会让整次请求 fail closed，前端显示“生产数据暂时不可用”。
- 发布状态只返回安全枚举：普通更新、提示更新、强制更新、暂停更新或暂无版本；不返回下载地址、提示正文、富文本、管理字段或任何凭据。

版本画像与发布流最高版本是两个独立口径。前者来自客户端 `daily_active.app_version`，表示实际使用中的版本；后者来自运营端发布的 `versions_*` 记录。即使客户端版本画像已有数据，没有正式发布记录的发布流仍显示“暂无版本”，不能据此认定客户端漏传版本，也不能自动把遥测版本写成可下载的正式发行版。

- 原始记录只在函数内短暂用于聚合，响应绝不序列化 `install_id`、`event_id` 或 `source_ip`。

## 应用中文名称维护

中文显示名统一维护在 [`cloudbase/functions/operations-dashboard/src/app-labels.json`](../cloudbase/functions/operations-dashboard/src/app-labels.json)。它是展示元数据的唯一权威；`cloudbase/apps.json` 仍独立负责 schema v3 的应用登记、发布流与技术身份。修改显示名不会修改 APP_ID、code、函数、集合、路由或客户端协议。

```powershell
npm run cloudbase:app:name -- bifang-window-layout "毕方多窗口排布器"
npm run cloudbase:labels:check
node cloudbase/app-labels.mjs list
```

名称命令只原子更新本地名称 JSON，不访问云端、不部署。显示名必须为 1–100 个 Unicode 字符、包含中文、无首尾空白、控制或格式字符及 `<`、`>`。检查命令验证每个当前已登记 APP_ID 都有安全的中文名称，并已接入 `npm run check`；新增应用登记后须补名称，再通过全量检查。

名称表可以保存已确认但尚未登记的展示元数据。为未知 APP_ID 设置名称只添加元数据，`list` 以 `registered=false` 标明；不会替它创建应用、发布流或资源，也不会把它自动加入看板查询范围。未知且未命名的应用显示时回退为 APP_ID。已在线上启用的应用必须先按实际发布流核对登记，不能仅靠名称表补齐其身份。

生产页面与本地看板使用同一份名称表。名称源码修改完成后，线上生效仍需按下述最新预检与确认门禁进行看板部署；本地名称维护命令不会自动发布。

## 可重现部署配置

生成器为聚合函数显式注入 `CLOUDBASE_ENV_ID={{tcb.envId}}`，直接绑定 CLI 本次选择的部署环境，不接受另一份可能漂移或未展开的 `ENV_ID`。`DASHBOARD_APPS_JSON` 包含每个应用固定的 telemetry collection、version collection 与 release streams，并在模板中双重 JSON 编码：CloudBase CLI 3.8.1 的 `ConfigParser.parseRawConfig` 会将普通 JSON 数组字符串转成数组，双编码让 SCF 环境变量保持字符串；函数只允许最多两层解析，随后核对 APP_ID、集合派生名、每应用最多 12 条发布流、code 全局唯一性和平台映射。不要手工去掉这层编码。

## 部署范围与复核

生产看板的 CloudBase 部署范围仅为原地更新 `operations-dashboard-api`，保留 `/admin/v1/metrics` 并新增 `/dashboard` 路由。仓库顶层部署同时包含现有上报函数和 application-version 服务，不能用于本看板的定向发布。不得借看板发布修改业务集合、上报函数、版本记录、套餐或其他应用资源。远程部署前必须：

1. 实时确认环境仍为体验版、状态正常、按量扣费为 0，且没有非零金额、自动续费或套餐升级提示。
2. 实时核对目标函数与完整默认域名路由；`/dashboard` 必须尚未占用或与本配置完全一致，已有其他路由全部保留。
3. 两个 Token 都必须至少 32 字节、互不相同；只把 SHA-256 放入 CloudBase，原始值留在 Git 忽略的本地 Secret 文件。
4. 校验模板并运行 dry-run；展示最终环境、函数、路由、QPS、变量名与零删除结论。
5. 在负责人明确确认后只定向更新该函数并创建 `/dashboard` 路由，不运行顶层整仓部署，不修改现有路由或集合。
6. 公网复验管理接口无 Token/错误 Token 为 401、正确请求为 200；网页未登录统计为 401、错误访问密钥为 401、正确访问密钥建立 Secure Cookie 后统计为 200，响应不含原始标识、IP、版本正文、下载地址或凭据。

平台默认 `.app.tcloudbase.com` 域名只适合测试和内部访问。正式对外生产域名需要另行备案和绑定；本项目不得代购域名、证书或付费资源，任何此类需求必须另行确认。

任何非零费用、付费资源、卡绑定、自动续费、套餐升级或超额风险都必须停止并提醒负责人。
