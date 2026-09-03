# 毕方公共埋点与更新基础设施

这是一个供多个小工具复用的 Phase 1 基础设施仓库，只包含：

- 腾讯云 CloudBase telemetry HTTP 云函数源码；
- 静态更新清单及 JSON Schema；
- 框架无关的 TypeScript SDK；
- 自动化测试、宿主接入片段和维护文档。

本仓库不是业务客户端，不包含 Tauri、Electron、React、产品界面、自动下载或自动安装逻辑。

## 最短上手

```powershell
npm ci
npm run check
```

首次部署后，可使用面向普通用户的
[CloudBase 功能验证助手](tools/python-sdk-test-client/README.md)。Windows 图形界面基于
标准库 Tkinter/ttk，以四步中文向导发送基础八类匿名样例、模拟十台匿名设备，并真实读取
完整更新文件地址。启动与填写内容不会联网；只有用户点击发送或检查按钮后才会访问填写
的地址。每条数据必须同时得到 HTTP 成功和服务端保存确认才会标绿，原有 CLI 继续兼容。

`example-tool` 和 `.example.invalid` 是 smoke test 占位值，不是业务产品配置。Task4 完成了旧协议的首次部署；Task8 已把 Task7 校正后的 telemetry 函数与 14 字段静态清单覆盖部署到同一现有 CloudBase 环境，并完成真实公网、数据库、拒绝用例与幂等复验。现有资源、HTTPS 地址、事件 ID、内容哈希和系统默认域名限制见 [部署回执](docs/cloudbase-deployment.md)。真实小工具接入前仍须替换 app ID、下载地址、发布说明、文案、哈希与发布时间；完整架构、API 和维护流程见 [长期文档](docs/telemetry-and-update.md)。
