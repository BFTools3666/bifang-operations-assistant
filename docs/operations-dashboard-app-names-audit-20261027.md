# 运营看板中文名称核对回执（2026-10-27）

本次从负责人已登录的生产看板读取应用筛选、发布流表，以及同源 `/dashboard/api/metrics?days=14&app_id=all` 的已渲染 JSON；未读取或保存 Token、Cookie、原始安装标识、IP 或请求头。机器回执见 [JSON](operations-dashboard-app-names-audit-20261027.json)。

## 线上只读结果

- 环境：`bftoos-sh-d3ga7hahz59229f0a`。
- 完整清单：16 个工具、25 条发布流。
- 原有中文显示名：3 个；仍回退显示英文 APP_ID：13 个。
- GitHub 远端默认分支与本地修改前基线均为 `f41c0048a2ab7e73e70235829578bdcf1247aa48`；远端登记仅 15 个应用。线上已存在的 Plus 是唯一额外身份。

| APP_ID                                | 核对时显示  | 统一中文名称           |
| ------------------------------------- | ----------- | ---------------------- |
| `bifang-screen-recorder`              | 已有中文名  | 毕方录屏助手           |
| `bifang-mouse-clicker`                | 已有中文名  | 毕方鼠标精灵           |
| `bifang-tools`                        | 已有中文名  | 毕方小工具             |
| `bifang-ai-usage-collector`           | 英文 APP_ID | 毕方AI用量看板         |
| `bifang-vm-sync-agentless`            | 英文 APP_ID | 毕方VM虚拟机同步助手   |
| `bifang-lan-file-transfer`            | 英文 APP_ID | 毕方局域网文件传输     |
| `bifang-codex-skins`                  | 英文 APP_ID | 毕方CodeX皮肤工坊      |
| `bifang-app-launcher`                 | 英文 APP_ID | 毕方应用启动器         |
| `bifang-multi-local-proxy`            | 英文 APP_ID | 毕方本地代理多开器     |
| `bifang-browser-sync`                 | 英文 APP_ID | 毕方浏览器多开同步器   |
| `bifang-browser-multi-instance`       | 英文 APP_ID | 毕方浏览器多开器       |
| `bifang-multi-instance-display`       | 英文 APP_ID | 毕方多窗口显示助手     |
| `bifang-app-network-accelerator`      | 英文 APP_ID | 毕方多应用加速器       |
| `bifang-content-production-assistant` | 英文 APP_ID | 毕方内容生产助手       |
| `bifang-window-layout`                | 英文 APP_ID | 毕方多窗口排布器       |
| `bifang-multi-instance-display-plus`  | 英文 APP_ID | 毕方多窗口显示助手Plus |

## 本地修复范围

名称统一保存在 `cloudbase/functions/operations-dashboard/src/app-labels.json`。聚合函数、CloudBase 网页、独立站和 Sites 看板共用该名称来源，覆盖下拉框、标题、发布流表、版本画像与 URL 筛选恢复。名称覆盖校验与本地维护命令已加入仓库检查。

根据线上精确身份，把既有 `bifang-multi-instance-display-plus` 同步登记为 Windows / x64 / stable，code 为 `bifang-multi-instance-display-plus-windows-x64`，并重新生成本地配置。该操作只对齐仓库记录，不创建线上函数、路由或集合；其余 15 个应用的技术身份保持不变。

本轮只处理中文名称与已有登记差异；版本发布记录、更新决策、遥测协议和统计口径保持原实现。

## 当前交付边界

本回执证明线上清单已完整读取和本地源码已更新，**不表示中文名称已经在线上生效**。尚未执行云端部署、Git 推送、购买或云资源删除。后续须取得 CloudBase 部署身份，完成最新函数、路由、应用映射与费用预检，按仓库门禁展示最终目标并等待负责人明确继续；只定向更新看板，保留线上完整 16 应用范围。
