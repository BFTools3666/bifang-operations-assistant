# 毕方运营精灵 AI 实施入口

本文件适用于整个仓库。Git 仓库是实施规范和可维护源码的权威来源；飞书中的文档与压缩包仅用于分享，不得反向覆盖仓库中更新的协议、脚本或 Skill。

## 开始前按顺序阅读

1. `README.md`：项目边界、统计口径、免费额度和最短验证入口。
2. `docs/毕方小工具公共服务分步接入指南.md`：面向小工具开发者的完整分阶段接入流程。
3. `docs/multi-tool-isolation.md`：APP_ID、函数、集合、路由和应用版本发布流的隔离规则。
4. `docs/telemetry-and-update.md`：统计/更新协议、客户端时序、隐私要求和验收标准。
5. 涉及应用版本 API 时，再读 `docs/application-version-api-zero-code-contract.md`、`contracts/application-version-api-v1/`、`cloudbase/functions/application-version-api/` 和 `cloudbase/plan-application-version-api-deployment.mjs`。
6. `examples/host-integration.ts`、`packages/telemetry-update-sdk`：协议的示例与公共 SDK 实现。
7. `cloudbase/apps.json`、`cloudbase/generate-cloudbaserc.mjs`：已登记应用与资源配置的机器权威源。
8. `bifang-onboarding.json`、`tools/bootstrap_bifang_onboarding.py`：规范仓库 URL 一句话接入的机器入口和授权边界。

需要给新手查看 CloudBase 控制台位置时，再读 `docs/cloudbase-quickstart.md`。它的真实截图位于 `docs/images/cloudbase/`，可分享 Word 版为 `docs/CloudBase免费额度内部署新手图文版.docx`，生成器为 `tools/build_cloudbase_guide_docx.py`，文档构建依赖锁定在 `tools/docx-requirements.txt`。

## 接入方式

- 接入必须由每个小工具在自己的项目中发起；规范一句话是 `https://gitlab.kuajingvs.com/qiuyang/bifang-operations-assistant.git 帮我接入`，也可显式调用 `$bifang-public-services-onboarding`。不要从本仓库扫描、发现或主动修改未知小工具。
- Skill 权威源码位于 `skills/bifang-public-services-onboarding/`，入口为 `skills/bifang-public-services-onboarding/SKILL.md`，Codex 展示与调用策略为 `skills/bifang-public-services-onboarding/agents/openai.yaml`。开始任何下游接入前完整阅读 Skill，并遵守一次只执行一个已获授权阶段的规则。
- 同一现有免费 CloudBase 环境可以承载多个工具。Telemetry 按 APP_ID 使用独立函数、路由、集合和本地状态；application-version 使用共享函数/路由，但每个工具必须使用独立发布流 code、凭据绑定和 versions/ads/audit 集合。
- `cloudbase/apps.json` 是登记状态的唯一权威；文档中的产品名和资源名仅是示例或时间点回执。
- 基础设施 3.0 不保留静态更新清单协议。修改运营精灵或未公开客户端时，保留 `daily_active` telemetry，删除旧静态更新实现、回退开关和双轨文档；不要重新引入兼容层。

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
- 运营看板规范见 `docs/operations-dashboard.md`。旧静态协议时期的看板回执和证据已从 3.0 工作树删除；完成 3.0 生产部署与真实 Edge E2E 后再创建新的日期回执。
- 每次交付说明实际修改、验证结果、提交哈希，以及明确未执行的部署、发布、购买、推送或删除操作。
