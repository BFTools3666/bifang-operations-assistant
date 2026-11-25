# PostgreSQL 资源与运行时适配

核对日期：2026-11-18。个人模式默认 `cloudbase.database_type=postgresql`，使用客户已有免费 PostgreSQL 环境和腾讯云 `pgdoc` Document 插件。仍使用集合 API，但数据由 PostgreSQL 承载；不能据 `.collection()` 推断底层是旧文档数据库。此实现不需要客户提供 PG 密码、连接串、端口或额外数据库实例。

## 第一门禁：默认值与只读取证

本流程涉及客户操作云端时，在当次提示逐项展开[官方页面指引](../assets/console-guides.json)中适用的 postgres、collections、indexes：给可点击入口、页面内位置、目标字段或操作和完成标志。

- init 已填 `postgresql`，不再让客户选择或填写数据库类型。旧文件空值按该默认值验证；旧文件明确填 `document` 时，只在客户已确认 PostgreSQL 后本地更正该非敏感字段，保留其他字段和原凭据，不能重新索要密钥。
- `DescribeEnvs` 必须返回目标环境唯一的 `PostgreSQL` 条目，读取 `Name`、`InstanceName`、`Region`。不能检查 `Databases[0].InstanceId` 是否以 `tnt-` 开头来判定 PostgreSQL；官方 `Status` 未列出完整枚举，不能把示例整数当状态契约。
- 免费套餐/账期/额度通过后，`ExecutePGSql` 只执行工具内固定的系统目录 SELECT，确认 SQL 可访问及 `pgdoc` 扩展、schema 是否存在。该查询不读取客户业务数据，不接受客户 SQL、角色或连接串。
- 回执的 `database` 为 `type=postgresql`、`document_api=pgdoc`、`sql_connectivity=verified`、`plugin=ready/missing`。missing 可通过第一门禁，留第二门禁准备；partial、类型不符或无法核验停止。不能用模板默认值代替实际读回。
- 两份 CAM 策略仍在第一门禁一起关联：检查策略增加 `tcb:ExecutePGSql`，创建策略增加 `tcb:EnablePGDocumentExt`。前者本身有 SQL 写能力；本工具只开放精确固定 SELECT，这不是 CAM 层面的只读权限。后者只在第二门禁具体计划授权后调用。

## 第二门禁：插件、集合、函数与路由

清单必须先展示 PostgreSQL / pgdoc 状态，再列统计、更新、大屏资源。随后客户选择手动、自动或已有仅检查；不能因插件已经存在跳过资源核验。

| 状态/方式               | 操作与通过条件                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pgdoc ready             | 复用插件，不重复启用；继续完整读取集合、基础权限、索引、函数和路由                                                                                                                                                 |
| pgdoc missing，自动创建 | plan 把 `EnablePGDocumentExt {EnvId:目标环境}` 列为第一项；精确计划获授权后 apply；必须返回 `Enabled:true`，随后只读系统目录核验 ready，再重新盘点资源。新盘点与剩余计划不一致就停止、重新审阅，不继续按旧假设写入 |
| pgdoc missing，手动创建 | 客户在目标环境“PostgreSQL 管理 → Document 编辑器”启用插件；没有费用、清空数据或升级提示才继续。prepare 只交付离线材料，不代表插件已检查；客户完成后 verify 核验插件和全部资源                                      |
| 插件已建、其他资源已建  | 用原材料与凭据只读 verify；客户声明、能打开编辑器或函数存在均不代替完整核验                                                                                                                                        |

普通资源继续由 `CreateTable` 创建 pgdoc 集合，基础权限固定 `ADMINONLY`（客户端无权限）；服务端执行鉴权和输入校验，不使用 pgdoc 不支持的 CUSTOM 安全规则。`UpdateTable` 创建普通索引，`RunCommands` 只读回精确索引，三类函数通过 Node SDK 访问当前环境；HTTP 路由与客户端请求协议保持一致。

### 必须停止的情况

- pgdoc 缺失且环境还列有旧文档库：`PGDOC_LEGACY_DATABASE_CONFLICT`。官方提示启用涉及旧库处理；普通创建授权不包含迁移、清空或销毁，不能自动去控制台二次确认。
- 扩展和 schema 仅部分存在：`PGDOC_PARTIAL_INSTALLATION`。不手工 CREATE/DROP EXTENSION，不改平台维护对象。
- `Enabled` 不是 true、读回超时、API 未开放、权限不足、共享实例内核不支持：记录脱敏错误并停止，不升级独享、不改参、不重启、不反复尝试写入。按官方对应错误说明处理后重新 plan。
- 控制面无法确认索引参数或 ACL、函数配置不一致：不得跳过或降级通过，不覆盖原资源。

## 三类云函数

| 服务 | PostgreSQL 访问方式与保留行为                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 统计 | Node SDK v3 `database().collection().add()` 走 pgdoc；保留服务端每日唯一 `_id`、重复写幂等、Date 类型 expires_at、HTTP 202 与十字段请求 |
| 更新 | Node SDK v3 pgdoc 事务写版本/唯一键/审计；保留版本排序和应用隔离，客户端 GET 路径、凭据头及七字段响应保持不变                           |
| 大屏 | Node SDK v3 pgdoc 按日期和 `_id` 分页查询统计及最新版本；每次调用取平台临时凭据，不用跨请求数据库游标，不暴露明细或凭据                 |

三个部署包统一锁定 `@cloudbase/node-sdk@3.18.3`，为官方说明支持的 Node SDK v3 `/admin` 入口；不把 Web SDK 临时凭据配置原样套进 Node SDK。当前调用的可信运行时 STS 映射为 `secretId/secretKey/sessionToken`，未提供时使用平台运行时身份。管理文件的长期 CAM 密钥不进入函数包/环境变量/客户端。仅从函数 context 取临时凭据，不接受请求 body、header 自报身份。客户端可信职责仍由 Rust 实现。

统计集合写入接收时间加 30 天的 `expires_at` 字段。新环境由技能创建的统计集合没有自动删除策略。旧环境的额外索引由环境所有者管理。见[统计数据与旧任务](retention-cleanup.md)。

## 验证与证据层级

本地测试覆盖 PostgreSQL 识别、固定 SQL 白名单、插件启用顺序、失败/旧库共存阻断、启用后差异复核、幂等计划，以及三类函数的 SDK 签名、临时凭据更新和现有业务合同。它们不连接真实云环境。

`access-verified` 只代表环境与只读访问；`resources-control-plane-verified` / `resources-created-control-plane-verified` 只代表资源配置；第三门禁仍须确认完整请求，第四门禁才实施客户项目，第五门禁做限定更新预检，第六步按授权做 EXE 和真实服务验收。保持原门禁顺序，不因 PostgreSQL 适配合并门禁。

## 官方依据

- [pgdoc 插件及启用边界](https://docs.cloudbase.net/database/postgresql/pg-doc)
- [pgdoc SDK、事务、权限与索引兼容范围](https://docs.cloudbase.net/database/postgresql/pg-doc-usage)
- [EnablePGDocumentExt 参数、成功标记与费用说明](https://cloud.tencent.com/document/api/876/140402)
- [EnvInfo.PostgreSQL 与 PostgreSQLInfo](https://cloud.tencent.com/document/product/876/34822)
- [ExecutePGSql 输入与返回格式](https://cloud.tencent.com/document/product/876/130469)
- [CloudBase CAM 动作与资源粒度](https://cloud.tencent.com/document/product/598/98174)

官方版本和套餐有时效性，执行前以目标环境及最新官方支持为准。上述公开资料核对不等于已在客户账号部署或验收。
