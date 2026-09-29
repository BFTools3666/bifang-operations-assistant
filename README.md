# 毕方运营精灵基础设施 3.0

这是毕方小工具共用的运营基础设施：保留低频 `daily_active` 启动遥测，版本与广告服务统一使用 application-version API v1。旧静态更新清单协议已经退出 3.0 设计，不再提供双轨、回退开关或长期兼容层。

所有工具共用负责人现有的一个免费 CloudBase 环境和平台默认 HTTPS 域名，但按应用隔离。客户端的 application-version Base URL 可使用该默认域名，或使用运营侧精确批准且保持同一 v1 合同的生产网关；这不改变 CloudBase 环境、函数、路由或费用边界：

- telemetry 使用独立 `app_id`、函数、路由、集合和本地状态；
- application-version 使用共享函数和单一 `/tools/version-control/v1` 路由，凭据绑定准确 `app_id + codes + scopes`；
- 每个应用使用独立 `versions_*`、`ads_*`、`audit_*` 集合；
- 每个 `(platform, architecture, channel)` 使用独立 `code`，不依赖 User-Agent 猜平台。

本仓库不是鼠标精灵或录屏助手的业务源码。两个客户端必须各自在自己的 Codex Task 中接入，运营精灵不能从这里主动扫描或修改它们。

## 一句话接入

在任意客户端项目中只需发送：

```text
https://gitlab.kuajingvs.com/qiuyang/bifang-operations-assistant.git 帮我接入
```

根 [`bifang-onboarding.json`](bifang-onboarding.json) 冻结规范 URL、版本和授权边界，[`tools/bootstrap_bifang_onboarding.py`](tools/bootstrap_bifang_onboarding.py) 只接受全仓干净且 HEAD 精确等于 GitLab 默认分支实时 advertised HEAD 的权威 checkout，并验证基础设施来源提交。它从原客户端 cwd 绑定当前 Git 根，先只读扫描，以分支、HEAD、index、Git 状态和内容摘要证明客户端未变，再隔离外部校验钩子安装/更新接入 Skill。客户端可以是 `CODEX_HOME/worktrees/` 下的 Codex worktree，但不得与实际 Skill 安装目录重叠。随后 Skill 在当前客户端内迁移非敏感 Profile、保留 telemetry、替换并删除旧静态更新实现、运行本地验证。

这句话不授权 CloudBase 写入或删除、客户端打包/安装、真实 GUI E2E、发布、推送或购买。上述外部或扩大范围的动作仍按门禁单独执行。

## 权威入口

本 Git 仓库是协议、Skill、脚本和可维护源码的唯一权威；分享文档不得反向覆盖。开发者和 AI 先读 [`AGENTS.md`](AGENTS.md)，再按顺序阅读：

- [完整分步接入指南](docs/毕方小工具公共服务分步接入指南.md)
- [多工具隔离](docs/multi-tool-isolation.md)
- [遥测与 application-version v1](docs/telemetry-and-update.md)
- [应用版本 API 契约与可行性报告](docs/application-version-api-zero-code-contract.md)
- [机器契约](contracts/application-version-api-v1)

当前登记应用以 [`cloudbase/apps.json`](cloudbase/apps.json) 为唯一权威。文档里的产品名、code 和资源名只作规则说明或时间点证据。

## 协议摘要

### 每日启动遥测

同一个匿名 `install_id` 按北京时间每天首次正常启动最多尝试一次固定事件 `daily_active`。客户端联网前先原子落盘当日门禁；失败当天不重试、不排离线队列。它近似表示活跃安装，不是安装量、账号人数或功能使用次数。客户端不得采集账号、主机名、MAC、硬盘号或其他硬件指纹；来源 IP 只由服务端可信上下文补充。

### Application-version API v1

规范 Base URL：

```text
https://<平台默认域名>/tools/version-control/v1
https://gateway.kaiwhale.com/tools/version-control/v1  # 已批准生产网关
```

其他自定义域名仍失败关闭；新网关必须先进入运营侧精确允许列表并复核 TLS、路径与费用事实。

`v1` 只出现一次，不存在 `/v1/v1` 别名。运行时客户端只持有最小权限凭据并调用：

```text
GET /versions/{code}/{currentVersion}
GET /app/{code}/ads/show    # 当前仅由服务端契约测试凭据验证
```

管理端点、精确响应、错误码和验证向量以 [`contracts/application-version-api-v1`](contracts/application-version-api-v1) 为准。每份客户端运行凭据只绑定一个发布流 code，且只给 `versions:check`；管理读取与管理写入使用两份独立凭据，绝不进入客户端。部署配置必须覆盖每条登记发布流，并全局保留一份不可导出到客户端的 `contract-ads-*` 广告契约测试凭据。任何 Key/Secret 原值都不得进入 Git、Profile、普通日志、命令行参数或截图证据。

## 本地验证

```powershell
npm ci
npm run check
```

仓库将 CloudBase CLI 固定为 `@cloudbase/cli@3.8.1`；部署包装器只调用仓库内这份 CLI。完整检查还会用该固定 CLI 离线解析 `cloudbaserc.example.json`，避免配置扩展名、Schema 或 QPS 下限在真正部署时才暴露。

每次生成可执行的 application-version 计划前，必须紧接着按锁文件重新执行一次 `npm ci`；从这次 `npm ci` 到生成计划之间，不得修改 `package-lock.json`、`package.json` 或 `node_modules/@cloudbase/cli`。

CloudBase 只读计划：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/application-version-credentials.ps1 -Mode generate
npm run cloudbase:version-api:deploy:plan -- --env-id <现有免费环境ID> --origin https://<平台默认域名> --credentials-b64-file cloudbase/application-version-credentials.b64
```

第一条命令只需执行一次：摘要配置写入 Git 忽略文件，Key/Secret 原值由当前用户 DPAPI 加密保存在本机。计划命令只读取本地配置和凭据摘要，不执行部署或删除，也不回显 Secret。线上写入前必须展示最新远端状态、精确资源、费用、差异、回滚与删除目标，再等待负责人明确“继续”。不创建第二个环境，不购买域名、证书、套餐或资源包，不开启按量超限、自动续费或超限扣费。

## 当前实施状态

application-version API v1 的十个端点、鉴权、隔离存储与事务已经部署到负责人现有的免费环境，并完成公网 HTTP 与两款真实 Windows 客户端的更新检查 E2E。本地测试仍不能替代后续每个发布候选自己的线上验证。

鼠标精灵与录屏助手是实际客户端验收对象。它们的旧版本未公开发布，因此各自迁移时直接删除静态更新实现。Windows 真实客户端 E2E 必须绑定本次构建的准确 EXE、SHA-256、进程/窗口和实际请求；录屏助手 macOS 结果必须在真实 Mac 上单独验证，Windows 证据不能替代。

独立只读运营看板位于 `apps/operations-dashboard`。看板只消费服务端聚合数据，失败显示“生产数据暂时不可用”，真实零值按零显示；现行说明见 [运营看板规范](docs/operations-dashboard.md)。旧静态协议时期的回执和截图已从 3.0 工作树删除；2026-09-10 两款真实客户端的 telemetry 落库、同日去重与 Edge 生产看板证据见 [E2E 回执](docs/operations-dashboard-e2e-20260910.md)。
