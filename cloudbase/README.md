# CloudBase 3.0 资源说明

本目录是毕方公共服务的可维护源码：保留每个小工具隔离的 `daily_active` 遥测，并统一提供 application-version API v1。基础设施 3.0 不包含静态更新清单、静态更新 hosting、旧版本路由、灰度清单或兼容回退。

旧静态协议的部署回执和截图已从 3.0 工作树删除，避免被误当成当前部署输入；需要追溯时只从 Git 历史读取。当前协议与验收要求以 [`docs/telemetry-and-update.md`](../docs/telemetry-and-update.md) 为准。

## 目录与权威源

- `apps.json`：schema v3 应用与发布流登记表，是 APP_ID、平台、架构、渠道和 version `code` 的唯一非敏感权威。
- `functions/operations-dashboard/src/app-labels.json`：中文显示名的唯一展示元数据权威；不代表应用已经登记或接入。
- `app-labels.mjs`：只维护本地中文名称并检查已登记应用的名称覆盖，不修改登记表或生成资源配置。
- `add-app.mjs`：一次登记应用和其已有的旧发布流；仅统计工具可不填发布流。
- `add-release-stream.mjs`：给已登记应用追加发布流。
- `generate-cloudbaserc.mjs`：生成并校验根目录 `cloudbaserc.example.json`。
- `plan-app-deployment.mjs`：只生成单应用 telemetry 的只读部署计划。
- `plan-application-version-api-deployment.mjs`：校验未提交的凭据配置与最新云端只读实况，生成共享版本服务的严格预览。
- `deploy-operations-dashboard.mjs`：从 Git 忽略的 Secret 文件只派生两个 SHA-256，生成可复核材料摘要，并在确认后只更新固定看板函数。
- `verify-operations-dashboard.mjs`：发布后验证页面、静态资源、安全 Cookie、浏览器统计接口与旧管理接口，不回显原始 Token。
- `functions/telemetry/`：Node.js 20 `daily_active` Event 函数源码。
- `functions/application-version-api/`：application-version API v1 十个端点的 Event 函数源码。
- `functions/operations-dashboard/`：私有只读运营看板页面、签名会话与聚合接口。

仓库中没有 `cloudbase/updates/`。生成配置没有 `hosting`，也没有 `/updates` 路由或 `DASHBOARD_UPDATES_BASE_URL`。

## 当前资源拓扑

每个应用独立拥有：

```text
telemetry-<app_id>
/apps/<app_id>/v1/track
telemetry_<规范化app_id>
versions_<规范化app_id>
ads_<规范化app_id>
audit_<规范化app_id>
```

前三项用于 `daily_active`；后三个 `ADMINONLY` 集合由共享版本服务使用。共享资源为：

```text
application-version-api  -> /tools/version-control/v1
operations-dashboard-api -> /admin/v1/metrics
operations-dashboard-api -> /dashboard
```

`/dashboard` 在平台默认 HTTPS 域名下提供页面资源、`/dashboard/api/session` 和 `/dashboard/api/metrics`。网页登录只向 CloudBase 保存访问密钥的 SHA-256；浏览器取得的是限定 `/dashboard` 的签名 `HttpOnly`、`Secure`、`SameSite=Strict` Cookie。现有 `/admin/v1/metrics` Bearer 管理接口保持不变。

看板本地预览命令只读取 Secret 并输出长度、目标和部署材料摘要，不输出原值或其单独摘要：

```powershell
npm run cloudbase:dashboard:deploy:plan -- --env-id <现有免费环境ID> --secret-file apps/operations-dashboard-standalone/.env.server.local
```

工作区同时登记了尚未获准部署的其他应用时，必须用 `--app-ids` 绑定本次看板应用范围；计划和部署命令使用完全相同的逗号分隔 APP_ID 列表，材料摘要会把该列表计入 SHA-256：

```powershell
npm run cloudbase:dashboard:deploy:plan -- --env-id <现有免费环境ID> --secret-file apps/operations-dashboard-standalone/.env.server.local --app-ids <既有线上APP_ID列表,本次APP_ID>
```

完成实时套餐、函数、完整路由和费用预检并得到负责人明确“继续”后，部署命令还必须带上刚审核的材料摘要：

```powershell
npm run cloudbase:dashboard:deploy -- --env-id <现有免费环境ID> --secret-file apps/operations-dashboard-standalone/.env.server.local --expected-materials-sha256 <审核值>
```

Helper 会建立私有临时快照，仅向 `operations-dashboard-api` 注入两个摘要变量，并抑制 CLI 原始输出；它不创建路由。`/dashboard` 路由必须按同一轮预检的精确目标单独创建并在创建后读回。

看板应用映射使用内部 compact schema v2，仅保存 APP_ID 和发布流四元组；函数端重新派生集合名与平台汇总并按完整规则校验。这样在保留全部已上线应用时仍满足 SCF 环境变量 4096 字节平台上限与仓库 3840 字节安全门槛，不得退回冗余的逐应用对象编码。

路由就绪后运行自动验收：

```powershell
npm run cloudbase:dashboard:verify -- --origin https://<平台默认域名> --secret-file apps/operations-dashboard-standalone/.env.server.local
```

验收脚本会使用两个本地 Secret 完成正反向鉴权，但输出只包含各检查的 HTTP 状态、筛选范围和最终 URL。

`v1` 是 API 版本，只出现一次。版本请求使用 `GET /tools/version-control/v1/versions/{code}/{version}` 和 `x-app-key`、`x-app-secret`；200 响应是契约定义的裸七字段对象。

`apps.json` 中每条 `release_streams` 都必须唯一声明：

```json
{
  "platform": "windows",
  "architecture": "x64",
  "channel": "stable",
  "code": "example-tool-windows-x64"
}
```

Version 请求本身没有平台字段，因此不同平台或架构不能共用同一个 `code`，也不能依赖 User-Agent 猜测。

## 登记应用与发布流

只接新更新中心且没有旧发布流的新工具，登记独立统计资源时无需填写旧 code：

```powershell
npm run cloudbase:app:add -- <app_id>
```

登记表使用空 `release_streams`；该工具不加入旧 application-version 映射或版本集合计划。看板可按中文名展示统计上报的客户端版本，更新中心的发布状态仍在更新后台查看。已有旧发布流不自动删除。首次同步看板配置前需先部署支持空发布流的看板代码，部署操作仍须单独预检和授权。

确有旧 application-version 发布流的应用，登记时给出真实四元组：

```powershell
npm run cloudbase:app:add -- <app_id> <platform> <architecture> <channel> <code>
```

追加发布流：

```powershell
npm run cloudbase:app:stream:add -- <app_id> <platform> <architecture> <channel> <code>
```

两个命令只修改登记表与生成配置，不创建本地清单，也不访问 CloudBase。它们会拒绝重复 APP_ID、重复 code、重复平台/架构/渠道组合和非法派生名。

中文显示名单独维护，不写入 schema v3 登记表：

```powershell
npm run cloudbase:app:name -- <app_id> "中文显示名"
npm run cloudbase:labels:check
node cloudbase/app-labels.mjs list
```

`cloudbase:app:name` 固定执行名称工具的 `set`，只原子更新 `functions/operations-dashboard/src/app-labels.json`；不会修改 APP_ID、发布流 code、函数、集合、路由、`apps.json` 或 `cloudbaserc.example.json`，不访问云端。名称应为 1–100 个 Unicode 字符、包含中文、无首尾空白、控制或格式字符及 `<`、`>`。`cloudbase:labels:check` 要求所有已登记应用都有安全中文名，已纳入 `npm run check`。

接入向导交接 Profile v2 后，先运行 Skill 的 Profile 校验，再在本仓库执行 `npm run cloudbase:labels:check -- --profile-file "<Profile 交接文件>"`。此命令只读核对完整名称覆盖、本工具 APP_ID 已登记且显示名与 Profile 精确一致；不把元数据独有的名字视作已接入。通过后才可在 Profile 记录名称已登记；线上生效仍需另行授权部署和实际验证。

允许为已确认的额外 APP_ID 保存名称元数据；未知 APP_ID 的 `set` 结果和 `list` 项标为 `registered=false`，不意味着已经登记、部署或完成客户端接入。新应用仍须另走应用登记和相应阶段门禁。线上已启用的应用还须按实际发布流核对登记，避免下一次部署遗漏。更名本身不改变技术身份；生产看板生效须另行完成看板部署的预检与确认。

修改登记后运行：

```powershell
npm run cloudbase:config:check
npm run cloudbase:labels:check
npm run check
```

### 已有生产看板的中文名代码更新

已有生产看板仅修改显示名时，使用 `deploy-operations-dashboard-code.mjs`。本地腾讯凭据写入 Git 忽略且未跟踪的 `cloudbase/.env.dashboard-deploy.local`，字段为 `SecretId`、`SecretKey`、可选 `Token`。凭据只在内存中用于 TC3 签名，不传入命令参数、CLI 登录状态、函数环境变量或上传代码包；原有看板口令无需重新提供。

```powershell
npm run cloudbase:dashboard:code:plan -- --env-id <现有环境ID> --origin https://<平台默认域名>
```

预览会实时核对完整工具/发布流映射、函数、路由、体验版、自动续费、超限扣费及资源点额度。只打包看板的 `index.js`、`package.json`、`src/` 和 `public/`，将源码、控制脚本、原有代码和需保留的配置绑定到 `materials_sha256`。线上映射与本地登记必须完全匹配；新增应用或更改发布流应另走相应部署流程。

展示最终目标与最新预检并取得负责人明确继续后，执行同一份摘要：

```powershell
npm run cloudbase:dashboard:code:deploy -- --env-id <现有环境ID> --origin https://<平台默认域名> --expected-materials-sha256 <预览摘要>
```

此入口先下载并校验旧代码 ZIP，保存在 Git 忽略的 `.cloudbase/dashboard-code-backups/`，再复核材料与线上状态；任何漂移都会在写入前停止。唯一写 API 是固定函数 `operations-dashboard-api` 的 `UpdateFunctionCode`，不提交环境变量、运行资源配置或路由。依赖按函数 `package.json` 的精确版本由云端安装，不发布函数版本。更新后等待 `Active`、检查代码摘要已改变，并复核原配置与全部路由保持一致；返回 `code-updated-awaiting-functional-verification` 后仍需核对线上静态资源、已登录接口的全部中文名和页面展示，不能仅凭函数状态宣称验收完成。备份保留供后续明确授权的恢复操作使用，不自动回滚或删除。

## 单应用 telemetry 计划

单应用计划只覆盖该应用的 telemetry 函数、路由和集合：

```powershell
npm run cloudbase:app:deploy:plan -- <app_id> --env-id <现有免费环境ID> --origin https://<平台默认域名>
```

它不得创建或修改 `versions_*`、`ads_*`、`audit_*`、共享版本函数、看板、静态 hosting 或其他应用资源，也不直接执行命令。

## application-version 服务计划

凭据原值不得进入 Git、命令输出或回执。在 Windows 运行生成器；摘要配置写入已忽略文件，Key/Secret 原值由当前用户 DPAPI 加密保存在 `%LOCALAPPDATA%\Bifang\OperationsAssistant\`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/application-version-credentials.ps1 -Mode generate
```

每次生成可执行的 application-version 计划前，必须紧接着按锁文件重新执行一次 `npm ci`；从这次 `npm ci` 到生成计划之间，不得修改 `package-lock.json`、`package.json` 或 `node_modules/@cloudbase/cli`。

先生成无写步骤的只读预检要求：

```powershell
npm run cloudbase:version-api:deploy:plan -- --env-id <现有免费环境ID> --origin https://<平台默认域名> --credentials-b64-file cloudbase/application-version-credentials.b64
```

没有完整 live-state 时，`reconciliation.status` 必须是 `live-state-required`，`write_steps_after_confirmation` 必须为空。将函数、路由、集合、网关默认域名、费用门禁和历史对象库存保存到被 Git 忽略的 `cloudbase/application-version-live-state.json` 后再运行：

```powershell
npm run cloudbase:version-api:deploy:plan -- --env-id <现有免费环境ID> --origin https://<平台默认域名> --credentials-b64-file cloudbase/application-version-credentials.b64 --live-state-file cloudbase/application-version-live-state.json
```

计划只允许输出 credential ID、APP_ID、codes、scopes、Secret 版本数和配置/部署材料 SHA-256；Key、Secret 及其摘要都不得显示。凭据 code 必须属于 `apps.json` 中对应应用的发布流。每份客户端运行凭据只绑定一个 code 且只有 `versions:check`；每条发布流必须同时有客户端运行、独立管理读取（`versions:read + ads:read`）和独立管理写入（`versions:write + ads:write`）覆盖；全局还必须恰好有一份不可导出的 `contract-ads-*` 凭据用于 `ads:show` 契约测试。任何角色或 scope 混用都会阻塞。

负责人确认写入后，只执行计划中列出的 credential-bound helper。部署材料摘要绑定 `cloudbaserc.example.json`、`cloudbase/apps.json`、部署/计划/生成脚本、根 `package.json` 与锁文件、完整 application-version 函数树和完整 `node_modules/@cloudbase/cli` 树。Helper 会在私有临时目录建立并复核同一份 staging 快照，按实际环境 ID 重新校验凭据覆盖和 3840 字节门禁，再从 staging 启动仓库内固定的 `@cloudbase/cli@3.8.1`；version/deploy 子进程都有有限时，设置 `NO_UPDATE_NOTIFIER`，不接受 PATH 中的 `tcb` 或命令 shell，原始输出保持抑制，最终精确清理 staging。失败回执不声称不存在的 request ID。部署后用计划中的只读轮询重新取得可分享证据。

首次部署只能创建缺失的共享函数、固定路由、逐应用三类 `ADMINONLY` 集合及所需索引。已有部署只允许保留非冲突对象并追加缺失项：移除应用、code、凭据、Secret 摘要或改变集合 ACL 都会阻塞。计划会核算自定义环境变量总字节并为平台上限预留余量。

## 写入与费用门禁

这里只允许复用负责人已确认的一个免费 CloudBase 环境和平台默认 HTTPS 域名。不创建第二环境，不购买域名、证书、套餐或资源包，不开启按量超限、自动续费或超限扣费。

任何部署前都必须重新只读确认：

1. 精确环境 ID、默认域名及证书状态；
2. 免费/体验状态、到期时间、剩余额度与最终应付 `0` 元；
3. 每个函数、路由、集合、ACL、索引的当前状态；
4. 计划要创建、更新、保留和明确不碰的资源；
5. 无顶层 `deploy`、`--all`、`--prune` 或删除命令；`--force` 仅由 credential-bound helper 用于固定的 `tcb fn deploy application-version-api` 精确创建或更新，不允许通配、目录推断、批量或其他目标；
6. 失败恢复方式。

出现非零金额、升级、连续包月、自动续费、按量超限或资源不足提示时立即停止。完成最新预检并展示最终参数后，仍须等待负责人明确“继续”才可写入。

## 旧线上静态资源退役

当前源码和生成配置已经删除旧静态协议；线上资源的删除是后续独立门禁。退役预览只承认以下固定历史 allowlist：

```text
/updates/bifang-mouse-clicker/windows.json
/updates/bifang-screen-recorder/windows.json
/updates/bifang-screen-recorder/macos.json
/updates/example-tool/windows.json
/updates/update.schema.json
```

live inventory 必须完整，并把每项分类为 `present` 或 `already-absent`。还要精确核对旧 `/updates` 网关路由和 `updates` hosting deploy path。发现 allowlist 外对象、路由冲突、hosting 冲突或库存不完整时，整组退役阻塞且删除目标清空；计划永远不生成删除命令。

只有两个真实 Windows 客户端都完成新 API E2E、确认无旧客户端流量、重新展示上述精确目标与恢复材料，并再次得到负责人明确“继续”后，才能执行删除。`telemetry-*`、`/apps/<app_id>/v1/track`、`telemetry_*`、application-version 服务、看板和其他应用永不进入退役范围。

## 安全与数据边界

- Telemetry 只接受固定 `daily_active`；同一匿名安装按北京时间每天最多一条，服务端生成 `active_date`、`received_at` 和可信上下文 `source_ip`。
- 客户端联网前先原子认领当天，失败当天不重试，以保护免费额度。
- Version 函数只根据已验证凭据绑定的 `app_id + codes + scopes` 选择固定集合，不能用客户端输入动态拼集合名。
- 运行客户端只给 `versions:check`；`ads:show` 仅由不可导出的专用契约测试凭据验证，管理读写使用分离凭据。
- 版本号按任意精度数字点分比较；下载和广告 URL 只允许安全 HTTPS；富文本经过允许标签重建并在读取时再次校验。
- 看板只读固定 `ADMINONLY` 集合，只返回聚合遥测与发布流摘要；不得返回安装标识、来源 IP、下载地址、提示正文、富文本或凭据。
- 所有 application-version API 响应使用 `Cache-Control: no-store`，鉴权失败、字段异常、跨应用访问与未知 code 都失败关闭。

本地 mock、localhost、单元测试或历史回执都不能代替本次真实 CloudBase、公网 HTTP 和客户端 GUI E2E。
