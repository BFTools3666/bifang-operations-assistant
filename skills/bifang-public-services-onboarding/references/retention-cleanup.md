# 普通索引与定时清理

核对日期：2026-11-18。个人版从 `3.0.0-personal.11` 起采用本方案；它替换统计 TTL 机制，不改变统计十字段协议、每日去重和更新接口。旧计划摘要不能授权新增函数、触发器或未来过期数据删除；展示新完整计划并确认后才 apply。客户只要求改规范或只读盘点时，不创建触发器、不调用清理函数、不删除记录。

## 资源与保留行为

- 统计集合仍为 `telemetry_<normalized_app_id>`，ADMINONLY，写入服务端 Date 类型 `expires_at = received_at + 30 天`。
- 必需普通复合索引 `expires_at_cleanup`，顺序 `{expires_at:1,_id:1}`，非唯一、非稀疏，没有 TTL/partialFilterExpression。所有普通索引用官方 `tcb:UpdateTable` 的 CreateIndexes 创建；RunCommands 仅用于 listIndexes 读回。
- 每个应用新增 `cleanup-<app_id>`，Event、Nodejs20.19、256 MB、3 秒、入口 `index.main`（ZIP 根部适配文件转调 `src/cleanup.js`），复用统计源码，单独生成带清理入口的部署包；环境变量仅 CLOUDBASE_ENV_ID、ALLOWED_APP_IDS、TELEMETRY_COLLECTION。运行身份 TCB_QcsRole，不上传 CAM 密钥，无 HTTP 路由。
- 每个清理函数新增 timer `cleanup-expired`，绑定 `$LATEST`，cron `0 */15 * * * * *`（每 15 分钟），CustomArgument=`telemetry-cleanup-v1`，Enable=OPEN。每 15 分钟的间隔不受 UTC/北京时间整点差异影响。
- 每轮固定开始时间作为到期截止，按 expires_at / _id 排序最多取 100 个 ID；删除仍附带应用、schema_version=2、event=daily_active、到期时间和这批 ID 条件。禁止操作更新/广告/审计集合，不接受请求提供的集合、应用、ID 或截止时间。
- SDK 单次请求 timeout=800 ms；读取后耗时达到 1600 ms 就停止，不发删除；每轮最多一次查询和一次删除，无循环或无界扫描。重复触发可幂等执行。失败保留数据，下一轮重新查到期记录。3 秒运行上限包括冷启动，不能承诺每轮一定完成。
- 输出只有状态、读取/删除计数和 batch_full；不记录 ID、IP、文档或密钥。batch_full 持续出现或失败意味着清理可能积压，应查看调用日志与额度，不自动升级套餐或无限加快频率。
- 语义是“30 天后到期，定期分批物理删除”，不是精确 30 天删除 SLA；正常无积压时通常在后续周期处理，故障和积压会延长。普通索引本身不清数据，大屏日期过滤也不等于物理删除。

## 权限、计划与核验

第一门禁策略模板新增检查 `scf:ListTriggers`，创建 `tcb:UpdateTable`、`scf:CreateTrigger`。旧版任务只补这三个差异，不重建子用户、不重新索取密钥；由客户在 CAM 更新/关联，助手不修改权限。UpdateTable 自身有删除/替换索引能力，策略并非仅创建；工具只允许精确计划的 CreateIndexes，不发送 DropIndexes，写前重读避免覆盖并发出现的同名索引。API 无条件创建机制无法消除最后一刻并发修改，创建期间应避免人工修改相同索引。

计划顺序：缺少插件 → 集合/权限 → 普通索引 → 统计/清理/更新/大屏函数 → HTTP 路由 → timer。触发器最后创建，创建后会按计划自动删除到期统计记录，必须在确认正文说明。旧 TTL 索引如已经存在，保留并报告，不自动删除或转换；存在同名不同配置索引、函数或触发器则停止。

读回索引键顺序与无 TTL 属性；读回函数 Active、部署标记、Handler、Runtime、内存、超时与环境变量；ListTriggers 完整分页检查名称、类型、cron、CustomArgument、Qualifier、Enable=1、AvailableStatus=Available。同名冲突或盘点不完整不得通过。触发器不存在的父函数也缺少时，可据父函数完整盘点判缺少，不用不存在的函数来证明触发器权限已验证。

prepare 交付四类函数 ZIP/配置及 triggers，手动分支在其它资源核验完成后再配置触发器。自动 apply 逐项读回；verify 只读，不调用清理函数。控制面通过不代表实际清理已运行。真实验收需要明确隔离的过期/未过期测试记录和删除授权，验证范围、重复触发、耗时与清理结果；未做标未测，不能以模拟测试代替。

## 免费套餐证据分层

1. 官方套餐：上海免费体验 PostgreSQL、云函数可用；函数固定 256 MB / 3 秒，每月 3000 资源点。官方提供 timer，文档没有声明必须购买付费套餐，但这不等于已实测目标环境可创建。
2. 账号只读：继续 DescribeEnvs / DescribeBillingInfo / DescribeEnvAccountCircle / DescribeBaasPackageList / DescribeCreditsUsage / 固定 PG 探测；确认 baas_trial、未开启超限与自动续费、额度足够、pgdoc ready。原始资源套餐限制在私有材料留存，正文只展示允许字段。ListTriggers 可读仅证明相应读取权限。
3. 实施后：索引、函数、触发器实际接受并读回才是目标环境支持证据。只读阶段将新写权限、普通索引创建、timer 创建与真实清理性能标为待验证，不用试写补证据。任何付费或升级要求立即停止。

每应用单个 timer 每天约 96 次、30 天约 2880 次调用；按 256 MB、每次最多 3 秒估算，调用及执行资源约 4.1 点/30天，另有数据库、日志及其它业务资源消耗。该估算不包含平台重试，不是总费用或零消耗承诺；同时有 Windows/macOS 发布流不会为同一 app 复制清理函数。

官方依据：[计费与免费限制](https://cloud.tencent.com/document/product/876/127357)、[普通索引 UpdateTable](https://cloud.tencent.com/document/api/876/127964)、[索引字段结构](https://cloud.tencent.com/document/api/876/34822)、[CloudBase 定时触发器](https://docs.cloudbase.net/cloud-function/timer-trigger)、[创建触发器](https://cloud.tencent.com/document/api/583/18589)、[查询触发器](https://intl.cloud.tencent.com/zh/document/api/583/36314)、[触发器字段](https://cloud.tencent.com/document/api/583/17244)。
