# 毕方局域网文件传输 CloudBase 部署回执（2026-09-28）

## 当前状态

**LAN 文件传输的目标专属 CloudBase 资源、VM 空支撑集合和六应用共享看板映射均已部署并通过公网 E2E。**

负责人明确回复 `继续，允许看板同时加入 VM 映射` 后，重新刷新了套餐、额度、函数、路由和集合清单。环境仍为 `baas_trial` 体验版，自动续费和超限扣费均为 false，资源包及按量扣减均为 0；所有已批准 LAN 目标当时不存在。

## 已完成的云端目标

复用环境 `bftoos-sh-d3ga7hahz59229f0a`（上海）：

| 资源                                      | 结果                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| `telemetry-bifang-lan-file-transfer`      | Active / Available；Nodejs20.19 / 3 秒 / 256 MB；三项环境变量精确绑定本 APP_ID、集合和路由 |
| `/apps/bifang-lan-file-transfer/v1/track` | 已创建并精确绑定上述函数；安全域名、路径透传开启；QPS 总计 100、单 IP 10                   |
| `telemetry_bifang_lan_file_transfer`      | ADMINONLY；`expires_at_ttl` = `{expires_at:1}`、`expireAfterSeconds:0`                     |
| `versions_bifang_lan_file_transfer`       | ADMINONLY；两个标准版本查询索引；0 条记录                                                  |
| `ads_bifang_lan_file_transfer`            | ADMINONLY；标准广告查询索引；0 条记录                                                      |
| `audit_bifang_lan_file_transfer`          | ADMINONLY；标准审计索引；0 条记录                                                          |
| `telemetry_bifang_vm_sync_agentless`      | ADMINONLY；标准 TTL 索引；0 条记录；未部署 VM 函数或路由                                   |
| `versions_bifang_vm_sync_agentless`       | ADMINONLY；两个标准版本查询索引；0 条记录                                                  |
| `operations-dashboard-api`                | 仅更新六应用映射；代码、函数规格、六个环境键和两份认证哈希保持不变                         |

部署后的清单为 7 个函数、8 条路由、22 个集合。共享 `application-version-api`、既有函数/路由/集合和静态托管均未修改。

## 公网 E2E

使用一次随机匿名 UUID v4 安装身份和当前版本 `0.1.0`，向正式 track 路由发送一条合成 `daily_active`，随后原样重试：

- 首次请求：HTTP 202，`{"ok":true}`。
- 完全相同重试：HTTP 202，`{"ok":true}`。
- 集合读回计数：1，确认幂等；该记录会按 30 天 TTL 自动清理。

未读取测试记录正文。此测试只证明云端 HTTP、函数和数据库链路，不等同于目标桌面客户端 E2E。

## 看板追加目标与验收

负责人随后明确回复 `继续创建 VM 两个空支撑集合并更新看板`。执行前再次确认套餐与费用开关未漂移、两个 VM 集合不存在、看板仍是线上四应用映射且认证值与本地密钥文件匹配。

先创建两个空支撑集合并读回 ACL、索引和记录数，再仅调用云函数配置更新接口替换 `DASHBOARD_APPS_JSON`。首次写入尝试在 API 调用前被容量断言拦截，没有发生云端配置写入：模板占位符计算为 2802 字节，替换线上实际 64 字节认证哈希后的真实值为 2877 字节。修正断言后执行，仍低于 4096 字节平台上限。

实际执行的追加目标：

| 动作       | 精确目标                                            | 范围                                                     |
| ---------- | --------------------------------------------------- | -------------------------------------------------------- |
| 新建空集合 | `telemetry_bifang_vm_sync_agentless`                | ADMINONLY；标准 TTL 索引；0 条记录；已读回验证           |
| 新建空集合 | `versions_bifang_vm_sync_agentless`                 | ADMINONLY；两个标准版本查询索引；0 条记录；已读回验证    |
| 更新配置   | `operations-dashboard-api` 的 `DASHBOARD_APPS_JSON` | 从 4 个映射增加为 6 个；仅更新环境配置；两份认证哈希匹配 |

真实公网验证覆盖看板 HTML、JS、CSS、未登录状态、错误登录、正确安全 Cookie 会话、全应用指标、管理 API 的缺失/错误/正确认证以及登出，全部通过。看板返回六个应用、11 条发布流；LAN 单应用今日活跃为 1、四条发布流，VM 单应用今日活跃为 0、一条发布流。

该追加范围没有部署 VM telemetry 函数或路由，没有创建 VM ads/audit 集合，没有写 VM 数据，也没有更新共享版本服务。同日的 VM 独立接入预检现在已不再反映云端现状，后续执行该任务前必须重新读取资源并按兼容已有集合处理。

## 最新费用复核与边界

阶段部署后再次读取：套餐仍为体验版，自动续费 false、超限扣费 false；当前周期已用 5.66 / 3000，资源包及按量扣减均为 0。

部署后再次执行配置生成检查、看板/隔离/定向部署相关测试和回执格式检查：配置与生成文件一致，定向测试 50/50 通过，部署回执 JSON 可解析且 Prettier 检查通过。

未执行：VM 函数或路由部署、VM ads/audit 集合创建、VM 数据写入、版本服务更新、凭据生成、版本/广告记录写入、购买、删除、Git 推送、目标客户端修改/构建/安装。

机器可读阶段证据见 [部署 JSON](bifang-lan-file-transfer-cloudbase-deployment-20260928.json)。
