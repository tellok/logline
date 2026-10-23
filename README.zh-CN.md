# Logline

[English](./README.md) | 简体中文

面向 JavaScript 和 TypeScript 的前端日志工具，以客户端存储为优先：通过 IndexedDB 在本地保存日志，由应用按需读取并上报。同时提供 Vite 集成与启动阶段错误捕获。

> [!IMPORTANT]
> **当前默认分支为 v2 beta。** 安装和使用 v1 请查看 [v1 README](https://github.com/tellok/logline/blob/v1/README.zh-CN.md)；[v1 分支](https://github.com/tellok/logline/tree/v1) 保留此前默认分支的实现。v2 重写了 API，不兼容 v1 的构造函数和存储协议。

## 安装

```sh
npm install logline@beta
pnpm add logline@beta
```

已发布版本请查看[发布状态](https://www.npmjs.com/package/logline?activeTab=versions)。开发要求 Node.js 24 和 pnpm 10.20.0。

## 迁移与单实例

从 v1 升级时，需要将构造函数与存储协议调用调整为 v2 的具名日志函数与插件 API。v2 不会自动导入历史数据库。详见[迁移说明](./docs/migration-v2.zh-CN.md)。

npm 库应在 `peerDependencies` 和 `devDependencies` 中声明明确的实验版本（例如 `2.0.0-beta.0`），构建时保持 `logline` 为外部依赖，由最终应用提供单一实例。库构建使用 Vite 插件时，显式设置 `logPrefixMacro: false` 并保持 `indexedDB: false`。

## 使用

### 如何打印日志

- 直接按需引入日志函数，日志等级从低到高依次为 `TRACE`、`DEBUG`、`LOG`、`WARN`、`ERROR`。
- 占位符支持 `%s/%d/%i/%f/%o/%O/%j`，与浏览器 console 行为一致。

占位符含义：

- `%s`：字符串（将值转为字符串）
- `%d` / `%i`：整数（按 10 进制输出）
- `%f`：浮点数（保留小数）
- `%o`：对象（更偏向可展开展示，常见于 DOM/对象）
- `%O`：对象（倾向以 JSON 结构完整展示）
- `%j`：JSON 字符串（调用 `JSON.stringify`，循环引用会报错）

```ts
import { DEBUG, ERROR, LOG, TRACE, WARN } from 'logline';

TRACE('进入请求处理流程');
LOG('用户信息：%o', user);
DEBUG('请求耗时：%dms', cost);
WARN('配置缺失，使用默认值');
ERROR('接口异常', detail);
```

### 自动导入日志函数

使用 `createLoglineAutoImport` 或 `loglineAutoImportResolvers` 配合 `unplugin-auto-import`，业务代码无需手动 import。

```typescript
// vite.config.ts
import AutoImport from 'unplugin-auto-import/vite';
import { createLoglineAutoImport } from 'logline/auto-import';

export default defineConfig({
  plugins: [
    AutoImport({
      imports: [],
      ...createLoglineAutoImport(), // 默认始终注入全部日志函数的类型声明
    }),
  ],
});
```

## configureLogline

`configureLogline` 用于在运行时配置日志系统的全局行为，如过滤、节流、插件扩展等。

| 参数名     | 类型                  | 默认值                  | 用途                                                   |
| :--------- | :-------------------- | :---------------------- | :----------------------------------------------------- |
| `filter`   | `(record) => boolean` | `undefined`             | 全局日志过滤器，返回 `false` 则丢弃日志                |
| `throttle` | `number \| object`    | `undefined`（默认关闭） | 全局日志节流配置                                       |
| `plugins`  | `LoglinePlugin[]`     | `[]`                    | 日志插件列表，用于扩展日志处理能力（如写入 IndexedDB） |

### 全局过滤 (`filter`)

设置全局过滤函数，返回 `false` 的日志会被直接丢弃。
过滤函数接收 `LogRecord` 对象，可基于日志正文 `messageText` 与对应参数 `messageArgs` 进行判断。

```ts
import { configureLogline } from 'logline';

configureLogline({
  filter: ({ messageText, messageArgs }) => {
    if (!messageText) return true;
    // 过滤包含敏感词的日志
    if (messageText.includes('敏感')) return false;
    // 过滤参数中包含特定值的日志
    if (messageArgs.some((item) => item === 'secret')) return false;
    return true;
  },
});
```

### 全局节流 (`throttle`)

配置日志节流策略，避免短时间内产生大量重复日志。

- **简单配置**：直接传入毫秒数，如 `throttle: 500`，等价于 `{ ms: 500 }`。
- **高级配置**：传入对象 `{ ms: number, key?: (record) => string }`。
- **默认 Key 生成策略**：若未提供 `key` 函数，默认使用首个入参的字符串值作为 key；若首参不是字符串，则该次日志不参与节流。
- **默认行为**：不传或传入 `undefined`/`false`/非正数会关闭节流。

```ts
configureLogline({
  throttle: {
    ms: 500,
    // 自定义节流 Key 生成策略：结合日志等级和首个参数
    key: ({ level, args }) => `${level}-${String(args[0])}`,
  },
});
```

### 插件扩展 (`plugins`)

通过插件机制可在打印日志的同时执行额外动作，如日志上报、持久化存储等。
详细插件列表与用法请参考下文 [Plugins](#plugins-1) 章节。

```ts
import { configureLogline } from 'logline';
import { createIndexedDBLoggingPlugin } from 'logline/plugin/indexeddb';

configureLogline({
  plugins: [createIndexedDBLoggingPlugin()],
});
```

## Plugins

### [IndexedDB Plugin](./docs/indexeddb.zh-CN.md)

将日志持久化存储到浏览器的 IndexedDB 中, 并提供API匹配查询获取。
最终应用可通过 `loglineVitePlugin({ indexedDB: true })` 自动创建插件，不再要求在主入口手动调用；该选项默认关闭。自动初始化会作为 import 注入原应用入口并进入正常构建和分包流程，业务入口 sourcemap 会继续由 Vite/Rollup 合并。
数据库名按以下优先级确定：显式 `databaseName`、`loglineVitePlugin` 读取的 Vite `base`、运行时 `import.meta.env.BASE_URL`、默认名称 `logline`。根路径继续使用 `logline`；子路径会自动生成 `logline:<规范化 base>`，例如 `/branches/feature-a/` 对应 `logline:/branches/feature-a`。自动模式通过 `indexedDB: { databaseName }` 指定，手动模式通过 `createIndexedDBLoggingPlugin({ databaseName })` 指定。
业务查询日志时优先保留插件实例并调用 `plugin.getLogs()`；未显式命名时也可使用独立 `getLogs()`，由它自动选择同一数据库。独立 `getLogs()` 不能查询显式命名的数据库，此时必须使用对应插件实例。排查实际名称时可在浏览器开发者工具的 `Application → IndexedDB` 中直接确认，不要使用页面路由路径推测 Vite base。
Vite 已自动创建时再次调用 `createIndexedDBLoggingPlugin()` 会复用自动实例，并通过一次性 `console.warn` 提示手动参数不会生效；不会重复安装全局监听或重复写入。后续 `configureLogline()` 无论是否传入其他插件，都不会覆盖自动实例。
创建 IndexedDB 插件时会自动接管并转存 `htmlInterop` 暂存在内存中的首屏日志，无需手动接管。
仅导入 `logline` 不会安装 HTML Interop；只有显式配置 `htmlInterop` 或导入 `logline/html-interop` 才会代理 console 并创建内存缓存。
IndexedDB 插件初始化完成后不会代理或订阅普通 `console.debug/log/warn/error`；此后只有 logline 日志函数产生的记录，以及插件独立监听到的 `error`、`unhandledrejection` 会写入数据库。初始化前由 HTML Interop 代理捕获的 console 属于启动缓存，会在接管时一次性转存。
插件会独立监听 `error` 和 `unhandledrejection`，分别以 `ERROR` 等级和 `[global error]`、`[global unhandledrejection]` 前缀直接写入数据库，不重复输出到 console。

### [Click Log Plugin](./docs/click-log.zh-CN.md)

自动监听用户点击或触摸事件，并打印点击元素的 ID 或 Class和元素文本内容（自动去除敏感信息），便于追踪用户行为路径。

## vite-plugin

`loglineVitePlugin` 提供了构建优化、自动注入调试信息以及首屏日志捕获等增强功能。

插件声明支持 Vite `^6.2.1`、`^7.0.0` 和 `^8.0.0`。使用 Vite 7 或更高版本时，Node.js 版本还必须满足对应 Vite 版本声明的运行要求。开发环境下，依赖归属注入在 Vite 8 中使用原生 Rolldown 转换，在 Vite 6/7 中使用 esbuild 钩子，无需额外配置依赖优化器。

插件还会把 Vite 最终解析的 `base` 注入 logline 运行时代码，供 IndexedDB 插件自动隔离同一 Origin 下不同部署子路径的数据库。动态 base 构建若在最终 JS 阶段将占位符改写为运行时表达式，也会得到实际部署路径；未被改写的动态占位符不会被用作数据库名。

| 参数名                               | 类型                                 | 默认值      | 用途                                                              |
| :----------------------------------- | :----------------------------------- | :---------- | :---------------------------------------------------------------- |
| `level`                              | `string`                             | `undefined` | 构建时保留的最低日志等级，低于此等级的调用将被剔除                |
| `indexedDB`                          | `boolean \| IndexedDBLoggingOptions` | `false`     | 最终应用是否自动创建 IndexedDB 插件；传入对象可配置数据库         |
| `logPrefixMacro`                     | `boolean \| object`                  | `true`      | 编译期自动注入文件路径、行列号和函数名，并标记 npm 依赖的实际包名 |
| `logPrefixMacro.includeFunctionName` | `boolean`                            | `true`      | 是否包含函数名                                                    |
| `logPrefixMacro.sourcemapRetrack`    | `boolean`                            | `true`      | 是否启用 sourcemap 支持以还原准确行列号                           |
| `logPrefixMacro.namespace`           | `string`                             | `undefined` | 为项目自身源码注入额外标签；npm 依赖始终使用自动解析的包名        |
| `htmlInterop`                        | `boolean \| object`                  | `undefined` | 自动在 index.html 注入预加载脚本，捕获首屏日志                    |

### 构建时剔除低等级日志 (`level`)

通过设置 `level`，构建阶段会将低于该等级的日志调用标记为 pure，从而在打包时被移除（Tree Shaking）。
例如设为 `WARN`，则 `TRACE`/`DEBUG`/`LOG` 会被视为可清理的冗余调用，仅保留 `WARN` 和 `ERROR`。

日志等级来源优先级如下：

1. `loglineVitePlugin({ level })` 显式传入的 `level`
2. `process.env.VITE_LOG_LEVEL`
3. 项目 `.env`、`.env.local`、`.env.<mode>`、`.env.<mode>.local` 按 Vite 规则合并后的 `VITE_LOG_LEVEL`
4. 默认值 `LOG`

执行 `vite build` 时，插件会通过 Vite logger 打印最终采用的日志等级和来源。

### 自动注入调用位置信息 (`logPrefixMacro`)

开启此选项后，插件会在编译期自动修改日志调用，将**文件路径**、**行列号**及**函数名**注入到日志前缀中。对于 npm 依赖，插件会读取当前文件最近的 `package.json`，自动注入实际包名和相对包根目录的构建产物路径：

```ts
// @example/xxxxx 包内 dist/sdd.js 第 213 行、第 17 列，位于产物函数 funb 中
LOG('[npm:@example/xxxxx dist/sdd.js:213:17 funb] hello');

// 日志调用位于产物顶层时不添加函数名
LOG('[npm:@example/xxxxx dist/sdd.js:219:1] initialized');
```

- **开发环境**：插件会加入 Vite 的依赖预构建流程，在依赖合并到 `node_modules/.vite` 之前完成注入。
- **生产构建**：插件会在 Rollup 转换依赖模块时完成注入，并保留 npm 包内实际构建产物的位置。
- **依赖归属**：A 依赖 B 时，B 文件最近的 `package.json` 属于 B，因此只会生成 B 的前缀，不会叠加 A 的前缀。
- **幂等处理**：历史产物若已经带有一个或多个标准 `[npm:包名 路径:行:列]` 前缀，插件只保留最内层日志归属并归一化为一个前缀。
- **精准位置还原**：项目源码可通过 SourceMap 还原行列号；npm 依赖仅在 SourceMap 仍指向当前构建产物时采用还原结果，避免错误定位到包作者的 TS 源码。
- **产物函数名**：开启 `includeFunctionName` 时，npm 依赖从实际发布产物的 AST 读取日志调用所在的最近具名函数；顶层或无法确定名称的匿名函数不添加函数名。

> **注意**：若日志函数的**第一个参数不是字符串字面量或模板字符串**（例如 `LOG(formatResponseLog(res))`），则不会自动注入位置信息。

> **打平依赖的边界**：若 A 在发布前把 B 的代码直接打平进 A 的单个产物，且没有保留可识别的 B 前缀或来源信息，消费端只能确认物理文件属于 A，无法可靠反推出代码原本来自 B。npm 包应将普通运行时依赖 external 化，由消费端分别加载 A、B。

**配置项**：

| 参数名                | 类型      | 默认值      | 用途                                                                                                                                                                       |
| :-------------------- | :-------- | :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `includeFunctionName` | `boolean` | `true`      | 是否包含函数名                                                                                                                                                             |
| `sourcemapRetrack`    | `boolean` | `true`      | 是否启用 sourcemap 支持以还原准确行列号。开启后将尝试读取 sourcemap 以还原准确的源码行列号；若担心 sourcemap 还原存在 bug，可关闭此选项，此时将直接使用当前 AST 的行列号。 |
| `namespace`           | `string`  | `undefined` | 为项目自身源码注入额外标签。npm 依赖会忽略该值并使用 `npm:<package.json name>`。                                                                                           |

```ts
// 源码
LOG('hello');

// 编译后 (示例)
LOG('[app.vue:24:9 p1] hello');

// 编译后（配置 namespace: 'app:trade'）
LOG('[app:trade app.vue:24:9 p1] hello');
```

### 首屏日志捕获 (`htmlInterop`)

自动在 `index.html` 头部注入预加载脚本，用于尽早接管 `console` 和 `error` 事件。
这使得在主应用（main.ts）加载失败或执行报错时，也能捕获到关键日志并写入 IndexedDB，便于后续上报分析。
应用启用 `indexedDB: true` 或手动创建 `createIndexedDBLoggingPlugin()` 后，预加载脚本缓存的日志会自动转存到该插件。

预加载脚本从注入时开始持续代理 `console`，并监听 `error` 和 `unhandledrejection`。Vue 挂载、`window.load`、生产入口开始执行、调用 `configureLogline` 或普通日志函数都不会提前停止捕获。自动或手动创建 IndexedDB 插件时才会完成以下接管流程：

1. 恢复原始 `console` 方法。
2. 移除 HTML 阶段注册的全局异常监听器。
3. 将全部缓存记录写入当前 IndexedDB 插件。
4. 清空缓存并移除 HTML Interop 的全局入口。

内存缓存最多保留 1000 条记录，避免应用没有创建 IndexedDB 插件时无限占用内存。缓存达到上限前不做去重；达到上限后，`ERROR` 记录按完整参数内容精确去重并保留最新一条，`Error.stack` 的路径、行号和列号也参与比较，不做任何位置归一化。溢出时优先按先进先出淘汰非错误记录。第三方需要在接管前查看缓存时，可调用 `await globalThis.__LOGLINE_HTML_INTEROP_PEEK__?.()`；该入口返回当前记录的副本，不会清空缓存。

完成转存后，IndexedDB 插件会接替监听全局异常：`error` 使用 `[global error]` 前缀，`unhandledrejection` 使用 `[global unhandledrejection]` 前缀，并且只写入数据库，不再次打印到 console。错误正文是日志首参，`event.error` 或 rejection reason 是后续日志参数，与业务调用 `ERROR(message, error)` 的结构完全一致，不使用全局异常专属字段。IndexedDB 插件会像处理其他日志参数一样将其序列化进 `message`；`Error` 参数会保留 `name`、`message` 和 `stack`。HTML 阶段捕获的全局异常也按相同结构转存。不再需要记录时调用 `plugin.dispose()` 移除监听并关闭数据库连接。

**配置项**：

| 参数名          | 类型                              | 默认值           | 用途               |
| :-------------- | :-------------------------------- | :--------------- | :----------------- |
| `inline`        | `boolean`                         | `true`           | 是否内联脚本       |
| `position`      | `'head-prepend' \| 'head-append'` | `'head-prepend'` | 插入位置           |
| `esbuildTarget` | `string`                          | `'es2016'`       | 内联脚本的构建目标 |

### 配置示例

```ts
import { loglineVitePlugin } from 'logline/vite-plugin';

export default defineConfig({
  plugins: [
    loglineVitePlugin({
      // 1. 构建优化：生产环境仅保留 WARN 及以上日志
      level: process.env.NODE_ENV === 'production' ? 'WARN' : undefined,

      // 2. 调试增强：自动注入调用位置信息
      logPrefixMacro: {
        includeFunctionName: true,
        sourcemapRetrack: true, // 开启 SourceMap 还原，确保行号准确
        namespace: 'app:trade', // 可选：只标记项目自身源码
      },

      // 3. 容灾能力：注入首屏日志捕获脚本
      htmlInterop: {
        inline: true, // 内联脚本，减少网络请求
        position: 'head-prepend', // 插入到 head 最顶部
      },
    }),
  ],
});
```

> **npm 包作者约束**：构建 npm 库时必须主动、显式配置 `logPrefixMacro: false`，并保持 `indexedDB: false`。`logPrefixMacro` 默认是 `true`，省略字段、调用 `loglineVitePlugin()` 或传入空对象都会开启前缀注入。不要把自身包名、源码位置或 IndexedDB 自动初始化固化进发布产物；这些能力由最终应用的 `loglineVitePlugin` 统一决定。

> `htmlInterop` 默认内联预脚本至 `<head>` 前侧，并使用 esbuild 降级至 es2016；可通过 `inline/src/position/esbuildTarget` 调整策略。

内联构建产物会避开 HTML 解析器禁止的原始控制字符，可由 Vite 开发服务器和生产构建页面直接解析。

## 发布流程

用户可观察的更新需添加 Changeset 与中文摘要。默认分支先轻量生成版本 PR，通过最新合并结果验证后，只有合法版本 PR 的合并提交才能构建并以 beta 标签发布。详见[发布流程](./docs/release-flow.zh-CN.md)。

## 许可证

[MIT](./LICENSE)。
