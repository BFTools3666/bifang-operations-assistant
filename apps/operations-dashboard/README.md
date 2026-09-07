# 毕方运营精灵 WebApp

这是一个私有、只读的 CloudBase 运营驾驶舱。首屏展示每日活跃匿名安装数、周期活跃、今日回访、数据新鲜度、活跃趋势、版本/平台/架构分布和更新清单状态。

## 本地预览

```powershell
npm ci
npm run dev
```

没有配置服务端环境变量或请求失败时，界面明确显示“生产数据暂时不可用”，不显示演示数据或伪造零值。线上已通过私有 Sites secret 接入生产聚合接口；本地诊断可复制 `.env.example` 为未提交的 `.env`，但不得把凭据提交到 Git。

## 安全边界

- 浏览器从不直连 `ADMINONLY` 数据库集合，也不持有腾讯云 SecretId/SecretKey。
- 原始 Bearer Token 只存在于私有 Sites 运行环境和本地未提交 `.env`；CloudBase 函数只保存其 SHA-256。
- 聚合接口最多查询 30 天，只返回日期、计数、版本、平台、架构和更新清单摘要。
- 接口不返回原始文档、`install_id`、`event_id` 或 `source_ip`。
- WebApp 没有更新发布、数据库写入、删除、套餐升级或付费操作。

CloudBase 远程部署必须先完成实时免费额度、现有函数/路由和零删除预检，仅执行负责人已授权的生产看板范围。详见仓库的 `docs/operations-dashboard.md` 与 `docs/operations-dashboard-e2e-20260907.md`。
