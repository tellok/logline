# 异步上报

[English](./reporting.md)

如果目标服务需要接收常规 logline 调用的**实时、尽力而为**的副本，可显式注册上报插件。每个实例拥有独立的内存队列、重试预算和传输适配器。仅导入 `logline` 不会启动上报、安装监听器；插件不依赖 IndexedDB 或 Vite。

## 示例：自定义 HTTP 传输

以下应用网关约定 **204 表示本批次所有 ID 已持久接收**，不同于返回逐条确认的 Logline 接收 API。网关负责认证用户并保管服务端凭据；切勿将这些凭据打入浏览器包。

```ts
import { configureLogline } from 'logline';
import { createReportingLoggingPlugin, type ReportingTransport } from 'logline/plugin/reporting';

const gateway: ReportingTransport = {
  name: 'application-gateway',
  async send(events, { signal }) {
    const ids = events.map((event) => event.id);
    const response = await fetch('/telemetry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
      signal,
    });
    const accepted = response.status === 204;
    const retry = !accepted && (response.status === 408 || response.status === 429 || response.status >= 500);
    const delay = response.headers.get('Retry-After');
    return {
      acceptedEventIds: accepted ? ids : [],
      retryableEventIds: retry ? ids : [],
      rejectedEventIds: !accepted && !retry ? ids : [],
      retryAfterMs: retry && delay && /^\d+$/.test(delay) ? Number(delay) * 1000 : undefined,
    };
  },
};
const reporting = createReportingLoggingPlugin({
  transport: gateway,
  sampleRate: 0.1,
  levelSampleRates: { ERROR: 1 },
  context: { release: 'demo', environment: 'staging' },
});
configureLogline({ plugins: [reporting] });
```

将其他显式插件一并放入 `plugins`。**Sentry** 适配器可映射等级、消息和已清理字段，传递去重标识；区分“SDK 已入队”与“远端已接收”，按需关闭 SDK 自身重试、console 面包屑和全局错误捕获，避免重复。**ELK** 适配器应对接认证的接入网关，将 `timestamp` 映射为 `@timestamp`，按事件 ID 去重。批量写入即使返回 200 也可能部分失败，请逐项区分永久拒绝（例如映射错误）与临时过载。

## 每个实例的选项

| 选项                                          |             默认值 | 行为                                                                                             |
| --------------------------------------------- | -----------------: | ------------------------------------------------------------------------------------------------ |
| `transport`                                   |               必填 | 有名称的适配器，每次 `send(batch, { signal })` 只尝试一次，插件负责重试。                        |
| `filter`, `sampleRate`, `levelSampleRates`    |      无、`1`、`{}` | 先执行同步谓词，再使用等级覆盖值或全局采样率；`0` 全丢，`1` 全留（仍受容量限制）。重试不再采样。 |
| `context`, `snapshotKeys`, `transform`        |                 无 | 显式提供的应用上下文、额外需读取的数据属性名、同步脱敏回调。                                     |
| `maxQueueEvents`, `maxQueueBytes`             |       1,000；1 MiB | 容量包括排队、重试及在途记录；字节数为各事件 UTF-8 JSON 大小之和。                               |
| `maxBatchEvents`, `maxBatchBytes`             |         50；64 KiB | 单次请求中的事件数量和 JSON 数组字节（含括号、逗号）；适配器封装的额外开销应另留余量。           |
| `flushIntervalMs`, `maxConcurrentBatches`     |           1,000；1 | 可发送小批次的最长合并等待时间、最大同时请求数；暂停、冷却和在途限制仍生效。                     |
| `requestTimeoutMs`, `maxAttempts`, `maxAgeMs` | 10,000；5；300,000 | 请求超时中止；首次发送也算一次尝试。生存期按本地入队时间计算，而非原始日志时间戳。               |
| `retryBaseMs`, `retryMaxMs`                   |        500；30,000 | 延迟上限随尝试次数翻倍，直至最大值；实际等待在该上限的一半与上限之间随机取值。                   |
| `onStatus`                                    |                 无 | 合并通知，在 `onLog` 返回后提供指标，回调失败不会中断交付。                                      |

容量及时间选项须为 `[1, 2147483647]` 内整数，等级必须受支持，采样率须为 `[0, 1]` 内有限数值；非法配置在创建时抛错。采样只影响当前实例，不影响 console、IndexedDB 或其他目标；全局过滤、限流及编译期等级移除仍先于插件。容量不足或单条记录超过批次大小时**丢弃新事件**，不驱逐排队或在途事件。`getMetrics()` 提供 `queued`、`inFlight`、占用 `bytes` 及累计 `accepted`、`retried`（开始的再次尝试）、`rejected`、`expired`、`discarded`、`sampledOut`、`overflow`、`failed` 和 `lastFailure`。内部诊断不会写入 console；适配器及回调（包括异步回调）也不应记录诊断日志，以免形成反馈循环。

## 快照和隐私

`ReportingEvent` 包含稳定字符串 `id`、五种等级之一的 `level`、原始 Unix 毫秒 `timestamp`、带来源前缀的格式化 `message`，以及可选 JSON `fields`、`context`。字段保留时间戳分量和脱敏后的参数信息。用 ID 标识事件，不要以时间戳或接收顺序代替 ID。版本、环境、会话、追踪等上下文须自行提供。不会发送原始记录或保留可变实参引用。

采样和**有界的单条快照在日志调用返回前同步执行**；批量编码及网络操作稍后进行，日志调用不等待网络。仅检查已知的数据属性和 `snapshotKeys` 显式选定的额外属性，其他属性直接略过，以免枚举无界对象。自定义业务字段应加入 `snapshotKeys`。内置字段包括错误详情（`name`、`message`、`stack`、`cause`、`code`）、常见结构化数据（`status`、`id`、`type`、`value`、`data`、`details`、`error`、`nested`、`user`、`durationMs`、`count`）、应用标识（`environment`、`release`、`traceId`、`sessionId`、`userId`）、已知脱敏字段及快照自身字段。可额外指定最多 24 个属性名（1–64 个 ASCII 字母、数字、下划线、点或连字符；不允许原型及序列化器属性）。每次清理最多访问 96 个值、深度 4、每个数组 16 项；单字符串最多 2,048 个 UTF-16 码元、总共 8,192 个，标准上下文标识上限为 256 个。即使允许更大的传输批次，最终快照超过 64 KiB 也会丢弃。循环引用、不支持的值、访问器、Error 及超长值采取保守处理。已有掩码不能识别所有密钥，请勿记录敏感信息。可用 `transform` 替换业务敏感值，返回 `undefined` 表示丢弃。回调只接收独立快照；返回值会再次清理，不能改写身份或时间。回调应快速完成，单条快照出错不影响其他记录。

## 确认与生命周期

- 三个 ID 数组必须恰好划分本批全部 ID，不能有重复、遗漏或额外 ID。`retryAfterMs` 非法也视整个响应无效。超过 `maxRetryAfterMs`（默认 300,000 毫秒）的提示无效，不会触发冷却或推迟无关批次；若目标服务确实需要更长时间，请调高该上限。无效响应、抛错、拒绝及超时在有限次数内重试；正常响应只重试标记为可重试的事件，已接收和永久拒绝的项立即移出队列。确认交付不会清除 IndexedDB 诊断记录。
- 入队完成后，按数量、字节、等待时间或显式 flush 触发有界批次。到期重试与新项交替发送，逐条退避不阻塞后续批次；可选的非负有限 `retryAfterMs` 为**同一目标后续所有请求**设置最短冷却时间，不中断已有请求。同一事件不会同时处于两个本地请求中；超时或确认丢失后，远端仍可能收到重复事件。适配器应响应中止信号；接收端按 ID 去重、按原始时间重建顺序。不保证恰好一次或必达。
- `await reporting.flush({ timeout: 5000 })` 使用常规调度器处理调用时尚未结束的记录，默认 30 秒。新日志可共用同一请求，但不延长等待范围。结果 `accepted`、`rejected`、`expired`、`discarded`、`remaining`、`timedOut` 只针对该范围。超时不取消后续发送，也不会绕过退避或暂停；指定零超时可立即查看。`maxFlushWaiters`（默认 16）限制每个实例同时等待的调用数；达到上限时，新增等待调用立即以 `RangeError` 拒绝，不设置定时器，不影响正在等待的调用。零超时查询及空队列不占用名额；完成、超时或销毁后释放名额。
- `pause()` 暂停新请求，但在途请求、入队和过期处理继续；`resume()` 恢复。`dispose()` 永久停止入队、清理定时器、中止请求并丢弃未完成事件。退出前可先限时 `flush`；撤销授权时则直接销毁。已发往远端的数据无法撤回。
- 安装没有副作用，可在 `configureLogline` 重配时复用同一实例。移除、替换或重置配置只停止新增日志分发，不会自动销毁旧队列；请显式释放实例。刷新页面会丢失内存队列；本实现不提供持久发件箱、历史上传、页面退出自动刷新或一致性会话采样。

**捕获边界：** 仅接收普通 logline 插件分发，不读取 HTML Interop 启动缓存、不安装全局 `error` / `unhandledrejection` 监听器，也不捕获接管后的普通 console 调用。由 IndexedDB 插件直接写入的启动和全局错误仍限于本地诊断；需要其他来源时请显式集成。
