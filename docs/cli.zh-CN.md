# Logline Server CLI

[English](./cli.md) | [README](../README.zh-CN.md)

`logline-server-cli` 命令通过 [Explorer API](./server-explorer.zh-CN.md) 查询自托管 Logline 服务。使用 Node.js 22.12 或以上版本，并准备具备 `logs:read` 权限的[个人访问令牌](./server-admin.zh-CN.md)。服务端根据令牌持有人当前的项目授权返回日志。

## 连接与查询

```sh
npm install -g logline-server-cli@beta
export LOGLINE_URL=https://logs.example.com
export LOGLINE_AUTH_TOKEN=YOUR_PERSONAL_ACCESS_TOKEN

logline-server-cli project list
logline-server-cli log list --period 2h --level error --query 'checkout timeout' --limit 20
```

`--url` 和 `--token` 分别覆盖对应的环境变量。URL 指向部署根路径，可以包含反向代理的路径前缀。远程部署使用 HTTPS，本地回环地址支持 HTTP。CLI 通过请求的 Bearer 头发送令牌。为避免令牌出现在命令历史或进程参数中，建议使用环境变量。

`log list` 默认查询所有可读项目最近一小时的日志，按时间从新到旧排列，每页默认 50 条，最多 100 条。`--project <uuid>` 和 `--environment <name>` 可重复传入，`--trace <id>` 精确匹配 trace ID，`--query` 按不区分大小写的字面子串匹配消息。可用 `--period 2h` 指定相对时间窗口，也可用 `--period '2026-01-15T00:00:00Z..2026-01-16T00:00:00Z'` 指定起止时间。`--sort oldest` 按时间从旧到新排序。如果列出了下一页游标，使用相同的过滤条件和排序，追加 `--cursor <cursor>` 继续查询。

默认格式显示 UTC 时间、级别、消息、项目 ID、事件 ID，以及存在的关联字段。多行消息会缩进，支持彩色输出的终端会用颜色标识级别。设置 `NO_COLOR=1` 可禁用颜色。使用输出中的项目和事件 ID 查看结构化字段或查询相关日志：

```sh
logline-server-cli log view "$PROJECT_ID" "$EVENT_ID"
logline-server-cli log context "$PROJECT_ID" "$EVENT_ID" --mode trace
```

上下文查询默认使用 `nearby`，也支持同一项目内的 `trace` 和 `session`。项目列表支持 `--limit` 和 `--offset`。运行 `logline-server-cli --help` 可查看命令和选项。

## 原始输出与 API 查询

`--raw`（别名 `--json`）输出成功响应的原始 HTTP 响应体，包括日志记录、时间范围和分页字段。错误写入 stderr，进程以非零状态退出。

```sh
logline-server-cli log list --level error --raw | jq '.items[]'
logline-server-cli api 'projects?limit=10&offset=0'
logline-server-cli api groups --data '{"query":{"range":{"last":"2h"}},"groupBy":["level"]}'
logline-server-cli api rows --data @request.json --raw
```

`api` 接受相对于 `/api/v1/explorer/` 的路径，或带此前缀的完整 Explorer 路径。对 `projects`、`views`、`views/<uuid>` 使用 GET，对 `rows`、`detail`、`context`、`selectors`、`fields`、`groups`、`series`、`refresh`、`export` 使用 POST 执行查询。JSON 请求对象可直接传入、通过 `--data @file` 从文件读取，也可通过 `--data @-` 从 stdin 读取。通用查询和项目列表默认输出缩进的 JSON。请求结构、支持的运算符和响应格式见 [Explorer API 文档](./server-explorer.zh-CN.md)。
