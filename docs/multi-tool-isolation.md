# 多工具资源隔离指南（共用一个免费环境）

## 结论

多个小工具可以共用同一个免费 CloudBase 环境和平台默认 HTTPS 域名。每个工具使用独立的应用编号、统计云函数与路由、数据库集合、本地状态目录和更新文件，因此统计与版本发布不会串用。固定路径的应用版本 API 使用一个共享函数和路由，但函数必须先鉴权，再按凭据绑定的应用选择独立集合。这是业务资源隔离，不是 CloudBase 环境级完全隔离。

共享的只有 CloudBase 环境、默认域名、`/updates` 静态托管入口、`application-version-api` 及其 `/tools/version-control/v1` 路由、免费额度和平台故障域。任一工具消耗的请求、函数、数据库、存储和流量都会计入同一环境额度；这不是额度或故障层面的完全隔离。若要连额度和故障域也隔离，就需要多个 CloudBase 环境，可能涉及付费，不能自行创建或升级。

在其他小工具仓库开始接入时，显式调用 `$bifang-public-services-onboarding`。向导会先读取目标项目和已有 `.bifang/public-services-profile.json`，只询问无法确认的信息；APP_ID 与资源映射确认后仍按八个独立阶段推进，不会把登记、部署、客户端修改、构建、发布和旧资源清理合成一次操作。

## 固定命名规则

部署用 `app_id` 必须满足：

- 全局唯一，不与其他工具复用；
- 长度 1–50 个字符；
- 只使用小写字母、数字和短横线；
- 开头和结尾必须是小写字母或数字。

登记表 [`cloudbase/apps.json`](../cloudbase/apps.json) 是全部工具及其更新平台的唯一基础设施清单。每项必须显式列出非空且无重复的 `platforms`；当前自动生成并校验 `windows` 和 `macos`，Linux 仍未开放。生成器会根据登记表一次生成包含所有函数和路由的 `cloudbaserc.json.example`，并逐项校验登记平台的清单文件。

| 资源             | 派生规则                             | `bifang-pdf-tool` 示例                  |
| ---------------- | ------------------------------------ | --------------------------------------- |
| 应用编号         | `<app_id>`                           | `bifang-pdf-tool`                       |
| Event 云函数     | `telemetry-<app_id>`                 | `telemetry-bifang-pdf-tool`             |
| 数据库集合       | `telemetry_` + 把每个 `-` 替换为 `_` | `telemetry_bifang_pdf_tool`             |
| 版本记录集合     | `versions_` + 把每个 `-` 替换为 `_`  | `versions_bifang_pdf_tool`              |
| 广告记录集合     | `ads_` + 把每个 `-` 替换为 `_`       | `ads_bifang_pdf_tool`                   |
| 版本审计集合     | `audit_` + 把每个 `-` 替换为 `_`     | `audit_bifang_pdf_tool`                 |
| 数据接收路由     | `/apps/<app_id>/v1/track`            | `/apps/bifang-pdf-tool/v1/track`        |
| 更新目录         | `/updates/<app_id>`                  | `/updates/bifang-pdf-tool`              |
| Windows 更新文件 | `/updates/<app_id>/windows.json`     | `/updates/bifang-pdf-tool/windows.json` |
| macOS 更新文件   | `/updates/<app_id>/macos.json`       | `/updates/bifang-pdf-tool/macos.json`   |
| 本地状态目录     | 每个宿主自己的 AppConfig 目录        | 由宿主程序单独指定                      |

每个独立函数的环境变量必须精确对应同一工具：

```text
ALLOWED_APP_IDS=bifang-pdf-tool
TELEMETRY_COLLECTION=telemetry_bifang_pdf_tool
TRACK_PATH=/apps/bifang-pdf-tool/v1/track
```

`ALLOWED_APP_IDS` 这个历史变量名仍被保留，但新模板中每个函数只允许填写一个 `app_id`，不能写逗号分隔的多工具名单。

## 共享应用版本 API 的隔离边界

应用版本 API 的规范 Base URL 是 `https://<平台默认域名>/tools/version-control/v1`，`v1` 只出现一次；不创建 `/v1/v1` 别名。共享函数 `application-version-api` 不能把请求中的 `code` 当成集合名，也不能跨集合搜索：`x-app-key` 与 `x-app-secret` 先解析为一个已登记 `app_id`、允许的 `codes` 和最小权限 `scopes`，随后只选择该应用从 `cloudbase/apps.json` 派生出的 `versions_*`、`ads_*`、`audit_*` 三个 `ADMINONLY` 集合。

该共享服务已在仓库中本地实现，但尚未部署或经未修改原程序的测试域名 E2E。当前 `$bifang-public-services-onboarding` 仍对应基础设施 `2.1.0` 的 telemetry 与静态 `/updates` 接入，不得借它把两个业务客户端提前切到新 API。共享服务先用独立的 `cloudbase:version-api:deploy:plan` 完成远程只读预检、费用复核和明确确认；原程序验收后，再分别升级接入 Skill、鼠标精灵和录屏助手。

## 新增一个工具

以下例子新增 `bifang-pdf-tool`。

1. 使用安全追加命令登记工具：

   ```powershell
   npm run cloudbase:app:add -- bifang-pdf-tool
   ```

   默认只登记 Windows。新应用从一开始同时支持 Windows 和 macOS 时使用 `npm run cloudbase:app:add -- bifang-pdf-tool windows macos`。命令会拒绝非法或重复编号/平台，不覆盖已有目录；成功后会同时更新 `cloudbase/apps.json`、创建每个登记平台默认关闭的清单，并重生成包含全部工具的 `cloudbaserc.json.example`。一次只运行一个新增工具命令，不要在两个终端并发执行；若电脑在写入中途异常退出，先运行下一步的一致性检查并处理提示，不要直接部署。

2. 已登记应用后来新增 macOS 时，运行 `npm run cloudbase:app:platform:add -- bifang-pdf-tool macos`。该命令只追加平台与对应清单，不改函数/路由，也不覆盖已有文件。修改每个平台清单的版本、标题、说明、下载地址、发布说明地址、SHA-256 和发布时间。新文件默认 `enabled=false`、`rollout=0`，并使用现有免费 CloudBase 默认 HTTPS 域名下的 `not-published` 404 地址；真实上线前必须先上传并验证制品和发布说明，再替换这些惰性地址。
3. 运行配置一致性检查：

   ```powershell
   npm run cloudbase:config:check
   ```

   检查会验证编号、平台、重复项、生成模板，以及每个登记工具是否存在 app ID/平台匹配的全部清单；缺失、多余、错平台和符号链接都会失败。不要手工维护生成后的函数与路由列表；若确需重新生成，使用 `npm run cloudbase:config`。

4. 在 CloudBase 文档型数据库页面**手工创建** `telemetry_bifang_pdf_tool`，权限设为 `ADMINONLY`、仅管理员可读写或控制台中含义相同的选项。生成器只生成函数、路由和静态更新配置，**不会自动创建数据库集合**。
5. 复制部署模板为本机配置，并只填写环境 ID：

   ```powershell
   Copy-Item -LiteralPath .\cloudbaserc.json.example -Destination .\cloudbaserc.json
   $env:ENV_ID = "<你的环境ID>"
   ```

6. 先检查，再部署：

   ```powershell
   npm run check
   tcb validate
   tcb deploy --dry-run
   ```

7. 在 dry-run 中确认：旧工具的函数和路由仍然存在；没有删除项、陌生资源或收费项。顶层 dry-run 只用于审查整份声明式配置；若它还计划创建或改动其他应用，就不得执行顶层 `tcb deploy`。
8. 为目标应用生成只读、资源级部署计划：

   ```powershell
   npm run cloudbase:app:deploy:plan -- bifang-pdf-tool --env-id <现有免费环境ID> --origin https://<平台默认域名>
   ```

   计划必须只含目标集合、函数、单条路由和逐个平台的单文件上传，并明确排除其他 `app_id`、`--all`、`--force`、`--prune`、目录级托管上传和删除命令。这个命令只输出 JSON，不部署；阶段 4 仍须做远程只读快照、费用复核，并在真实写入前等待负责人明确继续。

登记表和生成后的模板必须同时包含所有工具。不要为某个新工具制作一个只含单个函数的临时 `cloudbaserc.json`，否则部署预览可能出现删除其他工具资源。

## 改名、迁移和删除

`cloudbase/apps.json` 只描述准备部署的目标状态，不是云端资源清理器。新增、改名或删除工具前都必须运行 `tcb deploy --dry-run`，逐项检查云端旧函数、旧路由、数据库集合和孤儿更新目录；不要声称登记表会自动删除这些资源，也不要在没有备份与确认时手工删除数据。

把历史共享 `/v1/track`、`telemetry` 和 `telemetry_events` 迁移到独立资源时，按以下顺序操作：

1. 暂时保留历史函数、路由、集合和更新文件。
2. 部署目标工具的新函数、新路由、新集合和新更新文件。
3. 用测试 GUI 验证新链路后，再发布指向新地址的客户端。
4. 观察一段明确的迁移期，确认新版客户端数据只进入新集合，同时评估仍在使用旧版本的用户。
5. 最后由负责人确认并人工下线旧函数、路由和孤儿文件；数据库按既定保留与备份策略处理。

若先删除旧路由再切客户端，旧客户端会收到 404；若新旧客户端长期同时写不同集合，统计会分裂。迁移期报表必须注明统计来自哪个集合或合并了哪些集合。

## 每个程序怎么填写

假设默认域名是 `demo-123.ap-shanghai.app.tcloudbase.com`，目标工具是 `bifang-pdf-tool`：

```text
APP_ID=bifang-pdf-tool
TELEMETRY_ENDPOINT=https://demo-123.ap-shanghai.app.tcloudbase.com/apps/bifang-pdf-tool/v1/track
UPDATE_BASE_URL=https://demo-123.ap-shanghai.app.tcloudbase.com/updates
```

SDK 的 `UpdateChecker` 会根据 `APP_ID` 和运行平台自动拼出 `/updates/bifang-pdf-tool/<platform>.json`。Windows 请求 `windows.json`，macOS 请求 `macos.json`。测试 GUI 要填写完整更新文件地址；业务程序配置 `UPDATE_BASE_URL` 时只填到 `/updates`，不要重复拼接。

每个程序必须传入自己的稳定 AppConfig 目录。即使两个工具安装在同一台电脑，也不能共用保存 `install_id` 和每日上报标记的目录。

## 上线前逐工具验收

对每个工具分别验证：

1. GUI 的应用编号、数据路由和更新地址都含同一个 `app_id`。
2. 当天首次启动最多产生一个 POST，再次启动产生零个 POST。
3. 记录只出现在目标工具集合中，其他集合没有新增。
4. 更新检查只读取目标工具当前平台的清单文件。
5. 修改一个工具的版本清单不会影响其他工具。
6. 403 时核对目标函数唯一的 `ALLOWED_APP_IDS`；404 时核对目标工具路由或更新目录。

历史 `/v1/track`、`telemetry`、`telemetry_events` 和 `example-tool` 只属于旧部署回执，不用于新增工具。不要修改 [`cloudbase-deployment.md`](cloudbase-deployment.md) 中的历史 URL、字节数、哈希或验收结论。

## 免费使用边界

这个结构本身不要求购买域名或证书，也不要求为每个工具创建一个新环境。平台默认域名已经提供 HTTPS。

平台价格和免费额度可能变化。控制台若出现非零金额、套餐升级、连续包月、自动续费、超限按量、资源包、自定义域名、证书购买或 EdgeOne，立即停止并先提醒负责人。
