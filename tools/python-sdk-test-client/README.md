# Python SDK GUI / CLI 手动测试客户端

这是 `@bifang/telemetry-update-sdk` 的本地手动测试工具，不是业务客户端或管理后台。
Windows 图形界面使用 Python 标准库 Tkinter/ttk；原有命令行客户端继续保留。两种界面都
通过薄 Node.js JSON Lines 桥接调用仓库内真实 TypeScript SDK。Python 不实现 SDK 的
身份规则、事件清洗、URL 安全检查、更新清单解析、SemVer 或灰度决策。

## 安全边界

- 启动 GUI 只会启动本地 Node 子进程并执行零网络 `ping`，不会初始化 SDK，不会自动
  POST 或 GET。
- “本地零网络”页使用 capture transport 或注入式 update fetch；事件和更新决策仍由
  真实 SDK 生成，但不会访问公网。
- Live telemetry endpoint 和 update base URL 初始都为空。工具不从环境变量、示例、
  部署回执、历史输入或上次会话读取或预填 URL，也不把 URL 保存到磁盘。
- 每个真实请求都弹出确认框，显示 HTTP method、精确请求 URL 与副作用。Telemetry 要
  重输操作者手填且经 SDK 校验的 endpoint；update 要重输 SDK 构造的请求 URL。之后再
  输入区分大小写的 `POST` 或 `GET` 并点击授权按钮；按 Enter 不会授权。取消或输入不匹配
  不会提交 live 请求。
- Node 桥接还会再次检查 `allow_network=true`、精确确认词和 SDK URL 安全规则。GUI 的
  同意不是绕过 SDK 安全检查的开关。
- `init_live` 可能立即 POST `app_install`（首次有效身份）和 `app_start`（每次初始化），
  通常产生一至两次请求。事件发送每次都要求重新输入、确认 endpoint，且 endpoint 必须与
  初始化时逐字相同。
- 更新检查只返回 SDK 决策和调试信息。`title`、`message`、`download_url` 与
  `release_notes_url` 都作为不可信纯文本/JSON 展示；工具不下载、不打开链接、不校验
  安装包，也不安装更新。
- HTTP `http_ok` 只表示 transport 收到成功响应，不证明后端持久化；更新结果
  `none/unavailable` 也可能是 SDK 的网络失败静默语义，应同时查看结构化 `debug`。
- 所有桥接和网络调用都在 worker 中执行。窗口会显示忙碌状态并临时禁用动作按钮；失败
  写入结构化结果区，不弹系统错误框，也不会让窗口崩溃。
- 本工具不部署 CloudBase、不修改远端资源，也不接入任何真实业务客户端。

Task8 已把修正后的 Phase 1 v1 协议部署并验收到现有 smoke 环境；当前地址只记录在
[部署回执](../../docs/cloudbase-deployment.md)。GUI 和 CLI 都不会读取或预填这些地址。

## 准备与启动 GUI

需要 Node.js 20+、Python 3.9+，以及标准 Python 安装随附的 Tkinter/ttk。在仓库根目录
准备依赖并构建 SDK：

```powershell
npm ci
npm run build --workspace @bifang/telemetry-update-sdk
```

启动 Windows GUI：

```powershell
python .\tools\python-sdk-test-client\gui.py
```

也可以使用 Python Launcher：

```powershell
py -3 .\tools\python-sdk-test-client\gui.py
```

GUI 包含：

- 顶栏默认离线/桥接状态；
- SDK 配置卡，以及本地捕获和 Live 会话的 `install_id` / `session_id` 状态；
- 六个 telemetry 事件的离线参数编辑和真实 SDK 事件预览；
- 本地更新 manifest JSON 的真实 `UpdateChecker` 判定；
- 独立的 Live telemetry POST 与 Live update GET 高风险区；
- 不会执行链接的结构化结果/日志区和明确忙碌状态。

Task13 只完成 GUI 实现与自动构建验证，没有在本 Task 启动真实窗口、执行真实联网或交付
人工运行结果；这些属于后续独立人工测试 Task。

## 身份目录与含义

默认状态根目录是：

```text
%TEMP%\bifang-python-sdk-test-client
```

工具按 `capture` / `live` 和 `app_id` 的 SHA-256 短命名空间隔离身份目录，并在界面显示
实际根目录。它不会删除身份文件：

- `install_id` 是该 app 与状态目录内持久的随机安装 UUID。同一目录重启后保持不变，
  不是 MAC、硬盘号、CPU ID 或其他机器指纹。
- `session_id` 是每次 SDK 初始化新建的随机会话 UUID。

要观察新的 `app_install`，请在一次独立手测中指定全新的空目录：

```powershell
python .\tools\python-sdk-test-client\gui.py `
  --state-dir C:\Temp\bifang-sdk-manual-run-01
```

## GUI 建议手动流程

1. 等顶栏显示本地桥接与 SDK 版本就绪。启动探活不会联网。
2. 如需修改配置，编辑后点击“应用配置并重置会话”；编辑值不会隐式生效。
3. 在“本地零网络”页初始化本地捕获。首次空目录应看到 `app_install`、`app_start`；
   复用目录时应只看到 `app_start`，`install_id` 不变、`session_id` 改变。
4. 选择六个事件之一并编辑 `properties` JSON，运行本地预览。多字段、少字段、旧别名或
   敏感标识是否被丢弃，完全由真实 SDK 决定。
5. 粘贴或载入本地更新 JSON，运行离线判定。GUI 只解析 JSON object 外壳，清单契约、
   版本和灰度判定在 SDK 内完成。
6. 只有确实拥有测试 endpoint 时才进入“显式联网”页。Live 初始化确认文案会明确提示
   可能立即产生 `app_install` / `app_start` POST；提交后 URL 输入框会清空。
7. 发送 Live 事件时重新填写与初始化完全相同的 endpoint，并再次完成双输入确认。
8. Live update 先由桥接调用真实 SDK `buildUpdateUrl()` 离线生成精确请求 URL，再要求对该
   完整 URL 进行 `GET` 确认。结果只显示，不会打开 `download_url`。

事件 properties 示例只用于帮助输入：

| 事件                                     | 精确 properties                                         |
| ---------------------------------------- | ------------------------------------------------------- |
| `feature_used`                           | `{"feature_id":"export_csv"}`                           |
| `task_started`                           | `{"task_type":"batch_export"}`                          |
| `task_succeeded`                         | `{"task_type":"batch_export","duration_ms":120}`        |
| `task_failed`                            | `{"task_type":"batch_export","error_code":"E_TIMEOUT"}` |
| `update_prompt_shown` / `update_clicked` | `{"target_version":"1.2.3"}`                            |

`feature_id`、`task_type` 与 `error_code` 只能使用受控、低熵、稳定标识。不要粘贴姓名、
账号、Token、Cookie、文件路径/正文、完整 URL、用户正文、异常原文或这些内容的编码值。
GUI 不会把配置、endpoint 或 manifest 正文自动加入 telemetry properties。

## 保留的 CLI

原命令行工作流与参数保持兼容：

```powershell
python .\tools\python-sdk-test-client\client.py
```

或：

```powershell
py -3 .\tools\python-sdk-test-client\client.py `
  --state-dir C:\Temp\bifang-sdk-manual-run-01
```

CLI 同样默认完全离线；真实 POST/GET 仍须手填 URL 和精确确认。

## 自动验证

完整检查：

```powershell
npm run check
```

客户端专项检查：

```powershell
npm run build --workspace @bifang/telemetry-update-sdk
node --test .\tests\python-sdk-test-client.test.mjs
python -m unittest discover -s .\tools\python-sdk-test-client\tests -p "test_*.py" -v
```

GUI 测试使用 fake bridge、capture transport 和注入式 fetch，不创建真实 Tk 窗口，也不向
公网 POST/GET。Python↔Node 离线 IPC 用例还会核对 `network_performed=false`。
