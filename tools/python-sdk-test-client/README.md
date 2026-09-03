# Python SDK 手动测试客户端

这个本地终端客户端让 Python 宿主通过一个很薄的 Node.js JSON Lines
桥接，直接调用仓库已经实现的 `@bifang/telemetry-update-sdk`。Python 不实现
SDK 的身份、事件清洗、URL 安全检查、更新清单解析或版本决策。

## 安全边界

- 启动客户端不会初始化 SDK，也不会发起网络请求。
- “本地捕获”和“本地更新预览”使用 SDK 官方注入点，事件和决策仍由真实
  SDK 生成，但不会调用公网。
- 真实 telemetry POST 与更新 GET 是独立菜单项。每次操作都要求用户亲自
  填写 URL，并键入精确的 `POST` 或 `GET`；Node 桥接会再次核对确认词。
- 不从环境变量、示例文件、上次会话或默认配置中读取网络 URL。
- 更新检查只返回 SDK 决策，不下载、不打开链接、不校验安装包，也不安装更新。
- 本工具不部署 CloudBase、不修改远端资源，也不接入任何真实业务客户端。

Task8 已把修正后的 Phase 1 v1 协议部署并验收到现有 smoke 环境；当前 telemetry
endpoint 和更新 base URL 记录在[部署回执](../../docs/cloudbase-deployment.md)。本工具
不会读取或预填这些地址；确需 live 验证时，只能由操作者从回执人工复制、逐次完整
输入，并继续键入精确的 `POST` 或 `GET` 确认词。

SDK 会拒绝 HTTP、localhost、私网、带凭据及其他不安全 URL。因此本地预览
走 capture transport 或注入的 update fetch，而不是伪装成本地 HTTP 服务。

## 启动

需要 Node.js 20+ 与 Python 3.9+。在仓库根目录运行：

```powershell
npm ci
npm run build --workspace @bifang/telemetry-update-sdk
python .\tools\python-sdk-test-client\client.py
```

Windows 也可以使用：

```powershell
py -3 .\tools\python-sdk-test-client\client.py
```

默认身份数据按 `app_id` 隔离，分别保存在系统临时目录的 `capture` 和 `live`
子目录。可以为一次独立的首次安装测试指定新的目录：

```powershell
python .\tools\python-sdk-test-client\client.py `
  --state-dir C:\Temp\bifang-sdk-manual-run-01
```

客户端不会删除身份文件。要再次观察 `app_install`，请换用一个全新的空目录。

## 建议手动流程

1. 选择 `2` 初始化本地捕获会话。首次目录应看到 SDK 依次生成
   `app_install`、`app_start`；重启并使用同一目录时只应看到 `app_start`，
   `install_id` 保持不变而 `session_id` 改变。
2. 选择 `3`，选事件并编辑原始 `properties` JSON。输出是 SDK 最终接受的完整
   13 字段事件；多字段、少字段、旧别名或敏感标识会使整条事件被丢弃。
3. 选择 `6` 并填写本地清单路径，例如
   `cloudbase\updates\example-tool\windows.json`。程序通过真实 `UpdateChecker`
   显示 `none`、`optional` 或 `required` 决策，全程零网络。
4. 仅当你拥有测试 endpoint 时选择 `4`，亲自填写 telemetry URL 并输入
   `POST`。注意 `TelemetryClient.init()` 本身可能 POST `app_install` 和
   `app_start`；输出的 `http_ok` 只表示 transport 得到成功 HTTP 响应，不证明
   后端已经持久化。
5. live 会话初始化后，选择 `5`。每条事件仍须再次完整填写同一 endpoint 并
   输入 `POST`。
6. 先完成任一 SDK 初始化，再选择 `7`；填写更新 base URL 并输入 `GET`。检查
   在线程中执行，菜单保持可用，结果可在 `8` 查看。SDK 请求路径固定为
   `{baseUrl}/{appId}/{platform}.json`。

事件 properties 契约：

| 事件                                     | 精确 properties                                         |
| ---------------------------------------- | ------------------------------------------------------- |
| `app_install` / `app_start`              | `{}`                                                    |
| `feature_used`                           | `{"feature_id":"export_csv"}`                           |
| `task_started`                           | `{"task_type":"batch_export"}`                          |
| `task_succeeded`                         | `{"task_type":"batch_export","duration_ms":120}`        |
| `task_failed`                            | `{"task_type":"batch_export","error_code":"E_TIMEOUT"}` |
| `update_prompt_shown` / `update_clicked` | `{"target_version":"1.2.3"}`                            |

这些示例只帮助输入；Python 不据此判断合法性，最终接受或拒绝完全由 SDK 决定。

## 自动验证

```powershell
npm run check
```

也可以只运行客户端相关测试：

```powershell
npm run build --workspace @bifang/telemetry-update-sdk
node --test .\tests\python-sdk-test-client.test.mjs
python -m unittest discover -s .\tools\python-sdk-test-client\tests -p "test_*.py" -v
```

自动测试不会向公网 POST 或 GET。
