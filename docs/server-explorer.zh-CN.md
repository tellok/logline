# 日志浏览器 HTTP API

[English](./server-explorer.md) | [README](../README.zh-CN.md)

下文路径均相对于 `/api/v1/explorer`。使用 `Authorization: Bearer <用户 PAT>`，JSON 请求体使用 `Content-Type: application/json`。**包括保存、修改视图在内**的所有操作都需要 `logs:read`。服务端在同一 PostgreSQL 快照中验证令牌操作范围、用户当前的直接授权和团队授权，再执行查询。项目上报密钥和管理员凭据均不能用来读日志。未来的 Web UI 可以通过可信后端调用这些接口；切勿向浏览器发送管理员凭据。

## 浏览项目

1. `GET /projects?limit=50&offset=0` 返回 `items:[{projectId,slug,displayName}]`。以不可变的 `projectId` 作为选项值，不使用可改名的 slug 或显示名称。省略 `query.projectIds` 表示当前可读的所有项目；显式选择中只要有一个项目不可读或不存在，整个请求即返回 403。
2. `POST /selectors` 接收 `{query,limit?,offset?}`，返回当前范围内出现的 `{projectId,environment}` 组合（环境可能是 null）。`POST /fields` 接收相同参数，返回字段建议 `{name,types,operators}`。最多查看最新 200 条匹配事件、收集 512 个字段，达到截断条件时返回 `sampled:true`。未出现在样本中的字段仍可查询。内置字段只表示公共模式，不表示已有数据。
3. 向 `POST /rows` 发送如下请求。`items` 是行，`identities` 是与行一一对应的 `{projectId,eventId}`，即使列中不含这些 ID 也会返回。省略 `columns` 返回完整事件，含规范的项目和事件标识。表格应按所选 `columns` 的顺序展示，而非依赖 JSON 对象键顺序。

```json
{
  "query": {
    "range": { "last": "2h" },
    "environments": ["staging"],
    "where": {
      "and": [
        { "field": "level", "op": "eq", "value": "ERROR" },
        { "field": "message", "op": "icontains", "value": "timeout" },
        { "field": "fields.durationMs", "op": "gte", "value": 500 }
      ]
    }
  },
  "columns": ["timestamp", "message", "fields.durationMs", "traceId"],
  "sort": "desc",
  "limit": 50
}
```

行响应为 `{items,identities,range:{start,end},limited,nextCursor}`。使用相同查询参数及 `cursor:nextCursor` 继续，直到游标为 null。按时间升序或降序（默认降序）排列；时间相同时，按同方向比较项目和事件 ID。每页 1–100 行（默认 50），可选 1–24 个不重复列，不能同时选择重叠的父子路径。签名游标固定第一页算出的时间范围，**并非**跨请求的数据快照；清理或新提交的数据可能影响后续页。行与刷新游标闲置 15 分钟过期。查询、排序、列、用户或有效项目集合改变后需重新开始。游标不携带权限。

发现接口和视图列表支持 `limit` 1–100（默认 50）和 `offset` 0–10,000。响应有 `limited`、`nextOffset`，到达末尾或偏移上限时后者为 null；字段/选择器还返回实际 `range`。

`ingestKeyId` 是服务端记录的实际接收凭据 ID（公开 UUID，不是上报密钥），可用来筛选、分组或选列。旧版日志没有此记录，返回 `null`。详情、完整行和原始 JSONL 导出均以服务端元数据覆盖顶层同名字段。只有该顶层标记代表本次使用的密钥；原始事件内容（如 `fields.ingestKeyId`、消息或环境）由客户端提供，不证明发送者身份。公开浏览器密钥也无法证明是哪一个客户端在使用它。

### 公共查询模型

| 属性           | 约定                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectIds`   | 可选，1–100 个项目 UUID。始终受当前用户权限限制。                                                                                                                                                                                                                                                                                                              |
| `environments` | 可选，1–32 个环境名，按精确匹配的并集处理。                                                                                                                                                                                                                                                                                                                    |
| `range`        | 默认 `{"last":"1h"}`。正整数加 `m`、`h` 或 `d`，最多 30 天（含 `7d`、`14d`、`30d`）。也可传 `{"start":"2026-01-01T00:00:00Z","end":"2026-01-02T00:00:00Z"}`。绝对时间使用带时区的 RFC3339 格式，精度可到毫秒，左闭右开。时间桶和返回的边界均为 UTC。筛选基于事件时间；保留策略以接收时间删除数据（`RETENTION_DAYS`，默认 30 天），历史窗口可能正常返回空结果。 |
| `where`        | 一个 `{field,op,value}` 比较，或 `{and:[...]}`、`{or:[...]}`、`{not:谓词}`。最多 40 个节点，每个列表最多 16 项，从根到叶最多六条边。项目和时间范围不能被布尔组合反转。                                                                                                                                                                                         |

内置字段：`projectId`、`eventId`、`ingestKeyId`、`level`（`TRACE`、`DEBUG`、`LOG`、`WARN`、`ERROR`）、`timestamp`（Unix 毫秒）、`message`、`environment`、`release`、`traceId`、`sessionId`、`userId`。`fields.key` 和 `context.key` 可访问自定义字段，最多四级键，每级符合 `[A-Za-z_][A-Za-z0-9_-]{0,63}`。名称含点的键不能用此语法访问，但完整事件会保留。`eq`、`neq`、`lt`、`lte`、`gt`、`gte` 比较同类型的值；布尔值仅允许相等/不等。缺失和类型不匹配表示未知（包括在 `not` 下），不会隐式转为零或空字符串。字符串比较区分大小写；`message` 支持 `contains`、`icontains` 字面子串查找，后者使用数据库区域设置折叠大小写。字符串比较值最长 1,024 UTF-8 字节。

`message` 上的 `regex` 是区分大小写的 PostgreSQL 正则子集，最多 128 字节。支持 ASCII 单词字符、空格、`. , : / @ -`、`^ $`、字符类以及 `* + ?`；不支持转义、分组、分支、计数重复和连续量词。例如 `^Error [0-9]+$`。模型不接受任意 SQL，非法模式返回验证错误。

## 详情、上下文与图表

| 接口                                               | 结果和限制                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /detail` `{projectId,eventId}`               | `{item}` 为完整事件；在已授权项目中不存在时返回 404。                                                                                                                                                                                |
| `POST /context` `{projectId,eventId,mode?,limit?}` | `{items,limited}`，限定**同一项目**，排除锚点，由近及远。默认 `nearby` 搜索前后 5 分钟；`trace`/`session` 搜索前后 24 小时内同标识事件，缺少标识则为空。默认 25 条，最多 100 条。                                                    |
| `POST /groups` `{query,groupBy?,metric?,limit?}`   | `{items:[{group:[分组值...],value}],range,sampled:false,limited,limitReason}`。`groupBy` 可含 0–3 个不重复字段。按指标降序，其次按分组排序。                                                                                         |
| `POST /series`                                     | 同 `/groups`，可另指定 `intervalSeconds`；每项含 `bucket`（Unix 毫秒）。先按桶升序，再按指标降序和分组排序。默认约 60 桶。自定义间隔为 1–2,592,000 秒且整个窗口最多 1,000 桶。不生成空桶；对于完整的计数序列，客户端可将缺失桶填零。 |

默认指标 `{"op":"count"}`，亦可用 `{"op":"sum","field":"fields.durationMs"}` 或 `avg` 聚合数值字段。忽略缺失和非数值；若无可用值则为 null。指标以 JSON 数字返回。每个图表/指标发一次查询，可用多个 `groupBy` 属性生成多条序列。聚合和图表默认 100 行，最多 500 行；数据库对分组键另施加 1 MiB 预算。`limited:true` 表示分组/桶**不完整**，`limitReason` 为 `rows` 或 `bytes`；计数并非估算。

## 增量刷新与错误状态

对按最新时间排序的滚动表格，**先**向 `POST /refresh` 发送 `{query,columns?,limit?}` 建立水位，再加载 `/rows`。首次响应 `initialized:true`，行为空，返回签名 `nextCursor`。轮询时在相同请求体附 `cursor`。响应为 `{items,identities,range,asOf,pendingTransactions,initialized,limited,nextCursor}`。按 `(projectId,eventId)` 合并去重，客户端按事件时间重新排序。处理完一页后再保存新游标；网络中断则用原游标重试并去重。空结果也可能推进游标。若 `limited` 为真，立即继续读取后续页；在排空前固定窗口和水位。默认每页 50 行，最多 100 行。

水位取数据库中最早的活跃事务 ID，而非已分配的最大序号，可处理事务提交顺序与序号顺序不同的情况。长期事务可能阻碍进度；`pendingTransactions:true` 表示可能滞后，不能解读为没有新日志。若初始化时水位受阻，后续轮询可能返回初始化之前已可见的行；应按 `(projectId,eventId)` 合并，不能简单追加。`asOf` 为当前计算的窗口上界。迟到事件仅在轮询时**事件时间**仍落入滚动范围内才返回；已过期、超出窗口、时间在未来而被游标扫过的事件不会随后重放。手动搜索重新评估当前保留的数据。

- 200、`items:[]` 且未截断表示此次查询无匹配，需结合新鲜度理解。不要将字段发现的抽样、图表截断或增量分页误作无匹配。
- 错误统一为 `{error:{code,message}}`。400 `invalid_query` 应修正模型；401 表示凭据无效/撤销或用户被禁用；403 表示权限不足。404 隐藏不可读视图。409 `cursor_mismatch` 或 410 `cursor_expired` 需重新建立游标并加载。409 `version_conflict` 应先重新读取视图。
- 每个副本限制读取并发，查询与上传使用独立连接池。503 及 `Retry-After` 表示过载、存储不可用或超过单条 SQL 的 3 秒预算。保留当前结果并标记过期，暂停轮询并退避重试；反复超时应缩小范围。失败不会伪装成空的成功结果。

## 保存视图与安全共享

`POST /views` 创建（201）；`GET /views` 仅列出**本人拥有**且仍可访问的视图。`GET /views/{viewId}` 返回 `{item:{viewId,ownerId,name,version,visibility,definition}}`。`PATCH /views/{viewId}` 必须带上已读 `version`，可更改名称、可见性或整体替换定义，更新后版本递增。仅所有者可修改或删除；`DELETE /views/{viewId}` 返回 `{deleted:true}`。不保存查询结果。

```json
{
  "name": "Slow requests",
  "visibility": "private",
  "definition": {
    "schemaVersion": 1,
    "query": { "range": { "last": "24h" }, "where": { "field": "fields.durationMs", "op": "gt", "value": 500 } },
    "columns": ["timestamp", "message"],
    "sort": "desc",
    "visualization": {
      "mode": "series",
      "style": "line",
      "groupBy": ["environment"],
      "metric": { "op": "count" },
      "intervalSeconds": 3600
    }
  }
}
```

名称不超过 256 UTF-8 字节，定义不超过 16 KiB。展示模式为 `rows`、`groups`、`series`，图表样式为 `bar`、`line`、`area`。`private` 仅所有者可见。共享时建立 `visibility:"link"` 的视图并**明确指定项目 ID**，只共享含不透明 `viewId` 的 UI URL。要冻结滚动范围，可新建副本，并将 `query.range` 替换为已展示响应的绝对 `range`。接收方必须通过身份验证，并拥有对**全部**引用项目的读权限；否则返回 404，不在列表中出现。执行查询时按**当前调用者**重新授权。私人视图省略项目列表时，项目范围随当前授权变化。禁止将凭据、查询文本或日志内容放在 URL 中。

旧视图若引用了已移除的内置字段 `service`，仍可读取原定义，但执行相应查询将返回 400。所有者应替换定义，选择实际存在的字段。系统不会自动删除过滤条件，以免扩大查询范围。

## 有限导出

`POST /export` 接收 `{format:"csv"|"jsonl",mode?:"rows"|"groups",query,limit?,byteLimit?,columns?,...}`。原始行支持 `sort`；聚合支持 `groupBy` 和 `metric`。在查询池同步执行，返回 JSON `{format,data,rowCount,byteCount,limited,limitReason,range}`；客户端将 `data` 以 UTF-8 提供下载。`limit` 范围 1–1,000（默认 100）；`byteLimit` 为 1–1,048,576（默认 262,144），包括 CSV 表头及换行。`limitReason` 为 `rows`、`bytes` 或 null。不会截断半行，预算太小时可以一行也没有。执行超时返回可重试的 503，而非部分文件。

原始 JSONL 默认导出完整事件。CSV 默认列为 `projectId,eventId,timestamp,level,message`，两种格式均可选列和排序。CSV 全部单元格加双引号，内部双引号加倍，CRLF 换行，并在可能被电子表格执行的字符串前加单引号；需要精确保留原值请用 JSONL。分组导出默认选择分组字段和 `value`，可选择子集或调整顺序。无持久化导出任务或公开下载地址。

**界面边界：**尚未实现图表绘制、布局和链接生成、浏览器登录、实时推送、仪表盘、告警或完整链路瀑布图。浏览、编辑查询、保存视图和下载均可经上述 HTTP 接口实现，无需依赖 MCP 或直接访问数据库。
