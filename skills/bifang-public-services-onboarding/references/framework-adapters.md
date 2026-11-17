# 客户端更新中心框架适配

仅在阶段 5 或 6 读取。先从代码确认真实框架、生命周期和版本来源，不为套示例重构产品。

执行这些阶段前必须已经通过 [接入范围第一门禁](../SKILL.md#第一门禁确认接入范围)。下列联合清单只执行用户选择的服务；仅更新不新增/迁移日活，仅统计不迁移或删除旧更新。保留未选服务的既有行为，不将其当成本次必填配置。

## 所有宿主

全流程先遵守 [门禁串行总表](integration-contract.md#门禁顺序与放行总表)，不得依据历史阶段号跳步；联合任务必须两项在当前门禁全部通过。

实现前通过 [第二门禁](integration-contract.md#第二门禁授权中心授权与配置获取)：设备授权后读取所选真实配置，自动识别项目事实并采用有依据默认值，不让客户填参数表。OAuth/GET 合同已经明确；真实生产入口和 Endpoint 语义仍按部署资料核验。该流程只授权必要授权/配置读取，不自动授权下游写测试数据或安装。

取得并验证配置后，还须通过 [第三门禁](integration-contract.md#第三门禁客户端接入方案与请求明细确认)：自动核验当前项目的具体 Rust 接入位置、字段来源、默认行为、变更范围和验收计划，才在原授权内实施。只核验所选服务；技术项齐备后须在回复正文展示 [完整接入确认单](integration-contract.md#客户接入确认单回复正文必填)，逐项列真实完整 URL、方法、请求头和参数、实际非敏感值/生成规则、默认依据及待补，再等待客户明确确认，不能只给记录链接。客户不用手填参数；凭据不回显。范围选择及浏览器批准不代替该确认，未确认不实施；“仅确认方案”不授权写业务代码，“确认并进入第四门禁”只有本次所选范围第三门禁整体通过后才能进入第四门禁。方案就绪不代替本地实现或真实验收，也不改变本文原有阶段授权。

第三门禁经客户明确确认后，在原授权内按 [第四门禁](integration-contract.md#第四门禁客户端本地实施与验收) 先按 [UI 方案与位置确认](integration-contract.md#先展示并确认-ui再编码) 读取当前项目风格，展示更新提示、强更和入口预览及触发/显示位置，等待客户明确确认适用 UI 后才编码；第三门禁确认不能替代 UI 确认。仅统计无可见变更时记不适用；都接入等待 UI 确认期间也不先写统计代码。编码前先执行 [项目架构与规范核验](integration-contract.md#编码前学习当前项目架构与编码规范)，读取目标项目适用指令、真实调用链及同类实现，复用现有设施并按原目录/依赖/编码规则实现，不新增客户审批。随后完成所选服务的本地实施和宿主验收，自动修复本轮失败；不重复询问自动可完成项。用假凭据、注入 transport 和临时状态验证，真实服务/GUI/安装及云端写入仍需对应授权。单项与联合分开记录，只能标本地通过，不能冒充真实接入完成。本地通过后必须按 [线上配置与 EXE 测试](integration-contract.md#本地通过后更新中心配置与-exe-真实测试) 提示客户手动配置更新服务；客户告知完成后先做客户端更新接口简单预检，通过且 EXE 测试授权明确后才构建/运行真实 EXE，不代操作或审核后台。仅统计跳过更新中心及更新预检。

1. 保留正确的 `daily_active`：应用专属 AppConfig、APP_ID 隔离、联网前原子落盘、北京时间同日一次、失败不重试。
2. 在可信宿主调用更新中心 POST 接口，精确填写运行版本、操作系统、程序架构、安装形态、持久随机 UUID、触发方式及实际能力。
3. 使用运行时客户端 Bearer Token，只接受 HTTP 201 的有效决定；不要将认证转发给文件服务。
4. 依据 `decision`、`enforcement` 和 `action` 处理；仅 `block_new_operations` 阻止新业务，保留更新、重试和退出。
5. 下载时校验长度和 SHA-256，安装前以 `pre_install` 重检并比对目标，不执行服务端任意命令。
6. 按产品明确选择的离线策略处理持久强更；定时检查遵守服务端间隔，保留已有任务。
7. 远端文字按不可信纯文本显示；外链前再次验证 HTTPS。强制更新退出调用宿主完整清理路径。
8. 删除当前客户端旧静态和旧 application-version 更新实现及相关 fallback；不得因此删除其他客户端或线上资源。

测试默认使用注入 transport/fetch、固定时钟和临时 AppConfig，不能访问真实 CloudBase。阶段 6 才使用真实服务与准确制品。

应用版本从唯一发布来源或宿主运行时版本 API 读取，并供给 telemetry `app_version` 与更新检查的当前版本。Profile 仅是实施快照；不要在启动代码中读取它当运行时版本，也不要把 SDK 自身版本填进 `app_version`。Tauri/Rust 复用真实打包配置或宿主 package version，Node/Electron 复用真实应用包版本或主进程版本 API，其他原生程序复用制品版本信息；具体入口以当前项目证据为准。

本地测试捕获序列化的 `daily_active` 请求，验证实际 `app_version` 与固定 `sdk_version=3.0.0`，更换应用版本值和测试日期后再次验证；不能将 Rust crate 版本填入 sdk_version。来源缺失或版本格式非法时安静失败，不能发送空值或假版本；同日升级不得突破每日一次门禁。仅 SDK 单元测试通过、源码中出现字段名或 Profile 填了版本，都不能证明宿主已正确接入。

## Tauri / Rust

- 客户端 Token、经过验证的服务地址和 HTTP 请求留在 Rust 可信层。WebView 不得读取凭据或提交任意 URL/Path。
- 按实际程序平台、架构和安装形态填目标；不能依赖 User-Agent 或硬件架构猜测程序架构。
- Tauri command 只返回最小更新 DTO，并只暴露“打开已验证下载地址”“完整退出”等固定动作。
- 复用项目现有 HTTP client、超时和 AppConfig 抽象；如果原实现已有严格 SemVer、安全 URL 或完整退出，应保留并将其接到新响应。
- 单元测试至少覆盖：POST 请求字段与 Bearer 认证、201/错误、推荐/强更/不可更新、离线和策略解除、大小/摘要校验、安装前复检、完整退出、WebView 无任意 URL/凭据能力及 telemetry 无回归。

每个迁移 Task 都以当前 working-tree 的实际取证快照为权威；可自动确定的工作区事实不要求用户重复确认，只有无法判定的改动冲突才最少澄清。不得 `reset`、`stash`、`clean`，也不得从旧 HEAD 或旧默认分支另起而丢失现有改动；版本号与工作树状态必须在任务开始时实时核对，不能把某次快照写成长期事实。

### 运行时服务配置

授权中心 OAuth 与精确配置字段已由 [授权中心协议](integration-contract.md#授权中心协议与配置字段) 定义。接入执行方先完成/复用设备授权，按范围 GET 配置；若产品后续需要运行时取配置，Rust 仍须完整遵守同一 OAuth、串行刷新及禁止重定向规则，不能因此让 WebView 接触令牌。当前规范维护不表示已实现 Rust 获取代码。

- 默认 project_id=bifang_tools、scope 按范围取 updater:config:read、cloudbase:config:read 或两者以单个空格连接；本地 woskill 仅用于适用登记环境，无 client_secret；生产地址与登记从运维资料读取，不要求客户手填。
- CloudBase 响应是 SecretId、SecretKey、EnvId、Region、Endpoint；Updater 是 Endpoint、ClientToken，均无 data 包装。SecretId/SecretKey 只用于已授权可信运维，不分发到业务客户端，不添加到日活十字段。
- Endpoint 必须核验下游含义；CloudBase 服务端点不必然是日活网关。不能从 EnvId/Region 猜域名，不能让 SDK 忽略返回值偷偷使用内置地址。通过现有登记/只读部署资料核验，无法解释则报告部署缺项。
- OAuth access_token 只用于配置查询；Updater ClientToken 只用于更新检查。OAuth expires_in 与刷新不代表 ClientToken 的到期或刷新；UpdateCheck.expires_at 是检测快照期限。
- 所有令牌/密钥保持原文、不 trim、不打印；配置响应 no-store，不进入浏览器或通用 HTTP 缓存。凭据不进 Profile、源码、日志、错误 DTO 或 WebView；不向下载服务转发任何检查/配置令牌。
- 客户只参与必要的浏览器批准；项目事实自动识别、默认值按统一规范采用，不让客户重填 schema、版本、UUID、协议常量或整张参数表。
- 配置失败不伪装为无更新，不阻塞主窗口、不重置日活门禁。联合任务两配置分别处理，失败分支停止，不用旧缓存假装成功。
- 本地验证用假凭据及注入 transport，覆盖 OAuth 表单、轮询、一次串行刷新、GET 零 query/body、禁止重定向、精确字段及日志脱敏。真实授权/配置获取与下游 HTTP、云写入、安装 E2E 分别记录，不互相替代。

## Node / Electron / TypeScript

以下仅用于维护已有 Node/Electron 接入和仓库协议参考，不是新 Rust 接入的运行时方案。

已有 TypeScript SDK 和 examples/host-integration.ts 尚未完整对齐 OpenAPI 1.4.1；具体架构、字段、校验差异见 [Updater reference](client-update-center.md#验收与现有参考实现差异)。维护时先对照权威合同，不把示例参数或旧类型当成完整字段定义。本次规范整理不升级业务实现。

- 使用 `@bifang/telemetry-update-sdk` 的 `ClientUpdateService` 检查更新。该 SDK 不实现下载、校验、安装、持久强更或 UUID 存储，宿主必须补齐后才声明对应能力。
- 把同一应用版本来源传入 `TelemetryClient.init({appVersion, ...})` 和 checker 的 `currentVersion`；SDK 负责映射为请求字段 `app_version`，无需另发版本报告。
- 凭据与 checker 留在主进程；renderer 只接收已验证决策和固定 IPC 动作。
- SDK 分发仍须可复现：固定 tarball、私有不可变包、仓库受控复制或 workspace。使用项目相对来源并验证版本和哈希，不能引用开发机绝对 `node_modules`。
- `verify_sdk_distribution.py` 只验证本地制品/证据，不联网；门禁未通过时不能声称可交付。
- 本地分发校验统一验证 SDK 实际导出 `TelemetryClient`、`ClientUpdateService`、`parseClientUpdateSnapshot`、`isSameInstallTarget` 和对应声明；缺少传输字段也不能回到旧 GET 校验，混入旧 application-version 接口的 SDK 同样拒绝。私有包的新接入证据必须明确记录 `update_transport=client-update-center-v1`，且人工证据不能冒充本地制品字节验证。

## 其他原生程序

按更新中心的客户端契约实现薄适配层；生产使用 HTTPS，明确要求本机联调时只允许 `http://127.0.0.1:8080/`，并使用测试 Token；准确实现 POST 路径、Bearer 认证、响应校验和短超时，按产品完成安全下载、复检及完整退出。不要从摘要猜测边界值。

## 广告

新更新中心接入不添加广告 UI。旧 application-version 广告能力仍按既有服务管理，不能从更新中心协议推断广告接口或凭据。

## 阶段 5 完成证据

按第四门禁已选范围裁剪：更新项只适用于选择更新，telemetry 项只适用于选择统计，都接入还需联合隔离证据。单服务遇到联合 Profile 工具限制如实记录，不填假值，不将未选项当失败；选中但未完成项不能省略。

- Profile v2 与资源派生通过；
- 源码和配置只使用新版本协议；
- 旧静态版本实现已删除且完整扫描为 `removed`；
- 本地单元/契约/静态检查通过；
- 宿主级请求捕获证明版本来源、`app_version`、`sdk_version` 及每日门禁，`telemetry_app_version_verified=true`；
- 未打包、安装、访问真实服务、发布或推送，除非用户另有明确授权。

## 阶段 6 完成证据

- 服务端公网 HTTP E2E 与运行凭据已就绪；
- 构建制品版本、SHA-256、安装路径可审计；
- 真实制品正常上报的 `app_version` 与制品版本一致，服务端已接受且看板活跃版本可核对，`telemetry_app_version_online_verified=true`；
- 真实窗口验证无更新、推荐、强制、不可更新、错误/断网、安装及完整退出；
- 请求观测证明新 POST URL、真实目标字段、认证头存在且凭据值被遮挡，并证明不再请求旧协议；
- Windows 与 macOS 证据分开，未运行的平台保持 `Unverified`。
