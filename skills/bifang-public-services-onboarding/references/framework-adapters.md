# Application-version v1 框架适配

仅在阶段 5 或 6 读取。先从代码确认真实框架、生命周期和版本来源，不为套示例重构产品。

## 所有宿主

1. 保留正确的 `daily_active`：应用专属 AppConfig、APP_ID 隔离、联网前原子落盘、北京时间同日一次、失败不重试。
2. 主窗口显示完成后异步检查版本，网络不能阻塞启动。
3. Base URL 必须是安全公网 HTTPS，Path 精确以 `/tools/version-control/v1` 结束；拒绝查询、片段、用户信息和双 `/v1`。
4. Path segment 对 code 与当前 SemVer 分别编码，固定发送 `x-app-key` 和 `x-app-secret`。
5. 响应必须恰好是七字段裸 JSON 对象：`update`、`downloadUrl`、`promptContent`、`forcedUpdate`、`promptUpdate`、`stopUpdate`、`updateContent`。缺失、额外、错类型或不安全 URL 均视为不可用。
6. 按机器契约真值表映射无更新、提示、强制和停止；不要在客户端重新发明 rollout、min-supported 或第二套决策。
7. 远端文字按不可信纯文本显示；外链前再次验证 HTTPS。强制更新退出调用宿主完整清理路径。
8. 删除旧静态更新 URL、manifest parser/types、旧决策、fallback、compatibility flag 和只覆盖旧协议的测试。

测试默认使用注入 transport/fetch、固定时钟和临时 AppConfig，不能访问真实 CloudBase。阶段 6 才使用真实服务与准确制品。

## Tauri / Rust

- Key、Secret、Base URL、code 和 HTTP 请求留在 Rust 可信层。WebView 不得读取凭据或提交任意 URL/Path。
- 发布配置按平台/架构静态绑定 code。录屏助手 Windows x64 与 macOS arm64 必须使用不同 code；不要依赖 User-Agent。
- Tauri command 只返回最小更新 DTO，并只暴露“打开已验证下载地址”“完整退出”等固定动作。
- 复用项目现有 HTTP client、超时和 AppConfig 抽象；如果原实现已有严格 SemVer、安全 URL 或完整退出，应保留并将其接到新响应。
- 单元测试至少覆盖：唯一 URL、两个认证头、七字段严格解析、真值表、401/403/404/429/500、超时、外链拒绝、完整退出、WebView 无任意路径/URL/凭据能力、telemetry 无回归、旧协议运行时零引用。

每个迁移 Task 都必须以用户明确确认的当前 working-tree 快照为权威。不得 `reset`、`stash`、`clean`，也不得从旧 HEAD 或旧默认分支另起而丢失现有改动；版本号与工作树状态必须在任务开始时实时核对，不能把某次快照写成长期事实。

## Node / Electron / TypeScript

- 使用 `@bifang/telemetry-update-sdk` 3.0 的 application-version checker，不复制旧实现。
- 凭据与 checker 留在主进程；renderer 只接收已验证决策和固定 IPC 动作。
- SDK 分发仍须可复现：固定 tarball、私有不可变包、仓库受控复制或 workspace。使用项目相对来源并验证版本和哈希，不能引用开发机绝对 `node_modules`。
- `verify_sdk_distribution.py` 只验证本地制品/证据，不联网；门禁未通过时不能声称可交付。

## 其他原生程序

使用权威 OpenAPI、Schema 与 fixtures 实现薄适配层。必须具备严格 HTTPS、单层 v1、Path 编码、两个认证头、短超时、七字段严格解析、安全外链和完整退出。不要从本参考摘要猜测边界值。

## 广告

`GET /app/{code}/ads/show` 返回裸数组。当前下游客户端不接入该端点，客户端凭据也不得包含 `ads:show`；服务端广告契约由运营精灵使用不可导出的专用凭据做 E2E 验证。未来若产品明确新增广告界面，必须另立升级任务并重新设计最小权限边界。

## 阶段 5 完成证据

- Profile v2 与资源派生通过；
- 源码和配置只使用新版本协议；
- 旧静态版本实现已删除且完整扫描为 `removed`；
- 本地单元/契约/静态检查通过；
- 未打包、安装、访问真实服务、发布或推送，除非用户另有明确授权。

## 阶段 6 完成证据

- 服务端公网 HTTP E2E 与运行凭据已就绪；
- 构建制品版本、SHA-256、安装路径可审计；
- 真实窗口验证无更新、提示、强制、停止、错误/超时和完整退出；
- 请求观测证明准确单层 v1 URL、code、认证头存在且凭据值被遮挡，并证明不再请求旧协议；
- Windows 与 macOS 证据分开，未运行的平台保持 `Unverified`。
