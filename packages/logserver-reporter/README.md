# Logline server reporter

English | [简体中文](./README.zh-CN.md)

`logserver-reporter` uploads sanitized events from `logline/plugin/reporting` to your own Logline deployment. Install it with the matching `logline@beta` version. There are no server dependencies or vendor SDKs in the uploader.

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

`baseUrl` must be HTTPS (loopback may use HTTP). The transport appends `/api/v1/logs`, preserving reverse-proxy path prefixes. `projectId` is the server-issued UUID, not a slug; `service` identifies the producer. `token` accepts a string or a per-attempt sync/async provider. Use a write-only service identity; never ship a private PAT to browsers. Use an authenticated application gateway for public clients. `fetch` optionally supplies a fetch-compatible implementation. No ambient cookies, URL credentials or HTTP redirects are used.

Use `createLoglineServerTransport(options)` for the transport alone. `reporting` on the convenience factory accepts the core plugin options except `transport`. Its queue is bounded and in memory. Successful HTTP responses must partition IDs; on quota exhaustion a valid partial acknowledgement is preserved. Network errors, timeouts, HTTP 408/425/429 and 5xx responses may retry within the reporting limits. Other HTTP failures reject the batch. Keep `maxBatchEvents` and `maxBatchBytes` below server limits, allowing for the JSON envelope. The service does not retrieve historical IndexedDB logs. See the [reporting guide](https://github.com/tellok/logline/blob/master/docs/reporting.md) and [operations guide](https://github.com/tellok/logline/blob/master/docs/server-operations.md).
