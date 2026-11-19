# 毕方个人 CloudBase 接入 Skill

个人数据库默认 PostgreSQL，统计、更新和大屏经官方 pgdoc 插件访问；第一门禁自动核验，第二门禁才准备缺失插件。详见 [PostgreSQL 适配与边界](skills/bifang-public-services-onboarding/references/postgresql.md)。

本分支 `codex/personal-cloudbase` 用于个人免费 CloudBase 方案，当前定义五道门禁：确认免费环境并交接 CAM 密钥、选择手动/自动创建并核验服务资源、确认参数与请求、确认 UI 后按项目规范本地实施、客户确认计划后自动保存版本、读回并预检更新接口。第五门禁通过后才进入第六步 EXE 测试。配置与密钥通过本地私有文件交接，安装包使用外部链接，不存入 CloudBase 或由其代理。

入口为 [Skill](skills/bifang-public-services-onboarding/SKILL.md)，详细流程见 [分步接入指南](docs/毕方小工具公共服务分步接入指南.md)。维护前阅读 [`AGENTS.md`](AGENTS.md)。

首次接入按下列门禁推进。已接入应用想查看更新、推荐改强制、取消或重设版本，直接进入[版本更新管理](skills/bifang-public-services-onboarding/references/personal-release-management.md)。

目标明确时由助手查状态、预填并校验。客户只补真实缺项，在看到目标、差异和生效范围后回复“确认执行”。

## 当前可用范围

- 第一门禁：免费环境确认后，引导 CAM 子用户，在第一门禁同时关联检查与创建策略（含共享函数更新所需的 `scf:UpdateFunctionConfiguration`），再准备 SecretId/SecretKey；私有文件交接并通过只读 access 检查才通过。已有环境不能跳过密钥准备。
- 未创建环境：给详细注册、实名、零元创建指引；未回答、凭据/权限缺失或检查失败留在第一门禁。
- 第二门禁：先给统计、更新、大屏及配套资源清单，让客户选择手动或自动创建；手动交付专属 ZIP/配置并在客户完成后检查，自动按已授权计划创建且逐项/最终读回。已有只跳过创建，不跳过核验。
- 第三门禁：自动取值、私有文件补缺项、离线生成完整请求并等待客户确认。
- 第四门禁：展示普通更新、强更、手动入口及触发位置，等 UI 确认后核验项目架构与编码规范，再在授权内实施和本地验收。
- 第五门禁：收集发布信息并本地校验，确认具体计划后由助手自动保存、读回并预检；通过后进入制品测试。仅统计跳过本门禁更新部分。

免费方案使用腾讯云的“免费体验版”；“个人版”是另一收费套餐。开户条件见 [个人 CloudBase 指引](skills/bifang-public-services-onboarding/references/personal-cloudbase.md)；资源、必需数据及密钥文件交接见 [第二门禁](skills/bifang-public-services-onboarding/references/personal-resources.md)。

## 使用与分支

先下载或克隆 `codex/personal-cloudbase` 分支的完整项目，在项目根目录运行一次（Node.js >=20，无须先安装 npm 依赖）：

```shell
npm run skill:install
```

脚本自动识别当前源码位置，安装/更新本地 Skill 至 `3.0.0-personal.21` 并记录目录；原同名 Skill 先备份。此后在客户项目调用即可，不需要填写源码路径：

```text
$bifang-public-services-onboarding
```

只发送技能名即可看到两个选项，回复 **1** 接入统计和更新，回复 **2** 更新已接入应用的版本。也可以在技能名后直接写具体任务。

Skill 每次核验已绑定源码并读取本地最新规范及工具；支持 Git 克隆和 ZIP 解压。仓库移动后有限查找，找不到或有多个有效副本才请用户指定一次。详见 [本地安装与定位](skills/bifang-public-services-onboarding/references/local-source.md)。本机安装绑定不提交 Git；没有个人版远端 URL bootstrap，不运行旧安装脚本。

公司版历史已由标签 `skill-v2.1.5-company-managed` 保存；当前 Skill 不提供模式切换。个人资源工具复用仓库三类函数源码，但单独生成客户应用映射、凭据和部署包，不读取公司登记作为部署目标。既有 SDK、客户端示例及运维资料不构成个人版客户端合同或上线证据。

Application-version API v1 的底层合同位于 [contracts/application-version-api-v1](contracts/application-version-api-v1/README.md)。本模式按 [第三门禁](skills/bifang-public-services-onboarding/references/personal-client-confirmation.md) 使用个人工具实际部署函数的版本检查合同，不沿用该历史合同包的公司客户端验收流程。

## 资源创建工具

在本仓库根目录、Node.js 20 或以上运行。第一门禁先执行 `npm run cloudbase:personal:init`，将输出的实际私有路径交给客户填环境和 CAM 密钥，再用 `npm run cloudbase:personal:access -- --file <同一实际路径>` 做只读环境检查；不能把密钥填进仓库模板。第二门禁复用已准备的检查/创建权限和同一密钥文件，并补好应用参数，展示资源清单让客户选创建方式。

1. `npm run cloudbase:personal:validate -- --file <实际私有文件绝对路径>`：仅本地校验，不联网。
2. `npm run cloudbase:personal:plan -- --file <同一文件路径>`：只读云端预检，输出脱敏资源计划及 `materials_sha256`，本地生成独立服务凭据。
3. 客户选择自动创建且确认具体计划后，`npm run cloudbase:personal:apply -- --file <同一文件路径> --expected-plan <本次materials_sha256>`：重新预检，按集合→索引→函数→路由创建并读回，输出私有回执路径。

手动创建分支运行 `npm run cloudbase:personal:prepare -- --file <同一文件路径>`，交付离线生成的客户专属函数 ZIP、私有配置和完整步骤。客户告知完成后执行 `npm run cloudbase:personal:verify -- --file <同一文件路径>` 只读核验，缺少或冲突不通过。自动创建由 apply 完成逐项及最终核验；已有资源也需核验，不能以声明已建直接过门禁。

路径包含空格时加引号；命令参数中不放任何密钥。这些路径/摘要占位符由助手替换为当前任务的实际输出，不让客户猜值。

支持已有免费体验 PostgreSQL 环境、官方 pgdoc Document 插件、已启用的默认 HTTP 域名及 CAM API 密钥（含配套 STS Token）。不创建环境或域名，不覆盖现有不同配置的同名资源，共享函数新增应用按[增量接入](skills/bifang-public-services-onboarding/references/shared-function-extension.md)仅追加配置，保留旧凭据和代码，明确确认计划后执行。已匹配本工具配置的资源保留，失败后重新生成计划继续；不会删除资源回滚。自定义资源名、本机 CLI 登录会话和异构服务凭据导入仍待补。详细参数、API 依据和失败处理见 [第二门禁执行说明](skills/bifang-public-services-onboarding/references/personal-resources.md#可执行命令与支持边界)。

运行 `npm run check` 检查基础设施、个人创建工具及技能文档。工具的本地测试使用模拟云接口，不能当作真实部署或 HTTP/大屏/EXE 验收证据。

## 参数与请求确认工具

第二门禁通过后运行 `npm run cloudbase:personal:client:init`，自动补好项目事实并将返回的私有文件路径给客户填写缺项。运行时密钥优先引用第二门禁服务凭据文件；统计不需要客户端密钥。

客户回复已填写后，执行 `npm run cloudbase:personal:client:preview -- --file <实际私有文件绝对路径>`。工具只在本地校验并生成请求实例，缺项列出字段路径；完整时输出脱敏请求、confirmation_id 及含密钥的私有实例文件路径。助手在正文展示明细并等待客户明确确认，不能把脚本成功当客户确认，不发送真实请求或编写业务代码。

## UI 确认与本地实施

第三门禁通过后按 [第四门禁](skills/bifang-public-services-onboarding/references/personal-client-implementation.md) 执行：先读取客户项目的实际 UI 风格，展示普通更新、强制更新、手动入口及触发/显示位置，等客户明确确认 UI。随后核验适用 AGENTS.md、架构和编码规范、模块调用链与验证命令，再按已有授权直接编码并完成本地测试。仅统计无可见变更可记录 UI 人工确认不适用；两项均选时不得在等更新 UI 确认期间先实现统计。

第四门禁当前是规范，不能当作某个客户项目已接入的证据。只维护规范不会触发业务代码修改、真实接口调用、打包或部署；本地实施与真实服务/制品验收分别记录。

## 确认保存与更新接口预检

需要填写文件时，助手先提供已创建的私有发布交接文件的实际绝对路径和链接，逐项列明完整字段路径、要填的内容及必填/可选属性，并预填已有事实。客户只补缺项；“已填写”只触发本地校验，不代表版本已发布或接口可立即预检。详细填写规范见第五门禁 reference。

第四门禁本地通过后按 [第五门禁](skills/bifang-public-services-onboarding/references/personal-update-preflight.md) 补齐发布信息并本地校验，再展示具体自动保存计划供客户确认。确认后助手使用已有版本服务管理 API 保存、读回，并执行计划中的限定更新 GET。默认不要求客户手动调用 API；冲突和结果不明时停止，不盲重试或覆盖。预检通过才进入制品测试，构建/运行/安装按具体授权执行。

此阶段不请求安装包链接、不下载、不运行 EXE 或写统计；接口成功不证明安装包可达或可安装。仅统计记录更新配置/预检不适用；都接入先过更新预检。[第六步](skills/bifang-public-services-onboarding/references/personal-artifact-testing.md) 在已确认范围内直接构建并启动当前目标，验证更新与所选统计，不重复询问开始；实际下载/安装另按授权执行。规范本身不代表已执行测试。

第六步完成后，同一条最终回复主动交付测试结果及未验证项、实际 EXE/目标制品链接和校验信息、统计大屏实际地址及该客户的 `DASHBOARD_ACCESS_TOKEN` 登录凭据。凭据只向当前客户交付，不写入仓库或日志，不返回其他服务密钥；缺失如实报告，仅更新时大屏项不适用。详见第六步交付规则。

个人版统计保留采用普通索引与专用定时清理函数（每 15 分钟、每轮最多 100 条），包含新增 UpdateTable / CreateTrigger / ListTriggers 权限差异；完整资源与免费支持证据规则见 [清理方案](skills/bifang-public-services-onboarding/references/retention-cleanup.md)。旧 TTL 计划不能授权新增资源或未来到期删除；新计划确认前只改本地和只读盘点。
