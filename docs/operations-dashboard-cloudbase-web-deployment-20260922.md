# 运营看板 CloudBase 网页部署回执（2026-09-22）

## 结论

2026-09-22（北京时间），经负责人在最终预检后明确回复“继续”，已将运营看板网页部署到既有 CloudBase 环境 `bftoos-sh-d3ga7hahz59229f0a`：

- 访问地址：`https://bftoos-sh-d3ga7hahz59229f0a-1484029710.ap-shanghai.app.tcloudbase.com/dashboard`
- 页面、JavaScript、CSS、登录、退出、会话、指标查询和原管理员指标接口均通过公网 HTTPS 验证。
- 浏览器只提交独立站访问密钥；原始 CloudBase 聚合接口 Token 不会发送到浏览器，也没有上传到函数环境变量。
- 本次复用既有 `operations-dashboard-api`，没有创建第二个 CloudBase 环境。

## 最终目标和写入范围

| 项目         | 最终值                                           |
| ------------ | ------------------------------------------------ |
| 环境         | `bftoos-sh-d3ga7hahz59229f0a`（上海）            |
| 函数         | 原地更新 `operations-dashboard-api`              |
| 函数 ID      | `lam-rteriz3b`                                   |
| 运行时       | `Nodejs20.19`                                    |
| Handler      | `index.main`                                     |
| 超时 / 内存  | 3 秒 / 256 MB                                    |
| 新路由       | `/dashboard` -> SCF `operations-dashboard-api`   |
| 路由限流     | 总 QPS 100；单 ClientIP QPS 10                   |
| 既有管理路由 | `/admin/v1/metrics` 保留，仍由 Bearer Token 鉴权 |

部署使用的已审阅材料 SHA-256 为 `055af8eadeb583b8ceb93163726062a9d3993a819df96b3316e6a7effde7a556`。函数更新后最终读回时间为 `2026-09-22 13:32:55`，状态为 `Active / Available`，代码大小为 9,144,735 字节。

`/dashboard` 路由创建请求 RequestId 为 `2798ffa4-936b-4e7c-be42-e9cfc15bc2c3`，创建时间为 `2026-09-22T13:29:13+08:00`。最终读回确认默认 HTTP 服务域名为 `SUCCESS / DNS OK`，全部原有 5 条业务路由仍在，新路由配置为 enabled、safe domain、path transmission，CloudBase 网关鉴权关闭，由函数会话鉴权。

## 凭据与安全边界

CloudBase 函数环境变量最终只有以下 6 个键：

- `CLOUDBASE_ENV_ID`
- `DASHBOARD_ACCESS_TOKEN_SHA256`
- `DASHBOARD_APPS_JSON`
- `DASHBOARD_PATH`
- `DASHBOARD_TOKEN_SHA256`
- `DASHBOARD_WEB_PATH`

两个原始 Token 只保存在 Git 忽略的本地密钥文件中，CloudBase 只保存各自的 SHA-256；本回执不记录原始 Token 或完整摘要。网页登录成功后使用 `HttpOnly; Secure; SameSite=Strict; Path=/dashboard` 的 12 小时签名会话 Cookie。

页面响应包含 CSP、禁止 iframe、`nosniff` 和禁止搜索引擎索引等安全响应头。未登录指标请求、错误访问密钥、缺失管理员 Token 和错误管理员 Token 均返回 401。

## 验证结果

部署前及修正后的直接相关测试共 44/44 通过：

- 函数测试：26/26
- CloudBase 配置、部署门禁和仓库契约测试：18/18
- 生成配置检查：通过

2026-09-22 最终公网验证全部通过：

- 页面、JavaScript、CSS：200
- 初始会话：200，`authenticated=false`
- 未登录指标：401
- 错误访问密钥：401
- 正确登录与安全 Cookie：200
- 登录后会话：200，`authenticated=true`
- 登录后指标：200，`app_id=all`，`days=7`
- 管理接口缺失 Token：401
- 管理接口错误 Token：401
- 管理接口正确 Token：200
- 退出：200

## 免费额度复核

部署完成后的只读复核结果：

- 套餐：体验版（`baas_trial`），状态 `NORMAL`
- 自动续费：关闭
- 超限扣费：关闭
- 到期时间：`2027-03-17 23:59:59`
- 当前计费周期：`2026-09-17` 至 `2026-10-17`
- 积分：已用 3.44 / 3000
- 按量付费扣费：0
- 付费订单、扩展资源包：无

## 明确未执行

- 未创建第二个环境，未购买或升级套餐、域名、证书或资源包。
- 未开启自动续费、超限扣费或按量超限。
- 未修改数据库集合、记录、ACL 或索引。
- 未修改 telemetry、application-version 函数及其路由。
- 未删除、覆盖或迁移任何既有 CloudBase 资源。
- 未重新上传或修改用户自建服务器上的旧独立站部署；CloudBase 页面不依赖该服务器。
- 未修改、构建或发布业务客户端。
- 未推送 Git 远端。
