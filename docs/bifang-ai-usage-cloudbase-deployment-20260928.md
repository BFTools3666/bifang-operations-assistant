# 毕方AI用量看板 CloudBase 部署回执（2026-09-28）

**已完成本次授权的云端部署和公网 HTTP 验收。业务客户端尚未修改或接入。**

负责人在审阅[准备清单](bifang-ai-usage-cloudbase-preparation-20260928.md)和[部署前计划](bifang-ai-usage-cloudbase-preflight-20260928.json)后明确回复“继续”。本次执行范围为每日活跃统计、四个隔离集合、运营看板映射及一条合成统计记录验收。完整机器证据见[部署结果 JSON](bifang-ai-usage-cloudbase-deployment-20260928.json)。

## 应用与环境

| 项目            | 已确认值                                                  |
| --------------- | --------------------------------------------------------- |
| 产品            | 毕方AI用量看板                                            |
| APP_ID          | `bifang-ai-usage-collector`                               |
| 源仓库          | `https://github.com/BFTools366/bifang-ai-usage-collector` |
| 审阅分支 / 提交 | `master` / `580a89fc711d87050306f8a77ef84803aa360ea7`     |
| 当前源码版本    | `1.4.24`，以 Cargo workspace version 为准                 |
| CloudBase 环境  | `bftoos-sh-d3ga7hahz59229f0a`，上海                       |
| Windows 发布流  | x64 / stable / `bifang-ai-usage-collector-windows-x64`    |
| macOS 发布流    | arm64 / stable / `bifang-ai-usage-collector-macos-arm64`  |
| 更新地址        | 空；版本检查保持未启用                                    |

## 已执行资源

| 资源     | 精确目标                                   | 结果                                                                         |
| -------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| 统计函数 | `telemetry-bifang-ai-usage-collector`      | 已创建，Active / Available；Event / Nodejs20.19 / index.main / 3 秒 / 256 MB |
| 统计路由 | `/apps/bifang-ai-usage-collector/v1/track` | 已创建，绑定上述函数；安全域名、路径透传开启；QPS 100，单 IP 10              |
| 统计集合 | `telemetry_bifang_ai_usage_collector`      | ADMINONLY；`expires_at_ttl` 索引正确；当前一条合成测试记录                   |
| 版本集合 | `versions_bifang_ai_usage_collector`       | ADMINONLY；两个标准查询索引；0 条记录                                        |
| 广告集合 | `ads_bifang_ai_usage_collector`            | ADMINONLY；标准查询索引；0 条记录                                            |
| 审计集合 | `audit_bifang_ai_usage_collector`          | ADMINONLY；`occurred_at(desc)` 索引；0 条记录                                |
| 看板函数 | `operations-dashboard-api`                 | 仅更新 `DASHBOARD_APPS_JSON`，追加新应用与两条发布流                         |

新增集合采用 [CreateTable 的 ADMINONLY 权限参数](https://cloud.tencent.com/document/product/876/127968)创建，随后逐项读回权限、索引和空集合状态。TTL 为 `expires_at:1`、`expireAfterSeconds:0`，服务端设置 30 天到期时间。

看板通过 [UpdateFunctionConfiguration](https://cloud.tencent.cn/document/product/583/18580)更新应用映射，保留当前其他环境变量。没有重传代码或使用强制覆盖参数。更新后代码信息摘要及代码大小与更新前一致，两份现有认证值、运行时、超时和内存均保持不变。

执行时间均为北京时间：首个集合创建于 12:06:43；统计函数读回修改时间为 12:09:21；路由创建于 12:10:35；看板映射更新于 12:10:51。

统计函数部署命令退出码为 0，但 CLI 输出未形成可解析的 JSON 回包。随后只读查询确认函数 Active / Available 且配置完全匹配；未重复部署。此过程保留在机器回执中，没有把回包解析失败误记为云端部署失败。

## 公网验收

| 检查                     | 实际结果                                                                |
| ------------------------ | ----------------------------------------------------------------------- |
| OPTIONS / 不支持的方法   | 204 / 405                                                               |
| 跨应用 APP_ID            | 403，零写入                                                             |
| 多余请求字段             | 400，零写入                                                             |
| 首次合法 daily_active    | 202 `{"ok":true}`                                                       |
| 完全相同的重试           | 202 `{"ok":true}`，集合仍只有一条记录                                   |
| 看板页面、脚本、样式     | 全部 200                                                                |
| 看板认证                 | 未登录及错误凭据被拒绝；正确登录、安全 Cookie、退出和管理指标认证均通过 |
| 新应用独立聚合           | 200；今日活跃 1；两条 stable 流均为 empty                               |
| 全部应用及原三款应用聚合 | 全部 200，保持 live / connected                                         |

这条记录是已授权的随机匿名合成数据，版本标记为 `1.4.24+cloudbase-e2e`，暂时计入本工具日活，按现有 30 天 TTL 到期清理。它不代表真实用户，也不证明 Windows 或 macOS 客户端已完成接入。

## 部署后核对与费用

资源、权限及索引读回于 12:10–12:13 完成，看板代码信息另于 12:14:38 核对。

- 环境现有 **6 个函数、7 条路由、16 个集合**，全部集合为 ADMINONLY。
- 原三款工具的独立函数元数据、12 个集合的权限/索引/记录数量、既有六条路由均未变化。
- 共享 `application-version-api` 仍保留原三款应用和 11 份凭据绑定；6 个静态托管对象未变化。
- 看板环境变量共 1824 字节；认证值与已有本地配置一致。
- 套餐仍为 `baas_trial` / NORMAL，自动续费和超限扣费均为 false。12:11 读取的积分为 **4.83 / 3000**，资源包及按量扣减为 0；本环境返回的订单字段、扩展包和提示文本为空。此为该时间点查询结果，积分不是人民币费用。

没有创建第二环境、购买、开启超限扣费或删除资源。

## 客户端交接

统计地址已可用：

```text
https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/apps/bifang-ai-usage-collector/v1/track
```

运营看板沿用已有认证方式：[打开运营看板](https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/dashboard)。

工具自己的仓库后续需实现 `daily_active`：应用独立随机 UUID v4、北京时间每日联网前原子落盘门禁、同日最多一次尝试、失败不重试，不复用系统/硬件身份，不上传 AI 用量内容或账号资料。当前 GitHub 客户端明确没有该统计实现，本次没有修改它。

更新地址和安装包地址继续留空，不生成生产版本凭据、不写版本记录。未来启用版本检查前仍需解决已记录的共享函数配置容量门禁，并在客户端完成 Rust 协议适配。Linux 架构和接入时机仍待确认。

## 本地验证与变更

- `npm test`：在隔离 Python 测试环境中完整通过，270 项 JavaScript/TypeScript 测试、42 项 Python 测试。
- `npm run typecheck`、`npm run build`、`npm run typecheck:examples`：通过。
- 本轮变更文件格式检查、配置生成一致性检查：通过。
- `npm run check` 的整仓格式阶段仍有 80 个既有文件问题；上述测试、类型检查和构建已分别执行通过，不能将整仓 check 标记为通过。

完整测试最初发现系统 `python` 是不可运行的 Windows 应用别名，以及隔离运行时缺少 PyYAML。使用临时 venv 和 PyYAML 6.0.2 后全部通过，没有修改系统 Python。另同步了 `tests/application-version-credentials.test.mjs` 的旧应用数量断言，仍明确断言当前四应用版本配置超过 3840 字节时必须拒绝部署；没有放宽部署容量限制。

本阶段新增部署回执、维护上述测试并给准备回执添加完成链接。上一阶段的应用登记、生成配置与契约断言保留；用户原有工作区改动均保留。

运营精灵基线提交为 `30a6681eb69741f0328fa33b5b89138220636859`，未创建新提交、未推送或发布。未修改、构建或安装业务客户端，未执行真实 GUI E2E，未创建生产凭据，未删除任何云资源。

回滚材料已保留于本机仓库外的部署工作目录。因看板代码未变，必要时仅恢复之前的应用映射，保留现有认证及其他配置；新集合默认保留，任何删除仍需另行列明目标并确认。
