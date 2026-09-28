# 毕方局域网文件传输 CloudBase 接入准备回执（2026-09-28）

## 当前状态

> 后续状态：负责人先后明确批准 LAN 部署及 VM 两个空支撑集合。LAN 专属函数、路由和四个集合已完成公网 HTTP 验收；六应用共享看板映射也已更新并通过真实登录、管理 API 和全应用查询验证。见[部署回执](bifang-lan-file-transfer-cloudbase-deployment-20260928.md)。以下保留部署前准备记录。

本次按现有项目的最近接入规则，将 `bifang-lan-file-transfer` 登记为独立 APP_ID，并按目标仓库当前支持的平台预留四条 `stable` 发布流。云端准备范围为每日活跃 telemetry、四个隔离集合，以及后续运营看板映射；版本检查、版本记录和新凭据均不在本轮启用范围内。

机器可读证据见 [预检与部署计划](bifang-lan-file-transfer-cloudbase-preflight-20260928.json)。`cloudbase/apps.json` 仍是应用登记的唯一权威。

## 目标仓库核对

| 项目            | 结果                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------- |
| 仓库            | `https://github.com/BFTools366/bifang-lan-file-transfer`                                     |
| 默认分支 / 提交 | `master` / `ca476f33b8967fe89ce3ad181ee2f125b2bde5f3`；只读分析 checkout 干净                |
| 当前版本        | `0.1.0`，以根 `Cargo.toml` 的 workspace version 为准                                         |
| 技术栈          | Tauri GUI / Rust                                                                             |
| 目标平台        | Windows x64、macOS x64、macOS arm64、Linux x64                                               |
| 既有毕方接入    | 未发现 APP_ID、daily_active、毕方版本 API 或旧静态更新协议                                   |
| 产品规格边界    | 当前规格明确排除云服务、自动更新和 telemetry；本轮只准备运营精灵侧云资源，不反向修改目标仓库 |

登记的发布流：

| 平台    | 架构  | 渠道   | code                                   |
| ------- | ----- | ------ | -------------------------------------- |
| Windows | x64   | stable | `bifang-lan-file-transfer-windows-x64` |
| macOS   | x64   | stable | `bifang-lan-file-transfer-macos-x64`   |
| macOS   | arm64 | stable | `bifang-lan-file-transfer-macos-arm64` |
| Linux   | x64   | stable | `bifang-lan-file-transfer-linux-x64`   |

## 待确认的精确云端目标

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，不创建第二个环境：

| 动作         | 精确目标                                               | 规则                                                                       |
| ------------ | ------------------------------------------------------ | -------------------------------------------------------------------------- |
| 新建集合     | `telemetry_bifang_lan_file_transfer`                   | ADMINONLY；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0` |
| 新建函数     | `telemetry-bifang-lan-file-transfer`                   | Nodejs20.19 / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active`             |
| 新建路由     | `/apps/bifang-lan-file-transfer/v1/track`              | 绑定上述函数；安全域名和路径透传开启；QPS 100、单 IP 10                    |
| 新建空集合   | `versions_bifang_lan_file_transfer`                    | ADMINONLY；标准版本查询索引；不写版本记录                                  |
| 新建空集合   | `ads_bifang_lan_file_transfer`                         | ADMINONLY；标准广告查询索引；不写广告记录                                  |
| 新建空集合   | `audit_bifang_lan_file_transfer`                       | ADMINONLY；标准审计索引；不写审计记录                                      |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新函数、不生成凭据、不启用客户端版本检查                               |
| 保留其他资源 | 所有既有函数、路由、集合、托管对象                     | 不删除、不迁移、不全量部署                                                 |

若只执行上述目标专属资源，环境数量将从 6 个函数、7 条路由、16 个集合变为 7 / 8 / 20；版本、广告和审计集合保持空。

## 最新只读预检

最终刷新时间：北京时间 **2026-09-28 15:51**，使用仓库固定 CloudBase CLI 3.8.1。

| 检查项       | 结果                                                               |
| ------------ | ------------------------------------------------------------------ |
| 环境         | `baas_trial` 体验版，NORMAL，上海；到期 2027-03-17 23:59:59        |
| 费用开关     | 自动续费 false；超限扣费 false；扩展包为空；当前订单字段为空       |
| 积分         | 2026-09-17 至 2026-10-17；已用 5.66 / 3000；资源包及按量扣减均为 0 |
| 当前资源     | 6 个函数、7 条路由、16 个集合                                      |
| 目标冲突     | 本工具计划新增的函数、路由和四个集合均不存在                       |
| 线上已有应用 | 录屏助手、鼠标精灵、毕方小工具、AI 用量看板；均保持不变            |

只读取了环境、计费、函数、路由和集合元数据，没有读取业务记录正文，也没有写测试数据。积分不是人民币金额；实际部署前仍需刷新本表，发现付费、升级、超限或目标漂移时必须停止。

## 共享看板并发差异

本轮开始后，工作区出现了另一项现有用户改动：`bifang-vm-sync-agentless` 已登记在 `cloudbase/apps.json`，但最新云端清单中尚无其函数、路由或集合。该改动不是本次 LAN 文件传输接入创建的，已原样保留。

当前共享看板配置由完整应用登记表生成。因此直接部署 `operations-dashboard-api` 会同时加入 LAN 文件传输和 VM 工具两份映射，超出“只部署 LAN 文件传输”的最小范围。为避免夹带并发目标，**本轮尚未把共享看板更新列入可执行写入步骤**；需负责人明确是否允许同时加入 VM 映射，或另行批准先做 LAN 专属资源、暂缓看板。

## 版本服务与客户端后续

- 六个登记应用对应的完整共享版本凭据摘要已超过运行时解析器的 4096 字节上限，同时不可能满足更严格的 3840 字节函数环境部署安全门槛。因此本轮不更新共享版本函数，不生成新凭据，也不写占位版本记录。
- 目标仓库的当前产品规格排除 telemetry 和自动更新。真实日活不会自动出现；后续必须由该工具自己的项目发起独立接入任务，更新产品规格并实现随机 UUID v4 安装身份、北京时间每日落盘门禁和 `daily_active` 上报。
- 不得复用硬件、系统或账号标识；不得上传文件名、路径、文件内容、局域网地址或传输内容。
- 客户端修改、构建、安装、发布和真实 GUI E2E 均不在当前运营精灵仓库任务范围内。

## 修改、验证与边界

本轮新增了 LAN 文件传输应用登记及四条 stable 发布流，并同步了生成配置和登记契约测试。工作区原有 AI 用量看板、运营看板和 VM 工具等未提交改动均予以保留，未擅自覆盖或清理。

已执行并通过：

- `npm.cmd run cloudbase:config:check`
- `node --test tests/cloudbase-multi-app-config.test.mjs tests/repository-contract.test.mjs tests/cloudbase-target-deploy-plan.test.mjs`：19/19 通过
- `npm.cmd test`：全部通过（workspace 131、根测试 139、Python 42，共 312 项）
- `npm.cmd run typecheck`、`npm.cmd run build`、`npm.cmd run typecheck:examples`
- 目标仓库接入扫描：202 个文件，扫描完整；未发现现行或旧版毕方接入
- `git diff --check`（本轮涉及的登记、生成配置和契约文件）：通过

`npm.cmd run check` 已执行；配置检查通过，但随后仍因 80 个本轮前已存在的格式问题停止，后续步骤由上述独立命令完成。本轮涉及文件的单独 Prettier 检查通过，未批量改写其他文件。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`，本次未创建新提交。

**未执行：CloudBase 部署或写入、共享看板更新、版本发布、购买、Git 推送、云资源删除、凭据生成、目标客户端修改/构建/安装。**
