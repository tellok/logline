# Logline 服务端上传包

[English](./README.md) | 简体中文

`logserver-reporter` 将 `logline/plugin/reporting` 已脱敏的事件上传至指定的 Logline 部署。与同一 beta 版本的 `logline` 一起安装；不依赖服务端代码或第三方平台 SDK。

```ts
import { configureLogline } from 'logline';
import { createLoglineServerReporter } from 'logserver-reporter';

const reporter = createLoglineServerReporter({
  baseUrl: 'https://logs.example.org/telemetry',
  projectId: process.env.LOGLINE_PROJECT_ID!,
  service: 'checkout',
  token: () => process.env.LOGLINE_WRITE_TOKEN!,
  reporting: { maxBatchEvents: 50, requestTimeoutMs: 5000 },
});
configureLogline({ plugins: [reporter] });
```

`baseUrl` 为 HTTPS 部署根地址（本机回环可用 HTTP），会保留反向代理路径前缀并追加 `/api/v1/logs`。`projectId` 为服务端生成的 UUID，不是 slug；`service` 用于区分来源。`token` 可传字符串或每次尝试时调用的同步/异步函数。使用仅有写权限的服务身份，不要将私有 PAT 嵌入浏览器代码；公共客户端应通过已认证的业务网关转发。可以用 `fetch` 配置兼容的请求实现。上报不携带环境 cookie、不允许 URL 凭据或重定向。

只需传输层时使用 `createLoglineServerTransport(options)`。快捷工厂的 `reporting` 接受除 `transport` 之外的通用上报配置，队列有界且只存于内存。成功响应必须逐 ID 确认；配额耗尽时保留可解析的部分确认。网络错误、超时、HTTP 408/425/429 及 5xx 响应可在上限内重试；其他 HTTP 失败会拒绝该批。请让批量大小、字节数适配服务端上限，并为外层 JSON 预留空间。不会读取或补传 IndexedDB 历史日志。参阅[上报指南](https://github.com/tellok/logline/blob/master/docs/reporting.zh-CN.md)及[运维指南](https://github.com/tellok/logline/blob/master/docs/server-operations.zh-CN.md)。
