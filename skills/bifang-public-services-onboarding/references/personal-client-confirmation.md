# 第三门禁：接入参数、私有凭据与完整请求确认

前置条件：第一门禁已完成环境确认、检查/创建权限准备、CAM 私有密钥交接和 access 只读核验，第二门禁所需资源已有逐项检查依据。区分“客户手动创建后检查通过”“助手创建且读回通过”“已有资源检查通过”；仅客户声明已有或旧 skipped 状态不能进入本门禁。这些控制面结果均不代表真实业务接口已测试。本门禁生成接入确认单，不编码、不发送请求、不部署或发布版本。

## 必须按顺序执行

1. **确认本次客户端范围**：1. 仅更新　2. 仅统计　3. 更新和统计都接入。复用本次明确选择；仅有“资源全部创建”不等于选择客户端范围，需问一次。模板默认勾选两项不是客户回答。未选项保持原状，不为其索取参数或凭据。
2. **自动收集**：读取目标项目及实际构建配置，取得应用标识/名称、当前运行版本、目标平台和架构；从第二门禁回执、目标登记或客户已明确提供的部署资料取得真实路由与发布流映射。不要把本仓库登记或开发机架构当客户事实。记录每项来源与证据类型，不为能自动确定的数据增加问答。
3. **创建私有输入文件**：用下文 init 命令创建实际文件，自动填已知非敏感值和明确范围，把完整绝对路径及链接交给客户。先用 preview 离线校验。资料齐全就直接展示确认单；仍有缺项就在对话给 key 和原因，客户回复 value 后助手回写、读回并继续；已有可用服务凭据由本地进程复用，不让客户再次抄写。
4. **本地读取与补齐循环**：用 preview 命令解析。缺项、格式错误或绑定冲突只输出字段路径，助手在对话收取对应 value，再回写同一文件。不得用 Get-Content、cat、原始 readFile 输出读取私有内容，不把错误行、密钥或个人设备标识送入工具结果。未知地址、凭据、平台/发布流映射必须标待补，不能编造。
5. **完整返回确认单**：所有所选分支参数就绪后，对每个目标分别展示实际完整 URL、方法、请求头名称、路径参数、query/body 的有无与全部字段、来源、默认行为、响应判定及未执行事项。工具输出只是材料，助手须在回复正文展开，不只给文件链接。真实密钥只出现在私有请求文件，正文用“从私有文件读取”标注相应请求头；动态字段给出本次预览值及实际运行生成规则。
6. **等待客户明确确认**：提示“请确认这份更新/统计接入参数及请求实例；需要调整请指出字段，确认后才进入下一阶段。”记录 confirmation_id、所选范围、客户原话、待补项为零及对应文件。已填写、已创建、继续生成实例或未回复都不算确认。两项均选必须一起完成参数和确认，不能让其中一项先跨门禁实施。

如果客户明确只确认其中一项，先说明另一项仍未通过；只有客户明确缩小本次范围，才生成新的单项确认单。地址、版本映射、凭据、范围或默认行为实质变化后，重新生成并确认受影响明细，不复用旧确认。文件里不设“confirmed=true”替代客户回复。

## 输入文件与必要字段

本流程涉及客户操作云端时，在当次提示逐项展开[官方页面指引](../assets/console-guides.json)中适用的 domain、routes：给可点击入口、页面内位置、目标字段或操作和完成标志。

模板：[integration-input.template.json](../assets/integration-input.template.json)。实际文件位于 `%LOCALAPPDATA%\Bifang\PersonalCloudBase\intake\<任务标识>\integration-input.json`，其他系统采用当前用户私有配置目录。先实际创建再给地址，不把占位路径交给客户填写。沿用第一、第二门禁的仓库外、非同步目录、无符号链接、Unix 0700/0600 或 Windows 当前用户+SYSTEM 权限边界；只复用所需运行时凭据，不复制 CAM 管理密钥。

| 字段                                 | 条件、值与来源                                                                                                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema_version / purpose             | 助手固定为 1 / personal-client-integration-confirmation                                                                                                                                                                      |
| services.update / services.telemetry | boolean，反映客户明确选择，至少一项 true                                                                                                                                                                                     |
| app.app_id / app.display_name        | 本次真实应用标识与名称；复用第二门禁、项目事实。app_id 与该环境部署映射一致，当前工具采用 1～50 位小写字母、数字、连字符，首尾字母或数字                                                                                     |
| targets[].platform / arch            | 真实程序目标 windows/macos/linux；x64/arm64/ia32。多目标逐个列出，不填 x86_64 冒充本合同 arch                                                                                                                                |
| targets[].channel                    | 发布流已有事实优先；未设通道时默认 stable。与第二门禁的发布流一致，工具接受 1～32 位小写字母、数字、连字符、首尾字母或数字                                                                                                   |
| targets[].app_version                | 从最终包的权威版本字段自动读，不默认 0.0.0。更新要求 1～50 字符的纯数字点分版本；统计要求完整 SemVer，最长 64 字符。两项均选时同时满足，不能静默去掉 prerelease/build、v 前缀或让客户填假版本绕过；不兼容则列冲突待解决      |
| targets[].update_code                | 仅更新必填；该 app/platform/arch/channel 已登记的唯一 code，规则同本工具 app_id；不能拿 APP_ID 自动替代发布流 code                                                                                                           |
| targets[].runtime_credential_id      | 仅更新必填；定位本次发布流的 runtime 凭据，自动从已授权私有文件匹配；同一 app、准确 code、唯一记录                                                                                                                           |
| update.protocol / base_url           | 仅更新；固定 application-version-api-v1，实际 HTTPS origin + `/tools/version-control/v1`，无尾斜杠、query、fragment、userinfo。从真实部署资料/回执取得；不能根据 env_id 拼域名                                               |
| update.credentials_file              | 优先自动填第二门禁实际 service-credentials.json 的绝对路径，本地读取其中 version_credentials，不复制整个管理凭据文件到客户端。外部旧凭据文件若不符合私有目录/权限要求，助手复用受限来源或在对话收取缺失的 runtime 字段并回写 |
| update.credentials                   | 与 credentials_file 二选一；引用文件时保持 []。没有可复用文件时按实际 key 在对话收取缺失的 runtime 字段，由助手写入本任务私有文件；统计单独接入无需任何此类值                                                                |
| telemetry.protocol / url             | 仅统计；固定 daily-active-v2，真实 HTTPS origin + `/apps/<真实app_id>/v1/track`，无尾斜杠、query、fragment、userinfo                                                                                                         |

未选服务对应对象可保持模板空值，工具不校验、读取或生成该服务请求。每次一个应用，最多 12 个明确发行目标；多应用分别建确认单。不得向模板增加 CAM SecretId/SecretKey、管理面凭据或“已确认”字段。凭据不足只补运行时值，不要求新建 CAM 管理身份。

客户必须补已有运行时凭据时，update.credentials 中每条记录的字段为：credential_id、app_id、codes（恰好一个本次 update_code）、role（固定 runtime）、app_key、app_secret。前四项助手根据来源填写，后两项仅在无法复用时在对话按 key 收取并由助手回写；每个原值 1～512 字符，不能带空白或控制字符。第二门禁生成值是 32 字节随机 base64url，无需再次生成。匹配本地记录仅证明本地声明及映射一致，不证明云端接受；未经授权不得做探测或轮换。

## 更新检查：当前已部署源码的精确合同

仅当目标部署采用第二门禁的 application-version-api 基线时使用以下合同。若客户已有服务采用其他请求方式/字段，先取得对应部署文档或源码并补适配，本门禁停止该分支，不能自动把客户服务改成此合同。这里明确选用个人资源工具所部署函数的运行时合同，不复用公司授权中心、外部 Updater 或现有 SDK 的 client-update.ts 协议。

| 位置     | 字段/取值                                  | 必填及含义                                                                                 |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 方法/URL | `GET <base_url>/versions/<code>/<version>` | code、version 分别作为一个路径段进行 URL 编码，v1 只出现一次                               |
| 请求头   | x-app-key、x-app-secret                    | 均必填，原值来自本地选定 runtime 记录；对应服务权限仅 versions:check，绑定当前 app 和 code |
| 请求头   | Accept: application/json                   | 本地工具默认添加，用于表明预期返回 JSON                                                    |
| 路径     | code                                       | 真实发布流 code。平台、架构、通道通过 code 映射，不另发这些 query/body 字段                |
| 路径     | version                                    | 当前客户端纯数字点分版本，不是要发布的目标版本                                             |
| Query    | 无                                         | 服务端拒绝额外 query，不添加 app_id、token、channel 等参数                                 |
| Body     | 无                                         | GET 不附 JSON body；无需 Content-Type；也不发 Bearer Token、CAM 凭据或统计 install_id      |

成功为 **HTTP 200 JSON**，七个返回字段：update:boolean、downloadUrl:string、promptContent:string、forcedUpdate:boolean、promptUpdate:boolean、stopUpdate:boolean、updateContent:string。update=true 才有可执行更新；stopUpdate=true 表示停止提供更新，此时 update/forcedUpdate/promptUpdate 为 false。服务按最高版本、条件与停更状态判定；不把 404“未发布版本”视为“当前已最新”。401 为凭据不通过，403 为权限/绑定不符，429 按 Retry-After 处理，其他错误记失败；不能仅凭错误新建业务限制。已由有效响应进入强更后的重试与解除行为按第四门禁确认的 UI 方案处理。

当前返回**没有** latestVersion、signature、sha256、block_new_operations 等字段，不能在确认单或 UI 中假造。默认仅提示并交付外部 HTTPS 下载链接，不自动下载安装、不调用 Tauri 原生签名 updater 协议。forcedUpdate 表示服务端强更意图；实际 UI 与限制范围在 [第四门禁](personal-client-implementation.md) 预览并由客户确认，不能把确认参数当作已经实现强更能力。downloadUrl、目标版本、更新文案是后续版本发布数据，不是本门禁检查请求的客户必填项。服务器返回的富文本须按已确认 UI 的安全显示规则处理。

默认接入方案：Rust 发起可信请求；启动后台检查一次并提供手动检查入口，周期检查默认关闭，超时 5,000ms（本 Skill 方案默认，不是云接口字段），先采用外部链接交付。已有产品行为应先核对，不能未经确认覆盖；任何默认行为调整须写入本次确认单后重新确认，当前本地生成器输出的是上述基线，不支持的行为先标待补，不声称已经实现。

## 统计：精确十字段与无需密钥

请求为 **POST 实际 telemetry.url**，请求头 Content-Type: application/json，query 无；基线没有客户端鉴权密钥，不添加 x-app-key、x-app-secret、Authorization、CloudBase SecretId/SecretKey 或大屏登录 Token。

| JSON body 字段 | 必填类型/取值                  | 自动来源与实际运行规则                                                              |
| -------------- | ------------------------------ | ----------------------------------------------------------------------------------- |
| schema_version | number，固定 2                 | 协议版本，不是 Skill 版本                                                           |
| event_id       | string，UUID v4                | 每次实际尝试由程序随机生成，不向客户索取                                            |
| event          | string，固定 daily_active      | 日活，不是安装、账号人数或功能操作计数                                              |
| app_id         | string                         | 与路由、函数允许应用及本次应用完全一致                                              |
| app_version    | string，合法完整 SemVer        | 当前真实运行版本，最长 64 字符                                                      |
| install_id     | string，UUID v4                | 每应用每安装随机生成并持久化；复用有效既有安装身份，不取账号、MAC、序列号或硬件指纹 |
| platform       | string，windows/macos/linux    | 真实程序运行目标                                                                    |
| arch           | string，x64/arm64/ia32         | 真实程序架构                                                                        |
| sdk_version    | string，固定 3.0.0             | 当前函数校验的线协议值；即使 Rust 重写客户端，也不能替换为 Skill 的个人版本号       |
| occurred_at    | string，合法 ISO 8601 时区时间 | 每次实际尝试生成 UTC 时间，默认 toISOString 形式；不让客户填写本机真实身份/时间样本 |

仅允许这十个字段，多发或少发均不符合当前服务。请求 UTF-8 JSON 最多 4096 字节。成功为 **HTTP 202，{"ok":true}**；400 参数错误、403 应用不匹配、404 路由不符、429 限频、500 写入失败都不能当作成功。

默认：北京时间自然日（Asia/Shanghai）每个应用每安装最多尝试一次，先原子占位再后台发送，失败不立即重试、不阻塞主业务；启动触发，不为跨天额外常驻轮询。超时 2,000ms，与当前统计 SDK 默认一致。服务端按可信接收时间划分北京时间日活，不能发送 active_date、source_ip、expires_at 等服务端字段。服务端保存安装标识，并从可信请求上下文记录来源 IP。服务端写入接收时间加 30 天的到期标记，技能没有配置自动删除，记录可能保留超过 30 天；确认单说明此隐私事实，不称完全无标识统计。

## 本地命令、实例与客户确认

命令在 [本地源码定位](local-source.md) 自动返回并再次核验的个人版源码根目录执行，Node.js >=20；客户项目仍单独作为接入目标。独立 Skill 包不含此工具，缺少源码时按定位规则处理，不让客户重复填写已有路径，不运行公司分支同名命令。

1. `npm run cloudbase:personal:client:init`：只创建私有 integration-input.json，输出真实路径。助手先补项目事实；客户只补缺项与运行时密钥。
2. 助手已补齐或客户告知填写完成后，`npm run cloudbase:personal:client:preview -- --file <实际输入文件绝对路径>`：完全离线解析，缺项返回固定 fields 列表；完整时生成本次 confirmation_id、脱敏预览和私有 request-examples 文件。

含真实密钥的 `request-examples-<confirmation_id>.json` 与输入在同一受限私有目录，包含全部实际 URL、headers 与 body，未发送。正文使用工具已脱敏的 requests 输出；不要再读取原始实例文件来“补全显示密钥”。给客户完整私有文件链接，可自行本地查看。文件不写入 Git、制品、共享日志或报告；不要将它交给通用 HTTP 客户端自动执行。

预览的 event_id/install_id 是临时合成 UUID，occurred_at 是生成时刻，必须在确认单标“请求结构预览值，未发送；实施时按运行规则生成”，不能持久化为客户真实安装身份。工具不伪造云端响应；更新只列响应合同，统计列预期成功体，均明确不是实测结果。

正文确认单至少包括：

- 本次范围、应用、每个平台/架构/通道与版本，以及第二门禁证据类别。
- 每个所选服务的完整请求实例、字段表、来源和缺项；无 query/body/鉴权时明确写无，不能省略得让客户猜。
- 私有输入路径、服务凭据来源文件路径（若使用）、含密钥实例路径；密钥只标已配置/缺少/本地绑定匹配/尚未云端测试，不显示原值、片段、长度、摘要或可还原编码。
- 上述默认行为、只读/未发送状态、真实测试待执行、拟接入位置及后续步骤。若目标协议不同或版本不兼容，明确阻断，不输出“已就绪”。
- confirmation_id 和客户需要确认的具体内容，然后等待明确回复。

通过条件：前置门禁通过、范围明确、所选参数无缺项/冲突、有可信部署合同依据、完整实例已展示且秘密仅私有文件保存、客户明确确认当前版本明细。工具的 awaiting-customer-confirmation 只表示材料生成，不表示客户已确认；绑定摘要仅存在私有实例中，后续实施前核对输入和所选凭据未变。

通过后交付状态为“参数与请求已确认，尚未编码/真实测试”，进入 [第四门禁](personal-client-implementation.md) 先展示并确认 UI，再核验项目架构和编码规范后按已有授权本地实施。客户确认本单不代替 UI 确认，不自动授权部署、发布、安装或真实统计；明确只读/暂不实施限制仍须保留。

## 源码依据

- `cloudbase/functions/application-version-api/src/handler.js`、`auth.js`、`validation.js`、`version.js`：更新路由、双请求头、版本格式和七字段响应。
- `cloudbase/functions/telemetry/src/handler.js`、`validation.js`：十字段、202 成功、无客户端密钥、服务器日活日期和到期时间标记。
- `cloudbase/personal/spec.mjs`：个人部署的路由、app/code 与独立 runtime 凭据绑定。
- `cloudbase/personal/client-confirmation.mjs`：离线字段校验、请求构造、脱敏输出、私有实例落盘；不包含业务集成或真实网络请求。
