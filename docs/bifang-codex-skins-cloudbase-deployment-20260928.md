# 毕方 CodeX 皮肤工坊 CloudBase 部署回执（2026-09-28）

负责人在审阅[准备清单](bifang-codex-skins-cloudbase-preparation-20260928.md)和[部署前计划](bifang-codex-skins-cloudbase-preflight-20260928.json)后明确回复“继续”。本次每日活跃统计、四个隔离集合和运营看板映射均已部署，并通过公网合成事件与看板验收。机器可读结果见[部署结果 JSON](bifang-codex-skins-cloudbase-deployment-20260928.json)。

## 部署结果

| 项目           | 结果                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------ |
| APP_ID         | `bifang-codex-skins`                                                                                   |
| CloudBase 环境 | `bftoos-sh-d3ga7hahz59229f0a` / 上海                                                                   |
| 统计函数       | `telemetry-bifang-codex-skins`，Active / Available；Event / Nodejs20.19 / `index.main` / 3 秒 / 256 MB |
| 统计路由       | `/apps/bifang-codex-skins/v1/track`；安全域名与路径透传开启；QPS 总计 100、单 IP 10                    |
| 统计集合       | `telemetry_bifang_codex_skins`，ADMINONLY；TTL 索引正确；1 条合成记录                                  |
| 版本集合       | `versions_bifang_codex_skins`，ADMINONLY；两个标准查询索引；0 条记录                                   |
| 广告集合       | `ads_bifang_codex_skins`，ADMINONLY；标准查询索引；0 条记录                                            |
| 审计集合       | `audit_bifang_codex_skins`，ADMINONLY；`occurred_at` 降序索引；0 条记录                                |
| 运营看板       | `operations-dashboard-api` 已更新为 7 个应用、13 条发布流，Active / Available                          |
| 共享版本服务   | 未修改；仍为原 3 个应用和 11 份既有凭据                                                                |

公网统计端点：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/apps/bifang-codex-skins/v1/track`

运营看板：

`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/dashboard`

## 隔离与索引读回

四个集合均在创建请求中指定 ADMINONLY，部署后逐项调用权限接口读回，结果全部为 `ADMINONLY`。

- `telemetry_bifang_codex_skins`：`expires_at_ttl` = `{expires_at:1}`，`expireAfterSeconds:0`。
- `versions_bifang_codex_skins`：`idx_version_created` = `{doc_type:1, code:1, created_at:-1, _id:-1}`；`idx_version_sort` = `{doc_type:1, code:1, version_sort_key:-1, updated_at:-1, _id:-1}`。
- `ads_bifang_codex_skins`：`idx_ads_created` = `{doc_type:1, app_code:1, created_at:-1, _id:-1}`。
- `audit_bifang_codex_skins`：`idx_audit_occurred_at` = `{occurred_at:-1}`。

统计函数环境变量只包含本应用的 APP_ID、集合名和路径，没有混入其他应用。

## 公网 E2E 与看板验收

使用随机 UUID v4 的匿名安装身份和版本 `1.1.0+cloudbase-e2e`，向公网端点连续发送两次完全相同的 `daily_active`：

| 验收项       | 结果                                             |
| ------------ | ------------------------------------------------ |
| 首次请求     | HTTP 202，`{"ok":true}`                          |
| 相同重试     | HTTP 202，`{"ok":true}`                          |
| 最终记录数   | 1；服务端幂等成立                                |
| 统计保留     | 30 天，到期时间由服务端生成并由 TTL 清理         |
| 看板目标应用 | `bifang-codex-skins`，今日活跃 1                 |
| 看板发布流   | Windows x64 与 macOS arm64 共 2 条，均为 `empty` |
| 看板完整映射 | 7 个应用、13 条发布流                            |

看板完整 HTTP 验证通过：页面、JavaScript、CSS、会话登录、认证后指标和管理员指标均返回 200；未认证、错误访问密钥和错误管理员令牌均返回 401；退出登录成功。返回数据仍只包含聚合统计，没有安装 ID、事件 ID、来源 IP、下载地址或凭据。

更新看板前已把线上 `$LATEST` 代码下载到 `C:\Users\aws-a\AppData\Local\Temp\bifang-dashboard-backup-20260928-171808`。去除依赖目录后，线上与本地 13 个源码、配置和测试文件逐字节一致。部署使用已审阅材料哈希 `6717536f6d320141f82a07d7ee1a993d92cf9e980a206154fd0ffca054f72016`，认证值未轮换。

## 最终环境与费用复核

最终只读清单：

| 资源           | 总量 |
| -------------- | ---: |
| 云函数         |    9 |
| HTTP 路由      |   10 |
| 文档数据库集合 |   28 |
| 静态托管对象   |    6 |

部署后于北京时间 2026-09-28 17:24 再次读取计费状态：`baas_trial` 体验版仍为 NORMAL，自动续费 false，超限扣费 false，没有扩展包、有效订单或升级提示。当前周期已使用 8.22 / 3000 资源点，资源包扣减与按量扣减均为 0。资源点不是人民币金额，本回执不承诺未来费用。

`application-version-api` 的修改时间仍为 2026-09-17 16:32:11，证明本轮没有更新共享版本函数。六个既有静态托管对象保持不变。

## 源码、验证与未执行事项

目标仓库仍为干净的 `master` 提交 `53c03c0e583c0c9323299cb8c8728ff3e25f113d`。本轮没有修改、构建、安装或发布目标客户端；其旧 SLS 统计和外部版本服务仍需在目标仓库中另行迁移。

运营精灵本次相关契约测试 25/25 通过，配置检查、TypeScript 类型检查、构建、examples 类型检查和公网看板验证均通过。整仓既有的 80 个格式问题及本机缺少 `py` 启动器导致的仓库级测试环境失败，已记录在准备回执中，未伪装为通过。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`；本次没有创建新提交。

**未执行：付费购买、套餐升级、自动续费或超限扣费开启、Git 推送、云资源删除、版本记录或广告记录写入、新凭据生成、目标客户端修改/构建/安装/发布、真实 GUI E2E。**
