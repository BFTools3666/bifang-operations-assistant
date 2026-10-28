# 接入契约与 Profile v2

仅在阶段 1、2、5 或生成资源预览时读取。新更新 API 以更新中心项目的客户端文档和契约为准；本仓库的 application-version OpenAPI 是旧服务合同。

## 权威版本

- 基础设施：`3.0.0`
- Skill：`2.1.2`
- Application-version 契约：`1.0.0`
- Application-version 实现基线：`92b0c599a42c3a094c99787e6928c30c2d2ea3af`
- 规范来源：`https://github.com/BFTools3666/bifang-operations-assistant.git`

每次使用都记录权威仓库实际 HEAD。版本不一致时停止混用；先更新 Skill 或复核权威源码。

## 现行运行时

### Telemetry

- 固定事件 `daily_active`，同一匿名安装在北京时间当天最多尝试一次。
- 联网前原子落盘；失败当天不重试、不排队。
- 每个应用使用自己的 APP_ID、AppConfig、本地身份、函数、路由和集合。
- 客户端不发送 IP，不采集账号或硬件指纹。

### 三类版本信息

| 信息           | 来源与用途                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_version`  | 当前已运行应用的 SemVer，随既有 `daily_active` POST 发送，用于客户端活跃版本画像。宿主通过 SDK 的 `appVersion` 提供；缺失或非法值会被拒绝。 |
| `sdk_version`  | SDK/适配器版本，现行协议为 `3.0.0`；不作为应用版本来源。两者数值偶然相同合法，不能据此判错。                                                |
| `code_version` | 运营端管理接口维护的发布记录，位于逐应用 `versions_*` 集合，按发布流 code 读取，决定看板“最高版本”和更新策略。                              |

Profile `current_version` 只记录实施时快照；真实运行值应由 `version_source` 所指的发布配置/制品版本提供给 telemetry 和版本检查。升级后不需要改接入代码、Profile 或固定常量才能上报新版本。检查两个入口满足各自版本格式约束；格式冲突时报告，不私自截断或填 `0.0.0`。保持原 `daily_active` 十字段协议，不增加版本上报事件或额外字段。

阶段 5 必须在本地注入 transport/fetch，捕获序列化请求并比对应用版本；换一个来源版本值后使用新的测试日期重验，证明不是写死的值，且同日升级仍不多发。通过后记录 `telemetry_app_version_verified=true`，它不证明真实制品已经上报。阶段 6/7 的 `telemetry_app_version_online_verified` 必须来自已授权真实客户端和服务端接受证据：绑定制品版本与哈希，应用版本和已接受请求一致，核对看板相应平台/架构的活跃版本画像；既有同日门禁已领取时等待正常新日，不重置生产状态。只保留脱敏的版本比对证据，不保存安装标识、IP、原始凭据。

Telemetry 上报和更新检测都不发布版本。历史运营看板的 `code_version` 来自旧版本服务的发布记录；新更新中心另有自己的发布数据，不能把客户端观测值当作可供下载的正式发行版。

### 客户端更新中心

新客户端固定调用 `POST https://update.meetelf.com/api/v1/apps/{app_id}/update-checks`，使用运行时客户端 Bearer Token。按真实版本、系统、程序架构、安装形态、持久随机 UUID、通道和已实现能力发请求；仅 201 解析决定。完整处理、强更、下载、安装前复检、离线策略和验收见 [客户端更新中心接入合同](client-update-center.md)。

旧 application-version 的 GET 协议仍用于既有运营服务，不作为新客户端接入协议，也不因迁移客户端而自动删除云资源。

## 完全删除旧版本协议

基础设施 3.0 不承认旧静态更新为有效 transport。迁移时删除：

- 静态更新 Base URL 和平台 manifest URL；
- 14 字段 manifest types/parser/schema；
- rollout、min-supported、旧 force-update 决策；
- fallback、dual-read、兼容开关；
- 旧协议专用源码、夹具、测试和现行文档。

不要删除可复用的严格 SemVer、安全公网 HTTPS URL、纯文本 UI、主窗口异步时序、外链或完整退出逻辑。

## APP_ID 和隔离

APP_ID 用于隔离 telemetry 和更新中心中的应用身份。telemetry 仍派生 `telemetry-<app_id>` 函数、`telemetry_<normalized_app_id>` 集合和 `/apps/<app_id>/v1/track` 路由。新更新服务按实际 `os + architecture + installation_type + channel` 匹配；`x64` 映射为 `x86_64`，Linux 使用实际 Ubuntu 或 Debian。历史 CloudBase versions、ads、audit 集合及 code 仍由现有运营服务管理，不得作为新更新服务的配置或在此阶段删除。

## Profile v2

路径固定为 `.bifang/public-services-profile.json`。新接入设置 `update_transport=client-update-center-v1`、`update_center_base_url=https://update.meetelf.com`、非敏感 `update_center_auth_status`、按真实目标填写的 `update_targets`，并明确 `offline_enforcement=service-default|persist-until-resolved`。后一项仅用于产品负责人明确要求的离线持续强更例外。

继续保存确认的中文 `display_name`、APP_ID、版本来源、telemetry 信息、运行时钩子、门禁及阶段；不得存 Token、凭据摘要、硬件 ID 或绝对路径。旧 Profile v1/v2 先只读核验，迁移到新 transport 时删除客户端旧协议字段，不把旧 code 当作新接口目标。

## Profile 写入

1. 先只读解析现有 Profile；重复字段、非法 JSON 或敏感值立即停止，不覆盖。
2. 用当前代码证据重新核对已有事实；冲突必须展示。
3. 规范 URL 一句话已经授权阶段 1，可写确定性的 v2 非敏感档案；仍无法确认的产品事实最多问三个短问题。
4. 写后运行 `validate_profile.py <profile> --require-update-center` 和 `derive_resources.py`。
5. 只有生产代码/配置和活跃测试均无旧静态协议且扫描完整，才写 `legacy_update_status=removed` 与相应 gate。

中文名为 1–100 个 Unicode 字符，包含中文，无首尾空白、控制/格式字符或 `<`、`>`。从发布产品配置、窗口标题或负责人说明确认；不得把 npm 包名、仓库名、APP_ID 当作显示名，也不得自行翻译或猜名。旧 Profile 缺名或只含英文时，在已授权 Profile 修改范围内按证据补全并重新校验；草稿可暂缺名称，但不能标记完成。`derive_resources.py --profile` 要求有效名称，并输出 `display_name` 与 `dashboard_app_labels` 作为交接证据；只给 APP_ID 的技术资源预览不代表名称已经确认。

运营精灵阶段 2 将该映射写入唯一名称表 `cloudbase/functions/operations-dashboard/src/app-labels.json`，并运行 `npm run cloudbase:labels:check -- --profile-file "<已校验的 Profile 交接文件>"` 后，才可写 `app_display_name_registered=true`。命令同时核对精确名称、APP_ID 登记和完整名称覆盖；该 gate 不证明线上已生效。`dashboard_display_name_verified` 只在已授权部署后的已登录接口和页面实际显示正确中文名时为 true；没有生产验证时保持未验证。两个 gate 的证据不得互相替代，客户端本地阶段 5 仍不依赖云端完成。

旧档案的 `app_registered` 只证明既有技术登记，不证明中文名已登记；缺少名称证据时保留新 gate 为未验证，不能直接补成 true。阶段 5 可保留这一真实状态并完成本地迁移；阶段 3/4 及真实客户端验收、发布阶段分别补齐相应名称证据。

## 凭据

更新中心使用运行时客户端专用 Bearer Token，不能用后台管理凭据；其共享值可从客户端提取，不代表用户身份。不得写入 Git、Profile、命令行、普通日志或证据。没有真实凭据时用假 transport 做本地测试，线上状态保持 `Unverified`。

## 阶段门禁

- 阶段 2：APP_ID、更新目标和中文名已确认；登记表无冲突，统一名称表与 Profile 一致，完整名称覆盖检查通过。没有真实旧发布流时由运营精灵使用 `npm run cloudbase:app:add -- <app_id>` 登记仅 telemetry 资源，不编造旧 code。
- 阶段 3：生成 telemetry 配置包含全部已登记应用；`app_display_name_registered=true` 有实际校验证据；更新中心目标及费用计划已审查。
- 阶段 4：最新远端只读预检、费用为零、写入目标精确，等待明确“继续”；完成后核对线上应用集合、中文名及全部发布流，才标记 `dashboard_display_name_verified=true`。
- 阶段 5：服务端契约可本地测试；当前客户端替换/删除旧实现，本地实际请求证明应用版本来自唯一来源，`telemetry_app_version_verified=true`。
- 阶段 6：服务公网已验证、运行凭据已就绪；准确新构建制品的真实 GUI E2E 与已接受 `app_version` 一致，才标记 `telemetry_app_version_online_verified=true`。
- 阶段 7：隐私、签名、制品、下载地址、回滚均就绪，发布/推送前再次确认。
- 阶段 8：两个客户端新协议 E2E 完成，最新枚举证明旧云资源可删，展示精确目标后再次确认。
