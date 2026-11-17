# 毕方运营精灵 AI 实施入口

本文件适用于整个仓库。Git 仓库是实施规范和可维护源码的权威来源；飞书中的文档与压缩包仅用于分享，不得反向覆盖仓库中更新的协议、脚本或 Skill。

## 开始前按顺序阅读

1. `README.md`：项目边界、统计口径、免费额度和最短验证入口。
2. `docs/毕方小工具公共服务分步接入指南.md`：面向小工具开发者的完整分阶段接入流程。
3. `docs/multi-tool-isolation.md`：APP_ID、函数、集合、路由和应用版本发布流的隔离规则。
4. `docs/telemetry-and-update.md`：统计/更新协议、客户端时序、隐私要求和验收标准。
   新客户端更新还须读 `docs/client-update-center-migration.md` 与 `skills/bifang-public-services-onboarding/references/client-update-center.md`；一键接入使用 `client-update-center-v1`，不得把旧 GET 合同或网关当成新协议。
5. 涉及应用版本 API 时，再读 `docs/application-version-api-zero-code-contract.md`、`contracts/application-version-api-v1/`、`cloudbase/functions/application-version-api/` 和 `cloudbase/plan-application-version-api-deployment.mjs`。
6. `examples/host-integration.ts`、`packages/telemetry-update-sdk`：协议的示例与公共 SDK 实现。
7. `cloudbase/apps.json`、`cloudbase/generate-cloudbaserc.mjs`：已登记应用与资源配置的机器权威源。
8. `bifang-onboarding.json`、`tools/bootstrap_bifang_onboarding.py`：规范仓库 URL 一句话接入的机器入口和授权边界。

需要给新手查看 CloudBase 控制台位置时，再读 `docs/cloudbase-quickstart.md`。它的真实截图位于 `docs/images/cloudbase/`，可分享 Word 版为 `docs/CloudBase免费额度内部署新手图文版.docx`，生成器为 `tools/build_cloudbase_guide_docx.py`，文档构建依赖锁定在 `tools/docx-requirements.txt`。

## 接入方式

门禁必须按本次已选范围严格串行：1 范围确认 → 2 授权/配置验证 → 3 完整请求明细确认 → 4A UI 确认 → 4B 架构/规范核验 → 4C 编码 → 4D 本地验收。前一步未通过，不进入下一步；两项都接入须当前门禁两项全部通过，不能让成功分支先跨门禁。仅统计无可见 UI 变更只豁免 4A 的人工确认并记录依据，其他检查点不省略。每次转入下一步先核验证据；缺项/未回复/过期不算通过，复用有效证据不重复问。门禁状态写脱敏交接记录，不添加 Profile 字段；旧运维阶段或脚本成功不能代替此链。详见 `skills/bifang-public-services-onboarding/references/integration-contract.md` 的门禁总表。

- 客户端接入的第一个硬门禁是确认范围：必须先问“仅更新、仅统计，还是更新和统计都接入？”，等待明确选择。只提一项时也要问是否接另一项，同时提两项也先确认。未回答不执行来源验证、Skill 安装、项目扫描、参数收集或代码修改；已有本次门禁回答则复用。确认后只操作所选服务，另一项保持原状；整理 Skill 规范本身不触发此客户问答。
- 第二门禁是授权中心授权与配置获取：第一门禁后自动取证项目，按 `skills/bifang-public-services-onboarding/references/integration-contract.md` 中的设备授权流程取得/复用权限足够的有效授权，实际 GET 所选配置后进入第三门禁。默认 project_id=bifang_tools，本地已登记 client_id=woskill 仅在登记适用环境使用；生产地址与登记从可信部署资料取得。客户只做必要的浏览器登录批准，不手填技术参数、地址或密钥；项目可识别项自动读取，有依据的默认值直接采用。所选配置未取得或端点语义无法核验时停止对应分支。OAuth Token、Updater ClientToken、CloudBase SecretId/SecretKey 严格分离；获取配置不自动授权云写入或下游 E2E，整理规范不运行真实授权。
- 配置权限按范围申请：仅更新为 `updater:config:read`，仅统计为 `cloudbase:config:read`，都接入为 `cloudbase:config:read updater:config:read`（单个 ASCII 空格分隔）。`ip:read` 仅用于 IP 查询和代理详情，不能读取 CloudBase/Updater 配置；旧令牌需重新授权。以 token 响应的实际 scope 为准，客户端 allowed_scopes 和申请值都不代表实际获授；缺少所选权限停止对应分支，额外获授权限不扩大第一门禁范围。
- 刷新默认省略 scope，延续实际获授集合；若传入，必须与原获授集合完全相同（顺序不限），不能增权或缩权。`403 insufficient_scope` 需要重新设备授权选择缺失权限，不能循环刷新；账号限制或改密按各自错误处理。完整字段、错误和验收规则统一引用上述接入契约，不另设旧权限默认值。

- 第三门禁是客户端接入方案与请求明细确认：所选范围第二门禁整体通过后，按 `skills/bifang-public-services-onboarding/references/integration-contract.md` 的第三门禁清单，自动核验 Rust 接入点、字段来源、默认行为、拟修改范围和验收计划。仅更新核验检查/UI/真实能力/旧更新迁移；仅统计核验日活十字段/身份/原子每日门禁/后台上报；都接入还核验版本平台映射、独立调度、凭据状态隔离和部分失败。自动填好所选服务的接入确认单，在回复正文完整展示实际请求 URL、方法、请求头、路径/query/body 字段、必填性、非敏感实际值或动态生成规则、来源/默认值、待补项及实施验收计划；两项均选则分别完整展示。不能只给记录链接，未实施不能称已接入。凭据只展示状态和用途，不回显原值或摘要。技术就绪后必须等待客户明确确认明细；第一门禁选择或浏览器批准不代替此次确认。询问“确认并进入第四门禁／仅确认方案暂不实施／需要调整”，客户可直接授权第四门禁，不必输入阶段编号。已有只读限制不能被简单“确认”解除；未知关键项继续阻断。记录分支确认与实施授权，实质变更重新确认受影响项。仅对无法解决的产品事实冲突或无适用默认规则的行为变更最少澄清；关键地址/字段映射未知停止依赖分支。已知待登记/部署/发布另列线上依赖，方案就绪不表示代码或真实接入完成。本次所选范围的第二、第三门禁必须整体通过，联合任务不得单分支先跨门禁实施；此门禁不等于 CloudBase 运维阶段 3，不增加部署、安装、发布或删除授权。

- 第四门禁是客户端本地实施与验收：第四门禁先做 UI 方案与位置确认，再编码：选择更新时读取当前项目页面、组件和样式，展示普通更新提示、强制更新界面及手动检查入口的可见预览，列清启动/定时/手动/安装前触发点、实际显示位置、按钮/关闭行为和新业务限制范围。必须等待客户明确确认 UI；第三门禁确认不替代本次确认，等待时不写业务代码，都接入也不先实施统计。适用 UI 确认后，编码前必须先阅读目标项目及修改目录的 AGENTS.md、架构/编码约定、真实模块调用链和同类实现，明确复用组件、HTTP/配置/状态/错误/日志/异步机制及验证命令；简短报告有代码依据的落实摘要后直接编码，不新增确认门禁。保持现有架构和前端栈，Rust 实现可信服务职责，遵守目录、依赖方向、命名及测试规则，不套服务端模板或重构无关代码。UI 确认与架构核验完成后按已有授权编码和本地验收，不再问是否开始。仅统计默认无打扰，没有可见 UI 变更则记 UI 确认不适用；若改应用内隐私界面则先预览确认。复用现有风格，强更仅按有效 block_new_operations 限制新业务，保留已有任务和更新/重试/退出。所选范围第二、第三门禁整体通过且已有客户端实施授权后，按统一契约自动完成 Rust 实现、迁移、本地测试及本轮失败修复，不重复问可自动确定事项或笼统“是否继续”。仅更新验收检查/UI/能力/旧更新清理并保持统计；仅统计验收日活十字段/版本/原子每日门禁并保持更新；都接入还验证独立调度、身份状态凭据隔离及部分失败。测试用假凭据、注入 transport、固定时钟和临时状态，不请求真实业务接口或重置生产状态。测试所需编译可随本地检查执行，制品构建/打包/签名/安装、真实服务/GUI E2E、运营登记及云端/更新后台写入、发布/推送/线上删除仍需对应独立授权。复用已覆盖同目标动作的授权，遵守最终目标/预检确认及费用红线。交付脱敏本地验收记录，只标本地通过，不能冒充线上或安装成功；未选项不适用，选中但未验证项如实保留。本门禁不等于 CloudBase 运维阶段 4；仅整理规范不写业务代码。

- 接入必须由每个小工具在自己的项目中发起；规范一句话是 `https://github.com/BFTools3666/bifang-operations-assistant.git 帮我接入`，也可显式调用 `$bifang-public-services-onboarding`。不要从本仓库扫描、发现或主动修改未知小工具。
- Skill 权威源码位于 `skills/bifang-public-services-onboarding/`，入口为 `skills/bifang-public-services-onboarding/SKILL.md`，Codex 展示与调用策略为 `skills/bifang-public-services-onboarding/agents/openai.yaml`。开始任何下游接入前完整阅读 Skill，并遵守一次只执行一个已获授权阶段的规则。
- 同一现有免费 CloudBase 环境可以承载多个工具。Telemetry 按 APP_ID 使用独立函数、路由、集合和本地状态；仅使用新更新中心的工具无需登记旧发布流。历史 application-version 使用共享函数/路由，各已有发布流按应用隔离 code、凭据与 versions/ads/audit 集合。
- 新客户端版本检查使用客户端更新中心 POST 协议，携带真实目标字段和运行时客户端 Token；旧 application-version 资源仍按既有部署事实管理，客户端迁移不自动授权删除或改变其他客户端。
- `cloudbase/apps.json` 是登记状态的唯一权威；文档中的产品名和资源名仅是示例或时间点回执。
- 基础设施 3.0 不保留静态更新清单协议。修改运营精灵或未公开客户端时，保留 `daily_active` telemetry，删除旧静态更新实现、回退开关和双轨文档；不要重新引入兼容层。

## 本地通过后的交接

第 5 步只提示客户到更新中心自行手动配置，并交付已有项目参数；不代操作或审核管理后台。提示中说明客户告知完成后会做限定的简单更新接口预检：真实地址与 ClientToken、HTTP 201、响应合同、目标版本/平台/通道及预期更新行为；不下载、安装或运行 EXE。预检失败由客户调整后再告知重检，通过后才进入第 6 步，按具体授权构建/运行 EXE 并进行真实验收。仅统计跳过更新中心及更新预检；都接入先过更新预检，统计真实上报留 EXE 测试。完整规则见 Skill 统一契约的“本地通过后：更新中心配置与 EXE 真实测试”。

## 不可越过的边界

- 不创建第二个 CloudBase 环境，不购买域名、证书、套餐或资源包，不开启按量超限、自动续费或超限扣费。出现任何非零金额或升级提示立即停止并交给负责人确认。
- 未经明确阶段授权，不部署 CloudBase、不修改业务客户端、不构建安装、不发布、不推送、不删除或下线旧资源。
- 推送、发布、部署和删除前展示最终目标与最新预检结果，再等待负责人明确继续。
- 不提交 `cloudbaserc.json`、`.cloudbase/`、`.tcb/`、`.env`、Token、Cookie、Authorization、SecretId、SecretKey、数据库凭据、账号或硬件标识。
- 线上旧静态更新资源只能在两个实际客户端完成新协议 E2E 后删除；删除前必须列出每个精确目标、确认它不属于 telemetry 或其他应用，并再次等待负责人明确“继续”。

## 修改与验证

- 修改协议或资源命名时，同步检查 README、接入指南、Skill references、示例、SDK、CloudBase 生成器与测试；生产源码、配置和当前文档中不得残留第二套静态更新协议。
- 修改 `docs/cloudbase-quickstart.md` 或截图后，先安装 `tools/docx-requirements.txt`，再运行 `py -3 -X utf8 -B tools/build_cloudbase_guide_docx.py docs/cloudbase-quickstart.md docs/CloudBase免费额度内部署新手图文版.docx`；随后用当前 Codex documents Skill 的 `render_docx.py` 渲染全部页面并逐页检查。不要只编辑生成后的 DOCX。
- 先运行 `npm ci`（依赖未安装时），再运行 `npm run check`。只报告真实执行的测试、线上验证和部署结果。
- `tests/guide-git-contract.test.mjs` 会检查完整指南入口、Word 版、截图和 Skill 入口仍受 Git 管理；新增指南组成部分时同步更新该契约。
- `.cloudbase/`、`.tcb/`、构建目录和生成的 Skill 压缩包不是权威源码；不要为了“打包完整”将本地状态或重复归档提交到 Git。

## 文档与实施证据

- 通用规范放在 `docs/` 的长期文档中；某一应用或某次部署的事实放在独立回执中，不改写为永久事实。
- 运营看板规范见 `docs/operations-dashboard.md`；当前生产验收证据见 `docs/operations-dashboard-e2e-20260910.md`。旧静态协议时期的看板回执和证据已从 3.0 工作树删除。
- 每次交付说明实际修改、验证结果、提交哈希，以及明确未执行的部署、发布、购买、推送或删除操作。
