---
name: bifang-public-services-onboarding
description: Onboard the current small-tool repository to Bifang public services using the canonical GitHub URL or explicit invocation. Preserve daily-active telemetry, migrate client updates to the Bifang client update center, and keep deployment, installation, publishing, and deletion behind separate gates.
metadata:
  version: "2.1.1"
  infrastructure-version: "3.0.0"
  infrastructure-source-commit: "37f6dd120f082b8514a461bcfa30cee35b6259a6"
  application-version-contract-version: "1.0.0"
  application-version-baseline-commit: "92b0c599a42c3a094c99787e6928c30c2d2ea3af"
  source-repository: "bifang-operations-assistant"
  canonical-repository-url: "https://github.com/BFTools366/bifang-operations-assistant.git"
---

# 毕方公共服务接入向导

把当前小工具迁移到毕方基础设施 `3.0.0`：保留 `daily_active` 遥测，版本检查改为 `https://update.meetelf.com` 的客户端更新中心 POST 协议。已获授权时删除该客户端旧静态更新和旧 application-version 客户端实现，不建立双协议、回退开关或长期兼容层；不要据此删除在线服务或其他客户端的资源。

## 一句话入口

以下请求是本 Skill 的规范入口：

```text
https://github.com/BFTools366/bifang-operations-assistant.git 帮我接入
```

这句话明确授权在**当前客户端仓库**完成以下一个结果：获取并验证权威仓库、安装/更新本 Skill、只读扫描、创建或迁移非敏感 Profile、接入新更新中心并替换该客户端旧更新实现、运行本地静态和单元验证。它不授权 CloudBase 写入或删除、客户端打包/安装、真实 GUI E2E、发布、推送、购买或修改其他项目。

若用户显式调用 `$bifang-public-services-onboarding`，按用户指定阶段执行；若没有指定阶段，只做只读检查与方案。规范 URL 加“帮我接入”时，不要求用户再次输入 Skill 名称或逐阶段重复授权，但仍严格遵守上一段的本地范围。

阶段按顺序分别执行，每次只推进一个已获授权阶段；不得把本地授权扩展为运营仓库写入、服务部署或安装发布授权。

## 验证权威来源

先保存当前客户端根目录，再定位毕方运营精灵权威仓库。若本地没有可信副本，规范 URL 请求允许在客户端仓库之外的隔离临时目录执行只读 `git ls-remote` 和非嵌套 clone；不得把运营精灵变成客户端的子目录、submodule 或依赖源码副本。

权威仓库必须满足：

- `origin` 规范化后精确等于 frontmatter 中的 `canonical-repository-url`，URL 不含账号、Token、查询参数或片段；
- checkout 是 Git top-level，整个仓库相对 HEAD 没有 index、worktree 或未跟踪漂移；必需入口与 Skill 源文件均受版本控制、无符号链接/重解析点，也不含 `.pyc` 或 `__pycache__`；
- HEAD 精确等于 `git ls-remote --symref <canonical-url> HEAD` 实时返回的默认分支提交；
- 根 `bifang-onboarding.json`、`tools/bootstrap_bifang_onboarding.py` 和其中声明的 Skill/脚本都存在；
- HEAD 包含 manifest 的最低基础设施提交；frontmatter 的 `infrastructure-source-commit` 同时包含该最低提交、属于当前 HEAD 的祖先，且该提交的根 `package.json` 确实声明对应基础设施版本；
- manifest 的基础设施、Skill 和契约版本与本 frontmatter 一致。

在原客户端 cwd 中运行权威仓库的 bootstrap，并传入客户端绝对 Git 根。权威源码与目标客户端不能重叠；目标客户端可以是 `CODEX_HOME/worktrees/` 下的 Codex worktree，但不能与实际安装目录 `CODEX_HOME/skills/bifang-public-services-onboarding/` 重叠。bootstrap 先完成阶段 0 只读扫描，以分支、HEAD、index、porcelain 状态和扫描范围内容摘要证明客户端未变，再隔离外部 `quick_validate` 钩子安装 Skill，最后统一输出结果。安装完成后，本轮直接完整阅读已安装 `SKILL.md`，继续客户端迁移，不要求重开会话。

每次实施还要完整读取权威仓库中的：

- `README.md`
- `docs/毕方小工具公共服务分步接入指南.md`
- `docs/multi-tool-isolation.md`
- `docs/telemetry-and-update.md`
- `docs/client-update-center-migration.md`
- `references/client-update-center.md`
- `cloudbase/apps.json`、`cloudbase/generate-cloudbaserc.mjs`

涉及仍在线的历史 application-version 服务时，再读取其合同与 CloudBase 函数；不要将该服务的 GET 协议用于新客户端。

若权威仓库版本高于本 Skill，先用权威 installer 更新；installer 仅允许当前规范版本，或精确匹配允许列表中已发布 v1 / infrastructure 2.1、v2 树的旧 Skill 原子升级；任何修改过或来源不明的同名 Skill 都停止。若权威版本低于已安装版本，也停止写入并报告，不能套用混合版本。

## 当前客户端迁移流程

1. 核对目标项目根目录、Codex Task、Git 分支、HEAD 和工作区。保留用户已有改动；脏工作区可以迁移，但必须先区分现有修改与本轮修改，不能覆盖、清理、stash、reset 或切走。
2. 验证 `.bifang/public-services-profile.json`。Profile v1 只作为旧状态证据读取；不要原地猜测字段。规范一句话授权时，基于代码证据确定性写入 v2。`display_name` 必须是已确认的中文产品名，从当前发布产品配置、窗口标题或负责人说明取证；证据不一致或仅有英文包名时询问负责人，不从 APP_ID 自行翻译或拼接名字。冲突或无法确认的产品事实最多问 1–3 个短问题。
3. 运行 `scripts/scan_project.py <project-root>`。把 `daily_active` telemetry 与旧静态更新分开；扫描不完整时列出 `skipped_files`，不能声称旧协议已删除。
4. 从实际发布配置确认唯一 SemVer 来源、框架、平台、架构、主窗口 ready hook、安全外链和完整退出。`current_version` 是本次快照，`version_source` 指向真实发布/运行时来源，不把 Profile 当运行时版本配置。不得从 README 猜运行时事实。
5. 使用 `scripts/derive_resources.py --profile ...` 展示中文 `display_name`、APP_ID、telemetry 资源、新更新中心 POST 地址和每个实际目标。将名称映射连同资源清单交接给运营精灵任务；本地交接不表示已登记或已上线。旧 application-version 的 code 和集合是历史运营事实，不作为新服务的配置推导，也不由客户端接入删除。
6. 保留已经正确隔离的 `daily_active` 实现，并核对其请求必含真实应用 SemVer `app_version`。公共 SDK 由宿主的 `appVersion` 自动映射；其他框架按同一协议发送。从唯一版本来源取值，与版本检查的当前版本一致，禁止漏传、固定占位、误用 SDK 版本或另增版本上报接口。`sdk_version` 单独表示适配器版本。删除旧 `UPDATE_BASE_URL=/updates`、静态 manifest URL、14 字段解析、旧 rollout/manifest 决策、兼容开关和相关测试；不要删除通用 SemVer、安全 HTTPS 外链或完整退出能力。
7. 在可信宿主层实现 `POST https://update.meetelf.com/api/v1/apps/{app_id}/update-checks`，按 [新协议](references/client-update-center.md) 填真实版本、平台、安装形态、随机持久 UUID、触发方式和已实现能力；HTTP 201 才解析决定。只有 `enforcement=block_new_operations` 才阻止新业务，保留更新、重试和退出，不中断已有任务。
8. 使用服务端匹配的客户端专用 Bearer Token，管理凭据永不进入客户端。原值不进 Git、Profile、源码、命令行参数、普通日志或测试证据，只从运行时注入；共享 Token 可被提取，不能当作用户身份。缺少真实 Token 或后台应用策略时保持线上验证未完成，不伪造成功。
9. 本地测试覆盖请求字段和认证、201/错误处理、推荐与强更、断网策略、下载大小和 SHA-256、安装前重新检测与目标变化、失败重试和完整退出；不转发 Token 给文件服务。捕获实际 `daily_active` 请求并验证版本来源和同日去重，通过后记录 `telemetry_app_version_verified=true`。SDK 当前只提供检测和目标对照，不能把它当成完整下载/安装实现。不得在未授权时访问真实服务。
10. 再次运行 Profile 校验、资源派生、旧协议扫描和项目测试。只有扫描完整、`update_center_migration_gate=clear` 且人工确认生产代码、配置和活跃测试均没有旧静态或旧 application-version 更新客户端，才把 `legacy_update_status` 记为 `removed`。新服务的字符串命中只是线索，不能单凭扫描宣称接入完成。

## Profile 与发布流

档案固定为 `.bifang/public-services-profile.json`，Schema 位于 [references/public-services-profile.schema.json](references/public-services-profile.schema.json)。只保存非敏感事实；写后运行：

```text
python <skill-root>/scripts/validate_profile.py .bifang/public-services-profile.json --require-update-center
python <skill-root>/scripts/derive_resources.py --profile .bifang/public-services-profile.json
```

Windows 使用 `py -3 -X utf8 -B`。新接入 Profile v2 的 `update_transport` 固定为 `client-update-center-v1`，`update_center_base_url` 固定为 `https://update.meetelf.com`；`update_targets` 记录每个 `os + architecture + installation_type + channel`，以当前进程架构而非硬件架构为准。`x64` 映射为 `x86_64`，Linux 必须从真实发行版确认 `ubuntu` 或 `debian`。旧 v2 Profile 可作为历史输入读取，但新接入必须去掉旧协议配置并通过 `--require-update-center`。

Profile 只记录 `update_center_auth_status` 和已确认的 `offline_enforcement`，不记录 Token、凭据摘要或下载临时链接。`service-default` 遵循服务端强更缓存期限；`persist-until-resolved` 是产品明确要求的离线强更例外，不能未经确认套用到其他工具。

`display_name` 为 1–100 个 Unicode 字符，包含中文，无首尾空白、控制/格式字符和 `<`、`>`。草稿可以暂缺名称，但不能声称 Profile 完成，也不能生成缺名称的 Profile 交接清单。旧档案缺失名称或仍写英文 APP_ID 时，按产品证据补全后重新校验；不要改 APP_ID、发布流 code、集合或路由来实现中文展示。

阶段 2–4 的名称登记、覆盖检查与线上验收见 [references/cloudbase-gates.md](references/cloudbase-gates.md)。名称唯一展示来源是权威仓库的 `cloudbase/functions/operations-dashboard/src/app-labels.json`；每个工具自己的 APP_ID 和全部发布流共同使用同一中文名。普通版与 Plus 版仍保持独立身份，不合并发布流。

客户端版本、SDK 版本与发布记录的区别见 [references/integration-contract.md](references/integration-contract.md)。客户端 `app_version` 用于活跃版本画像；看板“发布流最高版本”来自旧运营端 `versions_*` 中的已发布 `code_version`。仅统计工具可不登记旧发布流，新更新中心的发布状态在更新后台查看；遥测和版本检查请求都不会创建发布记录。不允许为填表给客户端管理写权限或自动发布。即使升级了应用，当天已尝试过 `daily_active` 也不重置每日门禁，新版本在下一次正常的新日上报中出现。

## 框架和安全边界

实施客户端时读取 [references/integration-contract.md](references/integration-contract.md) 与 [references/framework-adapters.md](references/framework-adapters.md)。涉及云端或真实 E2E 时读取 [references/cloudbase-gates.md](references/cloudbase-gates.md)。

- Tauri/Rust：凭据和 HTTP 请求留在 Rust 可信层；WebView 只接收固定更新 DTO 和固定动作，不得提交任意 URL、路径或读取凭据。
- Node/Electron：可信主进程持有请求配置与凭据；renderer 只通过最小 IPC 接收决策。`@bifang/telemetry-update-sdk` 的 `ClientUpdateService` 只覆盖检测和目标对照，下载校验、强更缓存和安装由宿主完成。
- 其他原生程序：以更新中心的客户端 API 契约实现薄适配层；不得用旧服务的 OpenAPI 或凭参考摘要猜字段。
- 广告端点仅在产品已经明确包含广告展示能力或用户另行批准该产品功能时接入；没有广告 UI 的客户端不为“凑齐接口”新增广告产品能力。服务端广告与管理端点由运营精灵自己的契约/E2E 验收。

## 阶段与授权

阶段编号表示当前要交付的结果，不表示较小编号已经全部完成。校验器只检查当前阶段的硬门禁和显式依赖：阶段 5 可在没有云端写入、真实运行凭据或公网 E2E 时先完成本地替换；阶段 4/6/8 分别承担服务端、公网客户端和线上退役证据。Profile 用 `legacy_client_update_removed` 记录客户端旧实现已删，用 `legacy_cloud_resources_removed` 记录阶段 8 的线上资源退役，二者不得混用。

| 阶段 | 结果                                         | 规范一句话是否授权         |
| ---- | -------------------------------------------- | -------------------------- |
| 0    | 验证权威来源并只读扫描当前项目               | 是                         |
| 1    | 写入或迁移非敏感 Profile v2                  | 是                         |
| 2    | 在运营精灵登记 APP_ID、历史拓扑及中文名      | 否，须在运营精灵任务中执行 |
| 3    | 生成并审查 CloudBase 配置和只读计划          | 否                         |
| 4    | 部署/写入服务并完成公网 HTTP E2E             | 否，写入前再次确认         |
| 5    | 替换并删除当前客户端旧更新协议，运行本地验证 | 是                         |
| 6    | 构建、安装和真实客户端 GUI E2E               | 否，需明确要求             |
| 7    | 发布或推送                                   | 否，写入前再次确认         |
| 8    | 删除线上旧静态更新资源                       | 否，列出精确目标后再次确认 |

本 Skill 不从运营精灵仓库扫描或修改未知客户端；接入始终由目标客户端自己的 Task 发起。规范一句话不允许修改第二个客户端或运营精灵仓库。

## 完成标准

结束时分别报告：目标 Task/cwd/分支/HEAD、继承的用户改动、Profile v2、中文名及其证据、名称登记与线上显示的各自验证状态、版本来源与 `app_version` 的本地/真实客户端验证状态、发布流记录是否已发布、删除的旧更新实现、新 API 文件和请求形状、实际测试、未执行的构建/GUI/云端/发布/推送/删除。静态检查、单元测试、编译、HTTP E2E 与真实 GUI E2E 分开，不得互相冒充。

若没有真实云端服务、运行凭据或已安装制品，只能把相应状态标为 `Unverified`；不能用 mock 或 localhost 声称最终 E2E 完成。
