# 多工具资源隔离指南（共用一个免费环境）

## 结论

多个小工具可以共用同一个免费 CloudBase 环境和平台默认 HTTPS 域名。每个工具使用独立的应用编号、云函数、HTTP 路由、数据库集合、本地状态目录和更新文件，因此统计与版本发布不会串用。这是业务资源隔离，不是 CloudBase 环境级完全隔离。

共享的只有 CloudBase 环境、默认域名、`/updates` 静态托管入口、免费额度和平台故障域。任一工具消耗的请求、函数、数据库、存储和流量都会计入同一环境额度；这不是额度或故障层面的完全隔离。若要连额度和故障域也隔离，就需要多个 CloudBase 环境，可能涉及付费，不能自行创建或升级。

在其他小工具仓库开始接入时，显式调用 `$bifang-public-services-onboarding`。向导会先读取目标项目和已有 `.bifang/public-services-profile.json`，只询问无法确认的信息；APP_ID 与资源映射确认后仍按八个独立阶段推进，不会把登记、部署、客户端修改、构建、发布和旧资源清理合成一次操作。

## 固定命名规则

部署用 `app_id` 必须满足：

- 全局唯一，不与其他工具复用；
- 长度 1–50 个字符；
- 只使用小写字母、数字和短横线；
- 开头和结尾必须是小写字母或数字。

登记表 [`cloudbase/apps.json`](../cloudbase/apps.json) 是全部工具的唯一基础设施清单。生成器会根据它一次生成包含所有函数和路由的 `cloudbaserc.json.example`。

| 资源             | 派生规则                             | `bifang-tools-pdf` 示例                  |
| ---------------- | ------------------------------------ | ---------------------------------------- |
| 应用编号         | `<app_id>`                           | `bifang-tools-pdf`                       |
| Event 云函数     | `telemetry-<app_id>`                 | `telemetry-bifang-tools-pdf`             |
| 数据库集合       | `telemetry_` + 把每个 `-` 替换为 `_` | `telemetry_bifang_tools_pdf`             |
| 数据接收路由     | `/apps/<app_id>/v1/track`            | `/apps/bifang-tools-pdf/v1/track`        |
| 更新目录         | `/updates/<app_id>`                  | `/updates/bifang-tools-pdf`              |
| Windows 更新文件 | `/updates/<app_id>/windows.json`     | `/updates/bifang-tools-pdf/windows.json` |
| 本地状态目录     | 每个宿主自己的 AppConfig 目录        | 由宿主程序单独指定                       |

每个独立函数的环境变量必须精确对应同一工具：

```text
ALLOWED_APP_IDS=bifang-tools-pdf
TELEMETRY_COLLECTION=telemetry_bifang_tools_pdf
TRACK_PATH=/apps/bifang-tools-pdf/v1/track
```

`ALLOWED_APP_IDS` 这个历史变量名仍被保留，但新模板中每个函数只允许填写一个 `app_id`，不能写逗号分隔的多工具名单。

## 新增一个工具

以下例子新增 `bifang-tools-pdf`。

1. 使用安全追加命令登记工具：

   ```powershell
   npm run cloudbase:app:add -- bifang-tools-pdf
   ```

   命令会拒绝非法或重复编号，不覆盖已有目录；成功后会同时更新 `cloudbase/apps.json`、创建默认关闭的 `cloudbase/updates/bifang-tools-pdf/windows.json`，并重生成包含全部工具的 `cloudbaserc.json.example`。一次只运行一个新增工具命令，不要在两个终端并发执行；若电脑在写入中途异常退出，先运行下一步的一致性检查并处理提示，不要直接部署。

2. 修改新 `windows.json` 的版本、标题、说明、下载地址、发布说明地址、SHA-256 和发布时间。新文件默认 `enabled=false`、`rollout=0` 且使用 `.example.invalid`，因此不会意外发布；真实上线前必须替换占位地址。
3. 运行配置一致性检查：

   ```powershell
   npm run cloudbase:config:check
   ```

   检查会验证编号、重复项、生成模板，以及每个登记工具是否存在 app ID 匹配的 Windows 清单。不要手工维护生成后的函数与路由列表；若确需重新生成，使用 `npm run cloudbase:config`。

4. 在 CloudBase 文档型数据库页面**手工创建** `telemetry_bifang_tools_pdf`，权限设为 `ADMINONLY`、仅管理员可读写或控制台中含义相同的选项。生成器只生成函数、路由和静态更新配置，**不会自动创建数据库集合**。
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

7. 在 dry-run 中确认：旧工具的函数和路由仍然存在；新增内容只有目标工具的函数、路由与更新目录；没有删除项、陌生资源或收费项。确认无误后才运行 `tcb deploy`。

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

假设默认域名是 `demo-123.ap-shanghai.app.tcloudbase.com`，目标工具是 `bifang-tools-pdf`：

```text
APP_ID=bifang-tools-pdf
TELEMETRY_ENDPOINT=https://demo-123.ap-shanghai.app.tcloudbase.com/apps/bifang-tools-pdf/v1/track
UPDATE_BASE_URL=https://demo-123.ap-shanghai.app.tcloudbase.com/updates
```

SDK 的 `UpdateChecker` 会根据 `APP_ID` 和平台自动拼出 `/updates/bifang-tools-pdf/windows.json`。测试 GUI 要填写完整更新文件地址；业务程序配置 `UPDATE_BASE_URL` 时只填到 `/updates`，不要重复拼接。

每个程序必须传入自己的稳定 AppConfig 目录。即使两个工具安装在同一台电脑，也不能共用保存 `install_id` 和每日上报标记的目录。

## 上线前逐工具验收

对每个工具分别验证：

1. GUI 的应用编号、数据路由和更新地址都含同一个 `app_id`。
2. 当天首次启动最多产生一个 POST，再次启动产生零个 POST。
3. 记录只出现在目标工具集合中，其他集合没有新增。
4. 更新检查只读取目标工具的 `windows.json`。
5. 修改一个工具的版本清单不会影响其他工具。
6. 403 时核对目标函数唯一的 `ALLOWED_APP_IDS`；404 时核对目标工具路由或更新目录。

历史 `/v1/track`、`telemetry`、`telemetry_events` 和 `example-tool` 只属于旧部署回执，不用于新增工具。不要修改 [`cloudbase-deployment.md`](cloudbase-deployment.md) 中的历史 URL、字节数、哈希或验收结论。

## 免费使用边界

这个结构本身不要求购买域名或证书，也不要求为每个工具创建一个新环境。平台默认域名已经提供 HTTPS。

平台价格和免费额度可能变化。控制台若出现非零金额、套餐升级、连续包月、自动续费、超限按量、资源包、自定义域名、证书购买或 EdgeOne，立即停止并先提醒负责人。
