# 多工具资源隔离指南（基础设施 3.0）

## 结论

一个现有免费 CloudBase 环境可以承载多个毕方工具，但隔离必须发生在应用、发布流、凭据和数据层：

- telemetry 按 APP_ID 使用独立函数、路由、集合和客户端本地状态；
- application-version 共用一个函数和一个 `/tools/version-control/v1` 路由；
- 每个 APP_ID 使用独立 versions、ads、audit 集合；
- 每个 `(platform, architecture, channel)` 使用独立 code；
- 凭据先绑定 APP_ID、code 和最小 scopes，认证后才选择集合。

共享环境、默认 HTTPS 域名、网关额度、函数/数据库配额和平台故障域仍是共享的，并非无限容量或账单隔离。客户端可使用运营侧精确批准的 application-version 生产网关作为同一 v1 合同入口，telemetry 仍使用 CloudBase 默认 origin；这不创建第二环境或新资源。若要隔离额度或故障域，就会涉及第二环境和潜在费用，本方案不自行创建。

新客户端使用独立客户端更新中心 POST 协议，以 APP_ID 和实际平台、架构、安装形态、通道隔离；不保留静态更新清单或客户端双轨。下文 application-version 资源是现有历史服务，不因新客户端接入而删除。`daily_active` telemetry 保持独立。

## 一句话从客户端发起

在目标小工具自己的 Codex Task 中发送：

```text
https://gitlab.kuajingvs.com/qiuyang/bifang-operations-assistant.git 帮我接入
```

它授权该客户端完成权威来源验证、Skill 安装、Profile v2、旧版本协议替换/删除和本地测试；不授权修改另一个客户端，也不授权云端部署/删除、打包安装、发布或推送。运营精灵仓库不能反向扫描和主动修改未知工具。

## APP_ID 与 telemetry

APP_ID 全局唯一，长度 1–50，只含小写字母、数字和短横线，首尾必须是字母或数字。建议 `bifang-<product-key>`，但正式值需要负责人确认。

对 `app_id` 派生：

| 资源           | 规则                                           |
| -------------- | ---------------------------------------------- |
| Telemetry 函数 | `telemetry-<app_id>`                           |
| Telemetry 集合 | `telemetry_<app_id 中 - 替换为 _>`             |
| Telemetry 路由 | `/apps/<app_id>/v1/track`                      |
| 本地状态       | 应用自己的 AppConfig，再以 APP_ID 命名空间隔离 |

任何一个工具都不能复用另一个工具的 APP_ID、集合、路由或本地状态目录。

## 既有 Application-version 共享服务（历史）

固定资源：

```text
函数：application-version-api
路由：/tools/version-control/v1
```

`v1` 只出现一次，不存在 `/v1/v1`。对每个 APP_ID 派生：

| 数据     | 规则                           |
| -------- | ------------------------------ |
| 版本集合 | `versions_<normalized_app_id>` |
| 广告集合 | `ads_<normalized_app_id>`      |
| 审计集合 | `audit_<normalized_app_id>`    |

三类集合权限固定 `ADMINONLY`。共享函数不能把请求中的 code 当集合名，不能遍历集合找“碰巧匹配”的记录，也不能让客户端自选 APP_ID。正确顺序是：

```text
x-app-key + x-app-secret
  -> 固定 credential binding
  -> app_id + allowed codes + scopes
  -> 该 app_id 的固定集合
  -> code 范围内查询或写入
```

每份客户端运行凭据只绑定一个 code，且只给 `versions:check`。管理读取凭据固定为 `versions:read + ads:read`，管理写入凭据固定为 `versions:write + ads:write`；两者独立且绝不进入客户端。部署配置必须让每条发布流同时具备运行检查、管理读、管理写覆盖，并全局准备一份不可导出的 `contract-ads-*` 凭据执行 `ads:show` 契约测试。

## 发布流 code

application-version 请求没有 platform/arch 字段，所以 code 必须表达发布流。每个 code 长度 1–50，只含小写字母、数字和短横线，并在全登记表内唯一。

当前两个产品的建议映射：

| APP_ID                   | platform | architecture | channel | code                                 |
| ------------------------ | -------- | ------------ | ------- | ------------------------------------ |
| `bifang-mouse-clicker`   | windows  | x64          | stable  | `bifang-mouse-clicker`               |
| `bifang-screen-recorder` | windows  | x64          | stable  | `bifang-screen-recorder-windows-x64` |
| `bifang-screen-recorder` | macos    | arm64        | stable  | `bifang-screen-recorder-macos-arm64` |

不得依赖 User-Agent 猜平台，Windows 的成功不能替代 macOS 原生验收。

## 登记一个新工具

1. 在工具自己的 Task 中完成只读扫描和 Profile v2；展示并确认 APP_ID 和全部新更新中心目标。只接新更新中心且没有真实旧发布流时，运营精灵使用 `npm run cloudbase:app:add -- <app_id>` 登记统计资源；不编造旧 code。
2. 在运营精灵 Task 中检查 `cloudbase/apps.json` 全局唯一性，再运行受测的登记命令；一次只登记一个应用，不并发写登记表。
3. 运行 `npm run cloudbase:config:check`、相关契约测试和只读部署计划。
4. 计划必须完整保留所有已登记 telemetry 与 application-version 应用映射，不能只生成当前工具的临时配置。
5. 线上写入前展示现有免费环境、平台默认域名、函数、路由、集合、索引、凭据绑定、费用和差异，再等待明确“继续”。
6. 新服务公网 HTTP E2E 通过后，客户端 Task 才能用真实只读凭据进行真实安装包 E2E。

## 修改、改名与删除

APP_ID、code、函数、路由和集合都视为发布身份，不因显示名变化自动修改。改名应先新建并验收新身份，再迁移；但本次两个未公开客户端明确不需要保留旧静态版本协议，因此它们的旧更新实现直接删除。

源码删除与线上资源删除分开：

- 客户端/运营精灵仓库中的旧静态更新源码、配置、manifest、测试和现行文档按 3.0 升级直接删除；
- 线上旧静态路由、hosting 文件和相关配置必须等两个实际客户端新协议 E2E 完成，先做最新只读枚举，逐项证明不属于 telemetry 或其他应用，再展示精确目标并等待明确“继续”；
- 不使用目录推断、通配符、`--prune` 或批量删除；`--force` 只允许 credential-bound helper 精确创建或更新固定函数 `application-version-api`，不得用于资源删除或其他目标；历史业务数据的删除另需明确范围。

## 上线前逐工具验收

新客户端优先依据 [客户端更新中心接入合同](../skills/bifang-public-services-onboarding/references/client-update-center.md) 验证 POST、Bearer、目标隔离、强更、下载与复检。下面的 code、旧 v1 与集合项仅适用于历史 application-version 服务，不作为新服务已经接入的证明。

- APP_ID、所有 code、平台、架构、渠道映射准确且唯一；
- telemetry 只写自己的集合，客户端联网前落盘、同日一次、失败不重试；
- version runtime 凭据只能访问自己的 APP_ID/code 和运行 scopes；
- 三个 application-version 集合均为 `ADMINONLY`；
- Base URL 只有一个 v1，错误双 v1 返回 404；
- 版本无更新、提示、强制、停止和错误状态均完成契约测试；
- 客户端源码、配置和活跃测试不再引用旧静态版本协议；
- Windows/macOS 用各自 code 和真实制品分别 E2E；
- 无非零费用、升级、自动续费或超限扣费提示。

## 费用红线

只复用负责人确认的现有免费环境和平台默认 HTTPS 域名。不购买自定义域名、证书、套餐或资源包，不创建第二环境，不开启按量超限或自动续费。控制台或 CLI 一旦显示非零金额或升级要求，停止并把证据交回负责人。
