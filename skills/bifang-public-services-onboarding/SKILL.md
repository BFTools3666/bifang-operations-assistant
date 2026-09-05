---
name: bifang-public-services-onboarding
description: Inspect a small-tool project and resume its staged onboarding to Bifang daily-active telemetry and update services. Use only when the user explicitly invokes $bifang-public-services-onboarding.
metadata:
  version: "1.0.0"
  infrastructure-version: "2.1.0"
  infrastructure-source-commit: "704da8d702c9991c80ba079910936c275349fabb"
  protocol-baseline-commit: "01f42449bf0f80a2660e7ee0899eef1176aca934"
  source-repository: "bifang-operations-assistant"
---

# 毕方公共服务接入向导

以只读检查开场，逐步恢复或完善当前小工具的接入档案，再生成项目专属方案。不要把方案、云端准备、客户端改造、构建安装、发布迁移和旧资源清理合并执行。

## 先确认权威来源

先定位 `毕方运营精灵` 权威源码仓库。当前目录若不是该仓库，先通过可用的项目/工作区信息查找；无法定位时，把“权威仓库位置”作为本轮唯一问题，不要猜测或联网克隆。

每次开始都完整阅读权威仓库中的：

- `README.md`
- `docs/multi-tool-isolation.md`
- `docs/telemetry-and-update.md`
- `examples/host-integration.ts`
- `packages/telemetry-update-sdk` 下的受版本控制文件
- `cloudbase/apps.json`
- `cloudbase/generate-cloudbaserc.mjs`

本 Skill 的目标基础设施版本是 `2.1.0`；`01f42449bf0f80a2660e7ee0899eef1176aca934` 只是既有 `2.0.0` 多工具协议的审查基线和本次升级起点，不是 `2.1.0` 的来源提交。记录实际读取的权威仓库提交；若版本或协议已漂移，优先使用刚读取的权威源码，先报告差异并把“更新/复核 Skill”列为门禁，不要套用过期规则。不要把大段权威文档复制进目标项目。

## 每次调用的流程

1. 确认目标项目根目录；读取并验证 `.bifang/public-services-profile.json`（若存在），恢复已确认字段与 `current_stage`。无效档案不得被静默覆盖。
2. 在写入前只读检查项目和 Git。使用文件、配置、构建脚本与代码证据，自动识别：
   - 框架、语言、正常启动入口；
   - 当前 SemVer 及唯一版本来源；
   - 应用配置目录策略；
   - 主窗口显示完成位置、外部链接方法、完整退出方法；
   - 支持的平台与架构；
   - 已有统计/更新功能、历史 `/v1/track`、现有 `APP_ID`；
   - Git 分支、HEAD 与工作区状态。
   - 历史链路先运行 `python <skill-root>/scripts/scan_project.py <project-root>`；结合 `app_id_candidates`、非法值冲突、带路径/行号的架构候选与人工代码审查，不能用宽泛关键字命中代替运行时判断。若 `scan_incomplete=true`，先展示 `skipped_files`，迁移和清理门禁保持阻塞，不能把局部“未发现”写成已确认。
3. 合并“有效档案 + 当前代码证据”，区分 `confirmed`、`detected`、`unknown`、`conflict`。检测到的值附文件/行号或命令证据；有冲突就展示冲突，不替用户决定。
4. 只询问无法可靠确认的内容。每轮最多 1–3 个短问题，不展示整张问卷，也不重复询问已确认且未冲突的字段。
5. 信息充分后，先运行确定性资源派生脚本并展示资源预览、版本建议、八阶段计划和未满足门禁；未获得所选阶段授权时停在方案。
6. 只有用户明确说“进入/执行阶段 N”后，才修改该阶段允许的范围。一次调用只执行一个阶段；不要顺带进入下一阶段。

## 分步提问顺序

按依赖关系从仍缺失的最前一组开始，每轮最多问三项：

1. 中文产品名、用途或英文功能关键词、负责人。
2. 计划平台/架构；据用途生成 `bifang-<product-key>` 建议值。
3. **先展示建议 APP_ID 及完整资源映射，再单独等待用户确认正式 APP_ID。** 正式 APP_ID 不可由 Codex 自行决定。
4. 复用的现有免费 CloudBase 环境、登记状态、独立函数/集合/路由/更新文件的部署状态。
5. 隐私说明位置、本次只生成方案还是明确进入哪个阶段。

从代码或权威仓库已能确认的内容不要再问。云端状态若只有本地目标配置证据，应标为“本地已配置、线上未验证”，不能问一句后伪装为线上验收。

## 接入档案与资源预览

需要写档案、校验字段或展示协议时，读 [references/integration-contract.md](references/integration-contract.md)。档案固定为 `.bifang/public-services-profile.json`，只保存已确认的非敏感信息。写入前展示变更；仅在用户明确选择阶段 1 且确认内容后写入，随后运行：

```text
python <skill-root>/scripts/validate_profile.py .bifang/public-services-profile.json
python <skill-root>/scripts/derive_resources.py --profile .bifang/public-services-profile.json
```

Node/Electron 在进入阶段 5 前还必须运行 `python <skill-root>/scripts/verify_sdk_distribution.py .bifang/public-services-profile.json`；只有真实本地制品哈希匹配，或私有包的不可变引用与负责人证据一致时，`sdk_distribution_ready` 才能为真。Windows 使用 `py -3 -X utf8 -B` 代替 `python`，确保中文路径和 JSON 输出不受系统代码页影响。脚本仅校验/派生/读取本地制品，不得联网或部署。资源预览至少包含中文产品名、APP_ID、函数、集合、统计路由、更新目录、各目标平台清单、版本提升建议与未满足门禁。

## 阶段路由

| 阶段 | 本次调用允许的范围                | 必读                                               |
| ---- | --------------------------------- | -------------------------------------------------- |
| 1    | 完善并验证目标项目接入档案        | `integration-contract.md`                          |
| 2    | 在运营精灵登记一个已确认 APP_ID   | `integration-contract.md`、`cloudbase-gates.md`    |
| 3    | 生成并审查本地 CloudBase 资源配置 | `cloudbase-gates.md`                               |
| 4    | 部署独立资源并完成线上 E2E        | `cloudbase-gates.md`                               |
| 5    | 在业务客户端实施接入              | `integration-contract.md`、`framework-adapters.md` |
| 6    | 构建、安装和真实客户端 E2E        | `framework-adapters.md`、`cloudbase-gates.md`      |
| 7    | 发布与迁移观察                    | `cloudbase-gates.md`                               |
| 8    | 经负责人确认后清理旧资源          | `cloudbase-gates.md`                               |

选择阶段不等于前置门禁已通过。若门禁不足，列出缺口并保持零部署/零发布/零删除；不要伪造完成状态。不要自动创建 Codex 任务或 Worktree，除非用户另外明确要求。

## 不可越过的边界

- 复用一个**现有免费** CloudBase 环境和平台默认 HTTPS 域名；每个应用独立 APP_ID、函数、路由、集合、更新文件和本地状态。它们仍共享免费额度与故障域，不是无限容量。
- 不创建第二个环境，不购买域名、证书、套餐、资源包，不开启按量超限、自动续费或超限扣费。若需求必须使用自定义域名，它已超出本轻量免费路径，保持阻塞并交回负责人决策；不要把它当作默认 HTTPS 的前置条件。出现任何非零金额或升级提示，立即停止并报告。
- 未经明确授权，不部署 CloudBase，不修改业务客户端，不构建安装，不发布/推送，不删除/下线旧资源。阶段 4、7、8 在真实外部变更前还要展示最终参数和最新预检结果，等待明确继续。
- 历史客户端仍在使用时保留旧路由、函数、集合、文件和历史数据；先新链路验收、再迁移观察、最后由负责人批准清理。
- 不读取或保存 SecretId、SecretKey、Token、Cookie、Authorization、数据库凭据、用户账号或硬件标识；输出中也不得回显这些值。
- 保留目标项目已有改动。脏工作区不是完成门禁；不要覆盖不属于本阶段的文件。

完成本轮时报告：已确认/仍未知信息、当前阶段、实际修改、验证证据、未满足门禁，以及明确未执行的部署、发布、购买、推送或删除操作。
