# Logline Server CLI

[English](./README.md) | [CLI 指南](https://tellok.github.io/logline/zh/docs/cli)

从终端查询自托管 Logline 服务。需要 Node.js 22.12 或以上版本，以及具备 `logs:read` 权限的个人访问令牌。

```sh
npm install -g logline-server-cli@beta
export LOGLINE_URL=https://logs.example.com
export LOGLINE_AUTH_TOKEN=YOUR_PERSONAL_ACCESS_TOKEN

logline-server-cli project list
logline-server-cli log list --period 2h --level error
logline-server-cli log list --raw | jq '.items[]'
logline-server-cli --help
```

使用 `--url` 和 `--token` 覆盖环境变量。日志默认以适合终端阅读的格式输出。传入 `--raw`（或 `--json`）可输出原始响应体。使用 `logline-server-cli api` 执行其他 Explorer API 查询。
