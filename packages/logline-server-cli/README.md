# Logline Server CLI

[简体中文](./README.zh-CN.md) | [CLI guide](https://tellok.github.io/logline/docs/cli)

Query a self-hosted Logline server from your terminal. Requires Node.js 22.12 or later and a personal access token with `logs:read`.

```sh
npm install -g logline-server-cli@beta
export LOGLINE_URL=https://logs.example.com
export LOGLINE_AUTH_TOKEN=YOUR_PERSONAL_ACCESS_TOKEN

logline-server-cli project list
logline-server-cli log list --period 2h --level error
logline-server-cli log list --raw | jq '.items[]'
logline-server-cli --help
```

Pass `--url` and `--token` to override the environment. Logs are formatted for reading by default. Use `--raw` (or `--json`) for the original response body. Use `logline-server-cli api` to run other read queries against the Explorer API.
