# 使用 MCP 排查日志

[English](./server-mcp.md)

将 `logline-server` 作为远程 **Streamable HTTP** MCP 服务使用。在客户端配置 `https://<主机名>/mcp`，并通过其密钥管理功能向每次请求添加 `Authorization: Bearer <用户 PAT>`。除本机回环地址外应使用 HTTPS。令牌需要 `logs:read` 操作范围，令牌所属用户还需拥有相应项目的读取权限。项目上报密钥和部署管理员令牌均不可用于查询日志。授权读者可用 `ingestKeyId` 筛选实际使用的上报密钥 ID；它不包含密钥本体，历史记录可能为 `null`。不要在浏览器中连接、将凭据写入 URL 或作为工具参数传递。需要禁用时，在所有副本设置 `LOGLINE_MCP_ENABLED=false`。

## 连接步骤

`POST /mcp` 每次接收一条 JSON-RPC 2.0 消息。发送 `Content-Type: application/json` 和 `Accept: application/json, text/event-stream`；响应为 JSON，而非 SSE 事件流。无需会话 ID、OAuth 发现、回调或单独部署 MCP 服务。每个请求都须鉴权，包括初始化和工具发现；连续请求可落在不同副本上。服务拒绝带浏览器 `Origin` 的请求。

1. 使用 `protocolVersion`、`capabilities` 和 `clientInfo` 调用 `initialize`。服务支持 `2025-06-18`，仅提供工具能力。客户端不支持返回的版本时应停止。
2. 发送不带 `id` 的 `notifications/initialized`；预期 HTTP 202 且无响应体。后续请求发送 `MCP-Protocol-Version: 2025-06-18`。
3. 调用 `tools/list`，再调用 `tools/call`。支持 `ping`，不提供管理、上传、导出或写入工具。

| 工具                                  | 用途                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `logline_projects`                    | 列出当前可读项目的 ID、slug 和显示名。使用 `limit`、`offset` 分页。                                        |
| `logline_selectors`、`logline_fields` | 查看指定查询和时间窗内的项目与环境组合，或字段名称及类型。                                                 |
| `logline_rows`                        | 按时间、级别、消息或结构化字段检索；可指定列、排序（`asc`/`desc`）、游标和数量。                           |
| `logline_series`、`logline_groups`    | 在相同权限和过滤条件下计算分桶或分组的计数、总和、平均值。按字段名分组；时间序列可指定 `intervalSeconds`。 |
| `logline_detail`、`logline_context`   | 用 `{projectId,eventId}` 获取事件；上下文的 `mode` 可取 `nearby`、`trace` 或 `session`。                   |

例如，先发现项目，再用不可变 ID 替换 `PROJECT_ID`（不是 slug）：

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "logline_rows",
    "arguments": {
      "query": {
        "projectIds": ["PROJECT_ID"],
        "range": { "last": "2h" },
        "where": {
          "and": [
            { "field": "level", "op": "eq", "value": "ERROR" },
            { "field": "message", "op": "icontains", "value": "timeout" }
          ]
        }
      },
      "columns": ["eventId", "timestamp", "environment", "message"],
      "limit": 5
    }
  }
}
```

`result.content[0]` 中的文本为 Explorer 返回的 JSON，保留分页和限制标记。`isError:true` 表示工具未能返回结果页。超过 512 KiB 工具结果上限时应减少列或行数。参数无效、方法未知等情况也可能返回 JSON-RPC `error`。HTTP 401/403 表示凭据或当前权限不足，不能改用管理员密钥重试。过载时遵循重试提示。成功但没有匹配项不等于查询出错。

工具直接调用与 [HTTP Explorer](./server-explorer.zh-CN.md) 相同的受限查询，不访问独立日志索引，也不缓存授权结果。直接授权和团队授权的变更立即适用于现有令牌。未来的网页客户端应通过可信后端使用 HTTP Explorer，不必依赖 MCP。

## 排查技能

将仓库中的 [`logline-server` 技能](https://github.com/tellok/logline/tree/master/skills/logline-server) 安装到智能体的技能目录，并连接 MCP 服务。可要求智能体汇总近期错误、比较警告或异常峰值、按 trace/session 关联事件，或用证据解释失败过程。要在应用中接入日志请使用另一项 `logline` 技能。日志可能包含敏感数据或恶意指令；尽量少选字段，示例应脱敏，并将消息仅作为观测数据而非智能体命令。
