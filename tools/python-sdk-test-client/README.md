# Python SDK 验证客户端

这个本地工具通过长驻 Node 桥接进程调用仓库里的真实
`@bifang/telemetry-update-sdk`。它验证两条独立能力：

- `daily_active`：保留每个工具独立的 telemetry 函数、路由、集合和本地匿名身份；
- application-version API v1：使用发布流 `code`、当前版本和一对只读运行时凭据检查版本。

版本检查只使用以下冻结请求：

```text
GET https://<host>/tools/version-control/v1/versions/{code}/{currentVersion}
x-app-key: <runtime key>
x-app-secret: <runtime secret>
```

Base URL 必须精确到 `/tools/version-control/v1`，`v1` 只出现一次。成功体必须是裸七字段对象：

```json
{
  "update": true,
  "downloadUrl": "https://downloads.example.com/tool.exe",
  "promptContent": "发现新版本",
  "forcedUpdate": false,
  "promptUpdate": true,
  "stopUpdate": false,
  "updateContent": "<p>更新说明</p>"
}
```

`stopUpdate=true` 只表示暂停更新分发，不会退出或禁止启动应用。只有
`forcedUpdate=true` 才进入强制更新交互。

## 准备与启动

在仓库根目录执行：

```powershell
npm ci
npm run build --workspace @bifang/telemetry-update-sdk
py -3 -X utf8 -B tools/python-sdk-test-client/gui.py
```

也可以使用终端版：

```powershell
py -3 -X utf8 -B tools/python-sdk-test-client/client.py
```

启动只创建本地 Node 进程并执行零网络 `ping`。发送 telemetry 前会要求明确确认
`POST`；请求版本 API 前会要求明确确认 `GET`。

## GUI 填写项

- 应用编号：telemetry 的 `app_id`，例如 `bifang-tools`；
- 发布流 code：版本 API 的唯一发布流，例如 `bifang-tools-windows-x64`；
- 当前版本：数字点分版本，例如 `1.2.3`；
- 数据接收地址：`https://<host>/apps/<app_id>/v1/track`；
- 版本 API Base URL：`https://<host>/tools/version-control/v1`；
- `x-app-key` / `x-app-secret`：仅允许 `versions:check` 且绑定当前 code 的运行时凭据。

凭据输入框不回显，值只保存在当前进程内；客户端不把它们写入文件、输出、普通日志或
高级诊断。桥接返回的请求证据只列出头名称，并固定标记 `credentials_redacted=true`。
关闭窗口时 GUI 会清空两个输入变量。

## 验证结果边界

- telemetry 成功必须同时满足 HTTP 成功与服务端显式 `{ "ok": true }` 回执；
- 版本响应多字段、少字段、类型错误、非法状态组合或非安全 URL 都会静默降级为
  `invalid_response` / `unavailable`，不会阻断应用启动；
- `promptContent` 只按普通文本显示；`updateContent` 不在 Tkinter 中解释成 HTML；
- “立即更新”只打开经过 SDK 校验的 HTTPS 地址，不自动下载、安装或发布；
- 本地测试不等同于 CloudBase 公网部署、真实客户端 E2E 或第三方程序零代码兼容。

## 测试

```powershell
npm run build --workspace @bifang/telemetry-update-sdk
node --test tests/python-sdk-test-client.test.mjs
py -3 -X utf8 -B -m unittest discover -s tools/python-sdk-test-client/tests -p "test_*.py" -v
```
