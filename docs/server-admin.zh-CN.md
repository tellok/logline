# 服务端管理与项目访问

[English](./server-admin.md) | [自述文件](../README.zh-CN.md)

## 三种凭据，分别授权

运维人员生成至少 32 字节的随机数（例如 `openssl rand -hex 32`），把编码后的值作为 `LOGLINE_ADMIN_TOKEN` 注入每个入口副本。使用不含空格和逗号的可打印 ASCII 字符，不能使用保留前缀 `llpat_` 或 `llpk_`。系统没有默认凭据，也无需登录账号。使用 TLS，仅通过管理请求的 `Authorization: Bearer <admin-secret>` 传递此密钥。切勿将它嵌入浏览器、放入 URL，或记录授权头和签发令牌的响应。未来的管理控制台需要可信的服务端后端，自行验证操作员身份。轮换时需更新**所有**副本，旧副本全部退出后，旧密钥才在整个部署中失效。

个人访问令牌（PAT）只属于单个用户，不属于团队或项目。每个 PAT 含 256 位随机数，以适合 HTTP 的形式编码；数据库仅保存 SHA-256 摘要。**仅在签发时**返回密钥。丢失后应签发新令牌并按 ID 撤销旧令牌。PAT 仅用于读取（Explorer、MCP），不能上传或调用管理 API；管理凭据不能上传、搜索、导出日志或调用 MCP。

对每个读取请求，服务端均向共享 PostgreSQL **主库**验证 PAT，检查用户是否启用，再计算其当前项目权限。每个项目的结果是：

```text
允许的操作 = PAT 操作范围 ∩（用户直接权限 ∪ 所有当前团队授予的权限）
```

只加入团队不会自动获得项目权限。签发时不会保存项目列表。授权、团队成员关系、令牌和用户状态的变更提交后，对所有副本上随后进行的授权检查生效；此前已获授权的在途请求可能继续完成。禁用用户会阻止其**全部** PAT；重新启用后，未被撤销的 PAT 恢复使用。撤销单个 PAT 不可逆，且不影响其他 PAT。项目改名不影响授权、日志或保存的查询范围，这些引用均基于不可变的 `projectId`。

**项目密钥**（`llpk_` 加上 32 字节随机数的无填充 base64url 编码）只能写入一个绑定的项目，与成员关系或上传者身份无关。数据库仅保存 SHA-256 摘要。每个上传请求都在共享主库验证密钥。它不能充当管理员凭据或 PAT。

## HTTP 约定

以下路径均相对于 `/api/v1/admin`，全部需要管理员 Bearer 凭据。非空请求体使用 UTF-8 `application/json`。资源 ID 均是服务端生成的 UUID。创建和更新时不能发送未知字段。除 `204 No Content` 外均返回 JSON，响应不可缓存。

| 资源     | 端点                                                                               | 请求体 / 结果                                                                                                                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 用户     | `GET/POST /users`、`GET/PATCH /users/{userId}`                                     | `{userId,displayName,enabled}`。创建时提供 `displayName`，可选 `enabled`（默认 `true`）；可修改其中任一字段。                                                                                                                        |
| 项目     | `GET/POST /projects`、`GET/PATCH /projects/{projectId}`                            | `{projectId,slug,displayName}`。创建时提供 `slug` 和 `displayName`，均可修改。`slug` 在所有副本上唯一，格式为 `[a-z0-9_-]{1,80}`。`displayName` 支持 Unicode（例如 `支付服务`），无需唯一。API 路径和 PAT 授权使用 ID，不使用 slug。 |
| 团队     | `GET/POST /teams`、`GET/PATCH/DELETE /teams/{teamId}`                              | `{teamId,displayName}`。创建或改名提供 `displayName`。删除团队会级联删除其成员关系和项目授权，但不删除用户、项目、日志、令牌或其他授权来源。                                                                                         |
| 用户令牌 | `GET/POST /users/{userId}/tokens`、`DELETE /users/{userId}/tokens/{tokenId}`       | 创建使用 `{scopes,label?}`。元数据为 `{tokenId,userId,scopes,label,issuedAt,revokedAt}`。只有创建会额外返回 `secret`；列表不会返回密钥**或摘要**。时间是 UTC ISO 字符串；`revokedAt:null` 表示尚未撤销。重复撤销返回 `204`。         |
| 项目密钥 | `GET/POST /projects/{projectId}/keys`、`DELETE /projects/{projectId}/keys/{keyId}` | 使用 `{name}` 创建。元数据为 `{keyId,projectId,name,issuedAt,revokedAt}`；**仅创建时**额外返回原始 `key`。列表不返回密钥或摘要。重复撤销返回 `204`。                                                                                 |

名称及显式提供的标签必须为非空白 Unicode 字符串，最多 200 个码点。`permissions` 和 `scopes` 只接受 `["logs:read"]`，用户和团队授权不能用于日志写入。创建返回 `201` 和资源；修改返回 `200` 和资源；删除返回 `204`。不支持通过此 API 删除项目或用户。

### 成员、授权和权限来源

| 工作流                   | 读取                                                                                                                                                                                                                         | 变更                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 用户与项目的**直接**授权 | `GET /users/{userId}/memberships` 返回项目及 `permissions`；`GET /projects/{projectId}/members` 返回用户及 `permissions`。                                                                                                   | `PUT/DELETE /projects/{projectId}/members/{userId}`                                                        |
| 团队成员关系             | `GET /teams/{teamId}/members` 返回用户；`GET /users/{userId}/teams` 返回团队。                                                                                                                                               | `PUT/DELETE /teams/{teamId}/members/{userId}`                                                              |
| 团队与项目授权           | `GET /teams/{teamId}/projects` 返回项目及 `permissions`；`GET /projects/{projectId}/teams` 返回团队及 `permissions`。                                                                                                        | `PUT/DELETE /projects/{projectId}/teams/{teamId}`                                                          |
| 解释有效权限             | `GET /users/{userId}/access` 返回项目及 `permissions` 的并集。`GET /users/{userId}/access/{projectId}` 返回各个来源 `{sourceId,type,teamId,teamName,permissions}`。`type` 为 `direct` 或 `team`；直接授权的团队字段为 null。 | 由上述关系推导，不可直接编辑。这里展示用户的授权（包括已禁用用户）；令牌是否有效及其操作范围仍须另行检查。 |

授权 `PUT` 的请求体示例：`{"permissions":["logs:read"]}`，它会创建或**替换**整组权限。成员关系 `PUT` 无需请求体（也接受 `{}`）。两者均返回 `204`，即使未发生变化。删除现有关系无需请求体，返回 `204`；关系不存在返回 `404`。移除某个来源不会影响从其他来源获得的相同权限。所有关系使用稳定 ID，团队不支持嵌套。

### 分页和错误

所有列表（含权限来源和令牌元数据）均返回 `{items,nextCursor}`。使用 `?limit=50&cursor=<nextCursor>` 翻页；首页省略 `cursor`。每页 `1–100` 条，默认 `50`，按实体 UUID 升序（权限来源按来源 ID）。`nextCursor:null` 表示末页。游标是排他的起始位置，不是快照；请求之间的数据变更可能影响结果。顶层 `/users`、`/teams`、`/projects` 列表另接受 `q`：在显示名称中匹配不区分大小写的字面子串，最多 200 个字符，项目还匹配 slug。不支持按字母排名或自由 SQL。

错误格式为 `{error:{code,message}}`。管理凭据错误，或 PAT 无效、已撤销或用户被禁用：`401`。有效 PAT 缺少范围或项目授权：`403`。输入无效：`400`；资源不存在：`404`；方法不支持：`405`；slug 冲突：`409`；请求体过大：`413`；过载或暂时不可用：`503` 并附重试提示。多项目查询只要显式指定的一个项目无权访问，整个请求就会被拒绝。此 API 不提供自助注册、密码、浏览器会话、嵌套团队、团队管理员或匿名共享。

## 创建单项目上传凭据

在可信后端使用管理员 Bearer 凭据按顺序执行：

1. `POST /projects`，请求体 `{"slug":"payments-api_v2","displayName":"支付服务"}`，保存 `projectId`。
2. `POST /projects/{projectId}/keys`，请求体 `{"name":"Payments production"}`。立即保存返回的 `key`，保留 `keyId` 以供撤销。无需创建用户、团队或 PAT。
3. 用**你管理的部署对外地址**拼接 reporter 配置：`https://<key>@<host>[/prefix]/<projectId>`。只有回环地址支持 HTTP。服务器不会根据请求头猜测公开 URL；DSN 本身不是 HTTP 请求地址。见[写入 API](./server-ingestion.zh-CN.md)。
4. 轮换时签发第二把命名密钥，完成客户端部署后，通过 `DELETE /projects/{projectId}/keys/{oldKeyId}` 撤销旧密钥，不影响其他密钥。变更提交后所有副本的后续授权检查均生效；已获授权的在途请求可能完成。排障时为有权读取项目的用户单独签发 `logs:read` PAT。

## 从 v1 数据库升级

先备份数据库，排空并停止**所有 v1 副本**，不要让不兼容的版本同时运行。v2 启动时在共享迁移锁保护下以一个事务完成升级。保留项目、事件行、原始事件 JSON 和 ID，删除已弃用的 `log_events.service` 列，旧服务标签不另行复制。读权限不变；读写混合的授权及 PAT 仅保留读权限；只有写权限的授权会被移除，纯写 PAT 的元数据保留但已撤销，权限清空，绝不会将旧写权限提升为读权限。不会根据旧 PAT 自动生成密钥。请先签发新的项目密钥，配置 DSN，客户端切换到新的请求体后再恢复上传。迁移后如需回退 v1，请从备份恢复。
