# 应用版本 API v1 契约包

状态：**运行时目标已冻结；尚未实现、部署或经真实客户端验证。**

本目录描述毕方运营精灵将要提供的第三方应用版本 API 外部形状。目标是让已有小工具只修改服务地址、TLS/证书信任和 `x-app-key`/`x-app-secret` 配置，不修改程序代码。

文件：

- [`openapi.json`](openapi.json)：十个外部端点、两个原名请求头、HTTP 响应和运行时/管理面分级。
- [`schema.json`](schema.json)：请求、响应、分页和错误结构的 JSON Schema 2020-12 定义。
- [`fixtures/runtime-decision-cases.json`](fixtures/runtime-decision-cases.json)：数字点分版本比较、条件操作符和三个状态布尔量的冻结测试向量。
- [`../../docs/application-version-api-zero-code-contract.md`](../../docs/application-version-api-zero-code-contract.md)：可行性、零代码验收定义、安全边界、已知歧义和分步建议。

从仓库根目录运行：

```powershell
node --test tests/application-version-api-contract.test.mjs
```

契约状态分两级：

- `GET /versions/{code}/{version}` 与 `GET /app/{code}/ads/show` 是现有小工具的运行时冻结面。
- 其余管理端点是文档兼容的暂定面；参考文档对分页、列表和写入成功体存在矛盾，若要承诺既有管理客户端零代码兼容，必须先做真实请求观测。

本目录不是 CloudBase 部署声明。它不会改变当前 SDK、静态更新文件或线上资源，也不得作为“已经上线”的证据。
