---
name: bifang-public-services-onboarding
description: Onboard the current small-tool repository to Bifang public services when the user provides the canonical bifang-operations-assistant GitLab URL and asks "帮我接入", or explicitly invokes $bifang-public-services-onboarding. Preserve daily-active telemetry, replace the unpublished legacy static-update protocol with application-version API v1, and keep cloud deployment, packaging, publishing, and cloud deletion behind separate gates.
metadata:
  version: "2.0.0"
  infrastructure-version: "3.0.0"
  infrastructure-source-commit: "92b0c599a42c3a094c99787e6928c30c2d2ea3af"
  application-version-contract-version: "1.0.0"
  application-version-baseline-commit: "92b0c599a42c3a094c99787e6928c30c2d2ea3af"
  source-repository: "bifang-operations-assistant"
  canonical-repository-url: "https://gitlab.kuajingvs.com/qiuyang/bifang-operations-assistant.git"
---

# 毕方公共服务接入向导

把当前小工具迁移到毕方基础设施 `3.0.0`：保留 `daily_active` 遥测，版本检查统一改为 application-version API v1，并删除尚未公开发布的静态 `/updates/<app_id>/<platform>.json` 客户端实现。不要建立双协议、回退开关或长期兼容层。

## 一句话入口

以下请求是本 Skill 的规范入口：

```text
https://gitlab.kuajingvs.com/qiuyang/bifang-operations-assistant.git 帮我接入
```

这句话明确授权在**当前客户端仓库**完成以下一个结果：获取并验证权威仓库、安装/更新本 Skill、只读扫描、创建或迁移非敏感 Profile、用 application-version API v1 替换并删除旧静态更新客户端、运行本地静态和单元验证。它不授权 CloudBase 写入或删除、客户端打包/安装、真实 GUI E2E、发布、推送、购买或修改其他项目。

若用户显式调用 `$bifang-public-services-onboarding`，按用户指定阶段执行；若没有指定阶段，只做只读检查与方案。规范 URL 加“帮我接入”时，不要求用户再次输入 Skill 名称或逐阶段重复授权，但仍严格遵守上一段的本地范围。

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
- `docs/application-version-api-zero-code-contract.md`
- `contracts/application-version-api-v1/README.md`、`openapi.json`、`schema.json`
- `cloudbase/apps.json`、`cloudbase/generate-cloudbaserc.mjs`
- `cloudbase/functions/application-version-api/` 下的受版本控制源码

若权威仓库版本高于本 Skill，先用权威 installer 更新；installer 仅允许当前规范版本或精确匹配权威仓库已发布树的 v1 / infrastructure 2.1 Skill 原子升级，任何修改过或来源不明的同名 Skill都停止。若权威版本低于已安装版本，也停止写入并报告，不能套用混合版本。

## 当前客户端迁移流程

1. 核对目标项目根目录、Codex Task、Git 分支、HEAD 和工作区。保留用户已有改动；脏工作区可以迁移，但必须先区分现有修改与本轮修改，不能覆盖、清理、stash、reset 或切走。
2. 验证 `.bifang/public-services-profile.json`。Profile v1 只作为旧状态证据读取；不要原地猜测字段。规范一句话授权时，基于代码证据确定性写入 v2；冲突或无法确认的产品事实最多问 1–3 个短问题。
3. 运行 `scripts/scan_project.py <project-root>`。把 `daily_active` telemetry 与旧静态更新分开；扫描不完整时列出 `skipped_files`，不能声称旧协议已删除。
4. 从实际发布配置确认唯一 SemVer 来源、框架、平台、架构、主窗口 ready hook、安全外链和完整退出。不得从 README 猜运行时事实。
5. 使用 `scripts/derive_resources.py --profile ...` 展示 APP_ID、telemetry 资源、application-version Base URL、各发布流 `code` 以及 `versions_*`、`ads_*`、`audit_*` 集合。
6. 保留已经正确隔离的 `daily_active` 实现。删除旧 `UPDATE_BASE_URL=/updates`、静态 manifest URL、14 字段解析、旧 rollout/manifest 决策、兼容开关和相关测试；不要删除通用 SemVer、安全 HTTPS 外链或完整退出能力。
7. 在可信宿主层实现唯一版本请求：`GET <base>/versions/{code}/{currentVersion}`，其中 `<base>` 精确以 `/tools/version-control/v1` 结束，`v1` 只出现一次。固定发送 `x-app-key`、`x-app-secret`，严格解析冻结的裸七字段 JSON 对象，并映射无更新、提示更新、强制更新和停止更新。
8. 客户端运行凭据只允许 `versions:check`，并且必须绑定准确 `app_id + code`；`ads:show` 只由运营精灵中不可导出的专用凭据做服务端契约测试。管理凭据永不进入客户端。原值不进 Git、Profile、源码、命令行参数、普通日志或测试证据，只从项目既有安全本地注入层读取。
9. 本地测试必须证明新单层 v1 URL、两个认证头、七字段严格解析、错误/超时安静失败、安全外链、强制更新完整退出、telemetry 无回归，以及运行时代码不再引用静态 `/updates`。不得在未授权时访问真实 CloudBase。
10. 再次运行 Profile 校验、资源派生、旧协议扫描和项目测试。只有扫描完整且生产代码、配置和活跃测试均没有旧静态协议，才把 `legacy_update_status` 记为 `removed`。

## Profile 与发布流

档案固定为 `.bifang/public-services-profile.json`，Schema 位于 [references/public-services-profile.schema.json](references/public-services-profile.schema.json)。只保存非敏感事实；写后运行：

```text
python <skill-root>/scripts/validate_profile.py .bifang/public-services-profile.json
python <skill-root>/scripts/derive_resources.py --profile .bifang/public-services-profile.json
```

Windows 使用 `py -3 -X utf8 -B`。Profile v2 的更新传输固定为 `application-version-api-v1`，契约版本固定 `1.0.0`，Base URL 固定单层 `/tools/version-control/v1`。每个 `(platform, architecture, channel)` 使用一个独立、全局唯一、长度不超过 50 的 `code`；请求没有平台字段，禁止靠 User-Agent 猜平台。

单平台产品可使用产品 APP_ID 作为稳定版 code，例如 `bifang-mouse-clicker`。多平台产品必须分流，例如：

- `bifang-screen-recorder-windows-x64`
- `bifang-screen-recorder-macos-arm64`

凭据档案只记录不敏感的 binding ID 与 `unknown | planned | ready | verified` 状态，不记录 Key、Secret 或摘要。

## 框架和安全边界

实施客户端时读取 [references/integration-contract.md](references/integration-contract.md) 与 [references/framework-adapters.md](references/framework-adapters.md)。涉及云端或真实 E2E 时读取 [references/cloudbase-gates.md](references/cloudbase-gates.md)。

- Tauri/Rust：凭据和 HTTP 请求留在 Rust 可信层；WebView 只接收固定更新 DTO 和固定动作，不得提交任意 URL、路径或读取凭据。
- Node/Electron：可信主进程持有请求配置与凭据；renderer 只通过最小 IPC 接收决策。`@bifang/telemetry-update-sdk` 必须使用基础设施 3.0 对应的 application-version API，不能带回旧静态 checker。
- 其他原生程序：以冻结 OpenAPI、Schema 和 fixtures 实现薄适配层；不得凭参考摘要猜字段。
- 广告端点仅在产品已经明确包含广告展示能力或用户另行批准该产品功能时接入；没有广告 UI 的客户端不为“凑齐接口”新增广告产品能力。服务端广告与管理端点由运营精灵自己的契约/E2E 验收。

## 阶段与授权

阶段编号表示当前要交付的结果，不表示较小编号已经全部完成。校验器只检查当前阶段的硬门禁和显式依赖：阶段 5 可在没有云端写入、真实运行凭据或公网 E2E 时先完成本地替换；阶段 4/6/8 分别承担服务端、公网客户端和线上退役证据。Profile 用 `legacy_client_update_removed` 记录客户端旧实现已删，用 `legacy_cloud_resources_removed` 记录阶段 8 的线上资源退役，二者不得混用。

| 阶段 | 结果                                         | 规范一句话是否授权         |
| ---- | -------------------------------------------- | -------------------------- |
| 0    | 验证权威来源并只读扫描当前项目               | 是                         |
| 1    | 写入或迁移非敏感 Profile v2                  | 是                         |
| 2    | 在运营精灵登记 APP_ID 与发布流 code          | 否，须在运营精灵任务中执行 |
| 3    | 生成并审查 CloudBase 配置和只读计划          | 否                         |
| 4    | 部署/写入服务并完成公网 HTTP E2E             | 否，写入前再次确认         |
| 5    | 替换并删除当前客户端旧更新协议，运行本地验证 | 是                         |
| 6    | 构建、安装和真实客户端 GUI E2E               | 否，需明确要求             |
| 7    | 发布或推送                                   | 否，写入前再次确认         |
| 8    | 删除线上旧静态更新资源                       | 否，列出精确目标后再次确认 |

本 Skill 不从运营精灵仓库扫描或修改未知客户端；接入始终由目标客户端自己的 Task 发起。规范一句话不允许修改第二个客户端或运营精灵仓库。

## 完成标准

结束时分别报告：目标 Task/cwd/分支/HEAD、继承的用户改动、Profile v2、删除的旧更新实现、新 API 文件和请求形状、实际测试、未执行的构建/GUI/云端/发布/推送/删除。静态检查、单元测试、编译、HTTP E2E 与真实 GUI E2E 分开，不得互相冒充。

若没有真实云端服务、运行凭据或已安装制品，只能把相应状态标为 `Unverified`；不能用 mock 或 localhost 声称最终 E2E 完成。
