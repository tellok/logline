# Logline server reporter

English | [简体中文](./README.zh-CN.md)

`logserver-reporter` uploads sanitized events from `logline/plugin/reporting` to your own Logline deployment. Install it with the matching `logline@beta` version. There are no server dependencies or vendor SDKs in the uploader.

```ts
import { configureLogline } from 'logline';
import { createLoglineServerReporter } from 'logserver-reporter';

const reporter = createLoglineServerReporter({
  dsn: process.env.LOGLINE_DSN!,
  reporting: { maxBatchEvents: 50, requestTimeoutMs: 5000 },
});
configureLogline({ plugins: [reporter] });
```

Use a DSN of the form `https://<project-key>@host[/prefix]/<project-uuid>`. The project key is `llpk_` followed by 43 base64url characters; use an admin-issued project key, not a personal access token. HTTP is allowed only on loopback. Passwords, queries and fragments are rejected. The transport extracts the key, sends it only as `Authorization: Bearer`, and posts `{ projectId, events }` to `/api/v1/logs` under the proxy prefix. It does not forward URL credentials, send ambient cookies or follow redirects. Optionally supply a compatible `fetch` implementation.

A project key can submit events, not read logs. A DSN used in a browser is visible to its users and does not prove an event is trustworthy. Do not log the DSN; keep backend keys in trusted configuration. To rotate, issue a new key, replace the reporter, then revoke the old key.

Use `createLoglineServerTransport(options)` for the transport alone. `reporting` on the convenience factory accepts the core plugin options except `transport`. Its queue is bounded and in memory. Successful HTTP responses must partition IDs; on quota exhaustion a valid partial acknowledgement is preserved. Network errors, timeouts, HTTP 408/425/429 and 5xx responses may retry within the reporting limits. Other HTTP failures reject the batch. Keep `maxBatchEvents` and `maxBatchBytes` below server limits, allowing for the JSON envelope. The service does not retrieve historical IndexedDB logs. See the [reporting guide](https://github.com/tellok/logline/blob/master/docs/reporting.md) and [operations guide](https://github.com/tellok/logline/blob/master/docs/server-operations.md).
