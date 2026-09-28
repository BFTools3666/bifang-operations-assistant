# 毕方运营统计独立站

这是从现有 ChatGPT/Sites 看板中隔离出来的普通 Web 页面。它是一个独立 Node.js 子应用，不导入、不修改也不替换 `apps/operations-dashboard`，两者可以并行存在。

## 能力与边界

- 普通浏览器直接访问，不依赖 ChatGPT 登录态或 `chatgpt.site`。
- 独立访问密钥登录，成功后使用 `HttpOnly`、`SameSite=Strict` 的签名会话 Cookie。
- 浏览器只访问同源 `/api/metrics`；CloudBase Bearer Token 始终留在服务端。
- 继续使用现有只读 `/admin/v1/metrics` 聚合接口，不直连数据库，不返回 `install_id`、`event_id` 或来源 IP。
- 不包含发布、写数据库、删除资源、修改套餐或付费能力。
- 没有模拟数据 fallback；缺少配置或生产请求失败时明确显示不可用。

## 本地运行

PowerShell 示例：

```powershell
$env:CLOUDBASE_METRICS_TOKEN = '<现有只读聚合 Token>'
$env:DASHBOARD_ACCESS_TOKEN = '<新建的至少 32 字节访问密钥>'
$env:COOKIE_SECURE = 'false'
node server.mjs
```

打开 `http://127.0.0.1:4173`。`COOKIE_SECURE=false` 只用于本机 HTTP；正式站点必须使用 HTTPS，并保留默认的 Secure Cookie。

应用登记仍以仓库根目录的 `cloudbase/apps.json` 为唯一权威。服务默认从该文件读取应用和发布流，不维护第二份登记表。若只复制此子目录到独立部署目录，可通过 `DASHBOARD_APPS_FILE` 指向从同一权威仓库随部署带入的 `apps.json`。

## 部署前要求

1. 使用支持 Node.js 20+ 和 HTTPS 的普通 Web 托管服务或自有服务器。
2. 只在服务端 Secret 中配置 `CLOUDBASE_METRICS_TOKEN` 与 `DASHBOARD_ACCESS_TOKEN`，不要使用任何公开前缀。
3. `DASHBOARD_ACCESS_TOKEN` 必须与 CloudBase Token 不同，并至少 32 字节。
4. 反向代理需保留同源 Cookie；不要把 `/api/metrics` 配置成跨域公开接口。
5. 先运行 `node --test tests/*.test.mjs`，再进行只读页面验收。

本目录没有部署脚本，创建托管服务、绑定域名、发布或购买资源仍需单独授权。

完整的 Linux、systemd、Nginx、HTTPS、验收、更新与回滚步骤见
[`DEPLOYMENT.md`](DEPLOYMENT.md)。
