# IndexedDB Plugin

将日志持久化存储到浏览器的 IndexedDB 中, 并提供API匹配查询获取。

**导入路径**：`logline/plugin/indexeddb`

## 核心特性

### 1. 写入排队机制 (Queueing)

插件内部实现了写入队列机制。当数据库正在建立连接、或正在进行版本升级（Upgrade）时，产生的日志**不会丢失**，而是会进入内存队列排队等待。一旦数据库连接就绪，所有积压的日志将自动按顺序写入。

### 2. 多标签页版本冲突处理

当应用发布新版本导致 IndexedDB 表结构发生变化（版本号升级）时：

- **升级方**：新打开的页面会触发 `onupgradeneeded`，执行旧表删除与新表创建。
- **旧版本方**：已打开的旧版本页面会收到 `versionchange` 事件。插件会自动捕获该事件，**主动关闭数据库连接**并停止后续的日志写入，以避免多版本并发写入导致的数据冲突或错误。

  > ![WARNING] 此时旧页面的日志会无法持久化而丢失

### 3. 主键与容量约束

- 主键生成规则：`id = timestamp(ms) * 100 + sequence * 10 + tail`。`sequence` 为核心提供的同毫秒序列号（0~99），`tail` 为冲突补位（0~9）。
- 容量限制：同一毫秒最多写入 100 条（`sequence` 0~99），超出会丢弃并仅首次告警；若主键冲突会尾号递增最多 10 次，仍冲突则丢弃并告警。

**API**：

## `createIndexedDBLoggingPlugin(options?)`

创建插件实例，用于传递给 `configureLogline`。

开发环境的依赖预构建会保留最终解析的 Vite base：Vite 8 使用原生 Rolldown 转换，Vite 6/7 使用 esbuild 钩子。

标准 Vite 最终应用也可以显式开启自动初始化，该选项默认关闭：

```ts
loglineVitePlugin({
  indexedDB: true,
});
```

需要配置插件时直接传入对象：

```ts
loglineVitePlugin({
  indexedDB: {
    databaseName: 'app-logs',
    maxEntries: 5000,
  },
});
```

Vite 插件会在原应用入口中注入自动初始化 import，使其进入正常构建和分包流程，不会向最终 HTML 留下一段内联初始化代码。入口变换会提供 sourcemap，并由 Vite/Rollup 与已有映射继续合并。npm 库不应启用该选项；需要保持手动模式时配置 `indexedDB: false` 或省略该参数。

自动实例独立于业务 `plugins` 保存，后续 `configureLogline()` 不会覆盖它。自动启用后再次调用 `createIndexedDBLoggingPlugin()` 会返回同一个实例，并通过一次性 `console.warn` 提示本次手动参数不会生效；不会创建第二个数据库连接、全局异常监听或日志写入链路。

未显式传入 `databaseName` 时，数据库名按以下优先级解析：

1. `loglineVitePlugin` 注入的 Vite 最终 `base`
2. 运行时 `import.meta.env.BASE_URL`
3. 默认数据库名 `logline`

根路径继续使用 `logline`。非根路径会删除末尾斜杠并生成 `logline:<base>`，例如 `/branches/feature-a/` 对应 `logline:/branches/feature-a`。绝对 URL 只使用其中的路径部分；未被动态 base 插件转换的 `__xxx__` 路径占位符会被忽略。`databaseName` 一旦显式传入便保持原值并覆盖全部自动逻辑。

创建实例时会自动接管并转存 Vite `htmlInterop` 在此之前暂存的日志，不需要手动接管。接管时会恢复原始 console、移除 HTML 阶段的全局异常监听、将缓存写入当前数据库，然后清理内存缓存和全局入口。`plugin.getLogs()` 会等待本次自动转存完成后再返回结果。

HTML Interop 在插件创建前最多保留 1000 条记录。缓存达到上限前不做去重；达到上限后，`ERROR` 记录按完整参数内容精确去重并保留最新一条，`Error.stack` 的路径、行号和列号也参与比较，不做任何位置归一化。溢出时优先按先进先出淘汰非错误记录。第三方可调用 `await globalThis.__LOGLINE_HTML_INTEROP_PEEK__?.()` 查看全部当前缓存；该操作返回记录副本，不会清空缓存。

实例还会独立监听浏览器的 `error` 和 `unhandledrejection` 事件，分别以 `ERROR` 等级和 `[global error]`、`[global unhandledrejection]` 前缀直接写入数据库。该写入不经过标准日志函数，因此不会把同一异常再次输出到 console。

全局异常使用与普通错误日志相同的参数结构：

```ts
ERROR('Script error', event.error);
```

其中 `[global error]` 或 `[global unhandledrejection]` 只作为来源前缀，错误正文是首参，`event.error` 或 rejection reason 是后续参数，不设置全局异常专属的落库字段。IndexedDB 插件与处理其他日志相同，将格式化后的全部参数序列化到 `message`；`Error` 参数会显式保留 `name`、`message` 和 `stack`，不会被序列化成空对象。HTML 阶段捕获的全局异常转存时使用同一结构。

| 参数名                 | 类型     | 默认值      | 用途                                        |
| :--------------------- | :------- | :---------- | :------------------------------------------ |
| `options.databaseName` | `string` | 自动解析    | 显式数据库名称；优先于 Vite base 和默认名称 |
| `options.storeName`    | `string` | `'records'` | 对象仓库名称                                |
| `options.maxEntries`   | `number` | `100000`    | 最大保留日志条数，默认 100000 条            |

```ts
import { createIndexedDBLoggingPlugin } from 'logline/plugin/indexeddb';

configureLogline({
  plugins: [
    createIndexedDBLoggingPlugin({
      databaseName: 'app-logs',
      maxEntries: 5000,
    }),
  ],
});
```

插件不再使用时调用 `plugin.dispose()`，以移除全局异常监听并关闭数据库连接。

### 查询与确认实际数据库

业务查询日志时优先保留插件实例并调用 `plugin.getLogs()`，该方法始终查询插件实例实际写入的数据库，包括显式传入 `databaseName` 的场景。未显式命名时也可以使用下文独立导出的 `getLogs()`，它会按相同的 Vite base 规则自动选择数据库。

独立 `getLogs()` 不接收 `databaseName`，因此不能查询显式命名的数据库。第三方工具接入或排查动态 base 时，在浏览器开发者工具的 `Application → IndexedDB` 中查看当前 Origin 下实际创建的名称；不要用 `location.pathname` 推测，因为页面路由路径不等于 Vite base。支持 `indexedDB.databases()` 的浏览器也可以在控制台筛选候选名称：

```ts
const databaseNames = (await indexedDB.databases())
  .map(({ name }) => name)
  .filter((name) => name?.startsWith('logline'));

console.table(databaseNames);
```

## `getLogs(count?, query?)`

直接从 IndexedDB 获取最近的日志记录，无需持有插件实例。

该函数和 `createIndexedDBLoggingPlugin()` 使用同一套数据库名解析规则，因此未显式命名的插件按 Vite base 写入后，独立 `getLogs()` 会查询同一个数据库。

| 参数名  | 类型                    | 默认值      | 用途                                     |
| :------ | :---------------------- | :---------- | :--------------------------------------- |
| `count` | `number`                | `100`       | 返回的日志条数（指符合查询条件后的条数） |
| `query` | `IndexedDBQueryOptions` | `undefined` | 查询条件（时间范围、等级）               |

```ts
import { getLogs } from 'logline/plugin/indexeddb';

// 获取最近 50 条日志
const logs = await getLogs(50);

// 扫描数据库，直到获取满 50 条 ERROR 级别的日志（并非只在最近 50 条里找 ERROR）
const errorLogs = await getLogs(50, { level: 'ERROR' });

console.table(logs);
```
