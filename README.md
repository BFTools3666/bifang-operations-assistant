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

`example-tool` 和 `.example.invalid` 是 smoke test 占位值，不是业务产品配置。Task4 曾部署旧协议快照并完成当时的公网/数据库验收；Task7 校正后的本地函数与 14 字段静态清单尚未部署，Task8 必须重新部署两者并复验后才能恢复生产一致性。历史资源、HTTPS 地址和系统默认域名限制见 [部署回执](docs/cloudbase-deployment.md)。真实小工具接入前仍须替换 app ID、下载地址、发布说明、文案、哈希与发布时间；完整架构、API 和维护流程见 [长期文档](docs/telemetry-and-update.md)。
