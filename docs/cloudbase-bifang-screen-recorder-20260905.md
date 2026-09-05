# `bifang-screen-recorder` CloudBase 部署与线上 E2E 回执

## 结论

2026-09-05 在既有免费环境 `bifang-telemetry-prod-d8efa6a8d3` 中完成了 `bifang-screen-recorder` 的独立集合、Event 云函数、HTTP 路由和 Windows/macOS 更新清单部署。公网协议、写库、幂等和禁用清单的线上 E2E 通过。

本回执不包含登录态、云账号、密钥、Token、Cookie、Authorization 或原始来源 IP。

## 免费与实时预检

- 环境：`bifang-telemetry-prod-d8efa6a8d3`，状态 `NORMAL`，地域 `ap-shanghai`。
- 套餐：体验版；计费周期 `2026-09-03` 至 `2026-10-03`。
- 资源点：总额 `3000`，本次预检时已用 `6.6`。
- 按量扣费：`0`；未购买域名、证书、新套餐或第二环境。
- 默认 HTTPS 域名：`bifang-telemetry-prod-d8efa6a8d3-1251031333.ap-shanghai.app.tcloudbase.com`。
- 写入前已确认目标函数、路由、集合与两个对象均不存在；旧链路实时基线为函数 `telemetry`、路由 `/v1/track`、集合 `telemetry_events` 共 `44` 条以及旧 Windows 清单。

## 已部署资源

| 类型         | 精确资源                                                | 验证                                                       |
| ------------ | ------------------------------------------------------- | ---------------------------------------------------------- |
| 数据库       | `telemetry_bifang_screen_recorder`                      | 创建成功，起始计数 `0`，`DescribeDatabaseACL=ADMINONLY`    |
| 云函数       | `telemetry-bifang-screen-recorder`                      | Event / Nodejs20.19 / `index.main` / 3 s / 256 MB / Active |
| 函数配置     | `ALLOWED_APP_IDS=bifang-screen-recorder`                | 远程详情精确一致                                           |
| 函数配置     | `TELEMETRY_COLLECTION=telemetry_bifang_screen_recorder` | 远程详情精确一致                                           |
| 函数配置     | `TRACK_PATH=/apps/bifang-screen-recorder/v1/track`      | 远程详情精确一致                                           |
| HTTP 路由    | `/apps/bifang-screen-recorder/v1/track`                 | SCF 目标正确，已启用，无身份认证，开启安全域和路径透传     |
| 限频         | 总 QPS `100`，ClientIP QPS `10`                         | `DescribeHTTPServiceRoute` 精确返回                        |
| Windows 清单 | `/updates/bifang-screen-recorder/windows.json`          | HTTP 200，`611` 字节，与本地逐字节一致                     |
| macOS 清单   | `/updates/bifang-screen-recorder/macos.json`            | HTTP 200，`609` 字节，与本地逐字节一致                     |

集合创建 RequestId：`87cf5ccf-1518-416b-904c-ebc6fdfe822a`；路由创建 RequestId：`1563f962-3f1a-4f7d-b3d5-b5e6fabe7ef7`。

## 更新清单字节证据

| 平台    | SHA-256                                                            | ETag                                 | 安全状态                                 |
| ------- | ------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------- |
| Windows | `6ee5116ec7d41471c25886c0993d7f8d42ee6ebb6e9ae01db7d80a9442451a1e` | `"d7e878e2562834bbd70b4cb9f3d02f47"` | `enabled=false`、`rollout=0`、空制品哈希 |
| macOS   | `1c3899fbf850c0670bdee45d43213b6f43e23b4de78efb2418b141312f52c758` | `"5bad19fc566bdbd949f44f4c31d8895d"` | `enabled=false`、`rollout=0`、空制品哈希 |

CloudBase CLI 3.8.1 的单文件 `hosting deploy` 会返回 `successCount=0` 和 `verified=false`，因此本次没有把该字段当作成功证据；以远程对象列表、HTTP 200、长度、SHA-256 和逐字节相等作为验收证据。

## 公网统计 E2E

使用新生成的合成 UUID 调用真实默认 HTTPS 域名：

| 用例                          | 实际结果                 |
| ----------------------------- | ------------------------ |
| `OPTIONS` 正确路径            | `204`                    |
| 合法 schema v2 `daily_active` | `202 {"ok":true}`        |
| 原样重放                      | `202 {"ok":true}`        |
| 多余 `properties` 字段        | `400 invalid_payload`    |
| 错误 `app_id=bifang-tools`    | `403 unknown_app`        |
| 错误 GET 方法                 | `405 method_not_allowed` |
| 错误子路径                    | `404 not_found`          |

合法请求的合成 `install_id` 为 `141b0634-7fb5-4466-8403-e67e9b8ff39d`。认证 NoSQL 查询只投影非 IP 字段，结果为：

- 目标安装标识对应文档数精确为 `1`，证明重放没有新增第二条。
- 文档中 `app_id=bifang-screen-recorder`、`event=daily_active`、`app_version=0.7.0`、`platform=windows`、`arch=x64`、`sdk_version=2.0.0`。
- `active_date` 和 `received_at` 由服务端生成；本回执故意不查询或回显 `source_ip`。
- 全集合最终计数为 `1`，证明不合法用例均未写库。

## 本地验证

`npm run check` 通过：

- SDK Node 测试 `52/52`。
- CloudBase 函数测试 `32/32`。
- 仓库合同/Skill/资源规划测试 `59/59`。
- Python GUI/桥接测试 `41/41`。
- 格式、TypeScript 类型检查、workspace 构建与示例类型检查全部通过。

## 边界

- 两个更新清单仍为故意禁用的占位状态；本次不是客户端正式发布。
- 阶段 4 验收时保留了旧 `bifang-tools` 链路；只有新客户端完成后续 E2E 后才按负责人的明确授权进行精确清理。
- 未创建新环境，未使用自定义域名，未购买任何服务，未开启更新自动下载或安装。
