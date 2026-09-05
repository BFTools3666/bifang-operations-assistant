# 框架适配路由

仅在识别宿主钩子、实施阶段 5 或验证阶段 6 时读取。先以代码证据识别真实框架和生命周期；不要为了套用示例改造现有产品结构。

## 所有宿主共同约束

无论语言与框架，先确认并记录：正常启动入口、唯一版本来源、应用专属 AppConfig 目录、主窗口已显示钩子、安全外链方法、完整退出方法、平台/架构映射，以及现有统计/更新代码。

共同生命周期：

1. 从发布配置读取已确认的 APP_ID、SemVer、HTTPS telemetry endpoint、`/updates` base URL 和两个默认关闭的功能开关。
2. 使用该应用自己的 AppConfig 目录和 APP_ID 命名空间，原子读取/创建 UUID v4 匿名 `install_id`。
3. 正常启动时，在联网前原子领取北京时间当日标记；领取成功才低优先级发送一次 `daily_active`。失败不阻塞启动、当天不重试。
4. 主窗口显示完成后异步检查更新；网络/配置错误安静返回无更新。
5. 只把安全 HTTPS 地址交给宿主外链 API；更新文案按纯文本显示。强制更新退出必须调用宿主完整退出路径。

测试或调试代码不得默认访问真实 CloudBase。使用注入 transport/fetch、本地临时 AppConfig 和固定时钟；线上测试仅属于已授权阶段 4/6。

## Node / Electron / TypeScript

适用证据包括 `package.json`、Electron 主进程、TypeScript 配置以及 Node 20+ 运行时。

- 优先直接使用 `@bifang/telemetry-update-sdk` 和 `@bifang/telemetry-update-sdk/node`，按权威 `examples/host-integration.ts` 接线，不复制 SDK 实现。
- 实施前先解决 SDK 的可移植分发：当前 `2.0.0` 未发布到公网 npm，权威仓库也不提交 `dist`，不能把本机 `node_modules` 或绝对路径当作交付。只接受固定版本 tarball、私有包、仓库内受控复制或 workspace；使用项目相对来源，并记录版本与产物 SHA-256。运行 `verify_sdk_distribution.py` 验证真实 tgz 或目录内容；私有包还需精确版本、不可变 hash/commit 以及由档案负责人签认且带时区时间的项目内 JSON 证据，此模式必须标为 `manual_evidence`，不能声称已读取包字节。档案中的 `sdk_distribution`、`sdk_artifact_sha256` 和 `deployment_gates.sdk_distribution_ready` 未通过时，阶段 5 保持阻塞。
- 在 Electron 主进程或有 Node 文件系统能力的可信宿主层创建 `NodeFileIdentityStorage`。传入应用自己的绝对配置目录，并传 `{ appId: APP_ID }`；不要在 renderer 中暴露文件系统或任意外链能力。
- 复用应用现有生命周期。常见映射可能是 `app.getPath("userData")`、窗口 `ready-to-show`/实际 show 完成、`shell.openExternal` 和 `app.quit()`，但只有代码证据能确定；不凭框架名自动填写档案。
- renderer 需要更新 UI 时，通过现有最小权限 IPC 传递已验证决策和固定动作；不要允许 renderer 提交任意 URL 或任意进程命令。
- 校验平台/架构映射只产生 SDK 支持的 `windows|macos|linux` 与 `x64|arm64|ia32`。版本从项目现有唯一发布来源读取，避免 `package.json`、构建配置和 UI 三处漂移。

前向测试至少覆盖：首次/同日再次/跨日启动、发送前落盘、失败不重试、APP_ID 文件隔离、主窗口不受网络阻塞、更新 none/optional/required、安全外链、完整退出，以及旧 `/v1/track` 不再被运行时引用。

## Tauri / Rust

适用证据包括 `src-tauri/Cargo.toml`、`tauri.conf.*`、Rust 启动/命令代码和 Web 前端。

TypeScript SDK 的 `NodeFileIdentityStorage` 不能直接用于 Tauri WebView。先检查项目是否已有可信 Rust 后端存储/HTTP 能力或经过审计的桥接层，再选择最小适配：

- 若前端能复用 SDK 的框架无关部分，仍需由 Rust 命令提供应用配置目录内的原子身份/每日门禁；命令只暴露所需固定操作，不暴露任意文件路径。
- 若由 Rust 原生实现协议，必须逐项遵守当前权威 payload、北京时间门禁、无重试、超时、HTTPS、严格更新 Schema/SemVer、安全 URL 与失败静默规则；不要凭本参考重写过期协议。
- AppConfig 使用 Tauri/系统提供的应用专属配置目录，再以 APP_ID 隔离文件。禁止用安装目录、当前工作目录、系统根目录或其他工具目录。
- 从真实窗口事件确定“已显示”，再异步检查更新。外链使用已配置/允许的 opener 能力并再次校验 URL；完整退出走应用现有的托盘、后台任务和清理路径，而不是强制杀进程。

Rust 测试用临时目录、假 HTTP 和固定时间，至少覆盖与 Node 路径相同的行为不变量；额外验证 WebView 不能传任意路径、任意 URL 或伪造服务端字段。若没有可验证的原子每日门禁，阻塞阶段 5 完成。

## 其他原生程序

不要假定 TypeScript SDK 可直接嵌入。先寻找官方运行时/FFI/现有网络和配置抽象；无法直接复用 SDK 时，实施一个尽量薄的原生适配层，并以运营精灵精确协议和跨语言契约测试约束它。

原生适配必须具备：原子持久化 UUID v4、APP_ID 文件隔离、北京时间日门禁、发送前落盘、无重试/无队列、短超时、严格 HTTPS、精确 telemetry 字段、严格 14 字段更新解析、SemVer 比较、安全外链和宿主完整退出。缺一项就把对应门禁标为未完成，不用“基本兼容”替代证据。

## 毕方录屏助手历史兼容案例

此案例用于教会向导区分“自动识别事实”与“可复用规则”，不是其他项目的默认配置。证据快照来自毕方录屏助手仓库的提交 `389abf4`；下列文件位置均相对于该仓库根目录：

- 入口 `screen_recorder_gui/src-tauri/src/main.rs` 的 `main()` 调用 `screen_recorder_gui_lib::run()`；Tauri `setup` 只启动一次 `PublicServicesRuntime`。
- 唯一版本源是根 `Cargo.toml` 的 `[workspace.package].version = 0.7.0`，运行时读取 `app.package_info().version`。
- 稳定配置目录来自 `app.path().app_config_dir()`；Windows 实际策略为 `%APPDATA%\com.arden.screenrecorder`。
- React `ApplicationShell` 提交后用 `setTimeout(..., 0)` 请求更新检查；Rust 端再次确认 `main` 窗口可见，并用 `OnceCell` 保证每进程一次。
- 前端 `open_update_download` 不接收 URL；Rust 只从已验证清单取 URL 后调用 `ShellExecuteW`。
- `exit_application` 依次停止服务、效果和覆盖层，再 `app.exit(0)`；Exit 回收快捷键与输入观察器。这才是完整退出，不可替换成强杀进程。
- 仅 Windows x64 已获批准；非 Windows 外链路径为 `unsupported`，不得据代码存在宣称支持。
- 发布配置在 `screen_recorder_gui/src-tauri/public-services.json`；快照仍使用不可复用的 `APP_ID=bifang-tools`、两个开关为 `true`，且 telemetry 仍指向历史 `/v1/track`。
- 隐私文案在 `screen_recorder_gui/src/i18n/resources/zh-CN.json:209`，由 `screen_recorder_gui/src/components/support/about-panel.tsx:190` 以纯文本显示；`brand-support/zh-CN.json` 不是该隐私正文来源。

该项目采用 Rust 按权威协议实现，而不是强塞 Node SDK。测试域名不等于正式地址；远端清单 `0.1.0` 低于客户端 `0.7.0` 只能证明连通，不能证明正式更新配置正确。若负责人确认正式 APP_ID 为 `bifang-screen-recorder`，必须登记并部署整套独立函数、集合、路由、更新目录，保留旧链路完成迁移观察；只改显示名或一个配置字符串不构成迁移。

## 实施范围和验收证据

阶段 5 只改业务客户端接入及其本地测试；不得顺带构建安装、访问真实 CloudBase、发布或迁移。阶段 6 才构建并在准确制品上做真实客户端 E2E，且需明确授权。

报告分别标注：静态检查、单元/契约测试、构建、真实窗口测试、线上 CloudBase E2E。任一类证据不能代替另一类；未运行就写 `Not run` 或 `Unverified`。
