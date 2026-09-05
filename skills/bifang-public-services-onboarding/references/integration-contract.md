# 接入契约与档案

仅在完善档案、生成资源预览、登记应用或实施客户端接入时读取。这里提供决策边界，不替代运营精灵权威源码。

## 权威版本

- 基础设施版本：`2.1.0`
- Skill 版本：`1.0.0`
- `2.1.0` 功能源码提交：`704da8d702c9991c80ba079910936c275349fabb`
- `2.0.0` 多工具协议审查基线/升级起点：`01f42449bf0f80a2660e7ee0899eef1176aca934`
- 协议权威：运营精灵的 `docs/telemetry-and-update.md`
- 隔离与命名权威：`docs/multi-tool-isolation.md`、`cloudbase/apps.json`、`cloudbase/generate-cloudbaserc.mjs`
- 客户端 API 权威：`packages/telemetry-update-sdk`、`examples/host-integration.ts`

`704da8d702c9991c80ba079910936c275349fabb` 是 `2.1.0` 向导功能源码提交；上述基线提交不是 `2.1.0` 的来源提交。每次使用都读取当前权威文件及其实际提交；若它们与本参考冲突，以当前权威文件为准，报告漂移并阻止未经复核的实施。

## 运行时契约摘要

- 统计含义是软件**启动使用**：固定事件 `daily_active`，同一匿名 `install_id` 在北京时间同一天最多尝试一次；不是安装量。
- 客户端必须在联网前原子领取/落盘当日标记。失败当天不重试、不排离线队列，以保护免费网关。
- 每个应用传自己的 APP_ID、SemVer、平台、架构和独立 AppConfig 目录。不得读取账号、主机名、MAC、硬盘号、CPU 序列号或指纹。
- 统计仅走目标应用的公网 HTTPS 路由。来源 IP 只由服务端可信上下文补充；客户端不得发送 IP。
- 更新检查读取 `/updates/<app_id>/<platform>.json`，应在主窗口显示完成后异步运行，不阻塞启动。SDK 只作决策，不自动下载或安装。
- 更新标题和正文是不可信纯文本。外部下载/发布说明地址必须经安全 HTTPS 校验；完整退出、签名、哈希和回滚由宿主负责。

具体 payload、14 字段清单、超时和判定顺序不得从本摘要猜测；实施前回到权威源码。

## APP_ID 与资源派生

正式基础设施 APP_ID 必须全局唯一，长度 1–50，只含小写字母、数字和短横线，首尾为字母或数字。建议格式为 `bifang-<product-key>`；建议值必须先让用户确认。

对确认后的 APP_ID，派生规则固定为：

| 资源     | 规则                                   |
| -------- | -------------------------------------- |
| 云函数   | `telemetry-<app_id>`                   |
| 集合     | `telemetry_<app_id 中每个 - 替换为 _>` |
| 统计路由 | `/apps/<app_id>/v1/track`              |
| 更新目录 | `/updates/<app_id>`                    |
| 平台清单 | `/updates/<app_id>/<platform>.json`    |

不得手工猜名称。使用 `derive_resources.py`，并在用户确认 APP_ID 前把全部映射作为预览显示。

派生出某平台路径不等于该平台已经受基础设施支持。当前权威登记/清单生成流程自动创建并校验 `windows.json` 与 `macos.json`，登记表会显式保存每个应用的平台集合；Linux 仍只能作为计划平台记录和预览，必须把清单 Schema、生成器、制品签名与平台 E2E 缺口列为门禁。macOS 清单没有架构字段；当前单一 `macos.json` 只适合一个明确的 Apple Silicon/通用下载入口，不能伪装成 Intel 与 Apple Silicon 双制品选择协议。

## 档案规则

档案路径固定为目标项目根目录的 `.bifang/public-services-profile.json`。Schema 位于 Skill 的 `references/public-services-profile.schema.json`，以 `validate_profile.py` 结果为准。

`profile_schema_version` 固定为 `1`，是唯一始终必填字段；其余字段可随问答逐步补齐。字段缺失表示未知，不得为了通过校验写入空字符串、猜测值或 `false`。

允许保存的内容只限非敏感接入事实，包括：产品名/用途/关键词、APP_ID、负责人、平台/架构、框架、当前版本与版本来源、AppConfig 策略、启动入口、主窗口 ready hook、外链与退出 handler、CloudBase 环境 ID/默认 HTTPS origin、统计 endpoint、更新 base URL、基础设施版本/来源提交、登记/历史路由状态、部署门禁、隐私说明和当前阶段。Node/Electron 项目还可保存固定 SDK 分发类型、项目相对来源、SDK 版本与产物 SHA-256；私有包另可保存项目相对人工证据路径和 `sha256:`/`git:` 不可变引用。不得保存本机绝对路径或环境变量展开路径。

绝不保存或回显：SecretId、SecretKey、Token、Cookie、Authorization、数据库凭据、用户账号、硬件 ID 或任何从这些值派生的内容。`cloudbase_env_id` 和不含凭据的公网 `cloudbase_origin` 可保存；带用户名、密码、查询凭据或片段的 URL 不可保存。

`infrastructure_source_commit` 要记录实际读取且对应当前基础设施版本的权威提交；不能把上述 `2.0.0` 协议审查基线冒充为 `2.1.0` 来源提交。

### 恢复与写入

1. 先验证已有档案；验证失败时展示确定性错误，不覆盖。
2. 将档案值与当前代码重新比对。代码已变更的字段标为冲突，不把旧值当现状。
3. 自动检测值先展示证据；用户提供值标为已确认。只写用户确认过的非敏感值。
4. 用户必须明确进入阶段 1，且确认待写变更；否则保持只读。
5. 写后重新运行验证和资源派生。任何失败都不升级 `current_stage` 或门禁。

Node/Electron 的阶段 5/6 还要运行 `verify_sdk_distribution.py`。固定 tarball 必须是真实 npm tgz 且包名/版本/hash 一致；受控复制或 workspace 用 `bifang-relative-content-v1` 树哈希；私有包只验证负责人签认的不可变证据，并明确 `artifact_bytes_verified=false`。制品不存在、hash 不符或证据不完整时，`sdk_distribution_ready` 不得为真。

`registration_status` 使用 `unknown | not_registered | registered | verified`；`legacy_track_status` 使用 `unknown | not_found | found | migration_required | retained`；`current_stage` 是 `1..8`。`deployment_gates` 中缺失的键表示 `unknown`，不是 `false` 更不是已通过。线上状态必须来自当前线上只读证据或负责人明确陈述，并注明证据级别；本地文件不能证明已经部署。

## 项目专属预览

信息足以派生后，以紧凑表格显示：

- 中文产品名、当前版本、版本来源与版本提升建议；
- 正式 APP_ID 及函数、集合、路由、更新目录；
- 每个目标平台的清单路径；
- 若有默认 HTTPS origin，显示完整 telemetry endpoint；更新 base URL 只到 `/updates`；
- 登记、部署、隐私、测试、发布和迁移门禁中尚未满足的项。

接入统计与更新属于功能扩展，已有正式基线通常建议提升 minor；但必须从项目自己的唯一版本来源判断并展示建议，不能直接改版本。运营精灵基础设施从 `2.0.0` 提升至 `2.1.0`；SDK 公共 API 未变化时保持 `2.0.0`。

## 八阶段状态

1. 完善接入档案。
2. 在运营精灵登记新应用。
3. 生成并审查 CloudBase 资源配置。
4. 部署独立资源并完成线上 E2E。
5. 在业务客户端实施接入。
6. 构建、安装和真实客户端 E2E。
7. 发布与迁移观察。
8. 经负责人确认后清理旧资源。

计划可一次展示八阶段，但执行一次只能选一阶段。阶段状态使用“未开始 / 进行中 / 有证据完成 / 阻塞”；不得因文件存在或用户口头期望把后续阶段标成完成。
