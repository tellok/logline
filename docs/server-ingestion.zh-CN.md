# 日志写入 HTTP API

[English](./server-ingestion.md)

使用绑定到目标项目的命名[项目密钥](./server-admin.zh-CN.md)，只允许写入。PAT 和管理员凭据都不能上传。公开客户端的 DSN 仅标识项目，不能证明事件来源可信：获取 DSN 的人可以提交事件，但不能读取。不要暴露后端密钥；项目的所有密钥共用配额。入口应启用 TLS 并保护数据库连接。本服务不提供浏览器登录。

reporter 接受 `https://<key>@<host>[/prefix]/<projectUUID>`（仅回环地址可使用 HTTP）。实际请求发送至 `<部署根路径>/api/v1/logs`，不在 URL 中携带凭据。不要在日志中记录 DSN 或 Authorization 请求头。

**浏览器上报：** 将 `LOGLINE_INGEST_ORIGINS` 设为逗号分隔的精确浏览器 Origin 列表，例如 `https://app.example.org`。默认拒绝所有携带 `Origin` 的写入请求；不带 `Origin` 的后端请求不受影响。上传路由支持 `OPTIONS` 预检，允许 `POST` 携带 `Authorization` 和 `Content-Type`。Origin 白名单只是浏览器策略，不是来源鉴真，也不能保证阻止垃圾上报。

## 批量上报

`POST /api/v1/logs`，请求头为 `Content-Type: application/json` 和 `Authorization: Bearer <project-key>`：

```json
{
  "projectId": "00000000-0000-4000-8000-000000000001",
  "events": [
    {
      "id": "example-request-01",
      "level": "WARN",
      "timestamp": 1760000000000,
      "message": "Example request exceeded its time budget",
      "fields": { "durationMs": 125 },
      "context": { "environment": "test", "traceId": "example-trace" }
    }
  ]
}
```

使用**服务端生成的项目 UUID** 而不是 slug。请求体仅接受 `projectId` 和 `events`，发送旧版 `service` 字段会被拒绝。事件 ID 为非空白字符串，UTF-8 编码不超过 128 字节。每批至少一个事件，ID 不得重复。级别为 `TRACE`、`DEBUG`、`LOG`、`WARN`、`ERROR`。时间戳为 Unix 毫秒整数，范围 `[0,253402300799999]`；消息为字符串。可选 `fields` 和 `context` 均为 JSON 对象。若提供 `context.environment`、`release`、`traceId`、`sessionId`、`userId`，值必须为不超过 1,024 字节的字符串。保留其他事件属性，但顶层 `ingestKeyId` 为保留名：客户端提供此属性时该事件会被拒绝。服务端记录首次实际提交该事件的项目密钥 ID（不是原始密钥）。重放不会覆盖来源；从 v1 迁移的记录不标记密钥 ID。每个完整事件序列化后最多 65,536 UTF-8 字节，嵌套深度不超过 24，键名不超过 1,024 字节。拒绝非有限数值、NUL 和无效 Unicode。使用未压缩的 UTF-8 JSON。

`200` 响应将每个输入 ID 分类，不保证顺序：

```json
{ "acceptedEventIds": ["example-request-01"], "retryableEventIds": [], "rejectedEventIds": [] }
```

- **已接受**表示已提交到 PostgreSQL，提交后新发起的授权查询可立即在主库读到。重试已有 `(projectId,id)` 时不覆盖原数据，也不消耗新增配额。为事件分配稳定且唯一的 ID，并使用原始数据重试。
- 对能识别 ID 的非法事件**永久拒绝**，同批其他有效事件仍可提交。缺失或重复 ID 时整批 `400`；请求体或事件数量超限时 `413`。`401` 表示凭据缺失、无效、已撤销或类型错误；`403` 表示密钥有效但绑定的是其他项目。非确认类错误格式为 `{"error":{"code":"…","message":"…"}}`。
- `429` 表示该项目剩余的自然分钟事件数或字节配额无法容纳**全部新增有效事件**。响应区分已接受的重复 ID、可重试的新 ID、永久拒绝的 ID，并含 `retryAfterMs`；`Retry-After` 以秒向上取整。批量大小应小于整分钟配额。`503` 带 `Retry-After`，表示存储暂时不可用、容量不足或正在退出；使用退避与抖动重试未确认批次。原响应丢失或提交结果不明时允许重试，在数据仍被保留时不会生成第二行。
- 写入直接提交，**没有服务器端 flush 路由**、内存交付队列、异步索引器或需等待的消息偏移量。客户端 flush 只清空自身待发送队列。入口 Pod 丢失不影响已确认的数据；数据库或节点故障下的耐久性取决于 PostgreSQL 的 fsync、持久卷、复制和备份。不要使用临时数据库，也不要向异步只读副本查询权限或已提交事件。

## 运维边界

所有副本须使用同一 PostgreSQL 主库，以及相同的项目配额和保留设置。启动时服务在数据库内串行创建表结构，成功后才监听。部署数据库账号需要目标数据库或 schema 的 DDL 权限。每批锁定该项目的一行配额记录，不同项目可并发写入。单个热点项目的批次在此行串行化，且每个项目最多占用一个副本一半的写入数据库并发（向上取整）。准入名额包含读取请求体的时间；应用不会为上传维护无界等待队列。查询、导出和 MCP 共用独立的连接池与并发预算。入口还应限制未经认证流量的连接数与请求速率。

| 设置                                                    |            默认值 | 用途                                                                                      |
| ------------------------------------------------------- | ----------------: | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                          |              必填 | PostgreSQL 主库 URL；PostgreSQL 16/17（集成测试使用 16，部署使用 17）                     |
| `LOGLINE_ADMIN_TOKEN`                                   |              必填 | 随机部署密钥，至少 32 个非空格可打印 ASCII 字节，不含逗号，不以 `llpat_` 或 `llpk_` 开头  |
| `HOST`、`PORT`                                          | `0.0.0.0`、`4318` | HTTP 监听地址                                                                             |
| `MAX_BODY_BYTES`、`MAX_BATCH_EVENTS`                    |      1048576、500 | 请求体字节数（也限制管理和查询请求体）、每批日志数                                        |
| `PROJECT_EVENTS_PER_MINUTE`、`PROJECT_BYTES_PER_MINUTE` |   60000、67108864 | 按数据库时钟自然分钟计算的每项目新增事件数与序列化 UTF-8 字节数，不代表线上流量或磁盘大小 |
| `INGEST_CONCURRENCY`、`QUERY_CONCURRENCY`               |             12、4 | 每副本准入和连接池上限；健康检查与保留任务另预留最多两个连接                              |
| `RETENTION_DAYS`                                        |                30 | 按**接收**时间保留，不是按客户端时间                                                      |
| `LOGLINE_MCP_ENABLED`                                   |            `true` | `false` 禁用 `/mcp`                                                                       |

请求体期限为 10 秒，获取数据库连接最多 3 秒，默认单条 SQL 超时 5 秒。为全部副本和滚动升级的重叠副本配置数据库连接、内存、磁盘和 autovacuum 预算。每个副本每轮最多删除 5,000 行过期事件，通常每分钟执行一次，一轮满额时下一秒继续。这是最终清理而非精确 TTL 或硬性磁盘上限；监控增长和清理速率。原记录被删除后，相同 ID 可重新写入。目前没有容量硬上限或分区归档。

`GET /health` 不依赖数据库，`GET /ready` 检查数据库连通性。`GET /metrics` 需要管理员令牌，返回每进程 Prometheus 文本指标：新增事件数和字节数、已确认（含重放）、已拒绝和可重试 ID 计数、过载、清理和存储错误、当前并发量及已准入上传/查询耗时直方图。在读请求体之前发生的过载不计事件数。没有异步缓冲，服务 backlog 为零。单独采集每个副本并对速率求和，不应将跨重启的累计值直接相加。SIGTERM/SIGINT 停止接收请求，等待活动 HTTP 请求完成（15 秒后强制关闭连接），然后关闭连接池；部署应配置较长的退出宽限期。无需粘性会话。
