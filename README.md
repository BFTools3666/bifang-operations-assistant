# 毕方运营精灵基础设施 3.0

本仓库正在整理为以 **Rust 客户端接入 Skill** 为主的维护入口。CloudBase 和 Updater 配置通过授权中心设备授权后读取，合同已按 2026-11-17 提供的文档明确；APP_ID、版本和实际目标自动从项目取得。[统一接入规范](skills/bifang-public-services-onboarding/references/integration-contract.md) 定义 OAuth、精确响应、默认值、日活与验收；[Updater 完整合同](skills/bifang-public-services-onboarding/references/client-update-center.md) 定义下游 OpenAPI 1.4.1。客户不手填整张配置表，CloudBase 管理密钥不分发到业务客户端。本规范不表示 Rust 获取代码或真实授权验证已完成。

Skill 定义如何接入；仅要求整理规范时不写业务接入代码。现有 TypeScript SDK 与宿主示例尚未完整对齐 1.4.1，不能作为新 Rust 接入的字段权威；具体差异记录在 Updater 合同中。

当前代码按用途阅读：

| 用途                | 入口                                                                                    | 维护边界                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 新客户端接入        | `skills/bifang-public-services-onboarding/`                                             | Rust 可信层承担配置获取、遥测和更新；详见 [框架适配](skills/bifang-public-services-onboarding/references/framework-adapters.md) |
| 现行协议参考与测试  | `packages/telemetry-update-sdk/`、`examples/host-integration.ts`                        | TypeScript 参考实现只保留 daily_active 与更新中心 POST；不是 Rust 运行依赖                                                      |
| 现有 CloudBase 运维 | `cloudbase/`、`apps/operations-dashboard/`                                              | 保留统计、登记、看板及其部署工具                                                                                                |
| 历史服务维护        | `contracts/application-version-api-v1/`、`cloudbase/functions/application-version-api/` | 保留既有服务合同与服务端源码，不进入新客户端接入链路                                                                            |
| 迁移状态与历史证据  | [迁移进度](docs/client-update-center-migration.md)、`docs/*-2026*.md/json`              | 回执记录当时事实，不是新接入默认配置                                                                                            |

> 新客户端接入使用 `https://update.meetelf.com` 的 POST 协议，与旧 application-version API 不兼容。SDK 仅提供检测与目标对照；下载、校验、安装和强更生命周期仍由宿主实现。服务部署与真实客户端验证状态见 [迁移进度与接入边界](docs/client-update-center-migration.md)。

这是毕方小工具共用的运营基础设施：保留低频 `daily_active` 启动遥测，新客户端更新使用客户端更新中心。现有 application-version 版本与广告服务继续按历史运营事实管理；迁移单个客户端不代表线上旧资源可删除。旧静态更新清单协议已经退出 3.0 设计。

统计共用负责人现有的一个免费 CloudBase 环境和平台默认 HTTPS 域名，但按应用隔离。旧 application-version 服务仍可使用该默认域名或已批准的生产网关；新更新中心不使用该 GET 合同，也不改变 CloudBase 费用边界：

- telemetry 使用独立 `app_id`、函数、路由、集合和本地状态；
- application-version 使用共享函数和单一 `/tools/version-control/v1` 路由，凭据绑定准确 `app_id + codes + scopes`；
- 每个应用使用独立 `versions_*`、`ads_*`、`audit_*` 集合；
- 历史 application-version 的每个 `(platform, architecture, channel)` 使用独立 `code`；仅使用新更新中心的工具无需旧发布流，不依赖 User-Agent 猜平台。

本仓库不是鼠标精灵或录屏助手的业务源码。两个客户端必须各自在自己的 Codex Task 中接入，运营精灵不能从这里主动扫描或修改它们。

## 一句话接入

在任意客户端项目中只需发送：

```text
https://github.com/BFTools3666/bifang-operations-assistant.git 帮我接入
```

**第一个硬门禁是确认接入范围：仅更新、仅统计，还是更新和统计都接入。** 向导必须先问并等待明确回答；只提一项时询问是否也接另一项，同时提两项也先确认。不默认全接，不在等待时安装、扫描、收集接口参数或修改项目；已有本次门禁答案不重复问。下列流程按确认范围执行，未选择服务保持原状。选择记录在交接报告；机器入口的 `firstGate` 声明由 Skill 对话在调用 bootstrap 前落实，bootstrap 本身不代替用户回答。

根 [`bifang-onboarding.json`](bifang-onboarding.json) 冻结规范 URL、版本和授权边界，[`tools/bootstrap_bifang_onboarding.py`](tools/bootstrap_bifang_onboarding.py) 只接受全仓干净且 HEAD 精确等于 GitHub 默认分支实时 advertised HEAD 的权威 checkout，并验证基础设施来源提交。它从原客户端 cwd 绑定当前 Git 根，先只读扫描，以分支、HEAD、index、Git 状态和内容摘要证明客户端未变，再隔离外部校验钩子安装/更新接入 Skill。客户端可以是 `CODEX_HOME/worktrees/` 下的 Codex worktree，但不得与实际 Skill 安装目录重叠。随后 Skill 先整理事实并通过所选服务的第二、第三门禁，再进入第四门禁，在当前客户端内迁移非敏感 Profile、确认中文 `display_name` 并生成名称交接、保留 telemetry、替换并删除旧静态更新实现、运行本地验证。阶段 2 在运营精灵中同步登记中文名，阶段 3 检查全部名称覆盖，阶段 4 实际核对线上显示；本地名称登记和生产生效分别记录门禁，不能互相替代。

选择更新时使用 `--require-update-center` 验证适用的 Profile，详细请求、强更和安装规则见 [客户端更新中心接入合同](skills/bifang-public-services-onboarding/references/client-update-center.md)。仅统计不填更新字段、不删除旧更新；仅更新不要求新增统计。现有 Profile 的联合完成校验不能作为扩大范围的理由，单服务限制与记录方式见 Skill。这句话不授权 CloudBase 写入或删除、客户端打包/安装、真实 GUI E2E、发布、推送或购买。

## 本地通过后的下一步

第 5 步只提示客户到更新中心自行手动配置，并交付已有项目参数；不代操作或审核管理后台。提示中说明客户告知完成后会做限定的简单更新接口预检：真实地址与 ClientToken、HTTP 201、响应合同、目标版本/平台/通道及预期更新行为；不下载、安装或运行 EXE。预检失败由客户调整后再告知重检，通过后才进入第 6 步，按具体授权构建/运行 EXE 并进行真实验收。仅统计跳过更新中心及更新预检；都接入先过更新预检，统计真实上报留 EXE 测试。详见 [配置与 EXE 验收](skills/bifang-public-services-onboarding/references/integration-contract.md#本地通过后更新中心配置与-exe-真实测试)。

## 权威入口

门禁必须按本次已选范围严格串行：1 范围确认 → 2 授权/配置验证 → 3 完整请求明细确认 → 4A UI 确认 → 4B 架构/规范核验 → 4C 编码 → 4D 本地验收。前一步未通过，不进入下一步；两项都接入须当前门禁两项全部通过，不能让成功分支先跨门禁。仅统计无可见 UI 变更只豁免 4A 的人工确认并记录依据，其他检查点不省略。每次转入下一步先核验证据；缺项/未回复/过期不算通过，复用有效证据不重复问。门禁状态写脱敏交接记录，不添加 Profile 字段；旧运维阶段或脚本成功不能代替此链。详见 [门禁信息与放行总表](skills/bifang-public-services-onboarding/references/integration-contract.md#门禁顺序与放行总表)。

实施前通过 **第二门禁：授权中心授权与配置获取**。按 [三种范围的取配置流程](skills/bifang-public-services-onboarding/references/integration-contract.md#第二门禁授权中心授权与配置获取) 完成/复用设备授权，只读取所选配置。project_id 默认 bifang_tools，项目参数自动识别、有依据的默认值直接采用，在第二门禁客户只参与必要的浏览器登录批准，不手填技术表；第三门禁仍须确认自动填好的请求明细。真实生产授权地址/登记与 Endpoint 下游语义仍需自动核验，无法确定才报告准确缺项。`secondGate` 由 Skill 授权及读取流程执行，不是 bootstrap 自动验证；不因取得密钥自动获得部署或真实业务 E2E 权限。

配置读取必须实际获授对应资源权限：仅更新使用 `updater:config:read`，仅统计使用 `cloudbase:config:read`，都接入申请两项并以单个 ASCII 空格连接。以 token 响应的实际 scope 为准；缺权停止该分支，额外权限不扩大接入范围。旧 `ip:read` 不能读配置；刷新默认省略 scope 并延续实际获授集合，`403 insufficient_scope` 需要重新设备授权，不能靠刷新补权限。

配置验证后通过 **第三门禁：客户端接入方案与请求明细确认**。按 [分支清单](skills/bifang-public-services-onboarding/references/integration-contract.md#第三门禁客户端接入方案与请求明细确认) 自动落实 Rust 接入点、字段来源、默认行为、迁移清单和验收计划；仅更新不改统计，仅统计不改更新，联合接入另核验共享事实与相互隔离。自动填好所选服务的接入确认单，在回复正文完整展示实际请求 URL、方法、请求头、路径/query/body 字段、必填性、非敏感实际值或动态生成规则、来源/默认值、待补项及实施验收计划；两项均选则分别完整展示。不能只给记录链接，未实施不能称已接入。凭据只展示状态和用途，不回显原值或摘要。技术就绪后必须等待客户明确确认明细；第一门禁选择或浏览器批准不代替此次确认。询问“确认并进入第四门禁／仅确认方案暂不实施／需要调整”，客户可直接授权第四门禁，不必输入阶段编号。已有只读限制不能被简单“确认”解除；未知关键项继续阻断。记录分支确认与实施授权，实质变更重新确认受影响项。方案就绪后只在原授权内实施，不能冒充代码、测试或线上验证完成；已知线上依赖单列，关键映射未知停止对应分支。

随后在已有客户端实施授权内执行 **第四门禁：客户端本地实施与验收**。第四门禁先做 UI 方案与位置确认，再编码：选择更新时读取当前项目页面、组件和样式，展示普通更新提示、强制更新界面及手动检查入口的可见预览，列清启动/定时/手动/安装前触发点、实际显示位置、按钮/关闭行为和新业务限制范围。必须等待客户明确确认 UI；第三门禁确认不替代本次确认，等待时不写业务代码，都接入也不先实施统计。适用 UI 确认后，编码前必须先阅读目标项目及修改目录的 AGENTS.md、架构/编码约定、真实模块调用链和同类实现，明确复用组件、HTTP/配置/状态/错误/日志/异步机制及验证命令；简短报告有代码依据的落实摘要后直接编码，不新增确认门禁。保持现有架构和前端栈，Rust 实现可信服务职责，遵守目录、依赖方向、命名及测试规则，不套服务端模板或重构无关代码。UI 确认与架构核验完成后按已有授权编码和本地验收，不再问是否开始。仅统计默认无打扰，没有可见 UI 变更则记 UI 确认不适用；若改应用内隐私界面则先预览确认。复用现有风格，强更仅按有效 block_new_operations 限制新业务，保留已有任务和更新/重试/退出。详细步骤按 [三种范围的实施及验收清单](skills/bifang-public-services-onboarding/references/integration-contract.md#第四门禁客户端本地实施与验收) 自动修改、修复和本地测试。仅更新保持统计，仅统计保持更新，联合接入还须验证隔离与部分失败；不重复确认自动可完成项。测试使用假凭据和隔离状态，交付实际请求、行为与检查结果，只标本地通过。制品构建/安装、真实业务/GUI E2E、运营登记/部署/后台写入、发布/推送及线上删除继续按独立授权执行；门禁声明不代表 bootstrap 已实现或验收这些工作。

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

### 客户端更新中心

生产地址默认为 `https://update.meetelf.com`。明确要求本机联调时可配置 `http://127.0.0.1:8080/`；本地测试不能代替生产服务或客户端 E2E 验收。

客户端在可信宿主调用 `POST https://update.meetelf.com/api/v1/apps/{app_id}/update-checks`，使用运行时客户端 Token，发送真实运行版本、平台、程序架构、安装形态、持久随机 UUID、通道、触发方式和已实现能力。仅 201 表示成功。下载须验证大小、SHA-256，并在安装前重新检查目标；强更和离线处理以产品明确选择的策略为准。

### 既有 Application-version API v1

以下是仍在使用的旧运营服务信息，不是新客户端的一键接入协议，也不因客户端迁移自动删除。

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
