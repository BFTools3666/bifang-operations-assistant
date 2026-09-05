# `windows.json` 14 个字段中文说明

`windows.json` 是客户端启动后读取的更新清单，与“每日首次启动”统计互相独立。它必须是严格 JSON：**JSON 不能写注释，也不能自行添加 `_说明`、`comment` 等字段**，否则当前 Schema 和 SDK 会拒绝整个文件。中文说明请保留在本文档，不要塞进 JSON。

| 字段                    | 必填 | 中文含义                 | 示例或填写规则                                                                 |
| ----------------------- | ---- | ------------------------ | ------------------------------------------------------------------------------ |
| `schema_version`        | 是   | 更新清单协议版本         | 当前固定为整数 `1`，不是软件版本号                                             |
| `app_id`                | 是   | 应用编号                 | 必须与客户端配置、目录名和云函数 `ALLOWED_APP_IDS` 完全一致，如 `bifang-tools` |
| `platform`              | 是   | 清单适用的平台           | Windows 填 `windows`；另可为 `macos` 或 `linux`                                |
| `latest_version`        | 是   | 当前可发布的最新版本     | 完整 SemVer，如 `1.2.3`，不要写 `v1.2`                                         |
| `min_supported_version` | 是   | 仍允许继续使用的最低版本 | 客户端低于它时会被判为必须更新                                                 |
| `enabled`               | 是   | 是否启用更新清单         | `false` 表示暂时不提示更新                                                     |
| `force_update`          | 是   | 是否强制所有旧版本更新   | 常规发布建议 `false`；紧急强制更新才改为 `true`                                |
| `rollout`               | 是   | 可选更新的灰度比例       | `0` 到 `100` 的整数；`100` 表示全部符合条件的客户端可见                        |
| `title`                 | 是   | 更新提示标题             | 纯文本，1–120 个字符，不要写 HTML/Markdown                                     |
| `message`               | 是   | 更新提示正文             | 纯文本，1–1000 个字符，不要写 HTML/Markdown                                    |
| `download_url`          | 是   | 安装包下载地址           | 必须换成真实公网 HTTPS 地址；`.example.invalid` 只能占位，**不能上线**         |
| `release_notes_url`     | 是   | 版本说明地址             | 必须换成真实公网 HTTPS 地址；`.example.invalid` 只能占位，**不能上线**         |
| `sha256`                | 是   | 安装包 SHA-256           | 正式发布填 64 位十六进制；空字符串只用于占位测试，不代表已校验                 |
| `published_at`          | 是   | 发布时间                 | 带时区的严格 RFC3339，如 `2026-09-04T08:00:00+08:00`                           |

## 发布前最短检查

1. `app_id` 与云函数白名单、文件目录和客户端配置逐字一致。
2. `latest_version`、`min_supported_version` 都是完整三段 SemVer。
3. `download_url`、`release_notes_url` 已换成真实可访问的 HTTPS 地址，不含 `.example.invalid`。
4. 正式安装包已签名，并把它的真实 SHA-256 写入 `sha256`。
5. 修改后先运行 `npm run check`，再部署静态文件。

`cloudbase/updates/bifang-tools/windows.json` 已使用本项目固定应用编号；其中两个 `.example.invalid` 地址故意不可用，同版本客户端不会看到新版本。替换真实下载地址、版本说明地址和安装包哈希后才能正式上线。
