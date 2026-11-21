# Logline 服务端上传包

[English](./README.md) | 简体中文

`logserver-reporter` 将 `logline/plugin/reporting` 已脱敏的事件上传至指定的 Logline 部署。与同一 beta 版本的 `logline` 一起安装；不依赖服务端代码或第三方平台 SDK。

```ts
import { configureLogline } from 'logline';
import { createLoglineServerReporter } from 'logserver-reporter';

const reporter = createLoglineServerReporter({
  dsn: process.env.LOGLINE_DSN!,
  reporting: { maxBatchEvents: 50, requestTimeoutMs: 5000 },
});
configureLogline({ plugins: [reporter] });
```

DSN 格式为 `https://<project-key>@host[/prefix]/<project-uuid>`。项目密钥格式为 `llpk_` 加 43 个 base64url 字符；使用管理员为该项目签发的密钥，不要使用个人令牌。仅回环地址可使用 HTTP；不接受密码、查询串或片段。上传包从 DSN 分离密钥，仅通过 `Authorization: Bearer` 发送，向保留代理前缀的 `/api/v1/logs` 提交 `{ projectId, events }`，不会转发 URL 凭据、携带环境 cookie 或跟随重定向。可传入 `fetch` 指定兼容实现。

项目密钥只能上报，不能读取日志。浏览器中使用的 DSN 对访问者可见，不能证明日志可信。不要输出 DSN；将后端密钥保存在可信配置中。轮换时先签发新密钥并替换 reporter，再撤销旧密钥。

只需传输层时使用 `createLoglineServerTransport(options)`。快捷工厂的 `reporting` 接受除 `transport` 之外的通用上报配置，队列有界且只存于内存。成功响应必须逐 ID 确认；配额耗尽时保留可解析的部分确认。网络错误、超时、HTTP 408/425/429 及 5xx 响应可在上限内重试；其他 HTTP 失败会拒绝该批。请让批量大小、字节数适配服务端上限，并为外层 JSON 预留空间。不会读取或补传 IndexedDB 历史日志。参阅[上报指南](https://github.com/tellok/logline/blob/master/docs/reporting.zh-CN.md)及[运维指南](https://github.com/tellok/logline/blob/master/docs/server-operations.zh-CN.md)。
