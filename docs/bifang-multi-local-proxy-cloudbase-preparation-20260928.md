# bifang-multi-local-proxy CloudBase 接入准备回执（2026-09-28）

## 当前状态

> 后续状态：收到第一次“继续”后，四个专属集合、telemetry 函数和路由已部署并通过公网幂等验收。写入期间 `bifang-browser-sync` 由并发任务上线并加入看板，因此本任务暂停看板更新；负责人随后明确批准保留该应用，10 应用看板接入现已完成。见[部署回执](bifang-multi-local-proxy-cloudbase-deployment-20260929.md)。以下保留部署前准备记录。

本次已按负责人确认的方案，在运营精灵仓库登记 `bifang-multi-local-proxy`，发布流为 Windows / x64 / stable，code 为 `bifang-multi-local-proxy-windows-x64`。云端范围是隔离的 `daily_active` telemetry、运营看板映射，以及三个保持为空的版本、广告和审计支撑集合；不启用共享版本 API，不生成凭据，不写版本或广告记录。

机器可读证据见[预检与部署计划](bifang-multi-local-proxy-cloudbase-preflight-20260928.json)。`cloudbase/apps.json` 仍是应用登记的唯一权威。

依据 `$bifang-public-services-onboarding` 的 CloudBase 写入门禁，本轮已停在最终预检之后；负责人明确回复“继续”前没有执行任何云端写入。

## 目标仓库核对

`https://github.com/BFTools366/bifang-multi-local-proxy` 可访问，但 `git ls-remote --symref ... HEAD` 没有返回 HEAD、分支或任何 ref，说明当前是空仓库。因此无法核对实际版本、框架、安装身份、旧协议或客户端埋点；本轮 Windows x64 stable 身份来自负责人已确认的方案，没有反向修改目标仓库。

## 待执行的精确云端目标

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，不创建第二个环境：

| 动作         | 精确目标                                               | 规则                                                                         |
| ------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 新建集合     | `telemetry_bifang_multi_local_proxy`                   | `ADMINONLY`；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0` |
| 新建函数     | `telemetry-bifang-multi-local-proxy`                   | Nodejs20.19 / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active`               |
| 新建路由     | `/apps/bifang-multi-local-proxy/v1/track`              | 绑定上述函数；安全域名和路径透传开启；QPS 100、单 IP 10                      |
| 新建空集合   | `versions_bifang_multi_local_proxy`                    | `ADMINONLY`；`idx_version_created`、`idx_version_sort`；不写版本记录         |
| 新建空集合   | `ads_bifang_multi_local_proxy`                         | `ADMINONLY`；`idx_ads_created`；不写广告记录                                 |
| 新建空集合   | `audit_bifang_multi_local_proxy`                       | `ADMINONLY`；`idx_audit_occurred_at`；不写审计记录                           |
| 原位更新看板 | `operations-dashboard-api`                             | 只注入 8 个线上既有应用和本工具的 9 应用映射；不上传原始 secret              |
| 保留看板路由 | `/dashboard`                                           | 线上已存在，不重建、不改 QPS                                                 |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新、不生成凭据、不启用客户端版本检查                                     |
| 保留其他资源 | 其他函数、路由、集合和 6 个托管对象                    | 不删除、不迁移、不全量部署                                                   |

执行后资源总数预计从 10 个函数、11 条路由、32 个集合变为 11 / 12 / 36；静态托管仍为 6 个对象。版本、广告和审计集合保持空。

## 最新只读预检

最终刷新时间：北京时间 **2026-09-28 18:30**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项   | 结果                                                               |
| -------- | ------------------------------------------------------------------ |
| 环境     | `baas_trial` 体验版，NORMAL，上海；到期 2027-03-17 23:59:59        |
| 费用开关 | 自动续费 false；超限扣费 false；扩展包为空；当前订单字段为空       |
| 积分     | 2026-09-17 至 2026-10-17；已用 8.22 / 3000；资源包及按量扣减均为 0 |
| 当前资源 | 10 个函数、11 条路由、32 个集合、6 个托管对象                      |
| 集合基线 | 32 个现有集合全部为 `ADMINONLY`；TTL 和业务索引契约无差异          |
| 目标冲突 | 本工具函数、路由和四个集合均不存在                                 |
| 默认域名 | 已启用且状态正常；既有 11 条路由均启用                             |

本次只读取环境、计费和资源元数据，没有读取业务记录正文。积分不是人民币金额；实际写入前还会再刷新计费与精确目标，出现付费、升级、超限、资源漂移或材料摘要变化时立即停止。

## 看板容量与并发隔离

完整对象形式的看板映射会超过 SCF 4096 字节环境变量上限。本次将内部映射升级为 compact schema v2，只传 APP_ID 和发布流四元组，由函数端重新派生集合名与平台并按原有严格规则校验。计划中的 9 应用映射为 1493 字节，完整部署环境变量合计 1793 字节，低于仓库 3840 字节安全门槛和平台 4096 字节上限。

工作区同时出现了另一项未上线的 `bifang-browser-sync` 登记及回执，它不是本任务创建的，已原样保留。当前云端没有其专属资源，本次看板计划显式过滤并排除该应用，不会夹带部署。看板部署材料摘要为 `5936f13224ae7e0a0a515dd77f865cd79f33fd40cb7c635aac42a72487b8b985`，32 个文件、28,911,577 字节；删除列表为空。

## 写入后验收与回滚边界

收到“继续”后，只执行上述精确目标，并立即读回函数、路由、ACL、索引和看板映射。随后对新 telemetry 地址提交同一条合成 `daily_active` 两次，必须只保留一条幂等记录；不会向 versions、ads 或 audit 写测试数据。

若新函数或看板验收失败，将停止后续步骤并优先恢复看板上一版函数代码与映射。新增集合默认保留，不会自动删除；任何删除或下线都必须另列精确目标并再次获得明确批准。

## 修改与专项验证

已完成本地应用登记、生成配置和契约测试，并加入看板 compact schema v2 的生成、过滤、解析与失败关闭测试。工作区既有和并发改动均未清理或覆盖。

已执行并通过：

- `npm.cmd run cloudbase:config:check`
- 受影响根测试：24/24 通过
- `@bifang/cloudbase-operations-dashboard`：26/26 通过
- 本轮涉及文件的 Prettier 检查
- 类型检查与构建

全仓 `npm.cmd run check` 在 80 个本轮前已存在的格式问题处停止。完整测试曾因系统默认 Python 是 Windows 商店占位程序失败，改用 Codex 随附 Python 后恢复通过；按负责人要求已中止完整测试，未将其作为本次验收依据。

运营精灵基线提交为 `a08a77fcef2c5709d1980a9d6acdedb2c47a0734`，本次未创建新提交。

**未执行：CloudBase 部署或写入、客户端修改/构建/安装、共享版本 API 更新、凭据生成、版本或广告记录写入、购买、Git 推送、云资源删除。**
