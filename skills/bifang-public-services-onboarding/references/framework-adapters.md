# 客户端更新中心框架适配

仅在阶段 5 或 6 读取。先从代码确认真实框架、生命周期和版本来源，不为套示例重构产品。

## 所有宿主

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

本地测试捕获序列化的 `daily_active` 请求，验证实际 `app_version`、独立 `sdk_version`，更换来源版本值和测试日期后再次验证。来源缺失或版本格式非法时安静失败，不能发送空值或假版本；同日升级不得突破每日一次门禁。仅 SDK 单元测试通过、源码中出现字段名或 Profile 填了版本，都不能证明宿主已正确接入。

## Tauri / Rust

- 客户端 Token、固定更新中心地址和 HTTP 请求留在 Rust 可信层。WebView 不得读取凭据或提交任意 URL/Path。
- 按实际程序平台、架构和安装形态填目标；不能依赖 User-Agent 或硬件架构猜测程序架构。
- Tauri command 只返回最小更新 DTO，并只暴露“打开已验证下载地址”“完整退出”等固定动作。
- 复用项目现有 HTTP client、超时和 AppConfig 抽象；如果原实现已有严格 SemVer、安全 URL 或完整退出，应保留并将其接到新响应。
- 单元测试至少覆盖：POST 请求字段与 Bearer 认证、201/错误、推荐/强更/不可更新、离线和策略解除、大小/摘要校验、安装前复检、完整退出、WebView 无任意 URL/凭据能力及 telemetry 无回归。

每个迁移 Task 都必须以用户明确确认的当前 working-tree 快照为权威。不得 `reset`、`stash`、`clean`，也不得从旧 HEAD 或旧默认分支另起而丢失现有改动；版本号与工作树状态必须在任务开始时实时核对，不能把某次快照写成长期事实。

## Node / Electron / TypeScript

- 使用 `@bifang/telemetry-update-sdk` 的 `ClientUpdateService` 检查更新。该 SDK 不实现下载、校验、安装、持久强更或 UUID 存储，宿主必须补齐后才声明对应能力。
- 把同一应用版本来源传入 `TelemetryClient.init({appVersion, ...})` 和 checker 的 `currentVersion`；SDK 负责映射为请求字段 `app_version`，无需另发版本报告。
- 凭据与 checker 留在主进程；renderer 只接收已验证决策和固定 IPC 动作。
- SDK 分发仍须可复现：固定 tarball、私有不可变包、仓库受控复制或 workspace。使用项目相对来源并验证版本和哈希，不能引用开发机绝对 `node_modules`。
- `verify_sdk_distribution.py` 只验证本地制品/证据，不联网；门禁未通过时不能声称可交付。
- 新传输必须验证 SDK 实际导出 `ClientUpdateService`、`parseClientUpdateSnapshot`、`isSameInstallTarget` 和对应声明；只含旧 application-version 接口的 SDK 不能通过新接入门禁。私有包证据必须明确记录 `update_transport=client-update-center-v1`，且人工证据不能冒充本地制品字节验证。

## 其他原生程序

按更新中心的客户端契约实现薄适配层；生产使用 HTTPS，明确要求本机联调时只允许 `http://127.0.0.1:8080/`，并使用测试 Token；准确实现 POST 路径、Bearer 认证、响应校验和短超时，按产品完成安全下载、复检及完整退出。不要从摘要猜测边界值。

## 广告

新更新中心接入不添加广告 UI。旧 application-version 广告能力仍按既有服务管理，不能从更新中心协议推断广告接口或凭据。

## 阶段 5 完成证据

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
