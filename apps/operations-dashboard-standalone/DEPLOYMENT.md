# 毕方运营统计独立站生产部署手册

本文用于把 `apps/operations-dashboard-standalone` 发布到一台普通 Linux 服务器，通过独立 HTTPS 域名在浏览器中访问。推荐拓扑为：

```text
浏览器
  -> HTTPS 443 / Nginx
  -> HTTP 127.0.0.1:4173 / Node.js 独立站
  -> HTTPS /admin/v1/metrics / 现有 CloudBase 只读聚合接口
  -> ADMINONLY telemetry_* 与 versions_* 集合
```

独立站不会替换或修改 `apps/operations-dashboard`，也不要求重新部署 CloudBase。浏览器不会拿到 CloudBase Token，不会直连数据库，页面没有发布版本、写数据库、删除资源或修改套餐的能力。

本文默认：

- 服务器系统为 Ubuntu 22.04/24.04 或兼容的 Debian 系统；
- 已有一台服务器和一个已解析到该服务器的域名，例如 `stats.example.com`；
- 使用 Node.js 20 或更高版本；
- 使用 Nginx 终止 HTTPS，Node.js 只监听 `127.0.0.1:4173`；
- 使用 systemd 管理进程；
- 发布包来自一个已经审核并提交的准确 Git 提交。

如果域名、证书、服务器或公网带宽会产生费用，先停止并由负责人确认。不要因为本手册自动购买域名、证书、套餐或其他资源。

## 1. 发布前必须准备的信息

| 项目                      | 示例                | 要求                                                |
| ------------------------- | ------------------- | --------------------------------------------------- |
| 域名                      | `stats.example.com` | DNS 已指向目标服务器                                |
| 服务器地址                | `203.0.113.10`      | 具备 SSH 管理权限                                   |
| 发布提交                  | `0123456...`        | 必须是已审核的准确提交                              |
| CloudBase 聚合地址        | 仓库内默认地址      | 路径必须是 `/admin/v1/metrics`                      |
| `CLOUDBASE_METRICS_TOKEN` | 不展示              | 使用现有原始只读 Token，至少 32 字节                |
| `DASHBOARD_ACCESS_TOKEN`  | 不展示              | 新生成、至少 32 字节，且不得与 CloudBase Token 相同 |

### 两个 Token 的区别

`CLOUDBASE_METRICS_TOKEN` 是独立站服务端调用现有 CloudBase 聚合接口使用的 Bearer Token。CloudBase 端只保存它的 SHA-256。它不能进入 Git、浏览器、命令行参数、截图或普通日志。

`DASHBOARD_ACCESS_TOKEN` 是浏览器登录独立站时使用的新访问密钥。登录成功后，服务端只向浏览器设置签名的 `HttpOnly`、`SameSite=Strict`、`Secure` 会话 Cookie，不会把密钥写入 Local Storage 或 Session Storage。

两个值必须不同。如果现有 `CLOUDBASE_METRICS_TOKEN` 原值已经遗失，不能从 CloudBase 中保存的 SHA-256 反推；此时需要走 CloudBase Token 轮换和函数配置更新流程。该流程属于云端写入，必须另行预检和授权，不能在服务器部署中擅自执行。

### 生成独立站访问密钥

在可信机器上生成，不要把输出贴到聊天、工单或提交中：

```bash
openssl rand -base64 48
```

把生成结果保存到密码管理器，作为 `DASHBOARD_ACCESS_TOKEN`。不要复用账号密码、CloudBase Token 或 SSH 密钥。

## 2. 发布前本地检查

先确认工作区中需要发布的独立站已经进入 Git。当前目录不能只保持为未跟踪文件，否则 `git archive` 不会把它打进发布包。

```bash
git status --short
git rev-parse HEAD
git ls-files apps/operations-dashboard-standalone cloudbase/apps.json
```

必须看到以下关键文件受 Git 管理：

```text
apps/operations-dashboard-standalone/server.mjs
apps/operations-dashboard-standalone/public/index.html
apps/operations-dashboard-standalone/public/app.js
apps/operations-dashboard-standalone/public/styles.css
apps/operations-dashboard-standalone/package.json
apps/operations-dashboard-standalone/tests/server.test.mjs
cloudbase/apps.json
```

运行专项验证：

```bash
cd apps/operations-dashboard-standalone
node --check server.mjs
node --check public/app.js
node --test tests/*.test.mjs
```

预期所有测试通过。不要把测试失败的版本打包发布。

应用和发布流登记仍以仓库根目录的 `cloudbase/apps.json` 为唯一权威。不能在服务器上另建一份长期独立维护的登记表，也不能为了让页面通过校验而手工伪造应用或发布流。

## 3. 制作可追溯发布包

推荐从准确提交制作只包含独立站和权威应用登记的压缩包。以下命令在仓库根目录执行，把 `<commit>` 替换为完整提交哈希：

```bash
git archive \
  --format=tar.gz \
  --output=bifang-operations-dashboard-<commit>.tar.gz \
  <commit> \
  apps/operations-dashboard-standalone \
  cloudbase/apps.json

sha256sum bifang-operations-dashboard-<commit>.tar.gz
```

Windows PowerShell 可以使用：

```powershell
git archive --format=tar.gz --output=bifang-operations-dashboard-<commit>.tar.gz <commit> apps/operations-dashboard-standalone cloudbase/apps.json
Get-FileHash -Algorithm SHA256 bifang-operations-dashboard-<commit>.tar.gz
```

记录：

- 完整 Git 提交哈希；
- 发布包文件名；
- 发布包 SHA-256；
- 制作时间；
- 操作人。

通过已有的安全文件传输方式把发布包上传到服务器临时目录，例如 `/tmp/`。不要把 Token 放进发布包。

## 4. 服务器基础环境

### 4.1 创建专用系统用户

```bash
sudo useradd \
  --system \
  --home /nonexistent \
  --shell /usr/sbin/nologin \
  bifang-dashboard
```

如果用户已经存在，`useradd` 会报错；先用以下命令确认，不要重复创建：

```bash
getent passwd bifang-dashboard
```

### 4.2 安装并检查 Node.js

通过服务器操作系统或 Node.js 官方渠道安装 Node.js 20 或更高版本。安装后确认 systemd 将使用的准确路径和版本：

```bash
command -v node
node --version
```

本文后续假设路径为 `/usr/bin/node`。如果实际路径不同，必须在 systemd 单元的 `ExecStart` 和 `ExecStartPre` 中使用 `command -v node` 返回的绝对路径。

独立站没有第三方运行时依赖；发布服务器不需要执行 `npm install`，也不需要把开发环境的 `node_modules` 上传到服务器。

### 4.3 安装 Nginx

```bash
sudo apt-get update
sudo apt-get install nginx
sudo nginx -v
```

不要在确认域名、证书和费用前自动申请或购买任何资源。

## 5. 安装第一个发布版本

本文使用保留历史版本的目录结构：

```text
/opt/bifang-operations-assistant/
  releases/
    <commit>/
      apps/operations-dashboard-standalone/
      cloudbase/apps.json
  current -> releases/<commit>
```

把 `<commit>` 替换为本次发布的完整提交哈希：

```bash
sudo install -d -o root -g bifang-dashboard -m 0750 \
  /opt/bifang-operations-assistant/releases/<commit>

sudo tar -xzf /tmp/bifang-operations-dashboard-<commit>.tar.gz \
  -C /opt/bifang-operations-assistant/releases/<commit>

sudo chown -R root:bifang-dashboard \
  /opt/bifang-operations-assistant/releases/<commit>

sudo find /opt/bifang-operations-assistant/releases/<commit> \
  -type d -exec chmod 0750 {} \;

sudo find /opt/bifang-operations-assistant/releases/<commit> \
  -type f -exec chmod 0640 {} \;
```

核对发布内容与语法：

```bash
sudo -u bifang-dashboard \
  /usr/bin/node --check \
  /opt/bifang-operations-assistant/releases/<commit>/apps/operations-dashboard-standalone/server.mjs

sudo -u bifang-dashboard \
  /usr/bin/node --test \
  /opt/bifang-operations-assistant/releases/<commit>/apps/operations-dashboard-standalone/tests/*.test.mjs
```

确认测试通过后再创建或切换 `current`：

```bash
sudo ln -sfn \
  /opt/bifang-operations-assistant/releases/<commit> \
  /opt/bifang-operations-assistant/current
```

不要删除旧发布目录。至少保留上一个已验收版本，供快速回滚。

## 6. 配置服务端 Secret

创建只允许 root 读取的环境文件：

```bash
sudo install -o root -g root -m 0600 /dev/null \
  /etc/bifang-operations-dashboard.env

sudoedit /etc/bifang-operations-dashboard.env
```

写入以下内容，用真实值替换尖括号；不要保留尖括号：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=4173
COOKIE_SECURE=true

```

通常不需要设置 `CLOUDBASE_METRICS_ENDPOINT`，代码已经固定到当前生产只读聚合接口。如果生产地址经过正式迁移，可以显式增加：

```dotenv
CLOUDBASE_METRICS_ENDPOINT="https://<平台默认域名>/admin/v1/metrics"
```

服务会拒绝非 HTTPS、携带用户名密码、带查询参数、带片段或路径不是 `/admin/v1/metrics` 的地址。

确认权限：

```bash
sudo stat -c '%U %G %a %n' /etc/bifang-operations-dashboard.env
```

预期为：

```text
root root 600 /etc/bifang-operations-dashboard.env
```

不要执行会把环境文件内容打印到终端或日志的命令。不要把真实 Token 直接写进 shell 命令行，因为它可能进入历史记录或进程列表。

## 7. 配置 systemd

创建服务文件：

```bash
sudoedit /etc/systemd/system/bifang-operations-dashboard.service
```

内容如下：

```ini
[Unit]
Description=Bifang Operations Dashboard Standalone
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bifang-dashboard
Group=bifang-dashboard
WorkingDirectory=/opt/bifang-operations-assistant/current/apps/operations-dashboard-standalone
EnvironmentFile=/etc/bifang-operations-dashboard.env
ExecStartPre=/usr/bin/node --check /opt/bifang-operations-assistant/current/apps/operations-dashboard-standalone/server.mjs
ExecStart=/usr/bin/node /opt/bifang-operations-assistant/current/apps/operations-dashboard-standalone/server.mjs
Restart=on-failure
RestartSec=3
TimeoutStartSec=30
TimeoutStopSec=15
KillSignal=SIGTERM
UMask=0077

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

如果 `command -v node` 不是 `/usr/bin/node`，同步修改两处路径。

加载并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bifang-operations-dashboard.service
sudo systemctl status bifang-operations-dashboard.service --no-pager
```

查看最近日志：

```bash
sudo journalctl \
  -u bifang-operations-dashboard.service \
  -n 100 \
  --no-pager
```

日志中应看到服务监听 `http://127.0.0.1:4173`。日志不应包含两个 Token 的原值。

本机验证 Node 服务：

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:4173/healthz

curl --include \
  'http://127.0.0.1:4173/api/metrics?app=all&days=7'
```

第一个请求预期返回 `{"ok":true}`。第二个请求没有登录 Cookie，必须返回 `401 authentication_required`。`/healthz` 只证明进程存活，不证明 CloudBase Token 可用；完整数据链路需要在第 10 节通过浏览器验收。

确认端口只监听回环地址：

```bash
sudo ss -lntp | grep ':4173'
```

预期看到 `127.0.0.1:4173`，不能是 `0.0.0.0:4173` 或公网地址。

## 8. 配置 Nginx 反向代理

创建站点配置：

```bash
sudoedit /etc/nginx/sites-available/bifang-operations-dashboard
```

先写入 HTTP 配置，把 `stats.example.com` 替换为真实域名：

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name stats.example.com;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";

        proxy_connect_timeout 5s;
        proxy_send_timeout 15s;
        proxy_read_timeout 15s;
        client_max_body_size 16k;
    }
}
```

启用并检查：

```bash
sudo ln -s \
  /etc/nginx/sites-available/bifang-operations-dashboard \
  /etc/nginx/sites-enabled/bifang-operations-dashboard

sudo nginx -t
sudo systemctl reload nginx
```

如果同名链接已经存在，不要重复创建；直接检查它是否准确指向本文件。

### 防火墙

确保 SSH 规则已经正确配置后，再开放 Web 端口。使用 UFW 时：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw status verbose
```

不要开放 `4173/tcp`。如果服务器由云厂商安全组控制，也只允许所需的 SSH、80 和 443，不要给 4173 添加公网入站规则。

## 9. 配置 HTTPS

正式站点必须使用 HTTPS，因为生产会话 Cookie 默认带 `Secure`。在纯 HTTP 页面上，浏览器不会保存该 Cookie，表现为登录成功后仍回到未登录状态。

证书可以使用组织已有证书或免费的 ACME/Let's Encrypt。申请前必须确认：

- 域名已解析到当前服务器；
- 80/443 可达；
- 没有非零金额、套餐升级或自动续费要求；
- 证书范围只包含本次确认的域名。

使用 Certbot 时，先按其当前官方文档安装 Nginx 插件，然后执行：

```bash
sudo certbot --nginx -d stats.example.com
```

选择把 HTTP 重定向到 HTTPS。完成后检查：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --head https://stats.example.com/
```

最终 Nginx 必须满足：

- 80 自动跳转到 443；
- 443 使用有效证书；
- `/` 和 `/api/*` 仍为同一域名；
- 不把 4173 暴露到公网；
- 不额外添加允许任意来源的 CORS 头。

如果暂时只能在服务器本机用 HTTP 验证，可临时设置 `COOKIE_SECURE=false` 并只监听 `127.0.0.1`。该设置不得用于公网正式环境。

## 10. 首次生产验收

发布后按顺序验证，并记录时间、提交哈希、发布包 SHA-256、域名和结果。

### 10.1 未登录边界

```bash
curl --include \
  'https://stats.example.com/api/metrics?app=all&days=7'
```

预期：

- HTTP 401；
- JSON 为 `{"error":"authentication_required"}`；
- `Cache-Control: no-store`；
- 没有生产统计内容；
- 没有 CloudBase Token。

### 10.2 浏览器登录

1. 使用浏览器打开 `https://stats.example.com/`。
2. 确认显示“运营统计独立站”，页面地址不是 `chatgpt.site`。
3. 输入错误访问密钥，预期拒绝且不展示统计。
4. 输入正确的 `DASHBOARD_ACCESS_TOKEN`。
5. 预期进入看板，并显示“生产环境 · 已连接”。
6. 刷新页面，预期仍保持登录。
7. 点击退出，预期会话被清除，再访问统计接口返回 401。

### 10.3 生产数据与筛选

逐项检查：

- 今日活跃、周期活跃、今日回访、最新写入有合理值；
- 7、14、30 天切换正常；
- 全部应用和每个应用筛选正常；
- 趋势天数与所选周期一致；
- 版本、平台、架构分布可切换；
- 发布流与 `cloudbase/apps.json` 中的准确 APP_ID/code/platform/architecture/channel 一致；
- 空集合显示合法空状态；
- 上游失败时显示“生产数据暂时不可用”，不显示模拟数字或伪造零值。

### 10.4 浏览器安全检查

在浏览器开发者工具中确认：

- 浏览器只请求同源 `/api/session`、`/api/metrics` 和静态资源；
- 没有直接请求 CloudBase `/admin/v1/metrics`；
- 页面源码、网络请求和响应中没有 `CLOUDBASE_METRICS_TOKEN`；
- 会话 Cookie 带 `HttpOnly`、`Secure`、`SameSite=Strict`；
- 统计响应不含 `install_id`、`event_id`、`source_ip`、下载地址、管理凭据或版本提示正文；
- 页面不能被第三方 iframe 嵌入；
- 页面没有对搜索引擎开放索引。

### 10.5 服务端检查

```bash
sudo systemctl is-active bifang-operations-dashboard.service
sudo systemctl is-active nginx
sudo journalctl \
  -u bifang-operations-dashboard.service \
  --since '15 minutes ago' \
  --no-pager
```

确认：

- 两个服务均为 `active`；
- 没有持续重启；
- 没有 Token 原值或原始遥测记录进入日志；
- 没有创建第二个 CloudBase 环境；
- 没有修改 CloudBase 集合、函数、路由、版本记录或套餐。

## 11. 后续版本更新

每次更新都制作新的提交级发布目录，不要直接覆盖 `current` 中的文件。

1. 在本地审核变更并运行专项测试。
2. 用准确提交制作发布包和 SHA-256。
3. 上传到服务器。
4. 解压到新的 `releases/<new-commit>`。
5. 在新目录中运行 `node --check` 和 `node --test`。
6. 记录当前 `current` 指向的旧提交。
7. 原子切换 `current`。
8. 重启服务并执行第 10 节验收。

切换示例：

```bash
readlink -f /opt/bifang-operations-assistant/current

sudo ln -sfn \
  /opt/bifang-operations-assistant/releases/<new-commit> \
  /opt/bifang-operations-assistant/current

sudo systemctl restart bifang-operations-dashboard.service
sudo systemctl status bifang-operations-dashboard.service --no-pager
```

新增应用或发布流时，必须使用同一提交中的 `cloudbase/apps.json`，不能只更新页面或只复制一份手工登记表。新登记必须先按仓库规则完成审核和验证。

## 12. 回滚

回滚不修改 CloudBase，只把独立站进程切回上一个已验收发布目录。

```bash
sudo ln -sfn \
  /opt/bifang-operations-assistant/releases/<previous-commit> \
  /opt/bifang-operations-assistant/current

sudo systemctl restart bifang-operations-dashboard.service
sudo systemctl status bifang-operations-dashboard.service --no-pager
```

随后重新执行：

- `/healthz`；
- 未登录 `/api/metrics` 返回 401；
- 浏览器登录；
- 7 天全部应用生产数据读取；
- systemd 和 Nginx 日志检查。

不要通过删除新发布目录来代替回滚。先完成切换和复验，再按保留策略处理旧文件。

## 13. Token 轮换

### 13.1 独立站访问密钥

轮换 `DASHBOARD_ACCESS_TOKEN` 只影响独立站：

1. 生成新的至少 32 字节高熵值；
2. 用 `sudoedit` 修改 `/etc/bifang-operations-dashboard.env`；
3. 重启服务；
4. 用新密钥登录；
5. 确认旧密钥不能登录。

由于会话签名使用该密钥，重启并换值后旧会话自动失效。

### 13.2 CloudBase 聚合 Token

轮换 `CLOUDBASE_METRICS_TOKEN` 必须同时更新：

- CloudBase `operations-dashboard-api` 中的 `DASHBOARD_TOKEN_SHA256`；
- 服务器 `/etc/bifang-operations-dashboard.env` 中的原始 Token。

这会修改线上 CloudBase 函数配置，必须先执行最新远端状态、费用、精确目标和零删除预检，再等待负责人明确继续。不能只改服务器导致生产统计中断，也不能把原始 Token 放入 Git 或命令行参数。

## 14. 监控与日志

建议监控以下项目：

- `https://stats.example.com/healthz` 是否返回 200；
- systemd 服务是否为 `active`；
- Nginx 5xx 比例；
- 页面登录后是否能获取一次 7 天全部应用统计；
- TLS 证书到期时间；
- 磁盘空间和服务器时间同步。

`/healthz` 是公开的最小存活探针，只返回 `{"ok":true}`，不访问 CloudBase，不返回环境、应用或统计数据。不要把真实访问密钥配置到第三方监控 URL 中。

查看日志：

```bash
sudo journalctl -u bifang-operations-dashboard.service -f
sudo tail -f /var/log/nginx/access.log /var/log/nginx/error.log
```

对外分享日志或截图前，遮挡 Cookie、Token、公网 IP、账号和其他个人信息。

## 15. 常见故障

| 现象                         | 常见原因                                                  | 处理                                             |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| 页面 502                     | Node 服务未启动、端口不一致、Nginx 代理错误               | 检查 systemd、`ss -lntp`、Nginx 配置             |
| 登录返回 503                 | `DASHBOARD_ACCESS_TOKEN` 缺失或少于 32 字节               | 修正 root-only 环境文件并重启                    |
| 正确密钥登录后仍未登录       | 正式 Cookie 为 Secure，但页面仍是 HTTP                    | 完成 HTTPS；不要在公网关闭 Secure                |
| 登录返回 401                 | 访问密钥错误                                              | 从密码管理器核对，不要从日志寻找                 |
| 登录后统计返回 503           | CloudBase Token 缺失、错误、上游不可用或响应校验失败      | 查服务日志、接口状态和应用登记，不显示假数据     |
| 新应用导致全部统计不可用     | 页面使用的 `cloudbase/apps.json` 与生产聚合配置不一致     | 发布同一审核提交中的权威登记和对应服务配置       |
| 某个发布流导致校验失败       | code/platform/architecture/channel 或版本状态与登记不一致 | 修正权威登记或生产数据，不能放宽跨应用校验       |
| 页面显示“生产数据暂时不可用” | fail-closed 正常保护                                      | 检查上游状态，不添加模拟数据 fallback            |
| 访问密钥尝试过多返回 429     | 15 分钟内连续失败达到限制                                 | 等待窗口结束并核对密钥，不重启绕过保护           |
| systemd 报 Node 路径不存在   | Node 实际路径不是 `/usr/bin/node`                         | 用 `command -v node` 修正两处绝对路径            |
| systemd 无法读取应用文件     | 发布目录属主或权限错误                                    | 恢复 root:bifang-dashboard、目录 0750、文件 0640 |

## 16. 最终发布记录模板

每次发布至少留下以下非敏感回执：

```text
站点域名：
服务器环境：
Git 完整提交：
发布包文件名：
发布包 SHA-256：
发布时间（北京时间）：
systemd 服务状态：
Nginx 配置检查：
HTTPS 证书状态：
未登录 401：通过 / 失败
正确登录：通过 / 失败
7/14/30 天筛选：通过 / 失败
应用筛选：通过 / 失败
生产数据 fail-closed：通过 / 失败
响应敏感字段检查：通过 / 失败
回滚目标：
费用检查：无非零金额 / 已停止
未执行操作：CloudBase 部署、数据库写入、资源删除、套餐购买等
```

回执不得记录 Token、Cookie、Authorization、原始安装标识、事件标识、来源 IP、数据库凭据或账号信息。

## 17. 上线前最后检查清单

- [ ] 独立站代码和 `cloudbase/apps.json` 来自同一审核提交。
- [ ] 发布包 SHA-256 已记录并在服务器复核。
- [ ] 专项测试全部通过。
- [ ] Node.js 版本不低于 20。
- [ ] Node 只监听 `127.0.0.1:4173`。
- [ ] Nginx 只向本机 4173 反向代理。
- [ ] 4173 没有公网入站规则。
- [ ] HTTPS 有效，HTTP 自动跳转 HTTPS。
- [ ] `COOKIE_SECURE=true`。
- [ ] 两个 Token 不同、均至少 32 字节且只存在于服务端安全位置。
- [ ] 环境文件权限为 root:root 0600。
- [ ] 未登录统计接口返回 401。
- [ ] 页面登录、刷新、退出均正常。
- [ ] 7/14/30 天和应用筛选正常。
- [ ] CloudBase Token 不出现在浏览器和日志中。
- [ ] 响应不含原始匿名标识、IP 或管理字段。
- [ ] 上游失败时没有模拟数据 fallback。
- [ ] 上一个已验收发布目录仍保留，可快速回滚。
- [ ] 没有创建第二个 CloudBase 环境。
- [ ] 没有执行 CloudBase 部署、数据库写入、资源删除或套餐修改。
- [ ] 没有非零金额、自动续费或升级提示。
