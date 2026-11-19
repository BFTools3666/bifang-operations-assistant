# 个人 CloudBase Skill 实施入口

- 个人数据库默认 PostgreSQL，第一门禁不让客户填写类型；DescribeEnvs.PostgreSQL + 固定只读 SQL 核验。两份 CAM 策略在第一门禁包含 ExecutePGSql / EnablePGDocumentExt；第二门禁才按选择/精确计划准备 pgdoc，旧文档库共存或部分安装停止。三类云函数使用官方 Node SDK 文档 API，由 PostgreSQL 承载，不能按集合语法误判底层类型；详见 [PostgreSQL 适配](skills/bifang-public-services-onboarding/references/postgresql.md)。

本分支 `codex/personal-cloudbase` 重新建设个人免费 CloudBase 接入 Skill。当前定义五道门禁，严格按环境确认→资源准备→参数与请求确认→UI 确认/架构核验/本地实施验收→客户确认后自动保存版本与更新预检执行；第五门禁通过后在已确认范围内直接构建并运行第六步基础制品测试，前一步未通过不能进入下一步。不保留公司集中管理模式的 Skill 入口、授权中心链路或旧门禁。

单独调用技能或询问有哪些功能时，先展示「1. 接入统计和更新」「2. 更新版本」并等待选择。客户明确说明任务时直接分流。下列门禁属于首次接入，已接入应用的更新查询、设定与取消按[版本更新管理](skills/bifang-public-services-onboarding/references/personal-release-management.md)执行。只维护 Skill 时使用本地模拟记录。

## 阅读顺序

1. `README.md`。
2. `docs/毕方小工具公共服务分步接入指南.md`。
3. `skills/bifang-public-services-onboarding/SKILL.md`。
4. `skills/bifang-public-services-onboarding/references/personal-cloudbase.md`。
5. `skills/bifang-public-services-onboarding/references/personal-resources.md`：资源清单、字段及私有文件交接。
6. `skills/bifang-public-services-onboarding/references/personal-client-confirmation.md`：第三门禁完整参数、私有凭据、请求实例和客户确认。
7. `skills/bifang-public-services-onboarding/references/personal-client-implementation.md`：第四门禁 UI、触发位置、架构规范和本地实施验收。
8. `skills/bifang-public-services-onboarding/references/personal-update-preflight.md`：第五门禁发布信息、计划确认、自动保存与读回、限定预检及制品测试入口。
9. `skills/bifang-public-services-onboarding/references/local-source.md`：本地安装、源码绑定与有限自动定位。
10. `bifang-onboarding.json`：个人流程声明与工具入口。
11. 修改工具时读 `cloudbase/personal/`、现有函数、生成器和相关测试。

## 当前范围

- 第一门禁先确认个人免费环境，再引导专用 CAM 子用户、检查和创建两份策略同时关联与 SecretId/SecretKey 创建入口。init 创建仓库外私有文件并给真实路径，客户本地填密钥，access 只读验证环境/套餐/额度后才通过；已有环境只通过环境子项，不能直接越门禁。第一门禁只收集环境和管理凭据，不扫描客户项目或创建资源。
- 区分免费体验版与收费个人版，区分 CAM 管理密钥、平台服务角色与客户端运行时凭据。不得要求客户贴密钥。检查策略的 RunCommands 有写能力，resource:* 不是单环境最小权限；策略文件和准确范围见第一门禁 reference，检查与创建权限均在第一门禁准备并记录关联依据，缺少写权限不通过；第二门禁直接复用，不再常规补关联策略。只读 access 不代表写接口已实测，不通过试建资源验证写权限。
- 第二门禁复用密钥和同一私有文件，先展示统计、更新、大屏及集合/索引/路由的完整具体清单，再让客户选择手动创建、助手自动创建并检查或已有仅检查。手动交付步骤及 prepare 生成的私有 ZIP/配置，客户完成后 verify；自动先 plan，复用覆盖具体计划的授权 apply 并逐项/最终读回，已授权不重复问开始。已有只跳过创建不跳过核验，必需项全部核验通过才过门禁；客户声明或旧 skipped 状态不算通过。
- 第三门禁复用/确认客户端接入范围，自动读取项目事实和第二门禁产出；缺项放仓库外 integration-input.json 给客户补齐，密钥仅通过私有文件交接。使用 client-confirmation.mjs 离线生成完整请求，正文展示脱敏明细，含原值实例只存私有文件。客户明确确认本次明细后才通过；两项均选时整体通过，未确认不得编码或发送请求，配置实质变化重新确认。
- 第四门禁严格执行 4A UI 确认→4B 架构/规范核验→4C 编码→4D 本地验收。按目标项目已有风格展示普通更新、强更、手动检查入口的可见预览，明确触发及显示位置、按钮/关闭行为和新业务限制，等待客户明确确认 UI，不能由第三门禁确认替代。两项都选时等待期间也不先编码统计；仅统计无可见变更记录 4A 人工确认不适用，若改可见隐私/状态界面则先确认。
- UI 通过后编码前，阅读目标项目及拟改目录的 AGENTS.md、架构/编码约定、实际调用链与同类实现，报告有文件依据的复用机制、修改范围和检查命令，再按已有实施授权直接编码与本地验收，不新增架构审批或重复问是否开始。保持现有前端和模块边界，可信服务职责用 Rust；只读/文档限制不因 UI 确认自动解除。
- 个人更新使用当前 GET 合同和外部下载链接，不引入公司 POST、block_new_operations 或虚构安装能力。强更仅按有效响应和已确认限制清单处理新业务，保留已有任务、重试和安全退出。模拟测试只能标本地通过；真实服务请求和部署发布等仍受对应授权边界约束。
- 第五门禁先交接实际私有文件路径及缺项字段，本地校验后展示具体保存计划，请客户确认。确认后助手通过已有版本管理 API 自动保存、管理读回并执行已说明的限定更新 GET；默认不要求客户手动操作版本服务。保存、读回、预检分别使用 managementWrite、managementRead、runtime；输入变化或冲突修改需新计划，不盲重试结果不明的写入。此步不直写数据库、不上传包、不下载/安装/运行制品、不写统计；更新预检通过才进入第六步。客户明确分平台推进时保留未完成目标状态，不将局部结果标成全部通过。
- 第六步在第五门禁通过后，按已确认的当前目标范围直接构建和运行基础联网测试，不重复询问是否开始。第五门禁计划同时说明后续基础测试；客户后续明确要求构建测试时也复用授权。历史仅保存/预检或明确排除制品操作的限制不能因规范升级自动解除。详见 personal-artifact-testing.md；下载/安装、发布和未选平台仍需对应范围授权。
- 第六步完成后，最终回复一次交付测试结果及未验证项、实际制品链接与校验信息、统计大屏实际地址及当前客户的 DASHBOARD_ACCESS_TOKEN。仅此大屏登录 Token 可在客户最终交付回复中展示，不泛化为其他密钥披露；读取绑定本次环境的私有文件单个字段，不通用打印文件，不将原值写入仓库或日志。仅更新时大屏项不适用，缺项不得编造。详见第六步 reference 的交付规则。
- 仅整理规范不触发客户接入问答、不调用真实业务或管理接口、不读取真实客户凭据。
- 个人资源创建入口为 `cloudbase/personal/cli.mjs`，第一门禁 init → access，第二门禁 validate/plan 后按选择走 prepare → 客户完成 → verify，或 apply → 逐项与最终读回，实际云写入须已有精确目标授权并绑定已确认计划摘要。代码维护与模拟测试不触发客户门禁或真实部署。第三门禁只采用所部署个人函数的实际运行时合同；既有 SDK 的外部更新中心实现、示例不能直接当本模式合同。
- 私有文件只由本地进程读，不能用通用读文件命令展示内容。创建计划和回执只输出允许字段；函数包仅包含目标源码、客户名称与映射，管理密钥不得上传。新资源逐项创建和读回，冲突停止、失败留存并重新计划，不删除回滚、不覆盖共享资源、不默认使用公司登记。
- 权威来源为当前个人分支的仓库文件。`npm run skill:install` 从脚本位置自动安装并绑定源码，备份原同名技能；用户无需在接入提示词中填写固定本地路径。每次调用先运行 Skill 内 `scripts/local-source.mjs resolve`，读取其核验通过的源码规范与工具；源码/客户项目分开记录，工具执行前复核。绑定失效仅有限查找，找不到或多个候选才问一次，不全盘扫描、不读取客户凭据。此来源核验不触发客户接入问答、不增加门禁；第一门禁前不得扫描客户项目。默认分支、公司标签及缓存不能代替个人源码；远端 URL bootstrap 仍不支持，不运行旧 bootstrap。

## 操作边界

客户自行完成注册、实名、平台授权及零元环境申请。任何非零金额、升级或付费选项立即停止，不购买域名、证书、资源包或开启自动续费、超限扣费；不创建第二个免费环境，不为获取免费资格销毁旧环境。

部署、真实接口测试、制品构建/安装、推送/发布、权限调整及删除需要对应明确授权。已有同目标授权可复用。推送、发布、部署和删除前展示准确目标及预检结果。管理密钥、Token、Cookie、身份材料与本地环境状态不能进入 Git 或业务客户端。

## 修改与验证

- Skill 指令与必要 reference 保持自包含，同步入口、机器声明与相关测试；未来门禁缺项明确待补。
- 官方套餐、权限、购买链接有时效性，修改指引时查官方资料并记录核对日期；未登录的页面步骤不能称已实测。
- 依赖未安装先 `npm ci`，再 `npm run check`。Skill 使用 skill-creator 的 quick_validate 验证。
- `tests/guide-git-contract.test.mjs` 验证当前 Skill 和接入指南受 Git 管理、引用有效。删除功能时移除只验证已删除功能的测试，不削弱保留源码的行为测试。
- 不把生成包、构建目录或本地状态提交为权威源。不修改历史截图或生成 Word；如另有任务修改 `docs/cloudbase-quickstart.md`，需同步生成 Word 并渲染检查。
- 交付说明实际改动、检查结果、未执行事项；仅在真实提交后报告提交哈希。

个人版统计保留采用普通索引与专用定时清理函数（每 15 分钟、每轮最多 100 条），包含新增 UpdateTable / CreateTrigger / ListTriggers 权限差异；完整资源与免费支持证据规则见 [清理方案](skills/bifang-public-services-onboarding/references/retention-cleanup.md)。旧 TTL 计划不能授权新增资源或未来到期删除；新计划确认前只改本地和只读盘点。

共享函数新增应用可按[增量接入规范](skills/bifang-public-services-onboarding/references/shared-function-extension.md)准备配置更新计划；仅保留旧配置/凭据后追加新应用，配置更新权限在第一门禁创建策略中准备，旧账号仅补缺项，云写入仍需具体计划授权。该例外不授权代码替换、旧应用修改、凭据轮换或权限自动调整。
