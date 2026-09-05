# `bifang-screen-recorder` CloudBase 部署与线上 E2E 回执

## 结论

2026-09-05 在既有免费环境 `bifang-telemetry-prod-d8efa6a8d3` 中完成了 `bifang-screen-recorder` 的独立集合、Event 云函数、HTTP 路由和 Windows/macOS 更新清单部署。公网协议、写库、幂等和禁用清单的线上 E2E 通过；后续真实安装客户端发现 `.example.invalid` 会被更严格的宿主 URL 门禁拒绝，两个禁用清单已原位修复为同一批准默认域名下的 `not-published` 404 地址。

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
| Windows 清单 | `/updates/bifang-screen-recorder/windows.json`          | HTTP 200，`767` 字节，与本地逐字节一致                     |
| macOS 清单   | `/updates/bifang-screen-recorder/macos.json`            | HTTP 200，`761` 字节，与本地逐字节一致                     |

集合创建 RequestId：`87cf5ccf-1518-416b-904c-ebc6fdfe822a`；路由创建 RequestId：`1563f962-3f1a-4f7d-b3d5-b5e6fabe7ef7`。

## 更新清单字节证据

| 平台    | SHA-256                                                            | ETag                                 | 安全状态                                 |
| ------- | ------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------- |
| Windows | `3af69055ef09d21ce61e40f9f11fa0aa463deb54a2bf55cd4086d0cef07e2705` | `"a2281306c98017d1405654e84d36ed17"` | `enabled=false`、`rollout=0`、空制品哈希 |
| macOS   | `90db186b548123d50513ec3e01a2bb8bec0467bef7c6cb07705d8e2cc0dc52fe` | `"d63c9be1164470031f4684d4459c7bee"` | `enabled=false`、`rollout=0`、空制品哈希 |

CloudBase CLI 3.8.1 的单文件 `hosting deploy` 会返回 `successCount=0` 和 `verified=false`，因此本次没有把该字段当作成功证据；以远程对象列表、HTTP 200、长度、SHA-256 和逐字节相等作为验收证据。

## 禁用清单宿主兼容修复

- 真实 Windows 安装客户端首次复验返回 `unavailable`；远端清单本身是 200，但宿主会拒绝 `.example.invalid`，因此不能把它解析成明确的 `disabled`。
- 只覆盖了 `updates/bifang-screen-recorder/windows.json` 与 `updates/bifang-screen-recorder/macos.json`，没有部署目录、下载资源、发布说明、函数、路由或数据库变更。
- 两个平台的 `download_url` 与 `release_notes_url` 现在均位于批准默认 HTTPS 域名的 `/updates/bifang-screen-recorder/not-published/` 下；Windows 的 `windows.exe`、`windows-release-notes.html` 以及 macOS 的 `macos.dmg`、`macos-release-notes.html` 均实测 HTTP 404。
- 两个清单仍为 `enabled=false`、`force_update=false`、`rollout=0`、`sha256=""`，不会显示或下载更新；正式发布必须先上传并验证真实资源，再替换 URL 和哈希并另行启用。
- 公网两个清单均为 HTTP 200 且与本地 SHA-256 相同；旧 `updates/bifang-tools/windows.json` 继续为 404，新统计路由仍为 `GET=405`、`OPTIONS=204`。

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
- 阶段 4 验收时保留的旧 `bifang-tools` 静态清单已在负责人明确授权后精确清理；历史 `example-tool` 函数、路由、集合和清单仍保持不变。
- 未创建新环境，未使用自定义域名，未购买任何服务，未开启更新自动下载或安装。
