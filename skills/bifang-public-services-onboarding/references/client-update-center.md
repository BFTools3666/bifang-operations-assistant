# 客户端更新中心接入合同

本文定义 Skill 如何核对和接入 Updater，不提供业务接入代码。CloudBase 日活、授权中心 OAuth/配置合同与默认值见 [接入契约与 Profile](integration-contract.md)。仅整理规范时不得顺带修改业务客户端或发起真实授权。

执行 Updater 接入前必须通过 [接入范围第一门禁](../SKILL.md#第一门禁确认接入范围)，且明确选择更新或两项；仅统计任务跳过本文的配置、迁移、下载安装与验收。本文的“保留日活”只保护已有能力，不授权仅更新任务新增或迁移统计。

## 权威来源与适用范围

实施前完成 [第二门禁的仅更新或联合分支](integration-contract.md#第二门禁授权中心授权与配置获取)：设备授权后确认 token 响应实际包含 `updater:config:read`，再 GET /updater/{project_id}/config，取得顶层 Endpoint 和 ClientToken，不由客户手填。仅更新只申请该 scope；联合接入另需实际获授 `cloudbase:config:read`。缺权按统一合同重新授权，不能靠刷新补权限。OAuth access_token 仅查配置，ClientToken 用于下游检查；快照期限不是任何一类令牌的有效期。

取得并验证配置后，还须通过 [第三门禁](integration-contract.md#第三门禁客户端接入方案与请求明细确认)：自动核验当前项目的具体 Rust 接入位置、字段来源、默认行为、变更范围和验收计划，才在原授权内实施。只核验所选服务；技术项齐备后须在回复正文展示 [完整接入确认单](integration-contract.md#客户接入确认单回复正文必填)，逐项列真实完整 URL、方法、请求头和参数、实际非敏感值/生成规则、默认依据及待补，再等待客户明确确认，不能只给记录链接。客户不用手填参数；凭据不回显。范围选择及浏览器批准不代替该确认，未确认不实施；“仅确认方案”不授权写业务代码，“确认并进入第四门禁”只有本次所选范围第三门禁整体通过后才能进入第四门禁。方案就绪不代替本地实现或真实验收，也不改变本文原有阶段授权。

第三门禁经客户明确确认后，在原授权内按 [第四门禁](integration-contract.md#第四门禁客户端本地实施与验收) 先按 [UI 方案与位置确认](integration-contract.md#先展示并确认-ui再编码) 读取当前项目风格，展示更新提示、强更和入口预览及触发/显示位置，等待客户明确确认适用 UI 后才编码；第三门禁确认不能替代 UI 确认。仅统计无可见变更时记不适用；都接入等待 UI 确认期间也不先写统计代码。编码前先执行 [项目架构与规范核验](integration-contract.md#编码前学习当前项目架构与编码规范)，读取目标项目适用指令、真实调用链及同类实现，复用现有设施并按原目录/依赖/编码规则实现，不新增客户审批。随后完成所选服务的本地实施和宿主验收，自动修复本轮失败；不重复询问自动可完成项。用假凭据、注入 transport 和临时状态验证，真实服务/GUI/安装及云端写入仍需对应授权。单项与联合分开记录，只能标本地通过，不能冒充真实接入完成。本地通过后必须按 [线上配置与 EXE 测试](integration-contract.md#本地通过后更新中心配置与-exe-真实测试) 提示客户手动配置更新服务；客户告知完成后先做客户端更新接口简单预检，通过且 EXE 测试授权明确后才构建/运行真实 EXE，不代操作或审核后台。仅统计跳过更新中心及更新预检。

核对日期为 2026-11-16；更新中心远端 main 核对提交为 `27df2008c0f720eb7093443bfc1e09d0cb6f3981`。[权威 OpenAPI](https://github.com/BFTools3666/bifang-client-update-center/blob/27df2008c0f720eb7093443bfc1e09d0cb6f3981/docs/api/bifang-client-update-center.openapi.json) 的 `info.version=1.4.1`，路径仍为 `/api/v1`，Skill transport 为 `client-update-center-v1`，三者不是同一版本号。[客户端流程](https://github.com/BFTools3666/bifang-client-update-center/blob/27df2008c0f720eb7093443bfc1e09d0cb6f3981/docs/api/client-integration.md) 与 [协议说明](https://github.com/BFTools3666/bifang-client-update-center/blob/27df2008c0f720eb7093443bfc1e09d0cb6f3981/docs/api/client-updates.md) 补充时序；文字摘要与机器合同冲突时核对同提交服务端校验，不照抄旧架构列表。

实施时记录实际合同版本、提交和部署验证状态；上述来源证明已核对源码，不证明生产部署版本相同。当前 Profile 允许的生产 origin 为 `https://update.meetelf.com`；负责人明确要求本机测试时可用 `http://127.0.0.1:8080/`，仅用测试 Token。地址取授权中心 Endpoint 并按下游合同核验，不能因接口返回任意地址就扩宽允许列表。生产只用 HTTPS；loopback 不能完成生产 E2E/发布门禁。

本协议不同于旧 application-version GET、静态清单和 Tauri updater。保留独立 CloudBase `daily_active`；客户端迁移不授权删除旧云资源。

## 创建检测：路径、请求头与身份

`POST {已确认的服务 origin}/api/v1/apps/{app_id}/update-checks`

| 位置   | 名称              | 必填 | 合同                                                                       |
| ------ | ----------------- | ---- | -------------------------------------------------------------------------- |
| path   | `app_id`          | 是   | string，3～64 字符，`^[a-z][a-z0-9-]{2,63}$`；与应用登记一致，不放入请求体 |
| header | `Content-Type`    | 是   | `application/json`                                                         |
| header | `Authorization`   | 是   | 一个 `Bearer <客户端 Token>`，不得使用管理员 Token                         |
| header | `Accept`          | 建议 | `application/json, application/problem+json`                               |
| header | `Idempotency-Key` | 否   | 1～128 个 ASCII 可打印字符，`^[\x20-\x7E]+$`                               |
| query  | 无                | —    | 不添加未经定义的参数                                                       |

服务端共享客户端 Token 为 32～128 字节、无空白，来自授权中心顶层 ClientToken；原文保留，不 trim。配置 API 的字段允许更长值，不代表下游接受，超限交运维修正。ClientToken 不是用户身份，没有此处定义的 JWT、到期或刷新 API；授权中心 OAuth 刷新仅更新 access_token/refresh_token，不刷新 ClientToken。值不进前端、Git、Profile、源码、命令行、日志或截图。下游缺失/错误凭据返回 401，未配置检查凭据返回 503。

同次重试使用相同幂等键和相同请求内容；新检测尤其 pre_install 使用新键或不带键。幂等记录保留 24 小时，重放返回原状态码和快照，不重新计算或延长时间；同键不同内容返回 `409 IDEMPOTENCY_KEY_REUSED`。

## 创建检测：完整请求体

UTF-8 JSON 对象，最多 16384 字节，9 个必填字段、1 个可选字段，均不接受 null。禁止额外属性，未知字段返回 422；非法 JSON、重复键、多根对象、非法 UTF-8、超过 32 层嵌套按 400 处理。

| 字段                | 类型            | 必填 | 约束与来源                                                                                |
| ------------------- | --------------- | ---- | ----------------------------------------------------------------------------------------- |
| `current_version`   | string          | 是   | 当前实际运行版本，严格 SemVer 2，不带 v；不是已下载未运行的版本                           |
| `channel`           | string          | 是   | `stable`、`beta`，实际发布通道                                                            |
| `os`                | string          | 是   | `windows`、`macos`、`ubuntu`、`debian`                                                    |
| `os_version`        | string          | 是   | 2～4 段数字，无多余前导零；精确正则见下方系统版本格式                                     |
| `architecture`      | string          | 是   | `x86`、`x86_64`、`arm64`；仅 Windows 支持 x86                                             |
| `installation_type` | string          | 是   | `installed`、`portable`，禁止自动互换                                                     |
| `installation_id`   | string          | 是   | 持久匿名 UUID；合同不限定 v4，联合接入统一生成 v4；不由硬件、账号或 IP 派生               |
| `trigger`           | string          | 是   | `startup`、`scheduled`、`manual`、`pre_install`；手动不绕过灰度                           |
| `capabilities`      | array of string | 是   | 元素为 `download`、`auto_install`，唯一；schema 最多 8 项，当前只有两个枚举值；允许空数组 |
| `locale`            | string          | 否   | 合法 BCP 47；服务端要求非空、最多 35 字节、无下划线并规范化；缺省省略                     |

系统版本格式（同时适用于制品的 minimum_os_version / maximum_os_version）：

```regex
^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){1,3}$
```

Updater 的 SemVer schema 未声明 64 字符上限；CloudBase app_version 有该限制，同一版本来源须同时满足两边，不能截断。系统版本逐段按整数比较，缺段补零。语言按完整标签、基础语言、应用默认语言回退。

architecture 来自当前程序二进制，ARM 电脑运行 x86_64 程序仍填 x86_64。Linux 必须确认发行版，不发送 linux，不把不支持的发行版伪装成 Ubuntu。完整映射：

| 实际目标       | telemetry platform / arch | Updater os / architecture |
| -------------- | ------------------------- | ------------------------- |
| Windows x86    | `windows` / `ia32`        | `windows` / `x86`         |
| Windows x86_64 | `windows` / `x64`         | `windows` / `x86_64`      |
| Windows ARM64  | `windows` / `arm64`       | `windows` / `arm64`       |
| macOS x86_64   | `macos` / `x64`           | `macos` / `x86_64`        |
| macOS ARM64    | `macos` / `arm64`         | `macos` / `arm64`         |
| Ubuntu x86_64  | `linux` / `x64`           | `ubuntu` / `x86_64`       |
| Ubuntu ARM64   | `linux` / `arm64`         | `ubuntu` / `arm64`        |
| Debian x86_64  | `linux` / `x64`           | `debian` / `x86_64`       |
| Debian ARM64   | `linux` / `arm64`         | `debian` / `arm64`        |

声明 download 须具备完整下载、实际大小及 SHA-256 校验；auto_install 必须同时包含 download，且具有对应平台、包格式的本地安装适配器。空数组只支持人工升级页。不能因为用了参考 SDK 就声明不存在的能力。

## 检测成功：完整响应

创建成功固定 **HTTP 201**，包括 no_update；裸资源无 data 包装。响应有 Location、X-Request-ID、Cache-Control: no-store。下列 16 字段全部必须出现；可空不等于可省略。日期时间为 RFC3339。

| 字段                         | 类型          | 可空 | 约束                                                                          |
| ---------------------------- | ------------- | ---- | ----------------------------------------------------------------------------- |
| `id`                         | string        | 否   | 1～64 字符，`^[A-Za-z0-9_-]+$`                                                |
| `app_id`                     | string        | 否   | 当前应用，符合路径标识规则                                                    |
| `server_time`                | datetime      | 否   | 本次检测服务端时间                                                            |
| `expires_at`                 | datetime      | 否   | server_time + 600 秒；快照期限，不是 Token 期限                               |
| `policy_revision`            | integer       | 是   | 非空 1～9007199254740991                                                      |
| `decision`                   | enum          | 否   | no_update、update_available、update_unavailable                               |
| `reason`                     | enum          | 否   | 下表 14 个值                                                                  |
| `required`                   | boolean       | 否   | 策略是否要求更新，不单独决定阻断                                              |
| `enforcement`                | enum          | 否   | none、block_new_operations                                                    |
| `action`                     | enum          | 否   | none、auto_install、download_and_install、open_download_page                  |
| `minimum_supported_version`  | SemVer string | 是   | 最低支持版本，不高于目标；低于该版本立即强更，绕过灰度且不受 force_after 影响 |
| `force_after`                | datetime      | 是   | 强更生效时间；required 且 null 表示立即强更，recommended 时为 null            |
| `next_check_after_seconds`   | integer       | 否   | 60～86400；普通默认 21600，required 默认 3600，临近期限可缩短                 |
| `mandatory_cache_expires_at` | datetime      | 是   | 可执行强更时 server_time + 86400 秒；仅约束阻断，不延长下载资格               |
| `release`                    | object        | 是   | 下述版本对象                                                                  |
| `artifact`                   | object        | 是   | 下述安装包对象                                                                |

| decision           | reason 完整枚举                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| no_update          | policy_not_configured、policy_disabled、already_current、client_ahead、rollout_not_matched                        |
| update_available   | recommended、scheduled_force_pending、below_minimum_supported_version、required_by_policy、force_deadline_reached |
| update_unavailable | os_not_supported、artifact_not_available、manual_upgrade_required、client_capability_insufficient                 |

### release 与更新说明

非空 release 的五个直接字段及下述嵌套字段全部必填、不可空。

| 字段                     | 类型     | 约束                                          |
| ------------------------ | -------- | --------------------------------------------- |
| `id`                     | string   | 1～64 字符，`^[A-Za-z0-9_-]+$`                |
| `version`                | string   | 严格 SemVer                                   |
| `channel`                | string   | stable、beta；stable 发布版本不含预发布标识   |
| `published_at`           | datetime | 首次公开时间                                  |
| `notes`                  | object   | locale、title、items                          |
| `notes.locale`           | string   | BCP 47                                        |
| `notes.title`            | string   | 1～100 个 Unicode 字符                        |
| `notes.items`            | array    | 1～100 项                                     |
| `notes.items[].category` | string   | feature、improvement、fix、security、breaking |
| `notes.items[].text`     | string   | 1～1000 个 Unicode 字符，只按纯文本渲染       |

### artifact

非空 artifact 的 11 个字段全部必须出现。

| 字段                         | 类型          | 可空 | 约束                                           |
| ---------------------------- | ------------- | ---- | ---------------------------------------------- |
| `id`                         | string        | 否   | 1～64 字符，`^[A-Za-z0-9_-]+$`                 |
| `package_format`             | enum          | 否   | exe、msi、zip、dmg、pkg、tar_gz、appimage、deb |
| `file_name`                  | string        | 否   | 1～200 字符；无目录分隔符、控制字符、路径穿越  |
| `size_bytes`                 | integer       | 否   | 1～2147483648 字节，最多 2 GiB                 |
| `sha256`                     | string        | 否   | 64 位小写十六进制，`^[a-f0-9]{64}$`            |
| `download_url`               | HTTPS URI     | 是   | 当前检测的下载资格入口，不是永久文件地址       |
| `manual_download_page_url`   | HTTPS URI     | 是   | 人工升级页                                     |
| `minimum_os_version`         | string        | 是   | 与请求系统版本相同格式，包含边界               |
| `maximum_os_version`         | string        | 是   | 同上；不得低于最小值                           |
| `minimum_upgradable_version` | SemVer string | 是   | 直接覆盖升级下限，不得高于所属版本             |
| `auto_install_supported`     | boolean       | 否   | 发布方声明支持客户端预置安装适配器             |

| 系统           | installed 包格式 | portable 包格式 |
| -------------- | ---------------- | --------------- |
| Windows        | exe、msi         | zip             |
| macOS          | dmg、pkg、tar_gz | zip、tar_gz     |
| Ubuntu、Debian | deb、appimage    | tar_gz、zip     |

当前合同没有 signature 字段；平台签名按产品要求另行执行。下载入口与人工页可以同时非空，action 是建议动作，可按实际有效链接展示选择；自动安装仍须同时满足客户端能力、包声明与本地适配器。

### 字段组合校验

- no_update：required=false、action=none、enforcement=none，release、artifact、mandatory_cache_expires_at 均为 null。
- update_available：release/artifact 非空，action 非 none。required=false 时 reason 只能为 recommended/scheduled_force_pending，enforcement=none，强更缓存截止为空；required=true 时 reason 只能为 below_minimum_supported_version/required_by_policy/force_deadline_reached，enforcement=block_new_operations，强更缓存截止非空。
- update_unavailable：release 非空，artifact 可空，action=none、enforcement=none、强更缓存截止为空；即使 required=true 也不能新增阻断。
- 响应新增非关键展示字段可忽略；未知 decision/action/enforcement 不执行安装、不新增阻断。请求禁止额外字段不能套到响应扩展上。
- 文本/category 不触发强更；不得用旧 forcedUpdate、promptContent、updateContent、latest_version、rollout、code 替代现行字段。

## 错误与重试

错误为 application/problem+json。八个必填字段：type（URI string）、title（string）、status（400～599 integer，等于 HTTP 状态）、detail（string）、instance（URI-reference string）、code（string）、request_id（string，与 X-Request-ID 一致）、errors（array）。每项字段错误必含 string pointer、code、message；非字段错误 errors 为空数组。

| 状态 | 处理                                                                  |
| ---- | --------------------------------------------------------------------- |
| 400  | MALFORMED_JSON 等请求错误，修正请求                                   |
| 401  | UNAUTHORIZED；是否重取配置按配置接口合同，不能假定刷新 API            |
| 404  | 应用/资源不存在，核对登记及地址                                       |
| 409  | IDEMPOTENCY_KEY_REUSED 修正键复用；REQUEST_IN_PROGRESS 按服务提示等待 |
| 413  | PAYLOAD_TOO_LARGE，修正大小                                           |
| 415  | UNSUPPORTED_MEDIA_TYPE，修正媒体类型                                  |
| 422  | VALIDATION_FAILED，按字段错误修正                                     |
| 429  | RATE_LIMITED，遵守 Retry-After                                        |
| 503  | SERVICE_UNAVAILABLE 或 APP_DISABLED，报告实际错误，临时故障退避       |
| 500  | INTERNAL_ERROR，不能伪装为无更新                                      |

Retry-After 为十进制秒数字符串。临时故障采用有上限指数退避和随机抖动，不无限重试；同实例避免并发检查/下载。HTTP 错误、超时、非法响应均不能显示“已经是最新版”。

## 下载、复检与安装

1. 使用 artifact.download_url；服务路径 `/api/v1/apps/{app_id}/artifacts/{artifact_id}/download` 仅接受一个合法 check_id 查询参数，不构造/长期缓存旧链接。
2. 下载入口及外部重定向不携带检查用 Bearer。入口返回 302 Location，生产每跳 HTTPS；本机测试仅允许精确同源 loopback 入口且不得使用生产 Token。
3. 流式写应用私有临时文件，验证最终响应、实际字节数与 SHA-256，失败不得执行。409 CHECK_STALE 或 410 CHECK_EXPIRED 必须重新 POST。
4. 安装前以实际当前版本、trigger=pre_install、新幂等键或不带键创建新检测；确认仍允许安装，app_id、目标版本、包 ID、大小、摘要、action 匹配。
5. 复检通过才调用固定本地安装适配器，不执行远端任意命令。以重启后实际运行版本确认成功。

GET `/api/v1/apps/{app_id}/update-checks/{check_id}` 无请求体、无需客户端 Token，成功 200；只读原快照，不计算新策略、不延长期限。过期 410，不存在/清理后 404；按创建时间保留最多 24 小时，不能替代 pre_install POST。

## 强更、时钟与离线

只对有效 block_new_operations 阻止新业务，保留更新、重试、退出，不终止已有任务；有效新决定解除限制后恢复。scheduled_force_pending 到 force_after 时重检，自动检查遵守 next_check_after_seconds；结合服务端时间与单调时钟判断期限。

Profile 的 offline_enforcement=service-default：首次离线、无有效快照不新增阻断；已有可执行快照约束最多到原 server_time 后 24 小时，过期解除更新模块限制，不能通过重启、GET、幂等重放或下载延期。未来强更快照的 mandatory_cache_expires_at 当前为 null；到期重检失败时，只有完整可执行原快照可形成临时约束，最终截止仍为原 server_time+86400，不从 force_after 重新计时。无法可靠恢复时钟基准先重检，失败不新增阻断。

persist-until-resolved 是现有 Profile 支持的产品特定例外，只在负责人明确要求并记录后采用，不是服务默认合同。测试初次离线、凭据缺失、时间基准失效、存储损坏、策略撤销及重启恢复。

## 可选接口

不属于基础接入必选项，不为凑接口增加产品能力；启用前读取同提交 OpenAPI 的完整响应 schema。

| 接口                                              | 参数与结果                                                                                                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET `/api/v1/apps/{app_id}/releases`              | 无客户端 Bearer；query：channel 必填 stable/beta，locale 可选，after_version 可选 SemVer 排他下界，through_version 可选 SemVer 包含上界，limit 可选 1～100 默认 20，cursor 可选；200 PublicReleaseList |
| GET `/api/v1/apps/{app_id}/releases/{release_id}` | 无客户端 Bearer；locale 可选；200 PublicRelease                                                                                                                                                        |
| POST `/api/v1/apps/{app_id}/update-event-batches` | 无客户端 Bearer；Content-Type application/json；Idempotency-Key 必填，1～128 ASCII 可打印字符；最多 65536 字节；202 EventBatchReceipt                                                                  |

事件请求严格包含 installation_id（UUID）与 events（1～50 项），不允许额外属性。每项七字段全部必须出现：

| 字段        | 类型/约束                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id          | 随机至少 128 bit，1～64 字符，`^[A-Za-z0-9_-]+$`                                                                                                                               |
| check_id    | 同上资源 ID 格式，对应检测                                                                                                                                                     |
| release_id  | 同上资源 ID 格式，对应版本                                                                                                                                                     |
| artifact_id | 同上资源 ID 格式或 null                                                                                                                                                        |
| type        | prompt_shown、update_deferred、version_skipped、download_started、download_completed、download_failed、verification_failed、install_started、install_succeeded、install_failed |
| occurred_at | RFC3339 datetime                                                                                                                                                               |
| error_code  | 三个失败类型必须非空 string，其他类型 null                                                                                                                                     |

202 回执必含 id、accepted_count、duplicate_count、received_at；两计数各 0～50，合计等于提交项数。事件 ID 去重 30 天，冲突批次 409 且原子拒绝；客户端待发事件最多保留 7 天。新版本实际启动才上报 install_succeeded。队列规则不适用于 daily_active，日活仍失败当天不重试。

## 验收与现有参考实现差异

按 [统一接入流程与验收](integration-contract.md#接入流程与验收证据) 分别记录本地、生产 HTTP、实际制品、原生 GUI 和安装证据。DNS、TLS、应用、策略、Token、部署版本未核实保持 Unverified。构建安装、部署、发布、推送、线上删除遵守独立授权。

规范更新不表示 packages/telemetry-update-sdk/src/client-update.ts 业务实现已经对齐。旧 TypeScript SDK/宿主示例不是 1.4.1 完整合同，已知差异须在实现任务单独处理并验证后更新本表：

| 旧参考实现                                            | 当前规范                                          |
| ----------------------------------------------------- | ------------------------------------------------- |
| 请求架构仅 x86_64/arm64                               | Windows 还支持 x86                                |
| os_version 允许前导零、locale 仅检查字符串            | 严格系统版本正则；BCP 47、35 字节、非空、无下划线 |
| 缺可选 Idempotency-Key 入口                           | 同次重试与新检测区分键生命周期                    |
| 顶层类型缺 policy_revision、minimum_supported_version | 16 字段完整响应                                   |
| release 缺 channel、published_at                      | 五个直接字段                                      |
| artifact 仅五字段                                     | 11 字段及兼容矩阵                                 |
| ID 允许 200 字符、摘要允许大写、间隔仅非负            | ID 1～64 且限制字符；摘要小写；间隔 60～86400     |
| 仅部分组合与长度校验                                  | 全部必填、可空、枚举、范围、组合约束              |
| 只实现检测与目标对照                                  | 不证明下载、安装、身份、离线缓存或 UI 已实现      |

不能为适配旧 SDK 降低规范，也不能用分发校验通过证明服务合同完整一致。
