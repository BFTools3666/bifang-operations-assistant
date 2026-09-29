# bifang-multi-instance-display CloudBase 接入准备回执（2026-09-29）

> 状态更新：负责人已在审阅本文件后明确回复“继续”，本计划中的目标云端步骤已完成并通过验收。
> 本文件以下内容保留为写入前审查证据；最终事实见
> [CloudBase 部署回执](bifang-multi-instance-display-cloudbase-deployment-20260929.md)。

## 当前状态

本次已在目标仓库完成客户端本地迁移，并在运营精灵仓库登记
`bifang-multi-instance-display`。应用发布流为 Windows / x64 / stable，code 为
`bifang-multi-instance-display-windows-x64`。

客户端已移除旧外部更新服务和 Aliyun SLS 遥测，改为隐私最小化的 CloudBase
`daily_active` 与单次 application-version API v1 检查；源码中不再保存运行凭据回退值。
本地登记、资源隔离设计、目标专属部署计划、看板过滤计划和线上只读预检均已完成，
**尚未执行本应用的 CloudBase 写入或部署**。机器可读证据见
[预检与部署计划](bifang-multi-instance-display-cloudbase-preflight-20260929.json)。

依据 `$bifang-public-services-onboarding` 的 CloudBase 写入门禁，本轮停在最终预检之后；
负责人再次明确回复“继续”前，不执行任何目标云端写入。

## 目标仓库与客户端迁移

目标仓库：`https://github.com/BFTools366/bifang-multi-instance-display`。
已按负责人要求通过 Git Bash 的 Git Credential Manager 设备流重新授权，并只使用 Microsoft Edge
完成网页确认。私有仓库远端访问已复核成功。

| 字段     | 值                                          |
| -------- | ------------------------------------------- |
| 分支     | `master`                                    |
| 基线提交 | `25891c9d0615a579311e18fa143bdc7772b5125d`  |
| 版本     | `1.2.0`                                     |
| 技术栈   | Python 3.12 / PySide6 / PyInstaller         |
| APP_ID   | `bifang-multi-instance-display`             |
| 发布流   | `bifang-multi-instance-display-windows-x64` |

客户端本地实现包括：

- 主窗口显示后异步发送一次十字段 `daily_active`，使用 APP_ID 隔离的随机 UUID v4 安装身份；
- 北京时间日门禁在联网前原子领取，失败当天不重试；不采集账号、主机名、MAC、硬件标识、窗口数据或功能用量；
- 主窗口 ready 后只执行一次版本检查，URL 固定为单层 `/tools/version-control/v1`；
- 两个运行凭据只从 `BIFANG_VERSION_CHECK_APP_KEY` 和
  `BIFANG_VERSION_CHECK_APP_SECRET` 读取，缺少任一项时安静跳过；
- 严格解析冻结的七字段响应，下载链接只允许公共 HTTPS，强制更新通过主窗口完整退出路径关闭；
- 新增 Profile v2、隐私说明和离线单元测试。

源码扫描覆盖 54 个文件，无跳过文件；旧静态更新扫描门禁为 clear。38 个目标项目测试全部通过，
`compileall` 通过。没有构建、安装、发布或推送客户端。

## 待执行的精确云端目标

复用现有上海环境 `bftoos-sh-d3ga7hahz59229f0a`，默认 HTTPS origin：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com`

| 动作         | 精确目标                                               | 规则                                                                                  |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 新建集合     | `telemetry_bifang_multi_instance_display`              | `ADMINONLY`；TTL `expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`          |
| 新建函数     | `telemetry-bifang-multi-instance-display`              | Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB；只接受本 APP_ID 的 `daily_active` |
| 新建路由     | `/apps/bifang-multi-instance-display/v1/track`         | 绑定上述函数；安全域名和路径透传开启；QPS 总计 100、单 IP 10                          |
| 新建空集合   | `versions_bifang_multi_instance_display`               | `ADMINONLY`；两个标准版本查询索引；不写版本记录                                       |
| 新建空集合   | `ads_bifang_multi_instance_display`                    | `ADMINONLY`；标准广告查询索引；不写广告记录                                           |
| 新建空集合   | `audit_bifang_multi_instance_display`                  | `ADMINONLY`；标准审计索引；不写记录                                                   |
| 原位更新看板 | `operations-dashboard-api`                             | 使用精确 12 应用过滤映射；不上传原始 secret                                           |
| 保留看板路由 | `/dashboard`、`/admin/v1/metrics`                      | 线上已存在；不重建、不删除、不改变现有 QPS                                            |
| 保留版本服务 | `application-version-api`、`/tools/version-control/v1` | 不更新共享函数或路由，不生成本应用凭据，不写版本或广告记录                            |

非系统索引：

- `versions_bifang_multi_instance_display`：
  `idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；
  `idx_version_sort` =
  `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_multi_instance_display`：
  `idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_multi_instance_display`：
  `idx_audit_occurred_at` = `{occurred_at:-1}`。

完成后资源数量预期从 13 个函数、14 条路由、44 个集合变为 **14 / 15 / 48**；
静态托管仍为 6 个对象；看板从线上 10 个应用变为 12 个。新增 versions / ads / audit 集合保持空。

## 并发登记与看板过滤

只读复核时，`bifang-browser-multi-instance` 已完成自己的函数、路由、四个集合和遥测 E2E，
但其看板更新因本仓库并发新增两个应用触发材料摘要保护，尚未写入。为保持 fail-closed 看板可用，
本计划显式选择线上原有 10 个应用、已云端就绪的 `bifang-browser-multi-instance` 和本应用，
共 12 个应用。

`bifang-app-network-accelerator` 当前只有本地登记，其四个云集合不存在，因此明确排除；本计划不创建、
部署或修改它的任何资源。12 应用编码映射为 1824 UTF-8 字节，低于平台 4096 字节上限。
定向看板材料 SHA-256 为
`acd128e11c89d1236afbc9543feeab68a5a1a81445220a61c09f8437f6c8f5bf`；
32 个文件、28,916,421 字节；原始 secret 上传数为 0，删除列表为空。

## 最新云端只读预检

计费与集合基线读取于北京时间 **2026-09-29 09:32**；函数和路由在 **09:35** 再次刷新。

| 检查项       | 结果                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| 环境         | 仅有 `bftoos-sh-d3ga7hahz59229f0a`；`baas_trial` 体验版，NORMAL，上海            |
| 费用开关     | 自动续费 false；超限扣费 false；扩展包为空；无活动订单；到期 2027-03-17 23:59:59 |
| 积分         | 写前最近证据为已用 27.99 / 3000；资源包及按量扣减均为 0                          |
| 当前资源     | 13 个函数、14 条路由、44 个集合、6 个静态托管对象                                |
| 集合基线     | 44 个集合全部为 `ADMINONLY`；既有集合契约无差异                                  |
| 目标冲突     | 本应用函数、路由和四个集合均不存在                                               |
| 共享版本函数 | `application-version-api` 自 2026-09-17 16:32:11 起未修改；本轮不触碰            |
| 运营看板     | 线上仍为 10 应用；本计划仅使用上述 12 应用过滤映射                               |

积分不是人民币金额。真实写入前会立即再次刷新套餐、积分、费用开关、函数、路由、集合、ACL、索引、
看板映射和托管对象；如出现付费、升级、超限、自动续费、资源漂移、目标冲突或材料摘要变化，立即停止并
重新确认。本次只读预检没有读取业务记录正文。

## application-version 限制

客户端已经按 v1 契约迁移，但本次参照近期历史项目做法，不扩大共享版本服务的变更范围：不部署
`application-version-api`、不生成凭据、不写版本或广告记录。因此云端写入完成后，telemetry 与
看板可以验收；版本检查仍因缺少低权限运行凭据而安静跳过，真实版本服务和客户端 GUI E2E 保持
`Unverified`。后续若要启用，需要单独审查共享函数映射、全部已登记发布流的凭据覆盖及十端点公网 E2E。

## 收到下一次“继续”后的执行与验收

1. 再次刷新套餐、费用开关、函数、路由、集合、ACL、索引、看板映射和托管清单；任何漂移立即停止。
2. 创建上述四个集合、`ADMINONLY` 权限和精确索引；versions / ads / audit 保持空。
3. 仅部署 `telemetry-bifang-multi-instance-display`，仅创建本应用 track 路由。
4. 使用已审阅材料原位更新 `operations-dashboard-api` 为精确 12 应用映射；保留两条既有看板路由。
5. 回读函数、路由、ACL、TTL、索引、集合计数和看板映射。
6. 使用随机匿名安装身份提交同一个合成 `daily_active` 事件两次，要求只新增一条幂等记录；
   该记录会暂时计入日活，并按 30 天 TTL 清理。
7. 验证看板能读取本应用及其余 11 个选定应用；这不等同于真实桌面客户端 E2E。

若任一步失败，停止后续写入并重新读取实际状态，不自动重试有副作用的步骤。看板可恢复为部署前
映射和上一版函数；四个新集合、函数和路由不会自动删除。任何删除都必须另列精确目标并再次取得授权。

本计划不包含第二个 CloudBase 环境、共享版本函数或路由更新、凭据生成、版本或广告记录、
`bifang-app-network-accelerator` 云资源、托管写入、全量部署、强制清理、购买、套餐升级、自动续费、
超限扣费、客户端构建/安装/发布或 Git 推送。

## 修改与验证

目标客户端已完成 Profile v2、匿名日活、单次版本检查、安全外链、完整退出、隐私文档和测试迁移。
运营精灵仓库已登记本应用及 Windows x64 stable 发布流，并重新生成 CloudBase 示例配置。

已执行并通过：目标项目 38 个单元测试、`compileall`、Profile 校验、资源派生、54 文件完整扫描、
CloudBase 配置生成检查、目标专属 telemetry 计划、12 应用定向看板计划、14 个受影响根契约测试、
四个工作区共 131 个测试、类型检查、构建和示例类型检查。

全仓 `npm.cmd run check` 已执行，但在仓库既有 80 个 Prettier/换行问题处停止；根测试中的 Git 权威
来源用例会按设计拒绝当前包含多项并发登记的脏工作区。没有将这些基线问题冒充为本次通过项。

运营精灵基线提交为 `8c855c0837d33d1f4fa48925bdc4202f4d1a0888`；目标项目基线提交为
`25891c9d0615a579311e18fa143bdc7772b5125d`。本次未创建提交。

**未执行：本应用 CloudBase 部署或写入、共享版本 API 更新、凭据生成、版本或广告记录写入、客户端
构建/安装/发布、购买、Git 推送或云资源删除。**
