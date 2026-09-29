# 毕方浏览器多开同步器 CloudBase 部署回执（2026-09-28）

## 结果

负责人确认“继续”后，`bifang-browser-sync` 的 CloudBase 服务端接入已完成并通过公网验收：

| 资源         | 最终状态                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------- |
| 遥测函数     | `telemetry-bifang-browser-sync`，Active / Available，Nodejs20.19，3 秒，256 MB              |
| 路由         | `/apps/bifang-browser-sync/v1/track` → 上述函数；安全域名与路径透传开启；QPS 100 / 单 IP 10 |
| 统计集合     | `telemetry_bifang_browser_sync`，ADMINONLY，TTL 正确，含 1 条合成验收记录                   |
| 版本集合     | `versions_bifang_browser_sync`，ADMINONLY，两个标准索引，0 条记录                           |
| 广告集合     | `ads_bifang_browser_sync`，ADMINONLY，标准索引，0 条记录                                    |
| 审计集合     | `audit_bifang_browser_sync`，ADMINONLY，标准索引，0 条记录                                  |
| 运营看板     | 保留原 8 个线上应用并加入本工具；9 个应用、17 条发布流，目标今日活跃 1                      |
| 共享版本服务 | 未修改；修改时间仍为 2026-09-17 16:32:11，本工具没有凭据或版本记录                          |

机器可读证据见[部署回执 JSON](bifang-browser-sync-cloudbase-deployment-20260928.json)，部署前审阅范围见[预检计划](bifang-browser-sync-cloudbase-preflight-20260928.json)。

## 公网验收

专属 endpoint：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/apps/bifang-browser-sync/v1/track`

- CORS OPTIONS：204。
- 不支持的方法：405。
- 跨 APP_ID：403。
- 未知字段：400。
- 四个负向请求后集合仍为 0 条。
- 同一匿名 `daily_active` 请求首次与重试均返回 202 / `{"ok":true}`，最终恰好 1 条，幂等通过。
- 合成版本为 `1.2.9+cloudbase-e2e`，Windows x64，随机 UUID v4 安装身份；服务端 TTL 合同为 30 天。

运营看板的页面、静态资源、登录会话、Cookie、安全响应头、浏览器 metrics 和保留的管理员 API 共 13 项检查全部通过。目标应用返回今日活跃 1，发布流 `bifang-browser-sync-windows-x64` 当前为空。

## 权限与并发处理

CloudBase `CreateTable` 调用完成后，四个新集合的首次权限读回为 `PRIVATE`，未满足计划。部署流程因此在函数/路由写入前暂停，只对这四个精确目标调用 `ModifyDatabaseACL`，最终全部读回 `ADMINONLY`；未修改其他集合。所有 TTL 和标准索引随后再次读回匹配。

验收期间另一独立任务并发创建了 `bifang-multi-local-proxy` 的 1 个函数、1 条路由和 4 个集合，因此最终全环境总数为 12 个函数、13 条路由、40 个集合、6 个托管对象。本轮没有创建、修改或删除这些并发资源；本轮看板映射仍是原 8 个应用加 `bifang-browser-sync` 的精确 9 应用范围。

## 费用与边界

部署后环境仍为 `baas_trial` 体验版 / NORMAL，到期 2027-03-17 23:59:59；自动续费 false、超限扣费 false、扩展包和活动订单为空，资源包及按量扣减均为 0。当前周期用量为 9.55 / 3000 积分；积分不是人民币金额。

没有创建第二个环境，没有购买、托管写入、删除、全量部署、Git 提交或推送。共享 application-version 函数、路由和凭据未变，versions / ads / audit 保持空。

## 客户端后续（2026-09-29）

项目负责人随后明确回复“继续并确认”，批准目标仓库修改产品与隐私边界。`D:\workspace\bifang-browser-sync` 已在现有 Tauri 迁移分支中完成本地客户端接入并把版本门禁提升到 `1.3.0`：

- 统计默认关闭，设置页提供独立中英文明确同意开关；旧偏好自动回退为未同意。
- core 实现应用专属随机 UUID v4、北京时间自然日、联网前原子领取、同日一次和失败不重试。
- Rust 平台层只向本回执中的固定 HTTPS endpoint 发送十字段 JSON POST，无客户端秘密、query 或重定向。
- Tauri 生命周期拥有唯一任务；撤回同意、应用退出和状态析构都会取消在途任务。
- updater 和 application-version API 仍未启用。

只运行了变更相关验证：core telemetry 7 项、平台 telemetry 4 项、Tauri 任务回收 1 项、React 同意控件 1 项，以及前端类型检查，均通过。未运行全仓测试、构建、安装包、真实 GUI E2E 或真实客户端公网请求。目标工作树在本轮开始前已有一批未提交且多数未跟踪的 Electron → Tauri 迁移文件，本次没有把这些用户改动夹带为提交，也没有推送。

## 验证

已通过 CloudBase 配置检查、定向 Node 测试 20/20、目标部署计划、九应用看板计划、涉及文件格式检查、`git diff --check`、函数/路由/ACL/索引回读、幂等公网遥测 E2E，以及看板公网验证。无关全量测试按负责人要求未继续执行。

运营精灵基线提交为 `a08a77fcef2c5709d1980a9d6acdedb2c47a0734`；本轮未创建提交。
