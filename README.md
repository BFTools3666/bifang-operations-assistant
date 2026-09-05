# 毕方每日启动统计与更新基础设施

这是一个供多个小工具复用的 Phase 1 轻量基础设施仓库。所有工具共用一个免费 CloudBase 环境和平台默认 HTTPS 域名，但每个工具使用独立的 `app_id`、云函数、HTTP 路由、数据库集合、本地状态目录和更新清单，避免统计与版本发布互相串用。仓库只包含：

- 腾讯云 CloudBase“每日首次启动”HTTP 云函数源码；
- 静态更新清单及 JSON Schema；
- 框架无关的 TypeScript SDK；
- 自动化测试、宿主接入片段和维护文档。

本仓库不是业务客户端，不包含 Tauri、Electron、React、产品界面、自动下载或自动安装逻辑。

第一期只回答“今天有多少台设备实际启动使用过”：同一个匿名 `install_id` 按北京时间（`Asia/Shanghai`）每天首次启动最多上报一次固定事件 `daily_active`。**不统计安装动作**，也不再统计渠道、功能点击、任务开始/成功/失败、更新提示或更新点击。客户端只提供匿名 `install_id`、`platform`、`arch`、`app_id` 和 `app_version`；服务端补充 `active_date`、`received_at` 和来源 `source_ip`。

一台当天启动设备可近似理解为一位使用者，但它不是账号人数：同一人多台设备会多计，重装或清除本地数据也可能产生新 `install_id`。IP 不能用来去重人数；同一公司/家庭可共用公网 IP，移动网络也可能变化。IP 属于个人信息，接入前必须向用户说明用途，只做必要的最短保留，对外截图和导出时遮挡。

## 最短上手

```powershell
npm ci
npm run check
```

新增工具时不要复用 `bifang-tools`。例如工具编号为 `bifang-tools-pdf`，对应资源为：

```text
函数：telemetry-bifang-tools-pdf
路由：/apps/bifang-tools-pdf/v1/track
集合：telemetry_bifang_tools_pdf
更新：/updates/bifang-tools-pdf/<platform>.json
```

各工具的数据、更新开关和版本号完全分开；它们只共享免费环境、默认域名和免费额度。登记表显式记录每个工具的 Windows/macOS 平台清单，缺失或多余文件都会使配置检查失败。完整命名规则与新增步骤见[多工具隔离指南](docs/multi-tool-isolation.md)。

首次部署后，可使用面向普通用户的 [CloudBase 功能验证助手](tools/python-sdk-test-client/README.md)。Windows 图形界面基于标准库 Tkinter/ttk，用中文向导发送 `daily_active` 样例、模拟最多十台匿名设备，并真实读取完整更新文件地址。模拟十台设备最多产生 10 次 POST；它们在同一电脑测试时通常显示同一个公网 IP。启动与填写内容不会联网，只有用户点击发送或检查按钮后才会访问填写的地址。

为保护免费网关，客户端会在联网前先把“今天已经尝试上报”写入本地；即使随后网络失败，当天也不重试。此设计宁可少计一次，也不让反复启动冲击免费额度。

当前登记的真实工具为 `bifang-screen-recorder`。未发布清单保持关闭，并把下载与发布说明地址指向现有免费 CloudBase 默认 HTTPS 域名下明确不存在的 `not-published` 路径；这样严格客户端仍能解析出 `disabled`，误点或误开地址也只会得到 404。正式发布前仍须先上传真实制品与发布说明，再替换地址、文案、哈希与发布时间并单独启用。现有 [历史部署回执](docs/cloudbase-deployment.md) 只记录 `example-tool` 的历史 v1 验收；新应用证据见各自独立回执。14 个更新字段见 [中文说明](cloudbase/updates/WINDOWS_JSON_FIELDS.zh-CN.md)，完整架构、API 和维护流程见 [长期文档](docs/telemetry-and-update.md)。

这次简化不新增付费服务；平台价格与免费额度以后可能变化。凡控制台出现非零金额、按量计费、自动续费或需要升级套餐，都必须先提醒负责人并停止操作。

## 跨项目接入向导 Skill

基础设施根版本 `2.1.0` 新增显式调用的 `$bifang-public-services-onboarding`，权威源码位于 [`skills/bifang-public-services-onboarding`](skills/bifang-public-services-onboarding)。它会先检查目标项目和已有 `.bifang/public-services-profile.json`，只分批询问无法从代码确认的信息，再给出独立资源映射、未满足门禁和八阶段接入任务；没有用户明确选择的阶段不会修改对应范围。

SDK 公共 API 没有因新增向导而变化，因此 `@bifang/telemetry-update-sdk` 继续保持 `2.0.0`。安装或更新 Skill 时使用其 [`install_skill.py`](skills/bifang-public-services-onboarding/scripts/install_skill.py)；脚本会拒绝覆盖来源不明的同名 Skill。完整新手流程及“毕方录屏助手”示例见[毕方小工具公共服务分步接入指南](docs/毕方小工具公共服务分步接入指南.md)。
