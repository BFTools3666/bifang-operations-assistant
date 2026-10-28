# 客户端更新中心接入合同

规范入口为 `https://update.meetelf.com`，与既有 application-version GET 协议不兼容。接口详细合同以更新中心项目的 `docs/api/client-integration.md`、`docs/api/client-updates.md` 为准；本文是客户端实施和验证清单，不代表服务已部署或产品已完成迁移。保留独立的 CloudBase `daily_active`，不从这里删除线上旧资源。

## 请求与身份

可信宿主调用 `POST /api/v1/apps/{app_id}/update-checks`，请求头包含 `Authorization: Bearer <运行时客户端 Token>`、`Content-Type: application/json` 和 `Accept: application/json, application/problem+json`。仅 HTTP 201 表示成功；401、429、503、超时和非法响应均为错误，不能当成已是最新。不要使用管理凭据、向前端暴露凭据或将其写入 Git、Profile、日志、命令行或截图。共享 Token 可以被提取，不代表用户身份；应有轮换及实际运行时注入机制。

请求体使用真实运行版本 `current_version`、`channel`（`stable|beta`）、`os`（`windows|macos|ubuntu|debian`）、2–4 段数字的 `os_version`、程序架构 `architecture`（`x86_64|arm64`）、`installation_type`（`installed|portable`）、持久随机 UUID v4 `installation_id`、可选 `locale`、`trigger`（`startup|scheduled|manual|pre_install`）和 `capabilities`。本机或构建工具中的 `x64` 映射到 `x86_64`；ARM 设备运行 x64 程序仍发送 `x86_64`。Linux 必须按实际发行版选 Ubuntu 或 Debian，不用猜测。身份不得由用户名、MAC、硬件序列号或 IP 派生。

能力必须真实存在：`download` 要求宿主能够下载并校验大小和 SHA-256；`auto_install` 还要求本地安装适配器，并同时声明 `download`。公共 SDK 的 `ClientUpdateService` 目前只执行检查和 `isSameInstallTarget` 对照，不自动下载、安装、持久化 UUID 或实现 UI。不得因使用 SDK 就假称这些能力已存在。

## 决策、强更与离线

只依据有效响应的 `enforcement=block_new_operations` 阻止开始新业务；`required=true` 但 `enforcement=none`（例如 `update_unavailable`）不能新增阻断。保留更新、重试和退出入口，不中断已经进行的任务；有效的新决定解除限制时恢复使用。提示内容按不可信纯文本显示。`scheduled_force_pending` 在 `force_after` 到期时重检，自动检查遵守 `next_check_after_seconds` 和 `Retry-After`，避免并发检查与下载。

Profile 必须确认 `offline_enforcement`：`service-default` 遵循服务端 `mandatory_cache_expires_at` 和接入合同的离线时限；`persist-until-resolved` 仅在产品负责人明确要求时采用，记录强更并跨重启持续阻断，直到运行目标版本或服务端明确解除。后一行为是产品特定例外，影响服务故障时的可用性，不能静默推广。对初次离线、凭据缺失、时间基准失效、存储损坏、服务撤销策略分别制定并测试产品行为；不要把连接失败伪装成 `no_update`。

## 下载、复检与安装

从当前快照的 `artifact.download_url` 请求，允许服务端重定向到其登记的文件服务；每跳仅允许安全 HTTPS，不向文件服务转发 Token。流式写入应用私有临时文件，校验实际字节数和 SHA-256，失败不得执行。下载入口返回 409/410 时重新检测，不能长期保存或构造旧链接。

安装前使用实际当前版本、`trigger=pre_install` 获取新检测，确认决定仍允许安装、目标版本、包 ID、长度、摘要和 action 未变；只有全部匹配才调用固定平台安装适配器，不执行服务端任意命令。哈希证明完整性，不能单独证明发布者身份；签名策略遵循产品约束。安装是否成功以重启后的真实版本和服务端结果确认。

## 验证与授权

本地测试覆盖请求、目标映射、201/错误、推荐/强更/不可更新、离线及重启、策略解除、恶意 URL、大小/摘要不符、下载重定向、过期快照、复检目标变化和退出。真实 E2E 使用本产品真实包，目标版本必须高于真实运行版本，记录制品版本与 SHA-256、请求结果、进程窗口和安装后版本；把开发构建、安装版、模拟服务、生产服务证据分别报告。每个平台独立验证。

规范一句话只授权当前客户端的本地接入和测试，不授权后台登记或发布、部署、构建安装、推送或删除；这些操作按现有阶段授权执行。线上 DNS、TLS、应用、策略和客户端 Token 未验证时标记 `Unverified`。
