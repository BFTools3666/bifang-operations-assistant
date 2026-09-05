# `bifang-mouse-clicker` CloudBase 接入与线上协议回执

## 结论

2026-09-06，`bifang-mouse-clicker` 按“小工具主动接入运营精灵”的边界，在既有免费 CloudBase 环境 `bifang-telemetry-prod-d8efa6a8d3` 中完成独立应用登记、独立集合、独立 Event 云函数、独立 HTTP 路由和 Windows 更新清单部署。运营精灵没有扫描、发现或主动修改其他小工具。

本回执不包含登录态、云账号、密钥、Token、Cookie、Authorization、客户端真实安装标识或原始来源 IP。

## 免费与实时预检

- 环境状态：`NORMAL`；地域：`ap-shanghai`；套餐：体验版。
- 计费周期：`2026-09-03` 至 `2026-10-03`。
- 最新预检资源点：已用 `7.01 / 3000`。
- 套餐抵扣金额与按量扣费均为 `0`；未创建新环境、未购买域名或证书、未升级套餐、未开启自动续费。
- 复用默认 HTTPS 域名：`bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com`。
- 写入前已确认该 APP_ID 不存在同名函数、路由、集合或更新对象。

## 已部署资源

| 类型 | 精确资源 | 验证 |
| --- | --- | --- |
| 应用登记 | `bifang-mouse-clicker` / `windows` | `cloudbase/apps.json` 已登记 |
| 数据库 | `telemetry_bifang_mouse_clicker` | `ADMINONLY`，仅服务端管理权限 |
| 保留策略 | `expires_at_ttl` | `expires_at: 1`，`expireAfterSeconds: 0` |
| 云函数 | `telemetry-bifang-mouse-clicker` | Event / Nodejs20.19 / `index.main` / 3 s / 256 MB / Active |
| 函数配置 | `ALLOWED_APP_IDS=bifang-mouse-clicker` | 远程详情一致 |
| 函数配置 | `TELEMETRY_COLLECTION=telemetry_bifang_mouse_clicker` | 远程详情一致 |
| 函数配置 | `TRACK_PATH=/apps/bifang-mouse-clicker/v1/track` | 远程详情一致 |
| HTTP 路由 | `/apps/bifang-mouse-clicker/v1/track` | SCF 目标正确，启用路径透传，QPS `100` / ClientIP `10` |
| Windows 清单 | `/updates/bifang-mouse-clicker/windows.json` | 默认 HTTPS 返回 200，与本地逐字节一致，保持禁用 |

TTL 索引创建 RequestId：`c559837f-2ed0-4608-988c-5322b3615dca`；索引复核 RequestId：`d484df8c-e8dd-44d4-8e36-3d4be7c9438b`。

## 公网协议与写库 E2E

使用一次性合成 UUID 调用真实默认 HTTPS 端点：

| 用例 | 实际结果 |
| --- | --- |
| 正确路径 `OPTIONS` | `204` |
| 合法 schema v2 `daily_active` | `202 {"ok":true}` |
| 同一事件原样重放 | `202 {"ok":true}`，集合仍只有一条对应记录 |
| 多余字段 | `400 invalid_payload` |
| 未登记 `app_id` | `403 unknown_app` |
| 错误 GET 方法 | `405 method_not_allowed` |
| 错误子路径 | `404 not_found` |

认证数据库查询只投影了协议字段、服务端时间与 `expires_at`；没有查询或回显 `source_ip`。保留策略复验得到一条合成记录，其 BSON `expires_at` 精确为服务端 `received_at` 后 30 天。该次查询 RequestId：`1ea9020d-2391-437d-882d-4dcfe4ce661a`。

## 本地合同验证

运营精灵 `npm run check` 全量通过：

- SDK Node 测试 `52/52`。
- CloudBase 函数测试 `32/32`。
- 仓库合同、Skill 与资源规划测试 `59/59`。
- Python GUI/桥接测试 `41/41`。
- 格式、TypeScript 类型检查、workspace 构建与示例类型检查全部通过。

## Windows 安装态观察与清理

- 精确客户端提交 `86bb78fcbc722841d10659e888d6b388bc8ca8b5` 构建的 `v0.2.2` NSIS 安装包完成专用路径安装，安装与卸载均退出 `0`。
- 首次 `undecided` 启动使目标集合保持 `2`；隔离测试状态明确设为 `granted` 后目标集合精确增加到 `3`；第二实例和同一上海自然日完整重启均保持 `3`；隔离测试状态设为 `declined` 后仍保持 `3`。
- 其他应用集合 `telemetry_bifang_screen_recorder` 在全部观察期间保持 `4`，证明没有跨应用写入。
- 客户端新增记录只投影非 IP、非安装标识字段，确认 schema v2、`daily_active`、APP_ID、`0.2.2`、Windows/x64、SDK `2.0.0`、服务端日期与 30 天到期时间。
- 观察完成后按本轮查询得到的三个精确 `_id` 删除测试记录，返回 `n=3`；复核目标集合为 `0`、其他应用集合仍为 `4`。没有删除集合、TTL、函数、路由、清单或其他应用资源。
- 最终免费用量为 `7.16 / 3000` 资源点，`packageDeduct=0`、`payAsYouGoDeduct=0`，环境仍为体验版 `NORMAL`。

完整客户端 E2E 没有通过：当前 Windows Computer Use 原生 RPC 未配置，无法取得规定的真实 GUI 点击与截图证据。候选的 Authenticode 状态为 `NotSigned`，仓库也没有批准的非交互签名钩子，因此没有上传 unsigned 安装包、没有启用更新清单、没有正式发布。

## 边界与后续门禁

- 当前 Windows 更新清单保持 `enabled=false`、`rollout=0`，公网 SHA-256 为 `54b885e8d40e5aac65715f80e858bc3d447197ef72fa13f4a2c7bb1ca6306694`，不会触发客户端更新。
- 统计只接收固定最小字段；30 天到期由目标集合 TTL 索引删除。
- 正式更新发布仍必须先形成可验证的最终制品、SHA-256 与所需签名，再上传制品并最后启用清单；禁用清单不构成发布成功。
- 本次只创建并部署 `bifang-mouse-clicker` 的目标资源；没有变更其他应用的远程函数、路由、集合或更新对象。
