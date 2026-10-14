# Click Log Plugin

自动监听用户点击或触摸事件，并打印点击元素的 ID 或 Class 和元素文本内容（自动去除敏感信息），便于追踪用户行为路径。

**导入路径**：`logline/plugin/click-log`

**功能特性**：

1. **自动监听**：
   - 桌面端（Windows/Mac）监听 `click` 事件。
   - 移动端监听 `touchstart` 事件。
2. **智能查找**：自动向上查找最近的包含 `id` 或 `class` 的元素进行记录。
3. **内容记录与脱敏**：
   - 记录点击元素的文本内容（`textContent`）。
   - **自动脱敏**：长度不少于 10 且仅包含字母和数字、并同时含有两者的文本会被替换为 `*`。
   - **长度限制**：文本内容超过 10 个字符会被截断（例如 `VeryLongTe...`）。

**API**：

## `createClickLogPlugin()`

创建点击日志插件。

```ts
import { configureLogline } from 'logline';
import { createClickLogPlugin } from 'logline/plugin/click-log';

configureLogline({
  plugins: [createClickLogPlugin()],
});
```
