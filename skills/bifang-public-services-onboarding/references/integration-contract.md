# 接入契约与 Profile v2

仅在阶段 1、2、5 或生成资源预览时读取。精确 API 以权威仓库的 OpenAPI、Schema、fixtures 和函数源码为准。

## 权威版本

- 基础设施：`3.0.0`
- Skill：`2.0.0`
- Application-version 契约：`1.0.0`
- Application-version 实现基线：`92b0c599a42c3a094c99787e6928c30c2d2ea3af`
- 规范来源：`https://gitlab.kuajingvs.com/qiuyang/bifang-operations-assistant.git`

每次使用都记录权威仓库实际 HEAD。版本不一致时停止混用；先更新 Skill 或复核权威源码。

## 现行运行时

### Telemetry

- 固定事件 `daily_active`，同一匿名安装在北京时间当天最多尝试一次。
- 联网前原子落盘；失败当天不重试、不排队。
- 每个应用使用自己的 APP_ID、AppConfig、本地身份、函数、路由和集合。
- 客户端不发送 IP，不采集账号或硬件指纹。

### Application-version API

Base URL 固定：

```text
https://<平台默认域名>/tools/version-control/v1
```

`v1` 只出现一次。客户端版本检查固定：

```http
GET /versions/{code}/{currentVersion}
x-app-key: <runtime key>
x-app-secret: <runtime secret>
```

响应是冻结的裸七字段 JSON 对象。客户端映射：

- `update=false`：无更新；
- `update=true, force=false, stop=false`：提示更新；
- `update=true, force=true, stop=false`：强制更新；
- `stop=true`：停止更新/服务端暂停，按契约固定优先级处理。

广告读取只在产品已有广告 UI 时启用：`GET /app/{code}/ads/show`。管理端点不属于业务客户端。

## 完全删除旧版本协议

基础设施 3.0 不承认旧静态更新为有效 transport。迁移时删除：

- 静态更新 Base URL 和平台 manifest URL；
- 14 字段 manifest types/parser/schema；
- rollout、min-supported、旧 force-update 决策；
- fallback、dual-read、兼容开关；
- 旧协议专用源码、夹具、测试和现行文档。

不要删除可复用的严格 SemVer、安全公网 HTTPS URL、纯文本 UI、主窗口异步时序、外链或完整退出逻辑。

## APP_ID、集合与 code

APP_ID 长度 1–50，只含小写字母、数字、短横线，首尾为字母或数字。对 APP_ID 派生：

| 资源           | 规则                            |
| -------------- | ------------------------------- |
| telemetry 函数 | `telemetry-<app_id>`            |
| telemetry 集合 | `telemetry_<normalized_app_id>` |
| telemetry 路由 | `/apps/<app_id>/v1/track`       |
| versions 集合  | `versions_<normalized_app_id>`  |
| ads 集合       | `ads_<normalized_app_id>`       |
| audit 集合     | `audit_<normalized_app_id>`     |

Application-version 函数和路由全环境唯一共享。每个 `(platform, architecture, channel)` 必须有一个唯一 code；code 同样使用小写字母、数字和短横线且不超过 50。请求没有平台字段，不得靠 User-Agent 猜测。

## Profile v2

路径固定为 `.bifang/public-services-profile.json`。`profile_schema_version` 只能是 `2`。旧 Profile v1 是待迁移输入，不是有效完成状态；检测到后报告明确错误并在已授权阶段 1 生成 v2，不保留兼容字段。

Profile 只保存非敏感事实：

- 产品名、用途、负责人、APP_ID；
- 平台、架构、框架、当前 SemVer 与唯一版本来源；
- AppConfig、启动入口、ready hook、外链与退出 handler；
- 现有免费环境 ID、平台默认 HTTPS origin、telemetry endpoint；
- `update_transport=application-version-api-v1`；
- `application_version_contract_version=1.0.0`；
- 单层 `application_version_base_url`；
- `release_streams[]` 的 platform、architecture、channel、code；
- 非敏感 `version_api_auth_binding_id` 与状态；
- 基础设施版本/来源提交、登记状态、门禁、隐私说明、当前阶段；
- `legacy_update_status=detected | not_found | removed`。完成接入必须为 `removed`。

绝不保存或回显 Key、Secret、Token、Cookie、Authorization、数据库凭据、账号、硬件 ID、凭据摘要、本机绝对路径或带用户信息/查询凭据的 URL。

## Profile 写入

1. 先只读解析现有 Profile；重复字段、非法 JSON 或敏感值立即停止，不覆盖。
2. 用当前代码证据重新核对已有事实；冲突必须展示。
3. 规范 URL 一句话已经授权阶段 1，可写确定性的 v2 非敏感档案；仍无法确认的产品事实最多问三个短问题。
4. 写后运行 `validate_profile.py` 和 `derive_resources.py`。
5. 只有生产代码/配置和活跃测试均无旧静态协议且扫描完整，才写 `legacy_update_status=removed` 与相应 gate。

## 凭据

客户端凭据只能绑定准确 APP_ID/code，并且只给 `versions:check`。桌面二进制中的值可被提取，因此它是可轮换的低权限客户端令牌，不是假装不可提取的长期秘密。

管理凭据与客户端凭据分开；管理读取固定为 `versions:read + ads:read`，管理写入固定为另一份 `versions:write + ads:write`。服务部署配置必须覆盖每条登记发布流，并全局准备一份不可导出的 `contract-ads-*` 凭据执行 `ads:show` 契约测试。原值只通过项目既有本地忽略/构建注入来源提供；不进 Git、Profile、命令行参数、普通日志、测试输出或截图。没有真实凭据时本地测试注入假 transport，真实云端状态保持 `Unverified`。

## 阶段门禁

- 阶段 2：APP_ID 和全部 code 已确认；运营精灵登记表无冲突。
- 阶段 3：生成配置包含全部已登记应用；版本集合、凭据 binding、路由和费用计划已审查。
- 阶段 4：最新远端只读预检、费用为零、写入目标精确，等待明确“继续”。
- 阶段 5：服务端契约可本地测试；在当前客户端替换/删除旧实现并通过本地测试。
- 阶段 6：服务公网已验证、运行凭据已就绪，使用准确新构建制品做真实 GUI E2E。
- 阶段 7：隐私、签名、制品、下载地址、回滚均就绪，发布/推送前再次确认。
- 阶段 8：两个客户端新协议 E2E 完成，最新枚举证明旧云资源可删，展示精确目标后再次确认。
