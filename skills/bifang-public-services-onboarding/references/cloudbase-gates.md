# CloudBase 与真实 E2E 门禁

在阶段 2–4、6–8 读取。只复用负责人确认的现有免费环境和平台默认 HTTPS 域名。

## 费用红线

不创建第二环境，不购买域名、证书、套餐或资源包，不开启按量超限、超限扣费或自动续费。控制台、API 或 CLI 一旦出现非零金额、升级、连续包月、资源包、自定义域名、证书购买或 EdgeOne 提示，立即停止并保留只读证据。

## 固定资源

Telemetry 每个应用独立：

- `telemetry-<app_id>`
- `/apps/<app_id>/v1/track`
- `telemetry_<normalized_app_id>`，`ADMINONLY`

Application-version 全环境共享：

- 函数 `application-version-api`
- 路由 `/tools/version-control/v1`
- 每 APP_ID 独立 `versions_*`、`ads_*`、`audit_*`，均 `ADMINONLY`
- 凭据绑定 `app_id + codes + scopes`

不存在静态更新 hosting 或现行 `/updates` 路由。旧静态资源只作为待精确退役的线上候选，不得重新生成或部署。

## 阶段 2：登记

- APP_ID 与每个 `(platform, architecture, channel)` 的 code 已由负责人确认；code 唯一且长度不超过 50。
- `cloudbase/apps.json` 是非敏感拓扑唯一权威；凭据原值不写入登记表。
- 使用受测登记命令，一次只新增一个应用或一个发布流；不并发写文件。
- 本阶段只修改运营精灵本地登记与生成配置，不部署。

## 阶段 3：本地计划

- `npm run cloudbase:config:check` 和完整测试通过；生成配置包含全部已登记 telemetry、共享 version 函数/路由和看板，无旧静态 hosting/route/env。
- Version 部署计划输入完整只读 live-state。没有 live-state 时不得生成写步骤。
- 计划区分首次创建、已有兼容资源更新与冲突阻塞；不得用“存在”一概覆盖，也不得删除非空数据、未知索引、陌生凭据或其他应用。
- 每份客户端运行凭据只绑定一个 code 且仅有 `versions:check`；管理读取固定为独立 `versions:read + ads:read`，管理写入固定为独立 `versions:write + ads:write`。每条发布流必须有三类覆盖，全局还需恰好一份不可导出的 `contract-ads-*` 凭据执行 `ads:show` 契约测试；只显示 credential ID/fingerprint/scopes，不回显原值或摘要配置。
- dry-run/计划不得包含 `--all`、`--force`、`--prune`、顶层 deploy 或删除命令。

## 阶段 4：部署与公网 HTTP E2E

即使用户说“进入阶段 4”，真实写入前仍要展示：

- 环境 ID、确认的免费状态和平台默认域名；
- 函数、路由、六个业务集合、权限和索引；
- 三条发布流 code 与凭据绑定摘要；
- 当前 live-state、精确 create/update/preserve diff；
- 费用、回滚与明确排除项。

随后等待负责人明确“继续”。只执行已审查的精确步骤；失败后先重新读状态，不自动重试有副作用写入。

公网 E2E 覆盖十个端点、两个认证头、scope、跨 APP/code 拒绝、无/提示/强制/停止更新、空/单广告、列表/详情/写入、数字点分比较、内容消毒、429、事务和审计。测试记录不得包含 Key/Secret。

## 阶段 5：客户端本地迁移

规范 URL 一句话授权当前客户端完成 Profile v2、替换/删除旧静态版本协议和本地测试，不授权访问真实 CloudBase。使用注入 transport 和假凭据，真实服务状态仍标 `Unverified`。

## 阶段 6：真实客户端 E2E

- 阶段 4 有当前公网证据，运行凭据已安全准备，阶段 5 已通过。
- 构建与安装使用准确版本；记录 EXE/APP 和安装包 SHA-256、路径、进程与窗口。
- 网络观测证明单层 v1 URL、正确 code、两个认证头存在且值遮挡，并证明不再访问旧静态版本协议。
- 验证无更新、提示、强制、停止、错误/超时、安全外链和完整退出；telemetry 无回归。
- 鼠标精灵只需 Windows x64；录屏助手 Windows 与 macOS 分开，真实 Mac 未运行时保持 `Unverified`。
- DOM、mock、单元测试、编译或 HTTP 请求不能冒充原生 GUI E2E。

## 阶段 7：发布与推送

展示版本、制品哈希/签名、下载 URL、发布说明、隐私、回滚、远端状态和费用，再等待明确授权。不要因 E2E 通过自动推送或发布。

## 阶段 8：线上旧静态资源退役

客户端 Profile 中 `legacy_client_update_removed=true` 不授权也不证明这里的线上删除。只有本节全部门禁完成并执行精确退役后，才可记录 `legacy_cloud_resources_removed=true`。

前置条件：新服务公网 E2E、两个 Windows 实际客户端新协议 E2E、最新线上完整枚举、归属判断和恢复证据均完成。

候选必须逐项来自 live inventory 与受审计 allowlist，例如：

- 网关精确路由 `/updates`；
- `updates/bifang-mouse-clicker/windows.json`；
- `updates/bifang-screen-recorder/windows.json`；
- `updates/bifang-screen-recorder/macos.json`；
- 历史 `updates/example-tool/windows.json`；
- 历史 `updates/update.schema.json`；
- live inventory 中其他对象必须先人工确认归属，未知项阻塞。

计划只输出 preview，不生成删除命令。展示每个精确对象/路由、当前哈希/元数据、为何可删、恢复材料及排除的 telemetry/version/dashboard 资源，再等待负责人明确“继续”。不使用通配符、目录级删除、`--force` 或 `--prune`，也不因配置里名为 `updates` 就删除整个 hosting 服务。

删除后重新验证：新 version API、两个 telemetry 路由和运营看板正常；旧路由不存在，已列对象返回 404。任何超出精确 allowlist 的数据删除需要新授权。

## 绝不删除

- `telemetry-bifang-mouse-clicker`、`telemetry-bifang-screen-recorder`；
- 两条 `/apps/<app_id>/v1/track`；
- 两个 `telemetry_*` 集合及历史 daily-active 数据；
- `application-version-api`、单层 v1 路由、六个 versions/ads/audit 集合；
- `operations-dashboard-api` 与 `/admin/v1/metrics`；
- 其他应用或未知归属资源。
