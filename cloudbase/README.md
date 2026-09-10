# CloudBase 3.0 资源说明

本目录是毕方公共服务的可维护源码：保留每个小工具隔离的 `daily_active` 遥测，并统一提供 application-version API v1。基础设施 3.0 不包含静态更新清单、静态更新 hosting、旧版本路由、灰度清单或兼容回退。

旧静态协议的部署回执和截图已从 3.0 工作树删除，避免被误当成当前部署输入；需要追溯时只从 Git 历史读取。当前协议与验收要求以 [`docs/telemetry-and-update.md`](../docs/telemetry-and-update.md) 为准。

## 目录与权威源

- `apps.json`：schema v3 应用与发布流登记表，是 APP_ID、平台、架构、渠道和 version `code` 的唯一非敏感权威。
- `add-app.mjs`：一次登记应用及至少一条发布流。
- `add-release-stream.mjs`：给已登记应用追加发布流。
- `generate-cloudbaserc.mjs`：生成并校验根目录 `cloudbaserc.example.json`。
- `plan-app-deployment.mjs`：只生成单应用 telemetry 的只读部署计划。
- `plan-application-version-api-deployment.mjs`：校验未提交的凭据配置与最新云端只读实况，生成共享版本服务的严格预览。
- `functions/telemetry/`：Node.js 20 `daily_active` Event 函数源码。
- `functions/application-version-api/`：application-version API v1 十个端点的 Event 函数源码。
- `functions/operations-dashboard/`：私有只读运营看板聚合接口。

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
```

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

新增应用时同时给出一条或多条四元组：

```powershell
npm run cloudbase:app:add -- <app_id> <platform> <architecture> <channel> <code>
```

追加发布流：

```powershell
npm run cloudbase:app:stream:add -- <app_id> <platform> <architecture> <channel> <code>
```

两个命令只修改登记表与生成配置，不创建本地清单，也不访问 CloudBase。它们会拒绝重复 APP_ID、重复 code、重复平台/架构/渠道组合和非法派生名。

修改登记后运行：

```powershell
npm run cloudbase:config:check
npm run check
```

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
5. 无顶层 `deploy`、`--all`、`--force`、`--prune` 或删除命令；
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
