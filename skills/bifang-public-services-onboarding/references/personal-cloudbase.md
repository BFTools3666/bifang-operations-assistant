# 个人免费 CloudBase：第一门禁与开通指引

核对日期：2026-11-18。适用于腾讯云中国站、客户自行持有的 CloudBase 免费体验环境。本页定义第一门禁及开通准备；通过后进入 [第二门禁](personal-resources.md)，再进入 [第三门禁](personal-client-confirmation.md) 确认参数与请求。不能仅凭第一门禁通过就部署或编码。

## 第一门禁：免费环境、CAM 权限与管理密钥交接

客户已经选择「1. 接入统计和更新」或明确要求首次接入后，先确认：“你是否已经在自己的腾讯云账号下创建好了 CloudBase 免费体验版环境？打开[云开发环境列表](https://tcb.cloud.tencent.com/dev#/select-env)，点自己的环境名称或 ID，在环境信息中查看套餐版本。1. 已创建　2. 尚未创建　3. 不确定。”复用本次明确回答。未创建按下文给完整开通步骤；不确定先指导查看套餐与环境，不能把账号注册、订单成功或笼统“继续”当环境创建完成。

**已有免费环境只通过环境子项，不代表第一门禁通过。** 本门禁严格按以下顺序完成：

1. 客户确认目标免费体验环境已创建；已有用户跳过开户和购买指引。
2. 引导客户准备专用 CAM 子用户，在第一门禁一次性关联检查策略和创建策略，再准备 API 密钥；已有同用途有效子用户与密钥直接复用，不强制重建。
3. 助手运行 `npm run cloudbase:personal:init`。在对话列出缺少的环境字段并回写，再给实际私有文件链接；客户只在本机填写 `credentials.SecretId` 和 `credentials.SecretKey`，完成后告知。
4. 已向客户说明只读环境/套餐检查范围后，运行 `npm run cloudbase:personal:access -- --file <实际私有路径>`。此命令只读取目标环境、套餐、账期、额度及 PostgreSQL 系统目录，验证签名凭据可用于这些查询，不扫描项目、不盘点业务资源、不创建或修改云资源。填好文件不是云写入授权；已有明确只读/不联网限制须遵守。
5. 只有客户环境确认、检查与创建权限均已关联的明确依据、私有密钥交接和 `access-verified` 均完成，才通过第一门禁。认证失败、权限不足、过期、非免费套餐或密钥缺失继续停在此门禁；不要把“文件已填写”或仅格式合法当作可用。

环境/权限已有明确事实直接复用；缺项仅补缺项。项目扫描、应用/发布流参数收集和资源计划留第二门禁。维护 Skill 本身不向客户索取密钥、不启动真实云检查。

## 没有环境时：回复正文必须给出的步骤

以下是客户手动操作指引。链接及套餐规则可能变化，实际执行前重查官方页面；不能把价格、资格或菜单名称的旧截图当当前事实。本次核对了公开文档，未登录客户账号、未实际领取兑换码或下单。

### 1. 注册并登录腾讯云中国站

1. 打开 [腾讯云中国站](https://cloud.tencent.com/)，点击注册；已有账号直接登录。
2. 按页面可用方式注册，完成所需手机号验证并设置登录信息。账号由客户自己保管，不向助手发送验证码、密码或 Cookie。
3. 登录控制台，确认使用的是准备持有个人环境的账号；不要误入公司账号或微信小程序专属环境。
4. 需要帮助时打开 [账号注册与实名新手指引](https://cloud.tencent.cn/document/product/378/52700)，按其中当前注册链接操作。

### 2. 完成实名认证

1. 在腾讯云控制台账号菜单进入“账号信息 / 实名认证”；也可从上述新手指引进入认证页面。
2. 个人持有账号选择“个人认证”，按页面支持的方式完成认证。
3. 身份证件、人脸核验及其他身份材料由客户直接在腾讯云页面提交；不要发送到聊天或写入仓库。
4. 回到认证页面，确认状态已通过，再继续申请环境。已有认证直接复用。
5. 官方操作说明：[个人实名认证](https://cloud.tencent.com/document/product/378/56760)。

### 3. 进入免费环境申请入口

1. 打开官方文档所链接的 [CloudBase 环境购买入口](https://buy.cloud.tencent.com/lowcode?buyType=tcb)。该链接可能跳转登录页及新版 CloudBase 购买页。
2. 若链接布局改变，从 [CloudBase 官方计费概述](https://cloud.tencent.com/document/product/876/127357) 的“免费体验 / 环境购买页”进入，不使用第三方购买链接。
3. 选择 **免费体验版，¥0**。这是本流程所说的个人免费方案；腾讯云另有名称为“个人版”的付费套餐，不要选错。
4. 按购买页当前说明领取并使用一次性兑换码。不提供臆造的通用兑换码；入口不可见、账号不符合资格或只有付费选项时，停留本步骤，反馈页面中的非敏感提示。
5. 已有免费环境则回到环境列表复用。当前规则每个账号仅一个免费体验环境；不要为了领取资格销毁已有环境，也不要重复开新环境。

### 4. 开通 CloudBase 并创建环境

1. 打开 [CloudBase 控制台](https://console.cloud.tencent.com/tcb)。首次使用时，由客户主账号审阅平台提示的服务授权，确认后开通；已开通不重复授权。
2. 按控制台/购买页引导创建免费环境。如果零元订单已自动创建环境，直接进入该环境，不重复创建。
3. 填环境名称：无现有命名约定时建议 `personal-tools`；与现有环境重名时由客户自行区分。
4. 地域复用现有环境；新环境面向中国大陆使用时优先选择页面实际提供且支持免费体验的上海地域，不为该默认值切换付费套餐。页面不提供该选项时先核对免费地域及客户端部署需求。
5. 数据库默认选择 **PostgreSQL**，不再询问客户类型。创建后不可随意切换；已有环境通过 DescribeEnvs 和固定只读 SQL 核验实际类型。统计、更新和大屏使用官方 pgdoc Document 插件；未启用留第二门禁准备。若实际类型不符或页面只提供其他类型则停止，不删除环境、不创建第二个免费环境。详细规则见 [PostgreSQL 适配](postgresql.md)。
6. 审阅订单：套餐是“免费体验版”，最终应付金额为 **0 元**，无附加资源包、连续包月、按量超限或其他付费选项。只要出现非零应付金额就停止，不充值、不支付、不升级。
7. 客户自己提交零元申请/订单，等待开通完成。不要把订单成功当环境创建成功；进入环境列表确认目标环境已创建且可进入详情。

### 5. 检查套餐并继续凭据准备

1. 在目标环境的套餐/用量页面查看套餐名称、到期时间、资源额度及环境状态。
2. 当前免费体验规则：每月 3,000 资源点；到期前一个月内可手动续期，每次六个月，不支持自动续费。免费套餐不支持加购资源包和超限按量；升级付费后不能降回免费。以当时官方页面为准。
3. 使用腾讯云 CloudBase 控制台的免费体验环境。本规范不把微信小程序发布后的体验期规则当作桌面客户端长期免费政策。
4. 客户自行保存环境 ID、地域、数据库类型和到期时间，后续有合法访问方式时自动读取；此时不用在聊天中提供这些字段。
5. 告诉助手：“个人 CloudBase 免费体验环境已创建。”收到明确反馈后记录环境子项完成，继续下面的 CAM 与私有密钥交接。仅创建环境还不能通过第一门禁，也不证明任何服务已部署。

## CAM 子用户、策略与密钥：第一门禁必做

腾讯云权限服务叫 **CAM（访问管理）**。本门禁的 key/secret 精确指腾讯云 API 的 **SecretId / SecretKey**，不是 CloudBase 环境 API Key，也不是第三门禁的更新运行时 app_key/app_secret。管理密钥不进入函数环境变量、前端、Rust 常量、安装包或日志。函数运行使用平台已创建的 `TCB_QcsRole`；平台服务角色和 CAM 子用户分别管理。

### 6. 创建或复用专用子用户

1. 由客户主账号或权限管理员进入 [CAM 用户列表](https://console.cloud.tencent.com/cam/user)。已有专用子用户时进入该用户详情，检查权限，不重复创建。
2. 新用户点击“新建用户 → 自定义创建 → 可访问资源并接收消息”，默认名称 `personal-cloudbase-deployer`；名称冲突时保留既有用户或由客户区分。
3. 访问方式启用 **编程访问**；自动化用 API 密钥。若客户要用此子用户手动在控制台创建资源，同时启用控制台访问；若手动创建使用主账号/其他已授权身份，不强迫此用户启用控制台登录。
4. “设置用户权限”同时关联下文 `BifangPersonalCloudBaseInspect` 和 `BifangPersonalCloudBaseCreate` 两份自定义策略。缺少哪份就先按第 7 节创建，再回到用户详情“权限 → 添加/关联策略”。不使用全账号管理员快捷创建方式。
5. 标签可按客户约定，未设约定不强制；审阅用户名、访问方式和策略，由客户完成创建。账号、密码和 MFA 验证由客户自己操作。

依据：[官方创建子账号并授权](https://cloud.tencent.com/document/product/598/54458)。公开文档已核对，未登录客户控制台验证其当前页面。

### 7. 明确赋予哪些权限

第一门禁提供并同时关联两份策略，不按后续手动/自动创建选择延后写权限准备。回复中给两份文件的实际链接，并展开两份完整 JSON；说明作用范围后由客户在 CAM 审阅、创建和关联。已有等价权限经核对后复用，文件不含密钥。

| 准备阶段           | 自定义策略名称与文件                                                                           | 权限及用途                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 第一门禁，必须准备 | `BifangPersonalCloudBaseInspect`：[cam-inspect-policy.json](../assets/cam-inspect-policy.json) | 环境/套餐/账期/额度、路由、集合/权限、函数查询及索引盘点所需 RunCommands，及 PostgreSQL 系统目录查询，共 12 个明确 action              |
| 第一门禁，同时准备 | `BifangPersonalCloudBaseCreate`：[cam-create-policy.json](../assets/cam-create-policy.json)    | EnablePGDocumentExt、CreateTable、UpdateTable、CreateFunction、CreateHTTPServiceRoute、scf:UpdateFunctionConfiguration，共 6 个 action |

无论第二门禁选择手动还是自动创建，第一门禁都先把这两份权限准备好；第二门禁只选择执行方式、确认资源计划并执行/核验。客户使用其他控制台身份手动操作时，助手仍保留已准备的身份供检查，操作行为遵守客户选择。控制台额外菜单权限若实际缺失，再按具体报错处理，不盲加管理员。

检查策略完整 action：`tcb:DescribeEnvs`、`tcb:DescribeBillingInfo`、`tcb:DescribeEnvAccountCircle`、`tcb:DescribeBaasPackageList`、`tcb:DescribeCreditsUsage`、`tcb:DescribeHTTPServiceRoute`、`tcb:DescribeTable`、`tcb:DescribeDatabaseACL`、`tcb:RunCommands`、`tcb:ExecutePGSql`、`scf:ListFunctions`、`scf:GetFunction`。

第一门禁同时关联的创建策略完整 action：`tcb:EnablePGDocumentExt`、`tcb:CreateTable`、`tcb:CreateFunction`、`tcb:CreateHTTPServiceRoute`、`tcb:UpdateTable`、`scf:UpdateFunctionConfiguration`。本工具通过 TCB 创建函数，不要求 `scf:CreateFunction`；不授予删除环境、下单/购买、CAM 写入或所有服务的 `*` action。

2026-11-19 按[腾讯云更新函数配置接口](https://cloud.tencent.com/document/product/583/18580)核对，共享函数追加应用需 `scf:UpdateFunctionConfiguration`。新接入用上表两份策略一次准备。旧子用户使用六项创建策略时，核对已关联策略的生效版本或等价授权依据；确实缺少时，由客户更新原创建策略，或关联[旧账号单项补充策略](../assets/cam-shared-update-policy.json)。保持现有子用户和密钥。已在第二门禁的任务补齐差异后复核计划。技能文件更新不会改变云端策略。

新版共享大屏追加中文名沿用上述配置更新权限。已有旧版大屏的名称表在代码包内，客户选择修复该包时，另按具体目标核对读取包和更新代码的权限。这两项属于旧包维护范围。[共享大屏名称修复](shared-function-extension.md#已接入应用的名称修复)

该 action 可修改函数的多种配置。本工具仅在已确认的共享增量计划中，向指定环境和函数提交合并后的环境变量。第一门禁记录权限依据，第二门禁确认具体写入。

**权限范围必须如实说明**：两份策略采用 `resource:["*"]`，是限制 action 的账号资源范围策略，不能称单环境最小权限。部分官方 API 只支持操作级授权。`RunCommands` 和 `ExecutePGSql` 本身可执行数据库写命令，故检查策略也不是 CAM 层面的纯只读策略；本工具的检查 transport 只允许 `listIndexes` 及 postgresql.mjs 内精确固定的系统目录 SELECT，创建阶段只允许已确认计划的 `UpdateTable CreateIndexes` 与其它精确载荷，工具限制不能冒充 CAM 限制。若客户不能接受该权限范围，停留权限准备，按真实 UIN/地域/环境及官方粒度生成更窄策略；不能伪造 ARN 或偷用主账号密钥。

创建策略步骤：

1. 打开 [CAM 策略列表](https://console.cloud.tencent.com/cam/policy)，点击“新建自定义策略 → 按策略语法创建 → 空白模板”。
2. 分别复制两份策略文件中的**完整 JSON**，填写上表名称和用途，检查 `version=2.0`、全部 action 及 resource，客户自己提交。
3. 返回“用户 → 用户列表 → 专用子用户 → 权限”，同时添加/关联检查和创建两份策略。已有同名策略先核对内容，不覆盖其他任务策略。
4. 在第一门禁确认检查和创建两份策略都已关联，记录客户明确反馈或其他可核验依据；缺少创建权限时第一门禁仍未通过，不推迟到第二门禁。第二门禁复用同一子用户、权限和 key/secret；后续若权限被撤销或实际报错，作为第一门禁权限证据失效返回修复，不设第二次常规授权步骤。
5. `QcloudAccessForTCBRole` 权限较广，不作为本工具默认子用户策略；`QcloudAccessForTCBRoleInAccessCloudBaseRun` 是服务角色相关策略，不混用。API 密钥方式不需要为了 CLI 网页登录添加 `QcloudCamReadOnlyAccess`。

依据：[TCB 支持的 CAM action 与授权粒度](https://cloud.tencent.com/document/product/598/98174)、[SCF 支持的 CAM action 与授权粒度](https://intl.cloud.tencent.com/zh/document/product/598/57149)、[自定义策略创建与关联](https://cloud.tencent.com/document/product/876/47057)、[TCB 预设策略范围](https://cloud.tencent.com/document/product/876/47056)。策略来自本工具实际调用集合与官方 action 表，尚未在客户账号实测；第一门禁 `access` 只证明五项环境读取有效，不能宣布后续全部权限已获验证。

版本、广告和审计集合的普通索引使用 `tcb:UpdateTable`。工具仅按确认计划发送 CreateIndexes，并在写前核对同名冲突。

### 8. 在哪里创建 SecretId / SecretKey

1. 由客户主账号/权限管理员进入 CAM 用户列表，打开刚才的专用子用户详情。
2. 进入 **API 密钥** 页签，点击 **新建密钥**，按页面完成身份验证。创建用户时如果已生成同一有效密钥，直接复用，不再新建。
3. 创建成功窗口保存 **SecretId 和 SecretKey 两项**，填入助手给出的私有文件，不发到聊天。腾讯云 SecretKey 只在创建时展示，之后不能再次查询；遗失时由客户按官方流程创建新密钥并处理旧密钥，助手不擅自删除或轮换。
4. 这是子用户管理密钥；不要去主账号 API 密钥页创建主账号长期密钥，也不要拿 CloudBase 客户端 API Key 替代。
5. 使用 STS 时，若无可复用材料，在对话收集 `credentials.Token` 和 `credentials.expires_at`，助手回写。长期密钥的这两项保持空字符串。

依据：[子账号访问密钥管理](https://cloud.tencent.com/document/product/598/37140)。

### 9. 私有文件交接和检查

助手先运行 `cloudbase:personal:init` 并给客户返回的真实文件路径，不给尚不存在的占位路径，不让客户编辑仓库模板。文件使用 Windows 当前用户+SYSTEM ACL 或 Unix 0700/0600，位于仓库外受限目录；本地明文依靠文件权限保护，不称已加密。

索取环境信息时，随题给[环境列表](https://tcb.cloud.tencent.com/dev#/select-env)：点目标环境名称或 ID，在环境信息中查看「环境 ID（EnvId）」和「地域」，分别对应 `cloudbase.env_id`、`cloudbase.region`；地域显示中文时可直接回复中文。只有两项 CAM 密钥走本机填写，给[CAM 用户列表](https://console.cloud.tencent.com/cam/user)及「目标子用户 → API 密钥 → 新建密钥」的位置。缺少哪个字段就展示哪一项指引。[官方环境说明](https://docs.cloudbase.net/quick-start/create-env) · [官方密钥说明](https://cloud.tencent.com/document/product/598/37140)

第一门禁只填这些字段，其余 resources/applications 保持模板的未知/空值：

| 字段                             | 填写要求                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| cloudbase.env_id / region        | 当前目标环境的真实 ID、地域；已有部署资料自动复用，否则客户从环境详情取得值，在对话回复。工具支持 ap-shanghai / ap-beijing / ap-guangzhou，不猜地域 |
| cloudbase.database_type          | 模板已填 postgresql，无需客户输入；由 API 自动核验，不能凭默认值放行                                                                                |
| cloudbase.http_origin            | 本门禁可空；第二门禁从域名盘点自动读取，已有可信值可复用                                                                                            |
| credentials.mode                 | 固定 api-key                                                                                                                                        |
| credentials.SecretId / SecretKey | 专用子用户同一组 API 密钥，必填，不展示原值、部分值或摘要                                                                                           |
| credentials.Token / expires_at   | 长期密钥均空；STS 必须同时填同一组 Token 和未来 UTC ISO 时间，至少剩余 60 秒                                                                        |
| acknowledge_zero_cost_only       | 保持 true                                                                                                                                           |

客户回复“已填写”后，助手按已说明只读范围执行 `cloudbase:personal:access -- --file <同一实际路径>`。脚本本地读取并校验，不运行通用文件输出；仅返回脱敏状态、目标环境、PostgreSQL/pgdoc 核验状态、套餐/额度和回执路径。JSON 错误不回显原文。收到鉴权/权限错误只报告固定错误分类和缺少的具体 action，按错误来源处理：普通字段在对话纠正并回写，两项 CAM 密钥在本机修正，策略由客户在 CAM 修正，再重检。

## 第一门禁产出与通过条件

记录免费环境确认、专用子用户、检查/创建两份策略均已关联的依据、私有输入路径、SecretId/SecretKey 已交接状态、access 回执及核验时间。**环境有效、密钥齐备、检查与创建权限均已准备、只读环境预检通过**才进入第二门禁。策略关联状态与真实调用证据分别记录；不通过试建资源验证写权限。只填写但未检查、只创建环境、只有 SecretId、密钥过期或没有适用权限均不通过。

第一门禁不部署函数/集合/路由，不代表客户端已接入或下一阶段写入已授权。第二门禁先展示资源明细、询问手动或自动创建；自动创建针对已确认精确计划执行，手动创建由客户操作后核验，两种方式都必须给出结果。第三门禁再确认运行时请求参数，第四门禁先确认 UI 再实施。

个人方案用 CloudBase 执行版本检测并返回外部下载链接，不存储/代理安装包。当前免费套餐自定义域名配额为 0，默认域名仅用于开发测试并受限制；此限制记录方案，不要求第一门禁购买域名。来源：[官方计费概述](https://cloud.tencent.com/document/product/876/127357)、[HTTP 访问限制](https://cloud.tencent.com/document/product/876/122894)。免费环境不是永久免费或无限调用承诺。
