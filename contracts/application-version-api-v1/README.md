# 应用版本 API v1 契约包

状态：**本地实现与测试已完成；尚未部署或经原程序验证。**

本目录描述毕方运营精灵实现的第三方应用版本 API 外部形状。目标是让已有小工具只修改服务地址、TLS/证书信任和 `x-app-key`/`x-app-secret` 配置，不修改程序代码。规范 Base URL 是 `https://<host>/tools/version-control/v1`，`v1` 只出现一次，服务端不提供 `/v1/v1` 别名。

文件：

- [`openapi.json`](openapi.json)：十个外部端点、两个原名请求头、HTTP 响应和运行时/管理面分级。
- [`schema.json`](schema.json)：请求、响应、分页和错误结构的 JSON Schema 2020-12 定义。
- [`fixtures/runtime-decision-cases.json`](fixtures/runtime-decision-cases.json)：数字点分版本比较、条件操作符和三个状态布尔量的冻结测试向量。
- [`../../docs/application-version-api-zero-code-contract.md`](../../docs/application-version-api-zero-code-contract.md)：可行性、零代码验收定义、安全边界、已知歧义和分步建议。
- [`../../cloudbase/functions/application-version-api`](../../cloudbase/functions/application-version-api)：十个端点的 CloudBase Event 函数、本地内存适配器与测试。
- [`../../cloudbase/plan-application-version-api-deployment.mjs`](../../cloudbase/plan-application-version-api-deployment.mjs)：需要未提交凭据文件的只读服务级部署预览；不执行云端写入。

从仓库根目录运行：

```powershell
npm test --workspace @bifang/cloudbase-application-version-api
node --test tests/application-version-api-contract.test.mjs tests/cloudbase-application-version-api-deploy-plan.test.mjs
```

契约状态分两级：

- `GET /versions/{code}/{version}` 与 `GET /app/{code}/ads/show` 是已本地实现的运行时冻结面，仍需未修改原程序在测试域名上验收。
- 其余管理端点已按仓库冻结的解释实现，但兼容形状仍属暂定面；参考文档对分页、列表和写入成功体存在矛盾，若要承诺既有管理客户端零代码兼容，必须先做真实请求观测。

本目录不是 CloudBase 部署声明。当前 SDK、静态更新文件和线上资源尚未改变，也不得把本地 HTTP E2E 当作“已经上线”或“原程序无缝兼容”的证据。
