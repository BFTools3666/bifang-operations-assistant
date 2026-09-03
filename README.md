# 毕方公共埋点与更新基础设施

这是一个供多个小工具复用的 Phase 1 基础设施仓库，只包含：

- 腾讯云 CloudBase telemetry HTTP 云函数源码；
- 静态更新清单及 JSON Schema；
- 框架无关的 TypeScript SDK；
- 自动化测试、宿主接入片段和维护文档。

本仓库不是业务客户端，不包含 Tauri、Electron、React、产品界面、自动下载或自动安装逻辑。

## 最短上手

```powershell
npm install
npm run check
```

模板中的 `example-tool`、`.example.invalid`、CloudBase 环境 ID 和域名都必须在真实接入或部署时替换。完整架构、API、部署和维护流程见 [docs/telemetry-and-update.md](docs/telemetry-and-update.md)。
