# 客户端更新中心迁移进度

新的更新中心地址为 `https://update.meetelf.com`。服务端接入来源是 `bifang-client-update-center` 项目的 `docs/api/client-integration.md` 和 `docs/api/client-updates.md`。它与仓库中现有 application-version API 是不同协议，不能将域名简单替换到旧的 GET 路径上。此文记录本分支的本地实现进度，不代表线上部署或客户端迁移已经完成。

公共 SDK 新增 `ClientUpdateService`：使用客户端运行时提供的 Token，向 `/api/v1/apps/{app_id}/update-checks` 发起 POST；请求由宿主提供实际版本、系统、程序架构、安装形态、持久随机 UUID、触发原因和已实现能力。返回 201 才解析决定；HTTP 错误、超时或无效响应均报告错误，不能当作已是最新版本。日志不能记录 Token 或下载链接。服务端 Token 为共享访问凭据，无法代表用户身份，也无法保证不被客户端提取。

SDK 返回 `decision`、`enforcement` 和 `action`，宿主必须按新协议处理。只有有效的 `block_new_operations` 才限制开始新业务；不可中断正在进行的业务，并须保留更新、重试和退出入口。说明文字按纯文本显示；人工下载页还须按产品允许的域名检查。`isSameInstallTarget` 只比较安装前新检测与原始检测的目标，不会验证文件或替宿主安装。

SDK 目前只实现检测和安装目标对照，**尚未实现下载、大小与 SHA-256 校验、安装前复检编排、平台安装器、强更缓存/定时、UI、持久 UUID 或自动重试**。宿主完成这些能力前不能声明对应 capabilities 或执行安装。下载时需安全处理跳转，不向外部文件域名转发 Token；安装前必须用 `pre_install` 重新检测并比较目标版本、包、大小、摘要和 action。服务端不可用时不得伪装为无更新。

迁移仍需改造一键接入 Skill、Profile 校验与资源派生、宿主示例及相关文档和测试；旧 application-version 服务和当前运营看板仍按既有配置运行。各业务客户端应在各自项目中接入并验证，不由本仓库主动修改。部署、发布、推送、构建安装和删除线上资源均需遵守现有阶段门禁。
